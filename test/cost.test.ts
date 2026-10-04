import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildRateTable, turnCostMicro, formatMicroUsd, type PricingFile } from "../src/metrics/cost.ts";
import type { Turn } from "../src/ingest/types.ts";

const pricing: PricingFile = JSON.parse(readFileSync("data/pricing.json", "utf8"));
const table = buildRateTable(pricing);

function turn(p: Partial<Turn>): Turn {
  return {
    uuid: "u", sessionId: "s", ts: 0, model: "claude-sonnet-5",
    inputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0, outputTokens: 0, thinkingTokens: 0,
    iterations: 1, entrypoint: "claude-vscode", isSidechain: false, captureVersion: 2,
    speed: null, inferenceGeo: null,
    cwd: null, gitBranch: null, sourceFile: "f",
    ...p,
  };
}

test("rates are integers in micro-dollars per 1M tokens", () => {
  const s5 = table.rates.get("claude-sonnet-5")!;
  assert.equal(s5.input, 2_000_000);        // $2.00
  assert.equal(s5.output, 10_000_000);      // $10.00
  assert.equal(s5.cacheRead, 200_000);      // 0.1x
  assert.equal(s5.cacheWrite5m, 2_500_000); // 1.25x
  assert.equal(s5.cacheWrite1h, 4_000_000); // 2.0x
  for (const r of Object.values(s5)) assert.ok(Number.isInteger(r), `${r} not an integer`);
});

test("every model's derived rates are integers (no float artifacts)", () => {
  for (const [model, r] of table.rates) {
    for (const [k, v] of Object.entries(r)) {
      assert.ok(Number.isInteger(v), `${model}.${k} = ${v} is not an integer`);
    }
  }
  // The float trap this guards: 3.0 * 0.1 === 0.30000000000000004
  assert.equal(table.rates.get("claude-sonnet-4-6")!.cacheRead, 300_000);
});

test("1M output tokens on sonnet-5 costs exactly $10", () => {
  const c = turnCostMicro(turn({ outputTokens: 1_000_000 }), table)!;
  assert.equal(c, 10_000_000);
  assert.equal(formatMicroUsd(c), "$10.00");
});

test("cache reads are priced at one tenth of fresh input", () => {
  const fresh = turnCostMicro(turn({ inputTokens: 1_000_000 }), table)!;
  const cached = turnCostMicro(turn({ cacheReadTokens: 1_000_000 }), table)!;
  assert.equal(fresh, 2_000_000);
  assert.equal(cached, 200_000);
  assert.equal(fresh, cached * 10);
});

test("1h cache writes cost more than 5m writes", () => {
  const w5 = turnCostMicro(turn({ cacheWrite5mTokens: 1_000_000 }), table)!;
  const w1 = turnCostMicro(turn({ cacheWrite1hTokens: 1_000_000 }), table)!;
  assert.equal(w5, 2_500_000);
  assert.equal(w1, 4_000_000);
});

test("thinking tokens are not double-counted", () => {
  const without = turnCostMicro(turn({ outputTokens: 1000, thinkingTokens: 0 }), table)!;
  const with_ = turnCostMicro(turn({ outputTokens: 1000, thinkingTokens: 800 }), table)!;
  assert.equal(without, with_);
});

test("dated snapshot ids resolve to the bare model's rates", () => {
  const dated = turn({ model: "claude-haiku-4-5-20251001", outputTokens: 1_000_000 });
  const bare = turn({ model: "claude-haiku-4-5", outputTokens: 1_000_000 });
  assert.equal(turnCostMicro(dated, table), turnCostMicro(bare, table));
  assert.equal(turnCostMicro(dated, table), 5_000_000);
});

test("a date-like suffix on an unknown family still yields null", () => {
  assert.equal(turnCostMicro(turn({ model: "not-a-model-20251001", outputTokens: 1e6 }), table), null);
});

test("unknown model yields null, never a default rate", () => {
  assert.equal(turnCostMicro(turn({ model: "some-future-model", outputTokens: 1e6 }), table), null);
});

