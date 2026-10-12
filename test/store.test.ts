import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, loadSqlite, migrate } from "../src/store/sqliteStore.ts";
import { FileStore } from "../src/store/fileStore.ts";
import { SCHEMA_VERSION } from "../src/store/store.ts";
import type { Turn } from "../src/ingest/types.ts";

const sqlite = await loadSqlite();

/**
 * The `turns` schema as it shipped before entrypoint/is_sidechain existed.
 * Kept verbatim so the migration is exercised against the shape actually on
 * disk in an existing install, not against a guess at it.
 */
const SCHEMA_V0 = `
CREATE TABLE turns (
  uuid TEXT PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL,
  model TEXT NOT NULL, input_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL, cache_write_5m_tokens INTEGER NOT NULL,
  cache_write_1h_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  thinking_tokens INTEGER NOT NULL, iterations INTEGER NOT NULL,
  cwd TEXT, git_branch TEXT, source_file TEXT NOT NULL
);
CREATE TABLE cursors (
  path TEXT PRIMARY KEY, size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL, byte_offset INTEGER NOT NULL
);
`;

function turn(p: Partial<Turn> = {}): Turn {
  return {
    uuid: "u1", messageId: null, requestId: null,
    sessionId: "s1", ts: 1_000, model: "claude-sonnet-5",
    inputTokens: 1, cacheReadTokens: 2, cacheWrite5mTokens: 3,
    cacheWrite1hTokens: 4, outputTokens: 5, thinkingTokens: 6,
    iterations: 1, entrypoint: "claude-vscode", isSidechain: false, captureVersion: 2,
    speed: "standard", inferenceGeo: "not_available",
    serviceTier: null, fallbackCredit: null,
    source: "claude-code", costNanoAiu: null, tokenBreakdown: "reported",
    cwd: "/w", gitBranch: "main", sourceFile: "f.jsonl",
    ...p,
  };
}

function tmp(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "modelog-store-"));
  return {
    dir,
    path: join(dir, "modelog.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("a fresh database is already current and migrates nothing", { skip: !sqlite }, () => {
  const t = tmp();
  try {
    const store = new SqliteStore(sqlite, t.path);
    assert.deepEqual(store.migratedColumns, []);
    store.close();
  } finally {
    t.cleanup();
  }
});

test("both new fields survive a write/read round trip", { skip: !sqlite }, () => {
  const t = tmp();
  try {
    const store = new SqliteStore(sqlite, t.path);
    store.upsertTurns([
      turn({ uuid: "a", entrypoint: "claude-vscode", isSidechain: false }),
      turn({ uuid: "b", entrypoint: "cli", isSidechain: true }),
      turn({ uuid: "c", entrypoint: null }),
    ]);
    const byId = new Map(store.allTurns().map((x) => [x.uuid, x]));
    assert.equal(byId.get("a")!.entrypoint, "claude-vscode");
    assert.equal(byId.get("a")!.isSidechain, false);
    assert.equal(byId.get("b")!.entrypoint, "cli");
    assert.equal(byId.get("b")!.isSidechain, true);
    // A null entrypoint must stay a visible gap, not become a string.
    assert.equal(byId.get("c")!.entrypoint, null);
    store.close();
  } finally {
    t.cleanup();
  }
});

test("capture version survives a round trip, so an uncaptured row stays uncaptured", { skip: !sqlite }, () => {
  const t = tmp();
  try {
    const store = new SqliteStore(sqlite, t.path);
    store.upsertTurns([
      turn({ uuid: "old", captureVersion: 1, isSidechain: false, entrypoint: null }),
      turn({ uuid: "new" }),
    ]);
    const byId = new Map(store.allTurns().map((x) => [x.uuid, x]));
    assert.equal(byId.get("old")!.captureVersion, 1);
    assert.equal(byId.get("new")!.captureVersion, 2);
    store.close();
  } finally {
    t.cleanup();
  }
});

