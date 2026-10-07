import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, loadSqlite, migrate } from "../src/store/sqliteStore.ts";
import { SCHEMA_VERSION } from "../src/store/store.ts";
import type { Turn } from "../src/ingest/types.ts";
import { uncapturedFields } from "../src/ingest/capture.ts";

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
    uuid: "u1", sessionId: "s1", ts: 1_000, model: "claude-sonnet-5",
    inputTokens: 1, cacheReadTokens: 2, cacheWrite5mTokens: 3,
    cacheWrite1hTokens: 4, outputTokens: 5, thinkingTokens: 6,
    iterations: 1, entrypoint: "claude-vscode", isSidechain: false, captureVersion: 2,
    speed: "standard", inferenceGeo: "not_available",
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
        "capture_version", "cost_nano_aiu", "entrypoint", "inference_geo",
        "is_sidechain", "source", "speed", "token_breakdown",
      ],
    );

    // The pre-existing row is readable, with the new fields as gaps.
    const rows = store.allTurns();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.uuid, "old");
    assert.equal(rows[0]!.entrypoint, null);
    assert.equal(rows[0]!.isSidechain, false);
    // A null modifier is "not recorded", which prices as unmodified — distinct
    // from a recorded value we do not recognise, which prices as null.
    assert.equal(rows[0]!.speed, null);
    assert.equal(rows[0]!.inferenceGeo, null);
    // Unlike isSidechain, this default is a fact: Claude Code is the only
    // adapter that has ever written to this store, so a pre-existing row IS
    // a Claude Code turn and needs no capture-version caveat.
    assert.equal(rows[0]!.source, "claude-code");
    // No measured cost, and token classes the source reported outright.
    assert.equal(rows[0]!.costNanoAiu, null);
    assert.equal(rows[0]!.tokenBreakdown, null);

    // The false above is a default, not an observation; the row says so.
    assert.equal(rows[0]!.captureVersion, 1);
    assert.deepEqual(uncapturedFields(rows[0]!), ["entrypoint", "inferenceGeo", "isSidechain", "speed"]);

    // The cursor must be gone, or the scanner would skip the unchanged file
    // and the newly added columns would never be backfilled.
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
