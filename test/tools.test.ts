import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callTool,
  compareModels,
  getMarkers,
  getSummary,
  getDefinitions,
  listSessions,
  vendorOf,
  TOOLS,
  type ToolContext,
} from "../src/mcp/tools.ts";
import { PRICING, RATE_TABLE } from "../src/mcp/rates.ts";
import { openReadOnly, readTurns } from "../src/mcp/readOnlyStore.ts";
import { SCHEMA_VERSION } from "../src/store/store.ts";
import type { BillingInfo } from "../src/ingest/billing.ts";
import type { Turn } from "../src/ingest/types.ts";
import { FIXTURE_TURNS, makeStore, sqlite, BASE_TS, turn } from "./fixture.ts";

const API_BILLING: BillingInfo = { mode: "api", detected: true, rawType: "prepaid" };
const SUB_BILLING: BillingInfo = { mode: "subscription", detected: false, rawType: null };

/** After the fixture's last turn, so a default 30-day range contains it all. */
const NOW = BASE_TS + 5 * 86_400_000;
const DAY_MS = 86_400_000;

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    status: "ok",
    note: null,
    turns: FIXTURE_TURNS,
    pricing: PRICING,
    table: RATE_TABLE,
    billing: API_BILLING,
    billingFromEnv: false,
    schemaVersion: SCHEMA_VERSION,
    now: NOW,
    ...over,
  };
}

function unwrap(r: { ok: boolean }): any {
  assert.ok(r.ok, `expected ok, got error: ${(r as any).error}`);
  return (r as any).envelope;
}

// --- §8.2 get_summary ---------------------------------------------------------

test("summary totals the range, and counts calls apart from turns", () => {
  const env = unwrap(getSummary(ctx(), {}));
  assert.equal(env.data.turns, 9);
  // t3 carries iterations: 3, so calls exceed turns by 2.
  assert.equal(env.data.inferenceCalls, 11);
  assert.equal(env.data.sessions, 3);
  assert.equal(env.data.sidechainTurns, 2);
});

test("summary money is an integer plus a unit, never a bare number", () => {
  const env = unwrap(getSummary(ctx(), {}));
  assert.equal(env.data.totalCost.unit, "usd_micro");
  assert.ok(Number.isInteger(env.data.totalCost.amount));
  assert.match(env.data.totalCost.formatted, /^\$|^<\$/);
  assert.equal(typeof env.data.totalCost.amount, "number");
});

test("cost per turn divides by priced turns only, not by all turns", () => {
  // 2 of 9 turns are unpriced. Dividing by 9 would understate the average.
  const env = unwrap(getSummary(ctx(), {}));
  assert.equal(env.data.unpricedTurns, 2);
  assert.equal(env.data.costPerTurn.amount, Math.round(env.data.totalCost.amount / 7));
});

test("summary names both causes of an unavailable cost", () => {
  const c = unwrap(getSummary(ctx(), {})).data.unpricedCauses;
  assert.equal(c.unknownModelTurns, 1);
  assert.equal(c.unknownModifierTurns, 1);
});

test("a range with no turns reports zeros with null bounds, not an error", () => {
  // An empty range is a real answer: nothing happened then.
  const env = unwrap(getSummary(ctx(), { from: "2020-01-01T00:00:00Z", to: "2020-02-01T00:00:00Z" }));
  assert.equal(env.status, "ok");
  assert.equal(env.data.turns, 0);
  assert.equal(env.data.costPerTurn, null, "no priced turns means no average, not zero");
  assert.equal(env.data.firstTurn, null);
});

