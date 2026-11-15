import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../src/store/sqliteStore.ts";
import { SCHEMA_VERSION } from "../src/store/store.ts";
import {
  INSERT_WORK_RECORD_SQL,
  readOriginId,
  readWorkRecords,
  workRecordParams,
} from "../src/store/workRecordRows.ts";
import type { WorkRecord } from "../src/workSessions/records.ts";
import { makeStore, sqlite, BASE_TS } from "./fixture.ts";

/**
 * Work-session records (PRD §7.25), store layer. The database itself refuses
 * a record that breaks the per-kind rules, so these tests insert on a raw
 * connection: they prove the table's constraints, not a handler's manners.
 */

function record(p: Partial<WorkRecord> & { id: string; kind: WorkRecord["kind"] }): WorkRecord {
  return {
    workSessionId: p.id,
    continuesFrom: null,
    startedImplicitly: false,
    summary: null,
    openItems: null,
    brief: null,
    provenance: { summary: null, openItems: null, brief: null },
    chatSessionId: "chat-1",
    chatSessionIdSource: "client-env",
    cwd: "/home/dev/project",
    source: "claude-code",
    originId: "origin-1",
    attestedAt: BASE_TS,
    clientName: "modelog-test",
    clientVersion: "0",
    ...p,
  };
}

function insert(db: any, r: WorkRecord): void {
  db.prepare(INSERT_WORK_RECORD_SQL).run(...workRecordParams(r));
}

test("a schema-7 store gains work_records, meta and an origin id that never changes", { skip: !sqlite }, () => {
  const fx = makeStore();
  try {
    let raw = new sqlite.DatabaseSync(fx.path);
    raw.exec("DROP TABLE work_records; DROP TABLE meta; PRAGMA user_version = 7");
    raw.close();

    let store = new SqliteStore(sqlite, fx.path);
    assert.deepEqual(store.allWorkRecords(), []);
    store.close();

    raw = new sqlite.DatabaseSync(fx.path);
    assert.equal(raw.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    const origin = readOriginId(raw);
    assert.match(origin ?? "", /^[0-9a-f-]{36}$/);
    raw.close();

    store = new SqliteStore(sqlite, fx.path);
    store.close();
    raw = new sqlite.DatabaseSync(fx.path, { readOnly: true });
    assert.equal(readOriginId(raw), origin, "reopening must not mint a new origin id");
    raw.close();
  } finally {
    fx.cleanup();
  }
});

test("a schema-8 store loses the closure rating and keeps everything else", { skip: !sqlite }, () => {
  const fx = makeStore();
  try {
    // The schema-8 table exactly as 0.9.x created it, rating and its CHECK included.
    let raw = new sqlite.DatabaseSync(fx.path);
    raw.exec(`
      DROP TABLE work_records;
      CREATE TABLE work_records (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('start', 'continue', 'handoff', 'done')),
        work_session_id TEXT NOT NULL,
        continues_from TEXT,
        started_implicitly INTEGER NOT NULL DEFAULT 0 CHECK (started_implicitly IN (0, 1)),
        rating INTEGER CHECK (rating BETWEEN 1 AND 10),
        summary TEXT, open_items TEXT, brief TEXT,
        provenance TEXT NOT NULL,
        chat_session_id TEXT, chat_session_id_source TEXT, cwd TEXT, source TEXT, origin_id TEXT,
        attested_at INTEGER NOT NULL,
        client_name TEXT, client_version TEXT,
        CHECK ((kind = 'done') = (rating IS NOT NULL)),
        CHECK (summary IS NULL OR kind = 'done'),
        CHECK (brief IS NULL OR kind = 'handoff'),
        CHECK (open_items IS NULL OR kind IN ('handoff', 'done')),
        CHECK (continues_from IS NULL OR kind <> 'start'),
        CHECK (kind <> 'continue' OR continues_from IS NOT NULL)
      );
      CREATE INDEX idx_work_records_session ON work_records(work_session_id);
      CREATE INDEX idx_work_records_chat ON work_records(chat_session_id);
      CREATE INDEX idx_work_records_attested ON work_records(attested_at);
      CREATE UNIQUE INDEX uq_work_records_continues ON work_records(continues_from) WHERE continues_from IS NOT NULL;
      INSERT INTO work_records (id, kind, work_session_id, provenance, attested_at) VALUES ('s1', 'start', 's1', '{}', 1);
      INSERT INTO work_records (id, kind, work_session_id, brief, open_items, provenance, attested_at)
        VALUES ('h1', 'handoff', 's1', 'Next: x.', '["y"]', '{"brief":"user","openItems":"generated"}', 2);
      INSERT INTO work_records (id, kind, work_session_id, continues_from, provenance, attested_at)
        VALUES ('c1', 'continue', 's1', 'h1', '{}', 3);
      INSERT INTO work_records (id, kind, work_session_id, rating, summary, provenance, attested_at)
        VALUES ('d1', 'done', 's1', 7, 'Did x.', '{"summary":"user"}', 4);
      PRAGMA user_version = 8;
    `);
    raw.close();

    const store = new SqliteStore(sqlite, fx.path);
    const after = store.allWorkRecords();
    store.close();
    assert.deepEqual(after.map((r) => r.id), ["s1", "h1", "c1", "d1"]);
    assert.equal(after[3].summary, "Did x.");
    assert.equal(after[3].provenance.summary, "user");
    assert.deepEqual(after[1].openItems, ["y"]);

    raw = new sqlite.DatabaseSync(fx.path);
    const cols = raw.prepare("SELECT name FROM pragma_table_info('work_records')").all().map((r: any) => r.name);
    assert.ok(!cols.includes("rating"));
    assert.equal(raw.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r: any) => r.name);
    assert.ok(!tables.includes("work_records_v8"), "the old copy is dropped");
    // The indexes moved to the new table: a second claim on h1 still fails.
    assert.throws(
      () => insert(raw, record({ id: "c2", kind: "continue", continuesFrom: "h1", workSessionId: "s1" })),
      /UNIQUE constraint failed/,
    );
    // And an unrated closure, refused under schema 8, is now accepted.
    insert(raw, record({ id: "d2", kind: "done", summary: "Closed." }));
    raw.close();
  } finally {
    fx.cleanup();
  }
});

