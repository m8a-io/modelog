import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDefinitions,
  definitionsNotes,
  storeExtent,
  DEFINITIONS_DESCRIPTION,
  type DefinitionsInput,
} from "../src/mcp/definitions.ts";
import { PRICING, RATE_TABLE } from "../src/mcp/rates.ts";
import { buildEnvelope } from "../src/mcp/envelope.ts";
import { openReadOnly, readTurns } from "../src/mcp/readOnlyStore.ts";
import { SCHEMA_VERSION } from "../src/store/store.ts";
import type { BillingInfo } from "../src/ingest/billing.ts";
import type { Turn } from "../src/ingest/types.ts";
import { FIXTURE_TURNS, makeStore, makeEmptyStore, sqlite, BASE_TS } from "./fixture.ts";

const API_BILLING: BillingInfo = { mode: "api", detected: true, rawType: "prepaid" };
const SUB_BILLING: BillingInfo = { mode: "subscription", detected: false, rawType: null };

/** Fixed clock, so the staleness note is a decision and not a function of today. */
const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const FRESH_DATE = "2026-09-27";
const STALE_DATE = "2026-01-01";

function defs(turns: readonly Turn[] = FIXTURE_TURNS, over: Partial<DefinitionsInput> = {}) {
  return buildDefinitions({
    turns,
    pricing: PRICING,
    table: RATE_TABLE,
    billing: API_BILLING,
    billingFromEnv: false,
    schemaVersion: SCHEMA_VERSION,
    ...over,
  });
}

// --- the compiled-in rate table ---------------------------------------------