test("an existing pre-migration database gains the columns", { skip: !sqlite }, () => {
  const t = tmp();
  try {
    // Stand up a v0 database holding one turn and one cursor.
    const { DatabaseSync } = sqlite;
    const old = new DatabaseSync(t.path);
    old.exec(SCHEMA_V0);
    old
      .prepare(
        `INSERT INTO turns VALUES ('old','s',1,'claude-sonnet-5',1,2,3,4,5,6,1,'/w','main','f.jsonl')`,
      )
      .run();
    old.prepare(`INSERT INTO cursors VALUES ('f.jsonl', 500, 900, 500)`).run();
    old.close();

    const store = new SqliteStore(sqlite, t.path);

    assert.deepEqual(
      [...store.migratedColumns].sort(),
      [
        "capture_version", "cost_nano_aiu", "entrypoint", "fallback_credit",
        "inference_geo", "is_sidechain", "message_id", "request_id",
        "service_tier", "source", "speed", "token_breakdown",
      ],
    );

    // The pre-existing row was a Claude Code row (the only adapter that ever
    // wrote to a v0 store), stored before message_id existed — a per-block
    // copy with no way left to collapse it (issue #11). The migration wipes
    // it rather than keep a figure known to be inflated; the dropped cursor
    // below forces the rescan that rebuilds it from the log.
    assert.equal(store.allTurns().length, 0);

    // The cursor must be gone, or the scanner would skip the unchanged file
    // and the wiped rows would never be rebuilt.
    assert.equal(store.getCursor("f.jsonl"), undefined);
    store.close();
  } finally {
    t.cleanup();
  }
});

test("migrating is idempotent and records the schema version", { skip: !sqlite }, () => {
  const t = tmp();
  try {
    const first = new SqliteStore(sqlite, t.path);
    first.upsertTurns([turn()]);
    first.setCursor({ path: "f.jsonl", size: 1, mtimeMs: 2, byteOffset: 1 });
    first.close();

    // Reopening must not re-add columns, and must not drop the cursor again —
    // otherwise every launch would trigger a full rescan.
    const second = new SqliteStore(sqlite, t.path);
    assert.deepEqual(second.migratedColumns, []);
    assert.ok(second.getCursor("f.jsonl"));
    assert.equal(second.turnCount(), 1);
    second.close();

    const db = new sqlite.DatabaseSync(t.path);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    assert.deepEqual(migrate(db), []);
    db.close();
  } finally {
    t.cleanup();
  }
});

test("a Copilot turn round-trips its measured cost and breakdown", { skip: !sqlite }, () => {
  const t = tmp();
  try {
    const store = new SqliteStore(sqlite, t.path);
    store.upsertTurns([
      turn({
        uuid: "cop1",
        source: "copilot",
        costNanoAiu: 6_171_550_000,
        tokenBreakdown: "solved",
        speed: null,
        inferenceGeo: null,
      }),
    ]);
    const [row] = store.allTurns();
    assert.equal(row!.source, "copilot");
    assert.equal(row!.costNanoAiu, 6_171_550_000);
    assert.equal(row!.tokenBreakdown, "solved");
    store.close();
  } finally {
    t.cleanup();
  }
});

test("a turn whose cache-write split could not be solved says so, rather than reading as zero", { skip: !sqlite }, () => {
  const t = tmp();
  try {
    const store = new SqliteStore(sqlite, t.path);
    store.upsertTurns([
      turn({ uuid: "deg", source: "copilot", costNanoAiu: 0, tokenBreakdown: "unknown" }),
    ]);
    const [row] = store.allTurns();
    assert.equal(row!.tokenBreakdown, "unknown");
    // The cost is still known — it was measured, not derived from the split.
    assert.equal(row!.costNanoAiu, 0);
    store.close();
  } finally {
    t.cleanup();
  }
});

/**
 * Issue #11: Claude Code writes one record per content block, each repeating
 * the same usage object under a fresh record uuid. Rows that agree on
 * (source, message_id) are one API call counted again; the store keeps one.
 */
test("rows sharing (source, message_id) collapse to one row", { skip: !sqlite }, () => {
  const t = tmp();
  try {
    const store = new SqliteStore(sqlite, t.path);
    store.upsertTurns([
      turn({ uuid: "block-1", messageId: "msg_1", requestId: "req_1" }),
      turn({ uuid: "block-2", messageId: "msg_1", requestId: "req_1" }),
      turn({ uuid: "block-3", messageId: "msg_1", requestId: "req_1" }),
    ]);
    assert.equal(store.turnCount(), 1);
    // Last seen wins — deterministic, and the copies carry identical usage.
    assert.equal(store.allTurns()[0]!.uuid, "block-3");

    // A full rescan re-ingests the same records; still exactly one row.
    store.upsertTurns([
      turn({ uuid: "block-1", messageId: "msg_1", requestId: "req_1" }),
      turn({ uuid: "block-2", messageId: "msg_1", requestId: "req_1" }),
    ]);
    assert.equal(store.turnCount(), 1);
    store.close();
  } finally {
    t.cleanup();
  }
});

