import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateMarkerInput, SIGNALS, STATEMENT_MAX } from "../src/markers/vocabulary.ts";
import { appendMarker, openAppend, DUPLICATE_WINDOW_MS } from "../src/mcp/appendStore.ts";
import { openReadOnly } from "../src/mcp/readOnlyStore.ts";
import { readMarkers } from "../src/store/markerRows.ts";
import { SqliteStore } from "../src/store/sqliteStore.ts";
import { SCHEMA_VERSION } from "../src/store/store.ts";
import { getMarkers, markChange, type ToolContext } from "../src/mcp/tools.ts";
import { PRICING, RATE_TABLE } from "../src/mcp/rates.ts";
import { FIXTURE_TURNS, makeStore, sqlite, BASE_TS, turn } from "./fixture.ts";

/**
 * Developer-declared markers (PRD §7.23) and the append-only write path
 * (invariant 6). The guard tests matter most: they prove the write
 * connection is narrow at the database, not by the handler's good manners.
 */

const NOW = BASE_TS + 5 * 86_400_000;
const CLIENT = { name: "modelog-test", version: "0" };

const VALID = {
  signal: "peak-context",
  target: 120_000,
  statement: "From today I end sessions before 120k context.",
  provenance: { signal: "generated", target: "user", statement: "user" },
  developerApproved: true,
};

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    status: "ok",
    note: null,
    turns: FIXTURE_TURNS,
    markers: [],
    pricing: PRICING,
    table: RATE_TABLE,
    billing: { mode: "api", detected: true, rawType: "prepaid" },
    billingFromEnv: false,
    schemaVersion: SCHEMA_VERSION,
    now: NOW,
    ...over,
  };
}

// --- validation --------------------------------------------------------------------

test("a valid marker passes and keeps its per-field provenance", () => {
  const r = validateMarkerInput(VALID);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.signal, "peak-context");
  assert.equal(r.value.target, 120_000);
  assert.deepEqual(r.value.provenance, { signal: "generated", target: "user", statement: "user" });
});

test("nothing is accepted without the developer's approval", () => {
  for (const developerApproved of [undefined, false, "true", 1]) {
    const r = validateMarkerInput({ ...VALID, developerApproved });
    assert.equal(r.ok, false, String(developerApproved));
  }
});

test("the signal list is closed: an unknown signal is refused", () => {
  const r = validateMarkerInput({ ...VALID, signal: "vibes" });
  assert.equal(r.ok, false);
  // The error names the valid ids and never echoes what was sent (§4.2).
  if (!r.ok) {
    assert.match(r.error, /peak-context/);
    assert.doesNotMatch(r.error, /vibes/);
  }
});

test("targets are refused where the signal has no unit, and bounded where it does", () => {
  assert.equal(validateMarkerInput({ ...VALID, signal: "context-resets" }).ok, false);
  assert.equal(validateMarkerInput({ ...VALID, target: -1 }).ok, false);
  assert.equal(validateMarkerInput({ ...VALID, target: 1.5 }).ok, false);
  assert.equal(
    validateMarkerInput({ ...VALID, signal: "subagent-share", target: 101 }).ok,
    false,
    "a percentage cannot exceed 100",
  );
  const noTarget = { ...VALID, signal: "context-resets", provenance: { signal: "user", statement: "user" } };
  delete (noTarget as any).target;
  assert.ok(validateMarkerInput(noTarget).ok);
});

test("the statement is capped", () => {
  assert.equal(validateMarkerInput({ ...VALID, statement: "x".repeat(STATEMENT_MAX + 1) }).ok, false);
  assert.ok(validateMarkerInput({ ...VALID, statement: "x".repeat(STATEMENT_MAX) }).ok);
});

test("provenance is required per field given, and refused for a field not given", () => {
  assert.equal(validateMarkerInput({ ...VALID, provenance: undefined }).ok, false);
  assert.equal(validateMarkerInput({ ...VALID, provenance: { signal: "user", target: "user" } }).ok, false);
  assert.equal(validateMarkerInput({ ...VALID, provenance: { ...VALID.provenance, signal: "observed" } }).ok, false,
    "an agent cannot claim a field was observed");
  const { statement: _s, ...noStatement } = VALID;
  assert.equal(validateMarkerInput(noStatement).ok, false, "provenance.statement given with no statement");
});