test("a realistic cache-heavy turn prices correctly", () => {
  // Shape taken from a real record: tiny fresh input, large cache read.
  const c = turnCostMicro(
    turn({
      model: "claude-sonnet-5",
      inputTokens: 2,
      cacheReadTokens: 28_167,
      cacheWrite1hTokens: 21_726,
      outputTokens: 352,
    }),
    table,
  )!;
  // Micro-dollars per token: input 2, cacheRead 0.2, write1h 4, output 10.
  //   2*2 + 28167*0.2 + 21726*4 + 352*10 = 96061.4  ->  rounds to 96061.
  // The .4 is why this is integer arithmetic: the float expression below is
  // NOT an acceptable expected value, and asserting it fails.
  assert.equal(c, 96_061);
  assert.ok(Number.isInteger(c), "cost must always be an integer");
});

test("naive input-only pricing would be catastrophically wrong", () => {
  // Guards PRD §7.3: 95% of input-side tokens are cache reads.
  const t = turn({ inputTokens: 1_179, cacheReadTokens: 56_460_502 });
  const correct = turnCostMicro(t, table)!;
  const naive = t.inputTokens * table.rates.get(t.model)!.input / 1_000_000;
  assert.ok(correct > naive * 1000, "cache-aware cost must dominate naive input-only cost");
});

// --- daily series ---------------------------------------------------------

import { dailySeries, dayKey } from "../src/metrics/aggregate.ts";

test("daily series buckets by local day and fills gaps with null", () => {
  const day = (d: number, h = 12) => new Date(2026, 8, d, h).getTime();
  const ts = [
    turn({ uuid: "a", ts: day(1), model: "claude-sonnet-5", outputTokens: 1_000_000 }),
    turn({ uuid: "b", ts: day(1, 18), model: "claude-sonnet-5", outputTokens: 1_000_000 }),
    // nothing on the 2nd
    turn({ uuid: "c", ts: day(3), model: "claude-sonnet-5", outputTokens: 2_000_000 }),
  ];
  const { days, series } = dailySeries(ts, table);
  assert.deepEqual(days, ["2026-09-01", "2026-09-02", "2026-09-03"]);
  assert.equal(series.length, 1);
  // two turns at $10 each -> $10 per turn
  assert.deepEqual(series[0]!.values, [10_000_000, null, 20_000_000]);
  assert.deepEqual(series[0]!.turns, [2, 0, 1]);
});

test("a day with no turns for a model is null, never zero", () => {
  const day = (d: number) => new Date(2026, 8, d, 12).getTime();
  const ts = [
    turn({ uuid: "a", ts: day(1), model: "claude-sonnet-5", outputTokens: 1_000_000 }),
    turn({ uuid: "b", ts: day(2), model: "claude-opus-5", outputTokens: 1_000_000 }),
  ];
  const { series } = dailySeries(ts, table);
  const sonnet = series.find((s) => s.model === "claude-sonnet-5")!;
  assert.equal(sonnet.values[1], null, "unused model must be null, not 0");
});

test("unpriced turns are excluded from cost series rather than counted as zero", () => {
  const day = new Date(2026, 8, 1, 12).getTime();
  const ts = [
    turn({ uuid: "a", ts: day, model: "claude-sonnet-5", outputTokens: 1_000_000 }),
    turn({ uuid: "b", ts: day, model: "totally-unknown-model", outputTokens: 1_000_000 }),
  ];
  const { series } = dailySeries(ts, table);
  assert.equal(series.find((s) => s.model === "totally-unknown-model")!.values[0], null);
  assert.equal(series.find((s) => s.model === "claude-sonnet-5")!.values[0], 10_000_000);
});

// --- model switches -------------------------------------------------------

import { developerModelSwitches, modelSwitches } from "../src/metrics/aggregate.ts";

test("a subagent dispatch is not a model switch the developer made", () => {
  // Each isolated subagent turn otherwise manufactures TWO switches — one in,
  // one back out — neither of which the developer chose. Both the dashboard
  // and the MCP markers tool read this function, so the semantics live here.
  const ts = [
    turn({ uuid: "a", ts: 1000, model: "claude-opus-5" }),
    turn({ uuid: "b", ts: 2000, model: "claude-haiku-4-5", isSidechain: true }),
    turn({ uuid: "c", ts: 3000, model: "claude-opus-5" }),
  ];
  assert.equal(modelSwitches(ts).length, 2, "the raw primitive sees both transitions");
  assert.equal(developerModelSwitches(ts).length, 0, "the developer switched nothing");
});