test("an invalid range is a caller error, not an empty result", () => {
  const r = getSummary(ctx(), { days: 7, from: "2026-01-01" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /not both/);
});

// --- §8.3 compare_models -------------------------------------------------------

test("models are grouped by vendor, so no cross-vendor ratio can be emitted", () => {
  // PRD invariant 5 made structural: a ratio is only ever taken inside a group.
  const env = unwrap(compareModels(ctx(), {}));
  assert.equal(env.data.vendors.length, 1);
  assert.equal(env.data.vendors[0].vendor, "anthropic");
});

test("the relative multiple is measured against the cheapest model in the group", () => {
  const g = unwrap(compareModels(ctx(), {})).data.vendors[0];
  const cheapest = g.models.find((m: any) => m.model === g.cheapestModel);
  assert.equal(cheapest.relativeToCheapest, 1, "the baseline is 1x itself");

  for (const m of g.models) {
    if (m.relativeToCheapest === null) continue;
    assert.ok(m.relativeToCheapest >= 1, `${m.model} cannot be cheaper than the cheapest`);
  }
});

test("an unpriced model has a null multiple rather than a fabricated one", () => {
  const g = unwrap(compareModels(ctx(), {})).data.vendors[0];
  const unknown = g.models.find((m: any) => m.model === "claude-nonexistent-9");
  assert.equal(unknown.costPerTurn, null);
  assert.equal(unknown.relativeToCheapest, null);
  assert.equal(unknown.priced, false);
});

test("subagent turns are visible per model row", () => {
  const g = unwrap(compareModels(ctx(), {})).data.vendors[0];
  const haiku = g.models.find((m: any) => m.model.startsWith("claude-haiku"));
  assert.equal(haiku.turns, 2);
  assert.equal(haiku.sidechainTurns, 2);
});

test("a second vendor is grouped separately and flagged in the notes", () => {
  const withGpt = [...FIXTURE_TURNS, turn({ uuid: "x1", model: "gpt-5", ts: BASE_TS })];
  const env = unwrap(compareModels(ctx({ turns: withGpt }), {}));
  assert.equal(env.data.vendors.length, 2);
  assert.deepEqual(env.data.vendors.map((v: any) => v.vendor), ["anthropic", "openai"]);
  assert.match(env.notes.join(" "), /no cross-vendor/);
});

test("vendorOf classifies by id prefix and admits when it does not know", () => {
  assert.equal(vendorOf("claude-opus-5"), "anthropic");
  assert.equal(vendorOf("gpt-5"), "openai");
  assert.equal(vendorOf("gemini-3-pro"), "google");
  assert.equal(vendorOf("llama-4"), "unknown");
});

// --- filters -------------------------------------------------------------------

test("isSidechain filters subagent traffic in or out", () => {
  const only = unwrap(compareModels(ctx(), { isSidechain: true })).data.vendors[0];
  assert.equal(only.models.length, 1);
  assert.ok(only.models[0].model.startsWith("claude-haiku"));

  const without = unwrap(compareModels(ctx(), { isSidechain: false })).data.vendors[0];
  assert.ok(!without.models.some((m: any) => m.model.startsWith("claude-haiku")));
});

test("entrypoint filters by surface — Phase 0.2 segmentation, no webview needed", () => {
  const cli = unwrap(listSessions(ctx(), { entrypoint: "claude-cli" }));
  assert.equal(cli.data.sessions.length, 1);
  assert.equal(cli.data.sessions[0].sessionId, "s3");

  const ide = unwrap(listSessions(ctx(), { entrypoint: "claude-vscode" }));
  assert.equal(ide.data.sessions.length, 2);
});

test("a filter is reported by field name, never by its value", () => {
  // §4.2: a branch name is an untrusted string and must not reach prose.
  const env = unwrap(listSessions(ctx(), { branch: "feature/pricing" }));
  const notes = env.notes.join(" ");
  assert.match(notes, /Filtered by branch/);
  assert.ok(!notes.includes("feature/pricing"), "the value must stay out of the note");
});

test("filtered figures are flagged as covering only matching turns", () => {
  const env = unwrap(listSessions(ctx(), { model: "claude-opus-5" }));
  assert.match(env.notes.join(" "), /part of a longer session/);
});

// --- §8.4 list_sessions ---------------------------------------------------------

test("sessions come back most recently active first", () => {
  const s = unwrap(listSessions(ctx(), {})).data.sessions;
  assert.deepEqual(s.map((x: any) => x.sessionId), ["s3", "s2", "s1"]);
});

test("a session reports its span, models and branches as typed fields", () => {
  const s1 = unwrap(listSessions(ctx(), {})).data.sessions.find((x: any) => x.sessionId === "s1");
  assert.equal(s1.firstTurnInRange, new Date(BASE_TS).toISOString());
  assert.equal(s1.activeMsInRange, 120_000);
  assert.equal(s1.turnsInRange, 5);
  assert.equal(s1.sidechainTurns, 2);
  // Arrays rather than a single value: a session can span a branch change, and
  // picking one would be a quiet misreport.
  assert.deepEqual(s1.branches, ["main"]);
  assert.deepEqual(s1.models, ["claude-haiku-4-5-20251001", "claude-sonnet-5"]);
});

test("a range that cuts a session is disclosed by field name and by note", () => {
  // s1 has turns at +0..+120s; this range starts mid-session.
  const env = unwrap(
    listSessions(ctx(), {
      from: new Date(BASE_TS + 45_000).toISOString(),
      to: new Date(BASE_TS + DAY_MS / 2).toISOString(),
    }),
  );
  const s1 = env.data.sessions.find((x: any) => x.sessionId === "s1");
  assert.equal(s1.turnsInRange, 3);
  assert.equal(s1.activeMsInRange, 60_000);
  assert.equal(s1.turns, undefined, "no un-qualified turns field");
  assert.equal(s1.start, undefined, "no un-qualified start field");
  assert.match(env.notes.join(" "), /1 of 1 returned sessions have turns outside this range/);
});

test("a range containing every session produces no clipping note", () => {
  const env = unwrap(listSessions(ctx(), {}));
  assert.doesNotMatch(env.notes.join(" "), /outside this range/);
});

test("compare_models flags turnsPerSession when a session straddles the range", () => {
  const cut = {
    from: new Date(BASE_TS + 45_000).toISOString(),
    to: new Date(BASE_TS + DAY_MS / 2).toISOString(),
  };
  assert.match(unwrap(compareModels(ctx(), cut)).notes.join(" "), /extend beyond this range/);
  assert.doesNotMatch(unwrap(compareModels(ctx(), {})).notes.join(" "), /extend beyond this range/);
});

test("truncation is reported, never silent", () => {
  const env = unwrap(listSessions(ctx(), { limit: 2 }));
  assert.equal(env.data.matched, 3);
  assert.equal(env.data.returned, 2);
  assert.equal(env.data.truncated, true);
  assert.match(env.notes.join(" "), /3 sessions matched/);
});

test("an untruncated page says so by omission", () => {
  const env = unwrap(listSessions(ctx(), {}));
  assert.equal(env.data.truncated, false);
  assert.equal(env.data.limit, 50, "the documented default");
  assert.doesNotMatch(env.notes.join(" "), /sessions matched/);
});

test("a limit above the hard cap is clamped and the clamp is disclosed", () => {
  const env = unwrap(listSessions(ctx(), { limit: 5000 }));
  assert.equal(env.data.limit, 500);
  assert.match(env.notes.join(" "), /5000 was requested; 500 is the maximum/);
});

test("a nonsensical limit is a caller error", () => {
  for (const limit of [0, -1, 2.5]) {
    const r = listSessions(ctx(), { limit });
    assert.equal(r.ok, false, `limit ${limit} must be rejected`);
  }
});

// --- §8.5 get_markers ------------------------------------------------------------

test("markers exclude subagent dispatches, which are not developer switches", () => {
  // The bug this fixes: each isolated subagent turn manufactures TWO switches,
  // in and out. On the fixture that is 4 of 7 reported switches.
  const env = unwrap(getMarkers(ctx(), {}));
  assert.equal(env.data.markers.length, 3);
  assert.equal(env.data.sidechainTurnsExcluded, 2);
  assert.ok(
    !env.data.markers.some((m: any) => m.from.startsWith("claude-haiku") || m.to.startsWith("claude-haiku")),
    "no marker may mention a model only subagents used",
  );
});

test("the exclusion is disclosed rather than applied silently", () => {
  assert.match(unwrap(getMarkers(ctx(), {})).notes.join(" "), /switches that never happened/);
});

test("every marker carries its provenance, so inferred ones can be weighted later", () => {
  for (const m of unwrap(getMarkers(ctx(), {})).data.markers) {
    assert.equal(m.provenance, "observed");
    assert.equal(m.type, "model-switch");
    assert.ok(m.at && m.from && m.to);
    assert.equal(typeof m.intraSession, "boolean");
  }
});

test("intraSession distinguishes a mid-session switch from one between sessions", () => {
  const markers = unwrap(getMarkers(ctx(), {})).data.markers;
  assert.ok(markers.some((m: any) => m.intraSession === true));
  assert.ok(markers.some((m: any) => m.intraSession === false));
});

test("a store with no subagent turns excludes nothing and says nothing", () => {
  const main = FIXTURE_TURNS.filter((t: Turn) => !t.isSidechain);
  const env = unwrap(getMarkers(ctx({ turns: main }), {}));
  assert.equal(env.data.sidechainTurnsExcluded, 0);
  assert.doesNotMatch(env.notes.join(" "), /subagent/);
});

// --- notes: honesty fires only when it applies -------------------------------------

test("unpriced turns are explained with their causes when present", () => {
  const notes = unwrap(getSummary(ctx(), {})).notes.join(" ");
  assert.match(notes, /2 of 9 turns in this range have no cost/);
  assert.match(notes, /1 from an unrecognised model/);
  assert.match(notes, /1 from an unrecognised pricing modifier/);
  assert.match(notes, /gap, not a zero/);
});

test("a range with only priced turns carries no unpriced note", () => {
  const priced = FIXTURE_TURNS.filter((t: Turn) => t.model !== "claude-nonexistent-9" && t.speed !== "turbo");
  assert.doesNotMatch(unwrap(getSummary(ctx({ turns: priced }), {})).notes.join(" "), /have no cost/);
});

test("subscription billing marks the figures as a shadow price", () => {
  assert.match(unwrap(getSummary(ctx({ billing: SUB_BILLING }), {})).notes.join(" "), /shadow price/);
  assert.doesNotMatch(unwrap(getSummary(ctx(), {})).notes.join(" "), /shadow price/);
});

test("the rate-pinning caveat fires only when the range predates the rate table", () => {
  // Conditional on purpose: a caveat that fires every time trains an agent to
  // skip the notes array.
  const before = unwrap(getSummary(ctx(), { from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z" }));
  assert.match(before.notes.join(" "), /may reflect a rate change/);

  const after = unwrap(
    getSummary(ctx({ now: Date.parse("2026-10-20T00:00:00Z") }), {
      from: "2026-10-01T00:00:00Z",
      to: "2026-10-15T00:00:00Z",
    }),
  );
  assert.doesNotMatch(after.notes.join(" "), /may reflect a rate change/);
});

// --- the three envelope states, for every tool ---------------------------------------

const RANGE_TOOLS = [
  ["modelog_get_summary", {}],
  ["modelog_compare_models", {}],
  ["modelog_list_sessions", {}],
  ["modelog_get_markers", {}],
  ["modelog_get_definitions", {}],
] as const;

test("every tool reports no-data as null data, never as zeros", () => {
  for (const [name, args] of RANGE_TOOLS) {
    const r = callTool(name, args, ctx({ status: "no-data", note: "no store found", turns: [] }));
    assert.ok(r.ok, name);
    if (!r.ok) continue;
    assert.equal(r.envelope.status, "no-data", name);
    assert.equal(r.envelope.data, null, `${name} must not surface no-data as a reading`);
    assert.ok(r.envelope.notes.includes("no store found"), name);
  }
});

test("every tool reports schema-mismatch as null data", () => {
  for (const [name, args] of RANGE_TOOLS) {
    const r = callTool(name, args, ctx({ status: "schema-mismatch", note: "version mismatch", turns: [] }));
    assert.ok(r.ok, name);
    if (!r.ok) continue;
    assert.equal(r.envelope.status, "schema-mismatch", name);
    assert.equal(r.envelope.data, null, name);
  }
});

test("every tool returns data and an ISO range when the store is ok", () => {
  for (const [name, args] of RANGE_TOOLS) {
    const r = callTool(name, args, ctx());
    assert.ok(r.ok, name);
    if (!r.ok) continue;
    assert.equal(r.envelope.status, "ok", name);
    assert.ok(r.envelope.data, `${name} must carry data`);
    assert.match(r.envelope.range.from!, /^\d{4}-\d{2}-\d{2}T/, name);
    assert.match(r.envelope.range.to!, /^\d{4}-\d{2}-\d{2}T/, name);
  }
});

test("an unknown tool name is an error, not an empty envelope", () => {
  const r = callTool("modelog_drop_tables", {}, ctx());
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /Unknown tool/);
});

// --- the tools/list surface ------------------------------------------------------------

test("every tool is declared with a name, a description and an object schema", () => {
  assert.equal(TOOLS.length, 5);
  for (const t of TOOLS) {
    assert.match(t.name, /^modelog_/);
    assert.ok(t.description.length > 80, `${t.name} needs a real description`);
    assert.equal(t.inputSchema.type, "object");
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} must reject stray args`);
  }
});

test("declared tool names match what the dispatcher accepts", () => {
  for (const t of TOOLS) {
    const r = callTool(t.name, {}, ctx());
    assert.ok(r.ok, `${t.name} is declared but not dispatched`);
  }
});

test("no tool is a write tool — the surface is read-only by construction", () => {
  // MCP.md §4.1 / PRD invariant 6. A server with no write tools cannot be
  // talked into writing.
  for (const t of TOOLS) {
    assert.match(t.name, /_(get|list|compare)_/, `${t.name} must read, not mutate`);
  }
});

// --- trust model ----------------------------------------------------------------------

test("no note in any tool response contains an untrusted string", () => {
  // Branch names, paths and session ids are arbitrary strings from the user's
  // environment. They are returned as typed field values and must never be
  // interpolated into prose an agent could read as instruction (§4.2).
  const untrusted = ["feature/pricing", "/home/dev/project", "/logs/s1.jsonl"];
  for (const [name, args] of RANGE_TOOLS) {
    const r = callTool(name, args, ctx());
    if (!r.ok) continue;
    const notes = r.envelope.notes.join(" ");
    for (const u of untrusted) {
      assert.ok(!notes.includes(u), `${name} leaked ${u} into a note`);
    }
  }
});

/** Every property name appearing anywhere in a nested structure. */
function allKeys(v: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(v)) {
    for (const item of v) allKeys(item, into);
  } else if (v !== null && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) {
      into.add(k);
      allKeys(val, into);
    }
  }
  return into;
}

test("no tool response carries a field sourced from message content", () => {
  // MCP.md §10's no-content guarantee. Checked over field NAMES, not the
  // whole serialised blob: the definitions prose legitimately contains the
  // word "prompt" (as in "prompt cache"), and matching that would be
  // assertion theatre rather than a check on what the tools expose.
  const banned = /^(content|prompt|prompts|message|messages|text|userMessage|assistantResponse|summary)$/i;
  for (const [name, args] of RANGE_TOOLS) {
    const r = callTool(name, args, ctx());
    if (!r.ok) continue;
    for (const key of allKeys(r.envelope)) {
      assert.ok(!banned.test(key), `${name} exposed a field named "${key}"`);
    }
  }
});

// --- over a real read-only store ---------------------------------------------------------

test("the tools run against a real SQLite store", { skip: !sqlite }, async () => {
  const fx = makeStore();
  try {
    const opened = await openReadOnly(fx.path);
    assert.equal(opened.status, "ok");
    const turns = readTurns(opened.db);
    const c = ctx({ status: opened.status, note: opened.note, turns });
    opened.db.close();

    // The figures must match the in-memory fixture exactly, or something is
    // being lost in the storage round trip.
    assert.equal(unwrap(getSummary(c, {})).data.turns, 9);
    assert.equal(unwrap(getSummary(c, {})).data.sidechainTurns, 2);
    assert.equal(unwrap(getMarkers(c, {})).data.markers.length, 3);
    assert.equal(unwrap(listSessions(c, {})).data.matched, 3);
    assert.equal(unwrap(compareModels(c, {})).data.vendors[0].models.length, 4);
    assert.ok(unwrap(getDefinitions(c)).data.store.turns === 9);
  } finally {
    fx.cleanup();
  }
});

test("an explicit range narrows to just the sessions inside it", { skip: !sqlite }, async () => {
  const fx = makeStore();
  try {
    const opened = await openReadOnly(fx.path);
    const turns = readTurns(opened.db);
    const c = ctx({ status: opened.status, note: opened.note, turns });
    opened.db.close();

    // Session 2's three turns only: session 1 is a day earlier, session 3 a
    // day later. Range bounds are inclusive at both ends, so the window
    // starting exactly on session 2's first turn includes it.
    const env = unwrap(
      getSummary(c, {
        from: new Date(BASE_TS + DAY_MS).toISOString(),
        to: new Date(BASE_TS + DAY_MS + 200_000).toISOString(),
      }),
    );
    assert.equal(env.data.sessions, 1);
    assert.equal(env.data.turns, 3);
    assert.equal(env.data.firstTurn, new Date(BASE_TS + DAY_MS).toISOString());
  } finally {
    fx.cleanup();
  }
});