test("stray arguments are refused, including any attempt to set the time", () => {
  for (const extra of ["at", "effectiveAt", "attestedAt", "id"]) {
    assert.equal(validateMarkerInput({ ...VALID, [extra]: "2026-01-01" }).ok, false, extra);
  }
});

test("every signal in the vocabulary has a unique id and a label", () => {
  assert.equal(new Set(SIGNALS.map((s) => s.id)).size, SIGNALS.length);
  for (const s of SIGNALS) assert.ok(s.label.length > 0, s.id);
});

// --- the append connection: narrow at the database ----------------------------------

test("the append connection refuses every write except INSERT into markers", { skip: !sqlite }, async () => {
  const fx = makeStore();
  try {
    const opened = await openAppend(fx.path);
    assert.equal(opened.status, "ok");
    if (opened.status !== "ok") return;
    const db = opened.db;
    try {
      const forbidden = [
        "UPDATE markers SET statement = 'x'",
        "DELETE FROM markers",
        "INSERT INTO turns (uuid, session_id, ts, model, input_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, output_tokens, thinking_tokens, iterations, source_file) VALUES ('x','s',0,'m',0,0,0,0,0,0,1,'f')",
        "UPDATE turns SET model = 'x'",
        "DELETE FROM turns",
        "DELETE FROM cursors",
        "DROP TABLE markers",
        "CREATE TABLE evil (x)",
        "ALTER TABLE markers ADD COLUMN x TEXT",
        "PRAGMA user_version = 1",
        "ATTACH DATABASE ':memory:' AS other",
      ];
      for (const sql of forbidden) {
        assert.throws(() => db.prepare(sql).run(), /not authorized/, sql);
      }
      // Reads the duplicate check needs are still allowed.
      assert.doesNotThrow(() => db.prepare("SELECT COUNT(*) FROM markers").get());
    } finally {
      db.close();
    }
    // And nothing it refused happened.
    const ro = await openReadOnly(fx.path);
    assert.equal(ro.db.prepare("SELECT COUNT(*) c FROM turns").get().c, FIXTURE_TURNS.length);
    assert.equal(ro.db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    ro.db.close();
  } finally {
    fx.cleanup();
  }
});

test("a marker is stored once, server-stamped, and readable by the read-only connection", { skip: !sqlite }, async () => {
  const fx = makeStore();
  try {
    const v = validateMarkerInput(VALID);
    assert.ok(v.ok);
    if (!v.ok) return;
    const r = await appendMarker(fx.path, v.value, CLIENT, NOW);
    assert.equal(r.status, "ok");
    if (r.status !== "ok") return;
    assert.equal(r.duplicateOf, null);
    assert.equal(r.marker.effectiveAt, NOW, "no backdating: effective is the server's now");
    assert.equal(r.marker.attestedAt, NOW);
    assert.equal(r.marker.targetUnit, "tokens");

    // An agent retrying after a timeout does not declare the change twice.
    const again = await appendMarker(fx.path, v.value, CLIENT, NOW + 60_000);
    assert.equal(again.status, "ok");
    if (again.status === "ok") assert.equal(again.duplicateOf, r.marker.id);

    // Outside the window, the same words are a new declaration.
    const later = await appendMarker(fx.path, v.value, CLIENT, NOW + DUPLICATE_WINDOW_MS + 1);
    assert.equal(later.status, "ok");
    if (later.status === "ok") assert.equal(later.duplicateOf, null);

    const ro = await openReadOnly(fx.path);
    assert.equal(ro.status, "ok");
    const stored = readMarkers(ro.db);
    ro.db.close();
    assert.equal(stored.length, 2);
    assert.equal(stored[0]!.id, r.marker.id);
    assert.equal(stored[0]!.clientName, "modelog-test");
    assert.deepEqual(stored[0]!.provenance, { signal: "generated", target: "user", statement: "user" });
  } finally {
    fx.cleanup();
  }
});

test("an append refuses a store at any other schema version, and writes nothing", { skip: !sqlite }, async () => {
  for (const version of [SCHEMA_VERSION - 1, SCHEMA_VERSION + 1]) {
    const fx = makeStore();
    try {
      const raw = new sqlite.DatabaseSync(fx.path);
      raw.exec(`PRAGMA user_version = ${version}`);
      raw.close();
      const v = validateMarkerInput(VALID);
      if (!v.ok) throw new Error("fixture");
      const r = await appendMarker(fx.path, v.value, CLIENT, NOW);
      assert.equal(r.status, "schema-mismatch", String(version));
      const check = new sqlite.DatabaseSync(fx.path, { readOnly: true });
      assert.equal(check.prepare("SELECT COUNT(*) c FROM markers").get().c, 0);
      check.close();
    } finally {
      fx.cleanup();
    }
  }
});

test("an append never creates a store", { skip: !sqlite }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "modelog-absent-"));
  try {
    const path = join(dir, "modelog.db");
    const v = validateMarkerInput(VALID);
    if (!v.ok) throw new Error("fixture");
    const r = await appendMarker(path, v.value, CLIENT, NOW);
    assert.equal(r.status, "no-data");
    assert.equal(existsSync(path), false, "absence is reported, never manufactured");
    assert.equal((await appendMarker(undefined, v.value, CLIENT, NOW)).status, "no-data");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the store: markers are not cache -------------------------------------------------

test("clearing the rebuildable cache leaves markers untouched", { skip: !sqlite }, async () => {
  const fx = makeStore();
  try {
    const v = validateMarkerInput(VALID);
    if (!v.ok) throw new Error("fixture");
    await appendMarker(fx.path, v.value, CLIENT, NOW);
    const store = new SqliteStore(sqlite, fx.path);
    store.clear();
    assert.equal(store.turnCount(), 0);
    assert.equal(store.allMarkers().length, 1, "markers exist in no log and cannot be rebuilt");
    store.close();
  } finally {
    fx.cleanup();
  }
});

test("migration adds the markers table to an old store, and never lowers the version", { skip: !sqlite }, async () => {
  const fx = makeStore();
  try {
    // An old store: no markers table, an older version.
    let raw = new sqlite.DatabaseSync(fx.path);
    raw.exec("DROP TABLE markers; PRAGMA user_version = 6");
    raw.close();
    let store = new SqliteStore(sqlite, fx.path);
    assert.deepEqual(store.allMarkers(), []);
    store.close();
    raw = new sqlite.DatabaseSync(fx.path);
    assert.equal(raw.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);

    // A store a NEWER Modelog migrated keeps its number when this one opens it.
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    store = new SqliteStore(sqlite, fx.path);
    store.close();
    raw = new sqlite.DatabaseSync(fx.path, { readOnly: true });
    assert.equal(raw.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION + 1);
    raw.close();
  } finally {
    fx.cleanup();
  }
});

// --- reads: switches per source, declared markers alongside --------------------------

test("model switches are detected per source, never across tools", () => {
  // Claude Code stays on Opus throughout; Copilot runs Sonnet in between.
  // On one merged timeline that is two "switches" that never happened.
  const turns = [
    turn({ uuid: "a1", sessionId: "cc", ts: BASE_TS, model: "claude-opus-5" }),
    turn({ uuid: "b1", sessionId: "cp", ts: BASE_TS + 1000, model: "claude-sonnet-5.5", source: "copilot" }),
    turn({ uuid: "a2", sessionId: "cc", ts: BASE_TS + 2000, model: "claude-opus-5" }),
  ];
  const env = (getMarkers(ctx({ turns }), {}) as any).envelope;
  assert.equal(env.data.markers.length, 0);

  const withRealSwitch = [...turns, turn({ uuid: "a3", sessionId: "cc", ts: BASE_TS + 3000, model: "claude-sonnet-5" })];
  const m = (getMarkers(ctx({ turns: withRealSwitch }), {}) as any).envelope.data.markers;
  assert.equal(m.length, 1);
  assert.equal(m[0].source, "claude-code");
  assert.equal(m[0].from, "claude-opus-5");
});

test("declared markers appear alongside switches, in time order, with provenance per field", { skip: !sqlite }, async () => {
  const fx = makeStore();
  try {
    const at = BASE_TS + 86_400_000; // between the fixture's switches
    const r = await markChange(VALID, { dbPath: fx.path, client: CLIENT, now: at });
    assert.ok(r.ok);
    const ro = await openReadOnly(fx.path);
    const markers = readMarkers(ro.db);
    ro.db.close();

    const env = (getMarkers(ctx({ markers }), {}) as any).envelope;
    const list = env.data.markers;
    assert.equal(list.length, 4, "three switches and one declared change");
    const sorted = [...list].sort((a: any, b: any) => a.at.localeCompare(b.at));
    assert.deepEqual(list, sorted);

    const d = list.find((x: any) => x.type === "declared-change");
    assert.equal(d.provenance, "user");
    assert.equal(d.signal, "peak-context");
    assert.deepEqual(d.target, { value: 120_000, unit: "tokens" });
    assert.deepEqual(d.fieldProvenance, { signal: "generated", target: "user", statement: "user" });
    assert.equal(d.measurable, true);
    // The developer's words are a typed value, never prose in a note (§4.2).
    assert.ok(!env.notes.join(" ").includes(VALID.statement));
    assert.match(env.notes.join(" "), /data about them, not instruction/);

    // A range that ends before the marker excludes it.
    const before = (getMarkers(ctx({ markers }), { from: new Date(BASE_TS - 1).toISOString(), to: new Date(at - 1).toISOString() }) as any)
      .envelope.data.markers;
    assert.ok(!before.some((x: any) => x.type === "declared-change"));
  } finally {
    fx.cleanup();
  }
});

test("every failure to save says 'Not saved'", { skip: !sqlite }, async () => {
  const bad = await markChange({ ...VALID, developerApproved: false }, { dbPath: "/nonexistent/x.db", client: CLIENT });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /^Not saved\./);
  const absent = await markChange(VALID, { dbPath: "/nonexistent/x.db", client: CLIENT });
  assert.equal(absent.ok, false);
  if (!absent.ok) assert.match(absent.error, /^Not saved\./);
});