test("a real switch still registers once subagent turns are removed", () => {
  const ts = [
    turn({ uuid: "a", ts: 1000, model: "claude-sonnet-5" }),
    turn({ uuid: "b", ts: 2000, model: "claude-haiku-4-5", isSidechain: true }),
    turn({ uuid: "c", ts: 3000, model: "claude-opus-5" }),
  ];
  const sw = developerModelSwitches(ts);
  assert.equal(sw.length, 1);
  assert.equal(sw[0]!.from, "claude-sonnet-5");
  assert.equal(sw[0]!.to, "claude-opus-5", "the subagent must not break the pairing");
});

test("dayKey uses local time, not UTC", () => {
  const local = new Date(2026, 0, 15, 23, 30);
  assert.equal(dayKey(local.getTime()), "2026-01-15");
});

test("fast mode doubles the rate rather than being silently ignored", () => {
  const base = turn({ model: "claude-opus-5", inputTokens: 1_000_000, speed: "standard" });
  const fast = turn({ model: "claude-opus-5", inputTokens: 1_000_000, speed: "fast" });
  const b = turnCostMicro(base, table)!;
  const f = turnCostMicro(fast, table)!;
  assert.equal(b, 5_000_000); // $5.00 per 1M input
  assert.equal(f, 10_000_000); // published fast-mode rate is $10.00
  assert.equal(f, b * 2);
});

test("an unrecognised modifier value yields null, never a neutral ratio", () => {
  // The failure this guards: a known model, a rate we cannot justify. Pricing
  // it at standard rates would report a confidently wrong number.
  const t = turn({ model: "claude-opus-5", inputTokens: 1_000_000, speed: "turbo" });
  assert.equal(turnCostMicro(t, table), null);
  const g = turn({ model: "claude-opus-5", inputTokens: 1_000_000, inferenceGeo: "mars" });
  assert.equal(turnCostMicro(g, table), null);
});

test("a modifier the source never recorded is absent, not unknown", () => {
  // Records predating `speed` carry no such field; they must still price.
  const t = turn({ model: "claude-opus-5", inputTokens: 1_000_000, speed: null });
  assert.equal(turnCostMicro(t, table), 5_000_000);
});

test("inference_geo us applies 1.1x to every token class", () => {
  const std = turn({
    model: "claude-sonnet-5", inputTokens: 1_000_000, outputTokens: 1_000_000,
    inferenceGeo: "global",
  });
  const us = turn({
    model: "claude-sonnet-5", inputTokens: 1_000_000, outputTokens: 1_000_000,
    inferenceGeo: "us",
  });
  assert.equal(turnCostMicro(std, table), 12_000_000); // $2 + $10
  assert.equal(turnCostMicro(us, table), 13_200_000); // 1.1x
});

test("modifiers stack multiplicatively, as the rate card specifies", () => {
  const t = turn({
    model: "claude-opus-5", inputTokens: 1_000_000, speed: "fast", inferenceGeo: "us",
  });
  // $5 base -> x2 fast -> x1.1 geo = $11.00
  assert.equal(turnCostMicro(t, table), 11_000_000);
});

test("cache-read is per-model where the card sets it per-model", () => {
  const o55 = table.rates.get("claude-opus-5-5")!;
  const o5 = table.rates.get("claude-opus-5")!;
  const f51 = table.rates.get("claude-fable-5-1")!;
  assert.equal(o5.cacheRead, 500_000); // 0.1x of $5.00
  assert.equal(o55.cacheRead, 200_000); // 0.05x of $4.00
  assert.equal(f51.cacheRead, 250_000); // 0.025x of $10.00
  for (const r of [o5, o55, f51]) {
    for (const v of Object.values(r)) assert.ok(Number.isInteger(v), `${v} not an integer`);
  }
});