test("the rate table is compiled into the server, not read from disk", () => {
  // The MCP server has no access to the extension's install directory, so the
  // table must arrive with the bundle. If this import ever starts resolving
  // to nothing, every cost the server reports would silently become null.
  assert.ok(RATE_TABLE.rates.size > 0, "rate table must not be empty");
  assert.match(PRICING.effective_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(RATE_TABLE.rates.get("claude-sonnet-5"), "a known model must resolve");
});

// --- the semantics that field names do not convey ---------------------------

test("a turn is stated not to be an inference call, naming iterations", () => {
  const d = defs();
  assert.match(d.turn.notAnInferenceCall, /iterations/);
  assert.match(d.turn.notAnInferenceCall, /not necessarily a single inference call/);
});

test("synthetic records are stated to be excluded", () => {
  assert.match(defs().turn.excludedRecords, /<synthetic>/);
});

test("sidechain turns are explained AND stated to be included in the figures", () => {
  // The regression this guards: an agent blending subagent traffic into a
  // per-model comparison without remark. If this wording is ever softened,
  // the tool stops preventing the thing it exists to prevent.
  const d = defs();
  assert.match(d.sidechain.definition, /subagent/i);
  assert.match(d.sidechain.treatment, /included/);
  assert.match(d.sidechain.treatment, /not separated out/);
});

test("the sidechain breakdown is measured from the store, not asserted", () => {
  const d = defs();
  assert.equal(d.sidechain.observed.turns, 9);
  assert.equal(d.sidechain.observed.sidechainTurns, 2);
  assert.equal(d.sidechain.observed.mainConversationTurns, 7);

  // A store with no subagent traffic must report zero rather than inherit a
  // claim about someone else's data.
  const noSidechain = FIXTURE_TURNS.filter((t) => !t.isSidechain);
  assert.equal(defs(noSidechain).sidechain.observed.sidechainTurns, 0);
});

test("a model used only by subagents is visible as such per model", () => {
  const haiku = defs().models.observed.find((m) => m.model.startsWith("claude-haiku"));
  assert.ok(haiku, "haiku must appear in the observed models");
  assert.equal(haiku!.turns, 2);
  assert.equal(haiku!.sidechainTurns, haiku!.turns, "all haiku traffic here is subagent work");

  const sonnet = defs().models.observed.find((m) => m.model === "claude-sonnet-5")!;
  assert.equal(sonnet.sidechainTurns, 0);
});

// --- cost: the two causes of null -------------------------------------------

test("both causes of an unavailable cost are named", () => {
  const causes = defs().cost.unavailableCost.causes.join(" ");
  assert.match(causes, /unknown model/);
  assert.match(causes, /unknown pricing modifier/);
  assert.match(causes, /speed/);
  assert.match(causes, /inference_geo/);
});

test("an unavailable cost is stated to be neither zero nor a default rate", () => {
  const m = defs().cost.unavailableCost.meaning;
  assert.match(m, /never reported as zero/);
  assert.match(m, /never priced at a default rate/);
});

test("the two causes are counted separately, because they mean different things", () => {
  // One unknown model (claude-nonexistent-9) and one unknown modifier
  // (speed: "turbo" on a model that is otherwise priced).
  const o = defs().cost.unavailableCost.observed;
  assert.equal(o.unknownModelTurns, 1);
  assert.equal(o.unknownModifierTurns, 1);
  assert.equal(o.unpricedTurns, 2);
});

test("a model that resolves to no rate is flagged, not silently listed", () => {
  const models = defs().models.observed;
  assert.equal(models.find((m) => m.model === "claude-nonexistent-9")!.priced, false);
  // A dated snapshot id still prices, via its bare id.
  assert.equal(models.find((m) => m.model.startsWith("claude-haiku"))!.priced, true);
});

// --- cost: method and rates --------------------------------------------------

test("all four token classes plus output are described", () => {
  const classes = defs().cost.tokenClasses.join(" ");
  for (const c of ["input", "cache_read", "cache_write_5m", "cache_write_1h", "output"]) {
    assert.match(classes, new RegExp(c));
  }
});

test("thinking tokens are stated to be inside output tokens already", () => {
  assert.match(defs().cost.thinkingTokens, /inside output tokens/);
});

test("cache multipliers are reported as ratios, matching the rate card", () => {
  const c = defs().cost.cacheMultipliers;
  assert.equal(c.cacheRead, "0.1x");
  assert.equal(c.cacheWrite5m, "1.25x");
  assert.equal(c.cacheWrite1h, "2x");
});

test("per-model cache-read overrides are listed, since the card sets them per model", () => {
  const o = defs().cost.cacheMultipliers.perModelCacheReadOverrides;
  assert.equal(o.find((x) => x.model === "claude-opus-5-5")!.multiplier, "0.05x");
  assert.equal(o.find((x) => x.model === "claude-fable-5-1")!.multiplier, "0.025x");
});

test("modifier values are listed with their multipliers and an unknown-value policy", () => {
  const speed = defs().cost.modifiers.find((m) => m.field === "speed")!;
  assert.equal(speed.recognisedValues.find((v) => v.value === "fast")!.multiplier, "2x");
  assert.equal(speed.recognisedValues.find((v) => v.value === "standard")!.multiplier, "1x");
  assert.match(speed.unrecognisedValuePolicy, /unknown rather than neutral/);
});

// --- the honest disclosure of a known limitation -----------------------------

test("the rate table discloses that it reprices history", () => {
  // PRD §11 Q18 / issue #3. Modelog prices every turn at one snapshot, so an
  // agent must not assume rates-as-of-the-turn. If this disclosure is dropped
  // before the underlying fix lands, the tool starts implying accuracy it
  // does not have.
  const r = defs().cost.rateTable;
  assert.equal(r.effectiveDate, PRICING.effective_date);
  assert.match(r.historicalAccuracy, new RegExp(PRICING.effective_date));
  assert.match(r.historicalAccuracy, /does not\s+currently price a turn at the rate/);
  assert.match(r.historicalAccuracy, /rate change\s+rather than a change in usage/);
});

test("cost is stated to be derived from token counts, not read from an invoice", () => {
  assert.match(defs().cost.method, /cannot see an\s+invoice/);
});

test("a rate table over 90 days old is flagged as a note — MCP.md §9", () => {
  // Routed through the shared 2.1 helper, so the dashboard and the bridge
  // phrase the same staleness identically.
  const stale = definitionsNotes(FIXTURE_TURNS, API_BILLING, STALE_DATE, NOW).join(" ");
  assert.match(stale, /prices may have changed/);
  assert.match(stale, new RegExp(STALE_DATE));

  const fresh = definitionsNotes(FIXTURE_TURNS, API_BILLING, FRESH_DATE, NOW).join(" ");
  assert.doesNotMatch(fresh, /prices may have changed/);
});

// --- billing ------------------------------------------------------------------

test("billing carries the mode, its caveat copy, and where the mode came from", () => {
  const d = defs();
  assert.equal(d.billing.mode, "api");
  assert.equal(d.billing.label, "API credits");
  assert.ok(d.billing.detail.length > 0);
  assert.equal(d.billing.detected, true);
});

test("a detected mode admits the extension's override is invisible to this process", () => {
  // The MCP server cannot read VS Code settings, so it must not present a
  // detected mode as though it were the user's configured one.
  assert.match(defs().billing.source, /separate process/);
});

test("an explicitly configured mode says so instead", () => {
  const d = defs(FIXTURE_TURNS, { billingFromEnv: true });
  assert.match(d.billing.source, /client configuration/);
  assert.doesNotMatch(d.billing.source, /separate process/);
});

test("subscription mode is surfaced as a note, since it makes every figure a shadow price", () => {
  const notes = definitionsNotes(FIXTURE_TURNS, SUB_BILLING, FRESH_DATE, NOW).join(" ");
  assert.match(notes, /shadow price/);

  // API billing must not carry that note — a note that always fires teaches
  // an agent to ignore the array.
  assert.doesNotMatch(definitionsNotes(FIXTURE_TURNS, API_BILLING, FRESH_DATE, NOW).join(" "), /shadow price/);
});

// --- store provenance ---------------------------------------------------------

test("the store is described as a durable superset of the logs", () => {
  const d = defs().store;
  assert.match(d.durability, /durable superset/);
  assert.match(d.durability, /after the log files .* are deleted/);
  // Finding 5: permanent nulls on turns whose source file is gone.
  assert.match(d.durability, /stay null/);
});

test("uncaptured fields are defined, with the filter rule and measured counts", () => {
  const legacy = [...FIXTURE_TURNS, { ...FIXTURE_TURNS[0]!, uuid: "old", captureVersion: 1 }];
  const d = defs(legacy).store.uncaptured;
  assert.match(d.filterRule, /isSidechain: false/);
  assert.match(d.meaning, /priced as unmodified/);
  assert.equal(d.observed.turnsWithAnyUncapturedField, 1);
  assert.equal(d.observed.byField.isSidechain, 1);
  assert.equal(defs().store.uncaptured.observed.turnsWithAnyUncapturedField, 0);

  const withLegacy = definitionsNotes(legacy, API_BILLING, FRESH_DATE, NOW).join(" ");
  assert.match(withLegacy, /1 of 10 stored turns were ingested before some fields/);
  const without = definitionsNotes(FIXTURE_TURNS, API_BILLING, FRESH_DATE, NOW).join(" ");
  assert.doesNotMatch(without, /ingested before some fields/);
});

test("schema version and the data's true span are reported", () => {
  const d = defs().store;
  assert.equal(d.schemaVersion, SCHEMA_VERSION);
  assert.equal(d.turns, 9);
  assert.equal(d.sessions, 3);
  assert.equal(d.firstTurn, new Date(BASE_TS).toISOString());
  assert.equal(d.lastTurn, new Date(BASE_TS + 2 * 86_400_000).toISOString());
});

// --- an empty store is a gap, not a zero --------------------------------------

test("an empty store has no span, and says so with nulls", () => {
  const d = defs([]);
  assert.equal(d.store.turns, 0);
  assert.equal(d.store.firstTurn, null, "no turns means no first turn, not the epoch");
  assert.equal(d.store.lastTurn, null);
  assert.deepEqual(storeExtent([]), { from: null, to: null });
});

test("an empty store is noted as an absence rather than a measurement of zero", () => {
  const notes = definitionsNotes([], API_BILLING, FRESH_DATE, NOW).join(" ");
  assert.match(notes, /absence of data, not a measurement of zero/);
});

test("storeExtent reports the store's own bounds for a populated store", () => {
  assert.deepEqual(storeExtent(FIXTURE_TURNS), {
    from: BASE_TS,
    to: BASE_TS + 2 * 86_400_000,
  });
});

// --- trust model: §4.2 / §4.3 -------------------------------------------------

test("no untrusted string from the environment reaches the definitions output", () => {
  // Branch names, paths and repo names are arbitrary strings flowing to an
  // agent (MCP.md §4.2). This tool returns prose, so the safe rule is that it
  // returns none of them at all.
  const json = JSON.stringify(defs());
  for (const leaked of ["/home/dev/project", "feature/pricing", "/logs/s1.jsonl", "s1", "t1"]) {
    assert.ok(!json.includes(leaked), `definitions must not contain ${leaked}`);
  }
});

test("the tool description states what it is for without taking arguments", () => {
  assert.match(DEFINITIONS_DESCRIPTION, /Takes no arguments/);
  assert.match(DEFINITIONS_DESCRIPTION, /turn is not an inference call/);
  assert.match(DEFINITIONS_DESCRIPTION, /subagent turns are included/);
  assert.match(DEFINITIONS_DESCRIPTION, /gap rather than a zero/);
});

// --- the envelope, over a real store ------------------------------------------

test("definitions over a real read-only store produce an ok envelope", { skip: !sqlite }, async () => {
  const fx = makeStore();
  try {
    const opened = await openReadOnly(fx.path);
    assert.equal(opened.status, "ok");

    const turns = readTurns(opened.db);
    const env = buildEnvelope(
      opened,
      storeExtent(turns),
      defs(turns),
      definitionsNotes(turns, API_BILLING, FRESH_DATE, NOW),
    );
    opened.db.close();

    assert.equal(env.status, "ok");
    assert.equal(env.range.from, new Date(BASE_TS).toISOString());
    assert.ok(env.data, "ok must carry data");
    assert.equal(env.data!.store.turns, 9);
    // The round-trip through SQLite must preserve the sidechain flag, or the
    // most important thing this tool says would quietly become wrong.
    assert.equal(env.data!.sidechain.observed.sidechainTurns, 2);
    assert.match(env.notes.join(" "), /made by subagents/);
  } finally {
    fx.cleanup();
  }
});

test("an empty store still answers ok — readable, matching, and genuinely empty", { skip: !sqlite }, async () => {
  const fx = makeEmptyStore();
  try {
    const opened = await openReadOnly(fx.path);
    // An absent store is no-data; a present, current, empty one is not.
    assert.equal(opened.status, "ok");

    const turns = readTurns(opened.db);
    const env = buildEnvelope(opened, storeExtent(turns), defs(turns), definitionsNotes(turns, API_BILLING, FRESH_DATE, NOW));
    opened.db.close();

    assert.deepEqual(env.range, { from: null, to: null });
    assert.equal(env.data!.store.turns, 0);
    assert.match(env.notes.join(" "), /absence of data/);
  } finally {
    fx.cleanup();
  }
});

test("an absent store yields no-data with no definitions at all", async () => {
  const opened = await openReadOnly("/nonexistent/modelog.db");
  const env = buildEnvelope(opened, { from: null, to: null }, defs([]), []);
  assert.equal(env.status, "no-data");
  assert.equal(env.data, null, "no-data must never surface as an empty-but-present store");
  assert.ok(env.notes.length > 0);
});