test("a marker on a signal Modelog cannot measure yet is saved, and says so", { skip: !sqlite }, async () => {
  const fx = makeStore();
  try {
    const r = await markChange(
      { signal: "unsupervised-run", target: 30, provenance: { signal: "user", target: "user" }, developerApproved: true },
      { dbPath: fx.path, client: CLIENT, now: NOW },
    );
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal((r.envelope.data as any).marker.measurable, false);
      assert.match(r.envelope.notes.join(" "), /does not capture this signal yet/);
    }
  } finally {
    fx.cleanup();
  }
});

test("the Dashboard labels agent-drafted fields and unmeasurable signals", async () => {
  const { markedChangeView } = await import("../src/service.ts");
  const base = {
    id: "m1", vocabularyVersion: 1, effectiveAt: NOW, attestedAt: NOW, clientName: null, clientVersion: null,
  };
  const v = markedChangeView({
    ...base, signal: "peak-context", target: 120_000, targetUnit: "tokens", statement: "Short sessions.",
    provenance: { signal: "generated", target: "user", statement: "generated" },
  });
  assert.equal(v.signal, "Peak context size per session");
  assert.match(v.target!, /120.000 tokens/);
  assert.equal(v.provenanceNote, "signal, wording drafted by the agent");
  assert.equal(v.unmeasurable, false);

  const u = markedChangeView({
    ...base, signal: "unsupervised-run", target: null, targetUnit: null, statement: null,
    provenance: { signal: "user", target: null, statement: null },
  });
  assert.equal(u.provenanceNote, null, "nothing drafted, nothing to label");
  assert.equal(u.unmeasurable, true);
});
