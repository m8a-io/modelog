import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEnvelope,
  parseRange,
  staleRateTableNote,
  toMoney,
  toMoneyOrNull,
} from "../src/mcp/envelope.ts";

// --- toMoney / toMoneyOrNull ----------------------------------------------

test("toMoney is an integer plus an explicit unit, never a bare number", () => {
  const m = toMoney(10_000_000);
  assert.equal(m.amount, 10_000_000);
  assert.equal(m.unit, "usd_micro");
  assert.equal(m.formatted, "$10.00");
});

test("toMoneyOrNull preserves null rather than reporting $0", () => {
  assert.equal(toMoneyOrNull(null), null);
  assert.deepEqual(toMoneyOrNull(0), { amount: 0, unit: "usd_micro", formatted: "$0.00" });
});

// --- buildEnvelope ---------------------------------------------------------

const RANGE = { from: Date.parse("2026-01-01T00:00:00.000Z"), to: Date.parse("2026-01-31T00:00:00.000Z") };

test("an ok store returns the data it was given", () => {
  const env = buildEnvelope({ status: "ok", note: null }, RANGE, { turns: 5 }, []);
  assert.equal(env.status, "ok");
  assert.deepEqual(env.data, { turns: 5 });
  assert.deepEqual(env.notes, []);
  assert.deepEqual(env.range, { from: "2026-01-01T00:00:00.000Z", to: "2026-01-31T00:00:00.000Z" });
});

test("a no-data store forces data to null even if the handler computed zeros", () => {
  const env = buildEnvelope({ status: "no-data", note: "no store found" }, RANGE, { turns: 0 }, []);
  assert.equal(env.status, "no-data");
  assert.equal(env.data, null, "no-data must never surface as a zero reading");
  assert.deepEqual(env.notes, ["no store found"]);
});

test("a schema-mismatch store also forces data to null", () => {
  const env = buildEnvelope({ status: "schema-mismatch", note: "version mismatch" }, RANGE, { turns: 99 }, []);
  assert.equal(env.data, null);
  assert.deepEqual(env.notes, ["version mismatch"]);
});

test("the store's note is prepended ahead of handler-supplied notes", () => {
  const env = buildEnvelope({ status: "no-data", note: "store note" }, RANGE, null, ["handler note"]);
  assert.deepEqual(env.notes, ["store note", "handler note"]);
});

test("an ok store with no store-level note surfaces only handler notes", () => {
  const env = buildEnvelope({ status: "ok", note: null }, RANGE, { turns: 1 }, ["handler note"]);
  assert.deepEqual(env.notes, ["handler note"]);
});

// --- parseRange -------------------------------------------------------------

const NOW = Date.parse("2026-06-15T12:00:00.000Z");

test("no arguments means the last 30 days", () => {
  const r = parseRange({}, NOW);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.to, NOW);
  assert.equal(r.from, NOW - 30 * 86_400_000);
});

test("days is relative to now", () => {
  const r = parseRange({ days: 7 }, NOW);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.to, NOW);
  assert.equal(r.from, NOW - 7 * 86_400_000);
});

test("days together with from/to is rejected rather than one silently winning", () => {
  const r = parseRange({ days: 7, from: "2026-01-01" }, NOW);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /not both/);
});

test("a non-positive or non-integer days is rejected", () => {
  assert.equal(parseRange({ days: 0 }, NOW).ok, false);
  assert.equal(parseRange({ days: -3 }, NOW).ok, false);
  assert.equal(parseRange({ days: 1.5 }, NOW).ok, false);
});

test("explicit from and to are parsed as ISO-8601", () => {
  const r = parseRange({ from: "2026-01-01T00:00:00Z", to: "2026-01-31T00:00:00Z" }, NOW);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.from, Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(r.to, Date.parse("2026-01-31T00:00:00Z"));
});

test("to alone defaults to now, not an open-ended range", () => {
  const r = parseRange({ to: "2026-01-31T00:00:00Z" }, NOW);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.to, Date.parse("2026-01-31T00:00:00Z"));
  assert.equal(r.from, Date.parse("2026-01-31T00:00:00Z") - 30 * 86_400_000);
});

test("from alone defaults to to the moment", () => {
  const r = parseRange({ from: "2026-06-01T00:00:00Z" }, NOW);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.from, Date.parse("2026-06-01T00:00:00Z"));
  assert.equal(r.to, NOW);
});

test("an unparseable date is rejected by name", () => {
  const badFrom = parseRange({ from: "not-a-date" }, NOW);
  assert.equal(badFrom.ok, false);
  if (!badFrom.ok) assert.match(badFrom.error, /"from"/);

  const badTo = parseRange({ to: "not-a-date" }, NOW);
  assert.equal(badTo.ok, false);
  if (!badTo.ok) assert.match(badTo.error, /"to"/);
});

test("from after to is rejected", () => {
  const r = parseRange({ from: "2026-02-01T00:00:00Z", to: "2026-01-01T00:00:00Z" }, NOW);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /after/);
});

// --- staleRateTableNote ------------------------------------------------------

test("a recent rate table carries no staleness note", () => {
  const now = Date.parse("2026-06-15T00:00:00Z");
  const recent = new Date(now - 10 * 86_400_000).toISOString();
  assert.equal(staleRateTableNote(recent, now), null);
});

test("a rate table older than 90 days is flagged, with the date named", () => {
  const now = Date.parse("2026-06-15T00:00:00Z");
  const stale = "2026-01-01";
  const note = staleRateTableNote(stale, now);
  assert.ok(note);
  assert.match(note!, /2026-01-01/);
});