test("null message ids never collapse — no identity is not the same identity", { skip: !sqlite }, () => {
  const t = tmp();
  try {
    const store = new SqliteStore(sqlite, t.path);
    store.upsertTurns([
      turn({ uuid: "a", messageId: null }),
      turn({ uuid: "b", messageId: null }),
      // Same message id under a different source must also survive: one
      // vendor's id scheme can never collapse another's rows.
      turn({ uuid: "c", messageId: "msg_1", source: "claude-code" }),
      turn({ uuid: "d", messageId: "msg_1", source: "copilot", costNanoAiu: 1, speed: null, inferenceGeo: null }),
    ]);
    assert.equal(store.turnCount(), 4);
    store.close();
  } finally {
    t.cleanup();
  }
});

/**
 * The `turns` schema as v0.3.0 shipped it (schema version 4) — everything
 * current except message_id/request_id. Kept verbatim so the migration is
 * exercised against the shape actually on disk in an existing install.
 */
const SCHEMA_V4 = `
CREATE TABLE turns (
  uuid TEXT PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL,
  model TEXT NOT NULL, input_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL, cache_write_5m_tokens INTEGER NOT NULL,
  cache_write_1h_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  thinking_tokens INTEGER NOT NULL, iterations INTEGER NOT NULL,
  entrypoint TEXT, is_sidechain INTEGER NOT NULL DEFAULT 0,
  capture_version INTEGER NOT NULL DEFAULT 1, speed TEXT, inference_geo TEXT,
  source TEXT NOT NULL DEFAULT 'claude-code', cost_nano_aiu INTEGER,
  token_breakdown TEXT, cwd TEXT, git_branch TEXT, source_file TEXT NOT NULL
);
CREATE TABLE cursors (
  path TEXT PRIMARY KEY, size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL, byte_offset INTEGER NOT NULL
);
PRAGMA user_version = 4;
`;

test("migrating to message_id wipes claude-code rows, keeps other sources, drops cursors", { skip: !sqlite }, () => {
  const t = tmp();
  try {
    const { DatabaseSync } = sqlite;
    const old = new DatabaseSync(t.path);
    old.exec(SCHEMA_V4);
    const ins = old.prepare(`
      INSERT INTO turns (uuid, session_id, ts, model, input_tokens,
        cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
        output_tokens, thinking_tokens, iterations, capture_version, source,
        source_file)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    // Pre-message_id Claude Code rows are per-block copies that can no longer
    // be collapsed — the id was never stored — so the migration removes them
    // and the forced rescan rebuilds from the logs. Copilot rows were never
    // fanned out per block and must survive untouched.
    ins.run("cc-1", "s", 1, "claude-sonnet-5", 1, 2, 3, 4, 5, 0, 1, 2, "claude-code", "f.jsonl");
    ins.run("cc-2", "s", 2, "claude-sonnet-5", 1, 2, 3, 4, 5, 0, 1, 2, "claude-code", "f.jsonl");
    ins.run("cop-1", "s", 3, "claude-sonnet-5", 1, 2, 3, 4, 5, 0, 1, 2, "copilot", "c.jsonl");
    old.prepare("INSERT INTO cursors VALUES ('f.jsonl', 500, 900, 500)").run();
    old.close();

    const store = new SqliteStore(sqlite, t.path);
    assert.deepEqual(
      [...store.migratedColumns].sort(),
      ["fallback_credit", "message_id", "request_id", "service_tier"],
    );

    const remaining = store.allTurns();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.uuid, "cop-1");
    assert.equal(remaining[0]!.source, "copilot");
    // The cursor must be gone so the rescan actually rebuilds the wiped rows.
    assert.equal(store.getCursor("f.jsonl"), undefined);
    store.close();
  } finally {
    t.cleanup();
  }
});

test("the file store collapses per-block copies the same way, across a reload", () => {
  const t = tmp();
  try {
    const path = join(t.dir, "cache.json");
    const store = new FileStore(path);
    store.upsertTurns([
      turn({ uuid: "block-1", messageId: "msg_1" }),
      turn({ uuid: "block-2", messageId: "msg_1" }),
      turn({ uuid: "a", messageId: null }),
      turn({ uuid: "b", messageId: null }),
    ]);
    assert.equal(store.turnCount(), 3);
    store.close();

    // The collapse must survive persistence, and re-ingesting the same
    // records after a reload must not resurrect a copy.
    const reopened = new FileStore(path);
    assert.equal(reopened.turnCount(), 3);
    reopened.upsertTurns([turn({ uuid: "block-1", messageId: "msg_1" })]);
    assert.equal(reopened.turnCount(), 3);
    reopened.close();
  } finally {
    t.cleanup();
  }
});
