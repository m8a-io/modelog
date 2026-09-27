import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReadOnly } from "../src/mcp/readOnlyStore.ts";
import { SqliteStore, loadSqlite } from "../src/store/sqliteStore.ts";
import { SCHEMA_VERSION } from "../src/store/store.ts";

const BUNDLE = "dist/mcp-server.mjs";
const sqlite = await loadSqlite();

/**
 * A minimal MCP stdio client: newline-delimited JSON-RPC over the child's
 * stdin/stdout. Deliberately hand-rolled rather than using the SDK client, so
 * the test exercises the wire format a real client will actually send.
 */
class StdioClient {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private pending = new Map<number, (msg: any) => void>();
  private nextId = 1;
  readonly stderr: string[] = [];

  constructor(env: Record<string, string | undefined>) {
    this.child = spawn(process.execPath, [BUNDLE], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (c: string) => this.stderr.push(c));
  }

  request(method: string, params: unknown = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 10_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

async function handshake(env: Record<string, string | undefined> = {}) {
  const client = new StdioClient(env);
  const res = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "modelog-test", version: "0" },
  });
  client.notify("notifications/initialized");
  return { client, res };
}

test("the built bundle answers initialize over stdio", { skip: !existsSync(BUNDLE) }, async () => {
  const { client, res } = await handshake({ MODELOG_DB: undefined });
  try {
    assert.equal(res.jsonrpc, "2.0");
    assert.ok(res.result, `expected a result, got ${JSON.stringify(res)}`);
    assert.equal(res.result.serverInfo.name, "modelog");
    assert.ok(res.result.protocolVersion, "protocolVersion must be negotiated");
    assert.ok(res.result.capabilities.tools, "tools capability must be advertised");
  } finally {
    client.close();
  }
});

test("tools/list answers with an empty list in phase 1", { skip: !existsSync(BUNDLE) }, async () => {
  const { client } = await handshake();
  try {
    const res = await client.request("tools/list");
    assert.ok(res.result, `expected a result, got ${JSON.stringify(res)}`);
    assert.deepEqual(res.result.tools, []);
  } finally {
    client.close();
  }
});

test("a missing store does not stop the server starting", { skip: !existsSync(BUNDLE) }, async () => {
  const { client, res } = await handshake({ MODELOG_DB: "/nonexistent/modelog.db" });
  try {
    assert.ok(res.result, "server must start and serve even with no store");
    const note = client.stderr.join("");
    assert.match(note, /no-data/, "the reason belongs on stderr, not stdout");
  } finally {
    client.close();
  }
});

test("stdout carries only protocol frames — diagnostics go to stderr", { skip: !existsSync(BUNDLE) }, async () => {
  // A stray console.log would corrupt the client's parser. The handshake
  // succeeding at all proves stdout parsed cleanly; this pins the intent.
  const { client, res } = await handshake();
  try {
    assert.ok(res.result);
    assert.match(client.stderr.join(""), /mcp server .* ready on stdio/);
  } finally {
    client.close();
  }
});

test("no store path yields no-data, never a zero reading", async () => {
  const r = await openReadOnly(undefined);
  assert.equal(r.status, "no-data");
  assert.equal(r.db, null);
  assert.match(r.note!, /MODELOG_DB/);
});

test("an absent file yields no-data rather than creating one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "modelog-mcp-"));
  try {
    const path = join(dir, "absent.db");
    const r = await openReadOnly(path);
    assert.equal(r.status, "no-data");
    // Read-only must not manufacture the store it was asked to read.
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a current store opens read-only and is genuinely not writable", { skip: !sqlite }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "modelog-mcp-"));
  try {
    const path = join(dir, "modelog.db");
    new SqliteStore(sqlite, path).close();

    const r = await openReadOnly(path);
    assert.equal(r.status, "ok");
    assert.equal(r.foundSchemaVersion, SCHEMA_VERSION);

    // C1 is structural, not a promise: SQLite itself refuses the write.
    assert.throws(
      () => r.db.exec("INSERT INTO turns (uuid) VALUES ('x')"),
      /readonly|read-only/i,
    );
    r.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a newer store is refused rather than guessed at", { skip: !sqlite }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "modelog-mcp-"));
  try {
    const path = join(dir, "modelog.db");
    const store = new SqliteStore(sqlite, path);
    store.close();
    const db = new sqlite.DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    const r = await openReadOnly(path);
    assert.equal(r.status, "schema-mismatch");
    assert.equal(r.foundSchemaVersion, SCHEMA_VERSION + 1);
    assert.match(r.note!, new RegExp(String(SCHEMA_VERSION + 1)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an older store reports mismatch — a reader cannot migrate", { skip: !sqlite }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "modelog-mcp-"));
  try {
    const path = join(dir, "modelog.db");
    const store = new SqliteStore(sqlite, path);
    store.close();
    const db = new sqlite.DatabaseSync(path);
    db.exec("PRAGMA user_version = 0");
    db.close();

    const r = await openReadOnly(path);
    assert.equal(r.status, "schema-mismatch");
    assert.match(r.note!, /cannot migrate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
