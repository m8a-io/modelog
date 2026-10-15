import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { turn, BASE_TS } from "./fixture.ts";
import { delegationSplit, dailySeries } from "../src/metrics/aggregate.ts";
import { buildRateTable, type PricingFile } from "../src/metrics/cost.ts";

/**
 * The delegation split (PRD §11 Q23): main-thread and sub-agent turns are two
 * populations, and blending them is how a dashboard misleads — dozens of
 * cheap sub-agent calls drag an average down without the developer's own
 * turns getting any cheaper. These pin the segmentation rules, including the
 * one that cannot be seen in fresh data: a pre-capture turn's stored `false`
 * is a column default, not an observation, and belongs to neither bucket.
 */

const pricing: PricingFile = JSON.parse(
  readFileSync(join(process.cwd(), "data", "pricing.json"), "utf8"),
);
const table = buildRateTable(pricing);

const MIN = 60_000;

test("each population gets its own denominator, so neither dilutes the other", () => {
  const split = delegationSplit(
    [
      turn({ uuid: "m1", ts: BASE_TS }),
      turn({ uuid: "m2", ts: BASE_TS + MIN }),
      turn({ uuid: "s1", ts: BASE_TS + 2 * MIN, model: "claude-haiku-4-5", isSidechain: true }),
      turn({ uuid: "s2", ts: BASE_TS + 3 * MIN, model: "claude-haiku-4-5", isSidechain: true }),
    ],
    table,
  );

  assert.equal(split.main.turns, 2);
  assert.equal(split.sub.turns, 2);
  assert.equal(split.unknownTurns, 0);
  assert.ok(split.main.costPerTurn! > 0);
  assert.ok(split.sub.costPerTurn! > 0);
  // Identical usage on a cheaper model: the sub-agent population must come
  // out cheaper per turn, with no averaging across the boundary.
  assert.ok(split.sub.costPerTurn! < split.main.costPerTurn!);
  assert.equal(split.unit, "usd_micro");
});

test("sub-agent cost is counted, never dropped — real calls, real money", () => {
  const split = delegationSplit(
    [turn({ uuid: "m1" }), turn({ uuid: "s1", isSidechain: true })],
    table,
  );
  assert.ok(split.sub.totalCost > 0);
});

test("a pre-capture turn is unknown, not main-thread: its stored false is a default", () => {
  const split = delegationSplit(
    [
      turn({ uuid: "m1" }),
      // captureVersion 1 predates isSidechain capture; the false is unreadable.
      turn({ uuid: "u1", captureVersion: 1, isSidechain: false }),
    ],
    table,
  );
  assert.equal(split.main.turns, 1);
  assert.equal(split.sub.turns, 0);
  assert.equal(split.unknownTurns, 1);
});

test("a pre-capture TRUE is believed: Modelog cannot invent a sidechain flag", () => {
  const split = delegationSplit(
    [turn({ uuid: "s1", captureVersion: 1, isSidechain: true })],
    table,
  );
  assert.equal(split.sub.turns, 1);
  assert.equal(split.unknownTurns, 0);
});

test("unpriced turns count toward volume but never toward the cost average", () => {
  const split = delegationSplit(
    [
      turn({ uuid: "s1", isSidechain: true }),
      turn({ uuid: "s2", isSidechain: true, model: "claude-nonexistent-9" }),
    ],
    table,
  );
  assert.equal(split.sub.turns, 2);
  assert.equal(split.sub.unpricedTurns, 1);
  // The average is over the one priced turn — the unpriced one cannot drag it.
  assert.equal(split.sub.costPerTurn, split.sub.totalCost);
});

test("a population with no priced turns reports cost-per-turn as unavailable, not zero", () => {
  const split = delegationSplit(
    [turn({ uuid: "s1", isSidechain: true, model: "claude-nonexistent-9" })],
    table,
  );
  assert.equal(split.sub.costPerTurn, null);
  assert.equal(split.sub.totalCost, 0);
});

test("a mixed-source set is refused, same as every other money aggregate", () => {
  assert.throws(
    () =>
      delegationSplit(
        [turn({ uuid: "a" }), turn({ uuid: "b", source: "copilot", costNanoAiu: 5 })],
        table,
      ),
    /partitionBySource/,
  );
});

test("dailySeries keyed by population buckets days exactly like the model default", () => {
  const DAY = 86_400_000;
  const { days, series } = dailySeries(
    [
      turn({ uuid: "m1", ts: BASE_TS }),
      turn({ uuid: "s1", ts: BASE_TS, isSidechain: true }),
      turn({ uuid: "m2", ts: BASE_TS + DAY }),
    ],
    table,
    (t) => (t.isSidechain ? "Sub-agents" : "Main thread"),
  );

  assert.equal(days.length, 2);
  const main = series.find((s) => s.model === "Main thread")!;
  const sub = series.find((s) => s.model === "Sub-agents")!;
  assert.deepEqual(main.turns, [1, 1]);
  assert.deepEqual(sub.turns, [1, 0]);
  // Null, not zero, on the day sub-agents were unused: absent, not free.
  assert.equal(sub.values[1], null);
});