test("a work record round-trips through its row", { skip: !sqlite }, () => {
  const fx = makeStore();
  try {
    const db = new sqlite.DatabaseSync(fx.path);
    const done = record({
      id: "d1",
      kind: "done",
      workSessionId: "s1",
      summary: "Shipped the store layer; the installer failed its first test.",
      openItems: ["Fix the installer test", "Measure the context footprint"],
      provenance: { summary: "user", openItems: "generated", brief: null },
    });
    insert(db, done);
    assert.deepEqual(readWorkRecords(db), [done]);
    db.close();
  } finally {
    fx.cleanup();
  }
});

test("the table refuses records that break the per-kind rules", { skip: !sqlite }, () => {
  const fx = makeStore();
  try {
    const db = new sqlite.DatabaseSync(fx.path);
    const refused: Array<[string, WorkRecord]> = [
      ["a brief on a closure", record({ id: "d2", kind: "done", brief: "x" })],
      ["a summary on a handoff", record({ id: "h2", kind: "handoff", summary: "x" })],
      ["open items on a start", record({ id: "s", kind: "start", openItems: ["x"] })],
      ["a start that continues something", record({ id: "s2", kind: "start", continuesFrom: "h0" })],
      ["a continue that names no handoff", record({ id: "c", kind: "continue" })],
      ["an unknown kind", record({ id: "x", kind: "abandoned" as WorkRecord["kind"] })],
    ];
    for (const [what, r] of refused) {
      assert.throws(() => insert(db, r), /CHECK constraint failed/, what);
    }
    assert.equal(readWorkRecords(db).length, 0);
    db.close();
  } finally {
    fx.cleanup();
  }
});

test("a handoff can be continued only once", { skip: !sqlite }, () => {
  const fx = makeStore();
  try {
    const db = new sqlite.DatabaseSync(fx.path);
    insert(db, record({ id: "h1", kind: "handoff", brief: "Next: the installer." }));
    insert(db, record({ id: "c1", kind: "continue", continuesFrom: "h1", workSessionId: "h1" }));
    assert.throws(
      () => insert(db, record({ id: "c2", kind: "continue", continuesFrom: "h1", workSessionId: "h1" })),
      /UNIQUE constraint failed/,
    );
    db.close();
  } finally {
    fx.cleanup();
  }
});

test("clearing the rebuildable cache leaves work records untouched", { skip: !sqlite }, () => {
  const fx = makeStore();
  try {
    const db = new sqlite.DatabaseSync(fx.path);
    insert(db, record({ id: "s1", kind: "start" }));
    db.close();
    const store = new SqliteStore(sqlite, fx.path);
    store.clear();
    assert.equal(store.turnCount(), 0);
    assert.equal(store.allWorkRecords().length, 1, "work records exist in no log and cannot be rebuilt");
    store.close();
  } finally {
    fx.cleanup();
  }
});
