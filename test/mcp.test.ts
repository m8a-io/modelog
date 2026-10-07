import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReadOnly } from "../src/mcp/readOnlyStore.ts";
import { SqliteStore, loadSqlite } from "../src/store/sqliteStore.ts";
import { SCHEMA_VERSION } from "../src/store/store.ts";
import { makeStore } from "./fixture.ts";

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

test("tools/list advertises every tool with a JSON Schema", { skip: !existsSync(BUNDLE) }, async () => {
  const { client } = await handshake();
  try {
    const res = await client.request("tools/list");
    assert.ok(res.result, `expected a result, got ${JSON.stringify(res)}`);

    const names = res.result.tools.map((t: any) => t.name).sort();
    assert.deepEqual(names, [
      "modelog_compare_models",
      "modelog_get_definitions",
      "modelog_get_markers",
      "modelog_get_summary",
      "modelog_list_sessions",
    ]);

    for (const t of res.result.tools) {
      assert.ok(t.description?.length > 80, `${t.name} needs a real description`);
      assert.equal(t.inputSchema.type, "object", t.name);
      // Survives the JSON round trip: `as const` readonly objects must still
      // serialise as plain schema on the wire.
      assert.equal(t.inputSchema.additionalProperties, false, t.name);
    }
  } finally {
    client.close();
  }
});

test("tools/call returns a parseable envelope in a single text block", { skip: !existsSync(BUNDLE) }, async () => {
  const { client } = await handshake();
  try {
    const res = await client.request("tools/call", {
      name: "modelog_get_summary",
      arguments: { days: 30 },
    });
    assert.ok(res.result, `expected a result, got ${JSON.stringify(res)}`);
    assert.ok(!res.result.isError, "a valid call must not be an error");
    assert.equal(res.result.content.length, 1, "one block, not several");
    assert.equal(res.result.content[0].type, "text");

    // What an agent actually does with the response.
    const env = JSON.parse(res.result.content[0].text);
    assert.ok(["ok", "no-data", "schema-mismatch"].includes(env.status));
    assert.ok("range" in env && "data" in env && "notes" in env, "the §8.7 envelope");
    assert.ok(Array.isArray(env.notes));
  } finally {
    client.close();
  }
});

test("a tool call against no store reports no-data, not zeros", { skip: !existsSync(BUNDLE) }, async () => {
  const { client } = await handshake({ MODELOG_DB: "/nonexistent/modelog.db" });
  try {
    const res = await client.request("tools/call", {
      name: "modelog_get_summary",
      arguments: {},
    });
    const env = JSON.parse(res.result.content[0].text);
    assert.equal(env.status, "no-data");
    assert.equal(env.data, null, "emptiness must never arrive as a reading");
    assert.ok(env.notes.length > 0, "and must say why");
  } finally {
    client.close();
  }
});

test("a bad argument fails the call instead of returning an empty envelope", { skip: !existsSync(BUNDLE) }, async () => {
  const { client } = await handshake();
  try {
    const res = await client.request("tools/call", {
      name: "modelog_get_summary",
      arguments: { days: 7, from: "2026-01-01" },
    });
    // "You asked wrongly" must not be readable as "there is no data".
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /not both/);
  } finally {
    client.close();
  }
});

test("an unknown tool name fails the call and does not kill the server", { skip: !existsSync(BUNDLE) }, async () => {
  const { client } = await handshake();
  try {
    const bad = await client.request("tools/call", { name: "modelog_delete_everything", arguments: {} });
    assert.equal(bad.result.isError, true);

    // The server must still be serving afterwards.
    const good = await client.request("tools/call", { name: "modelog_get_markers", arguments: {} });
    assert.ok(!good.result.isError, "the server survived a bad call");
  } finally {
    client.close();
  }
});

test("the full stack answers with real figures over stdio", { skip: !existsSync(BUNDLE) || !sqlite }, async () => {
  // Bundle, transport, read-only store and handlers together. The in-process
  // tests cover the handlers; this is the only test that proves the built
  // artifact a client actually spawns produces the same numbers.
  const fx = makeStore();
  try {
    const { client } = await handshake({ MODELOG_DB: fx.path });
    try {
      const summary = await client.request("tools/call", {
        name: "modelog_get_summary",
        arguments: { from: "2026-08-01T00:00:00Z", to: "2026-10-01T00:00:00Z" },
      });
      const env = JSON.parse(summary.result.content[0].text);
      assert.equal(env.status, "ok");
      assert.equal(env.data.turns, 9, "the fixture's nine turns, through the whole stack");
      assert.equal(env.data.sessions, 3);
      assert.equal(env.data.sidechainTurns, 2);
      assert.equal(env.data.costBySource[0].source, "claude-code");
      assert.equal(env.data.costBySource[0].totalCost.unit, "usd_micro");
      assert.equal(env.data.unpricedTurns, 2);

      const markers = await client.request("tools/call", {
        name: "modelog_get_markers",
        arguments: { from: "2026-08-01T00:00:00Z", to: "2026-10-01T00:00:00Z" },
      });
      const m = JSON.parse(markers.result.content[0].text);
      assert.equal(m.data.markers.length, 3, "subagent dispatches stay excluded on the wire");
      assert.equal(m.data.sidechainTurnsExcluded, 2);
    } finally {
      client.close();
    }
  } finally {
    fx.cleanup();
  }
});

test("every advertised tool answers a bare call over the wire", { skip: !existsSync(BUNDLE) }, async () => {
  const { client } = await handshake();
  try {
    const list = await client.request("tools/list");
    for (const t of list.result.tools) {
      const res = await client.request("tools/call", { name: t.name, arguments: {} });
      assert.ok(res.result, `${t.name} returned no result`);
      assert.ok(!res.result.isError, `${t.name} errored: ${res.result?.content?.[0]?.text}`);
      const env = JSON.parse(res.result.content[0].text);
      assert.ok("notes" in env, `${t.name} did not return an envelope`);
    }
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
