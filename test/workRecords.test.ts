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
    rating: null,
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

test("a work record round-trips through its row", { skip: !sqlite }, () => {
  const fx = makeStore();
  try {
    const db = new sqlite.DatabaseSync(fx.path);
    const done = record({
      id: "d1",
      kind: "done",
      workSessionId: "s1",
      rating: 7,
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
      ["a rated handoff", record({ id: "h", kind: "handoff", rating: 5 })],
      ["an unrated closure", record({ id: "d", kind: "done" })],
      ["a rating out of range", record({ id: "d0", kind: "done", rating: 11 })],
      ["a brief on a closure", record({ id: "d2", kind: "done", rating: 5, brief: "x" })],
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
