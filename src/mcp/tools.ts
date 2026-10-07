import type { Turn } from "../ingest/types.ts";
import { isCaptured, type CapturedField } from "../ingest/capture.ts";
import { resolveRates, turnCostMicro, type RateTable } from "../metrics/cost.ts";
import {
  filterByRange,
  modelRows,
  developerModelSwitches,
  sessionRows,
  totals,
  partitionBySource,
  type ModelRow,
} from "../metrics/aggregate.ts";
import {
  buildEnvelope,
  parseRange,
  staleRateTableNote,
  toMoney,
  toMoneyOrNull,
  type Envelope,
  type Money,
} from "./envelope.ts";
import type { BillingInfo } from "../ingest/billing.ts";
import type { StoreStatus } from "./readOnlyStore.ts";
import {
  buildDefinitions,
  definitionsNotes,
  storeExtent,
  DEFINITIONS_DESCRIPTION,
  type Definitions,
} from "./definitions.ts";
import type { PricingFile } from "../metrics/cost.ts";

/**
 * The query tools (MCP.md §8.2–§8.5).
 *
 * Handlers are pure over a `ToolContext` so they can be tested without a
 * process, a transport or a client. 2.4 supplies the context from
 * `openReadOnly` and wires these onto the low-level `Server`.
 *
 * Three rules hold across all of them:
 *
 * - **Every response is an envelope**, built by the one shared helper, so a
 *   non-ok store cannot be reported as zeros (MCP.md §8.7).
 * - **Every money value is `{amount, unit, formatted}`** — never a bare
 *   number, so an agent cannot add two units or parse currency text.
 * - **Untrusted strings appear only as values of typed fields** (§4.2).
 *   Branch names, paths and session ids are never interpolated into a note or
 *   any other prose, which is asserted by a test rather than left to care.
 */

const DEFAULT_SESSION_LIMIT = 50;
const MAX_SESSION_LIMIT = 500;

export interface ToolContext {
  /** From `openReadOnly`. Not every status carries readable turns. */
  status: StoreStatus;
  note: string | null;
  turns: readonly Turn[];
  pricing: PricingFile;
  table: RateTable;
  billing: BillingInfo;
  billingFromEnv: boolean;
  schemaVersion: number;
  now: number;
}

/**
 * A bad argument is a caller error, not a data gap, so it is kept distinct
 * from the three store statuses rather than smuggled into `notes`.
 */
export type ToolResult<T> = { ok: true; envelope: Envelope<T> } | { ok: false; error: string };

export interface RangeArgsInput {
  days?: number;
  from?: string;
  to?: string;
}

/**
 * Filters shared by `compare_models` and `list_sessions`. `entrypoint` is
 * where Phase 0.2's CLI-vs-IDE segmentation lands first; `isSidechain` is the
 * only way an agent can currently separate subagent traffic from work the
 * developer directed.
 */
export interface FilterArgsInput {
  model?: string;
  branch?: string;
  entrypoint?: string;
  isSidechain?: boolean;
}

// --- vendor identity (PRD invariant 5) --------------------------------------

/**
 * A model id's vendor. Used to make "no cross-vendor cost comparison" a
 * property of the response *shape* rather than a policy note: rows are nested
 * under their vendor, and a ratio is only ever computed inside one group.
 */
export function vendorOf(model: string): string {
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3")) return "openai";
  if (model.startsWith("gemini-")) return "google";
  return "unknown";
}

/**
 * The key rows are grouped by, and inside which a cost ratio may be computed.
 *
 * **Source first, vendor second.** Vendor alone is not enough: the same model
 * id reaches a developer through both assistants, so `claude-sonnet-5` run via
 * Claude Code and via Copilot would otherwise land in one group and be divided
 * against each other — two different billing relationships in two different
 * units, which is exactly the comparison PRD §4.5 forbids. §4.5 says it
 * directly: the surviving distinction is the billing relationship, not the
 * vendor whose weights ran.
 */
export function groupKeyOf(turnSource: string, model: string): string {
  return `${turnSource}:${vendorOf(model)}`;
}

// --- shared helpers ----------------------------------------------------------

interface FilterResult {
  matched: Turn[];
  /** Turns with no definite miss whose filtered field was never captured. */
  unevaluable: Turn[];
  unevaluableFields: CapturedField[];
}

/**
 * A turn whose filtered field was not captured is neither a match nor a
 * non-match, so it is set aside and counted rather than silently dropped.
 * A definite miss on another filter still makes it a plain non-match.
 */
function applyFilters(turns: readonly Turn[], args: FilterArgsInput): FilterResult {
  const matched: Turn[] = [];
  const unevaluable: Turn[] = [];
  const fields = new Set<CapturedField>();

  for (const t of turns) {
    if (args.model !== undefined && t.model !== args.model) continue;
    if (args.branch !== undefined && t.gitBranch !== args.branch) continue;

    let miss = false;
    const unknown: CapturedField[] = [];
    if (args.entrypoint !== undefined) {
      if (!isCaptured(t, "entrypoint")) unknown.push("entrypoint");
      else if (t.entrypoint !== args.entrypoint) miss = true;
    }
    if (args.isSidechain !== undefined) {
      if (!isCaptured(t, "isSidechain")) unknown.push("isSidechain");
      else if (t.isSidechain !== args.isSidechain) miss = true;
    }

    if (miss) continue;
    if (unknown.length > 0) {
      unevaluable.push(t);
      for (const f of unknown) fields.add(f);
      continue;
    }
    matched.push(t);
  }

  return { matched, unevaluable, unevaluableFields: [...fields].sort() };
}

function unevaluableNote(f: FilterResult): string | null {
  if (f.unevaluable.length === 0) return null;
  const sessions = new Set(f.unevaluable.map((t) => t.sessionId)).size;
  // Field names only, never filter values (§4.2).
  return (
    `${f.unevaluable.length} turns in ${sessions} sessions could not be evaluated against ` +
    `the filter on ${f.unevaluableFields.join(", ")}, because that value was not captured ` +
    "when they were ingested. They are excluded from these figures and are not known to " +
    "be non-matches."
  );
}

function activeFilters(args: FilterArgsInput): string[] {
  const out: string[] = [];
  // Field NAMES only. The values are user-supplied strings and must not be
  // interpolated into a note (§4.2) — they are already returned as typed
  // fields on each row, which is where an agent should read them.
  if (args.model !== undefined) out.push("model");
  if (args.branch !== undefined) out.push("branch");
  if (args.entrypoint !== undefined) out.push("entrypoint");
  if (args.isSidechain !== undefined) out.push("isSidechain");
  return out;
}

/**
 * How many of `sessionIds` have turns outside the range. Those sessions' per-session
 * figures describe a fragment, which the default 30-day range makes the common case.
 */
function rangeClippedSessions(
  all: readonly Turn[],
  sessionIds: ReadonlySet<string>,
  range: { from: number; to: number },
): number {
  const clipped = new Set<string>();
  for (const t of all) {
    if (sessionIds.has(t.sessionId) && (t.ts < range.from || t.ts > range.to)) {
      clipped.add(t.sessionId);
    }
  }
  return clipped.size;
}

function unpricedCauses(turns: readonly Turn[], table: RateTable) {
  let unknownModel = 0;
  let unknownModifier = 0;
  for (const t of turns) {
    if (turnCostMicro(t, table) !== null) continue;
    if (resolveRates(t.model, table) === null) unknownModel++;
    else unknownModifier++;
  }
  return { unknownModelTurns: unknownModel, unknownModifierTurns: unknownModifier };
}

/**
 * Caveats every cost-bearing response carries when — and only when — they
 * apply. A note that fires unconditionally trains an agent to skip the array,
 * so each one is gated on the condition actually holding.
 */
function costNotes(
  ctx: ToolContext,
  turns: readonly Turn[],
  range: { from: number; to: number },
): string[] {
  const notes: string[] = [];
  const tot = totals(turns, ctx.table);

  if (tot.unpricedTurns > 0) {
    const c = unpricedCauses(turns, ctx.table);
    notes.push(
      `${tot.unpricedTurns} of ${tot.turns} turns in this range have no cost and are ` +
        `excluded from every total: ${c.unknownModelTurns} from an unrecognised model, ` +
        `${c.unknownModifierTurns} from an unrecognised pricing modifier. An excluded ` +
        "turn is a gap, not a zero.",
    );
  }

  const sidechain = turns.filter((t) => t.isSidechain).length;
  if (sidechain > 0) {
    notes.push(
      `${sidechain} of ${tot.turns} turns in this range were made by subagents and are ` +
        "included in these figures. Subagent work is often routed to a different model " +
        "than the developer selected.",
    );
  }

  const unknownSidechain = turns.filter((t) => !isCaptured(t, "isSidechain")).length;
  if (unknownSidechain > 0) {
    notes.push(
      `${unknownSidechain} of ${tot.turns} turns in this range were ingested before ` +
        "isSidechain was captured. They are counted as main-conversation turns, so " +
        "subagent counts omit any of them that were subagent turns.",
    );
  }

  if (ctx.billing.mode === "subscription") {
    notes.push(
      "Billing mode is subscription, so these costs are a shadow price — what this " +
        "usage would have cost at API list rates — rather than an amount billed.",
    );
  }

  // Fires only when the range actually reaches behind the rate table's
  // effective date, which is exactly when the pinning distorts a comparison.
  if (range.from < Date.parse(ctx.table.effectiveDate)) {
    notes.push(
      `This range extends before ${ctx.table.effectiveDate}, the rate table's effective ` +
        "date. Every turn is priced at that table regardless of when it ran, so a cost " +
        "difference across this range may reflect a rate change rather than a change in usage.",
    );
  }

  const stale = staleRateTableNote(ctx.table.effectiveDate, ctx.now);
  if (stale) notes.push(stale);

  return notes;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function toIso(ts: number | null): string | null {
  return ts === null ? null : new Date(ts).toISOString();
}

// --- §8.1 modelog_get_definitions --------------------------------------------

export function getDefinitions(ctx: ToolContext): ToolResult<Definitions> {
  const data = buildDefinitions({
    turns: ctx.turns,
    pricing: ctx.pricing,
    table: ctx.table,
    billing: ctx.billing,
    billingFromEnv: ctx.billingFromEnv,
    schemaVersion: ctx.schemaVersion,
  });

  return {
    ok: true,
    envelope: buildEnvelope(
      ctx,
      storeExtent(ctx.turns),
      data,
      definitionsNotes(ctx.turns, ctx.billing, ctx.table.effectiveDate, ctx.now),
    ),
  };
}

// --- §8.2 modelog_get_summary -------------------------------------------------

/** Per-source money. Costs never blend across sources; counts may. */
export interface SourceCost {
  source: string;
  turns: number;
  totalCost: Money;
  /** Over PRICED turns only — averaging in an unpriced turn would understate it. */
  costPerTurn: Money | null;
  unpricedTurns: number;
  unpricedCauses: { unknownModelTurns: number; unknownModifierTurns: number };
}

export interface Summary {
  turns: number;
  /** A turn is not an inference call; this is the call count. */
  inferenceCalls: number;
  sessions: number;
  sidechainTurns: number;
  /**
   * One entry per assistant present in the range — **always an array, even
   * for a single source**, matching how `compare_models` always nests under a
   * group. There is deliberately no single blended total: the sources bill in
   * different units with no defensible conversion between them, so one number
   * covering both would be denominated in nothing (PRD §4.5, §8.2).
   *
   * The counts above (turns, sessions, cache hit rate) do blend, because they
   * are unit-free and a cross-source count is a real quantity.
   */
  costBySource: SourceCost[];
  unpricedTurns: number;
  cacheHitRate: number;
  firstTurn: string | null;
  lastTurn: string | null;
}

export function getSummary(ctx: ToolContext, args: RangeArgsInput): ToolResult<Summary> {
  const r = parseRange(args, ctx.now);
  if (!r.ok) return { ok: false, error: r.error };

  const turns = filterByRange(ctx.turns, r.from, r.to);

  // Unit-free aggregates over everything; money strictly per source.
  const sessions = new Set(turns.map((t) => t.sessionId));
  let calls = 0;
  let cacheRead = 0;
  let inputSide = 0;
  let unpricedAll = 0;
  for (const t of turns) {
    calls += t.iterations;
    cacheRead += t.cacheReadTokens;
    inputSide += t.inputTokens + t.cacheReadTokens + t.cacheWrite5mTokens + t.cacheWrite1hTokens;
  }

  const costBySource: SourceCost[] = [];
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  for (const [source, sourceTurns] of partitionBySource(turns)) {
    const tot = totals(sourceTurns, ctx.table);
    const priced = tot.turns - tot.unpricedTurns;
    unpricedAll += tot.unpricedTurns;
    if (tot.firstTs !== null && (firstTs === null || tot.firstTs < firstTs)) firstTs = tot.firstTs;
    if (tot.lastTs !== null && (lastTs === null || tot.lastTs > lastTs)) lastTs = tot.lastTs;

    costBySource.push({
      source,
      turns: tot.turns,
      totalCost: toMoney(tot.totalCost, tot.unit),
      costPerTurn: toMoneyOrNull(
        priced > 0 ? Math.round(tot.totalCost / priced) : null,
        tot.unit,
      ),
      unpricedTurns: tot.unpricedTurns,
      unpricedCauses: unpricedCauses(sourceTurns, ctx.table),
    });
  }
  costBySource.sort((a, b) => a.source.localeCompare(b.source));

  const data: Summary = {
    turns: turns.length,
    inferenceCalls: calls,
    sessions: sessions.size,
    sidechainTurns: turns.filter((t) => t.isSidechain).length,
    costBySource,
    unpricedTurns: unpricedAll,
    cacheHitRate: round4(inputSide > 0 ? cacheRead / inputSide : 0),
    firstTurn: toIso(firstTs),
    lastTurn: toIso(lastTs),
  };

  return { ok: true, envelope: buildEnvelope(ctx, r, data, costNotes(ctx, turns, r)) };
}

// --- §8.3 modelog_compare_models ----------------------------------------------

export interface ModelComparison {
  model: string;
  turns: number;
  inferenceCalls: number;
  sessions: number;
  sidechainTurns: number;
  costPerTurn: Money | null;
  /** Multiple of the cheapest model IN THE SAME VENDOR GROUP. Null if unpriced. */
  relativeToCheapest: number | null;
  totalCost: Money;
  turnsPerSession: number;
  cacheHitRate: number;
  unpricedTurns: number;
  priced: boolean;
}

export interface VendorGroup {
  /** Which assistant these turns came through. Half of the grouping key. */
  source: string;
  vendor: string;
  /** The per-turn baseline `relativeToCheapest` is measured against. */
  cheapestModel: string | null;
  /** The unit every cost in this group is denominated in. */
  unit: string;
  models: ModelComparison[];
}

export interface ModelComparisonData {
  vendors: VendorGroup[];
}

export function compareModels(
  ctx: ToolContext,
  args: RangeArgsInput & FilterArgsInput,
): ToolResult<ModelComparisonData> {
  const r = parseRange(args, ctx.now);
  if (!r.ok) return { ok: false, error: r.error };

  const filtered = applyFilters(filterByRange(ctx.turns, r.from, r.to), args);
  const turns = filtered.matched;

  // Partition by source BEFORE aggregating. Two reasons, both load-bearing:
  // modelRows() refuses a mixed set because the costs are in different units,
  // and the same model id reaches a developer through both assistants, so
  // grouping on vendor alone would put a Copilot claude-sonnet-5 and a Claude
  // Code claude-sonnet-5 in one group and divide them (PRD §4.5).
  const bySource = partitionBySource(turns);

  // Group first, THEN compute ratios. A cheapest-model baseline is only ever
  // taken within one group, so no cross-group ratio can be emitted even by
  // mistake (PRD §4.5, invariant 5).
  const grouped = new Map<string, { source: string; vendor: string; rows: ModelRow[] }>();
  for (const [source, sourceTurns] of bySource) {
    for (const row of modelRows(sourceTurns, ctx.table)) {
      const vendor = vendorOf(row.model);
      const key = groupKeyOf(source, row.model);
      let entry = grouped.get(key);
      if (!entry) grouped.set(key, (entry = { source, vendor, rows: [] }));
      entry.rows.push(row);
    }
  }

  const vendors: VendorGroup[] = [];
  for (const [, { source, vendor, rows: list }] of grouped) {
    const cheapest = list.find((x) => x.costPerTurn !== null) ?? null;
    const base = cheapest?.costPerTurn ?? null;
    const unit = list[0]!.unit;

    vendors.push({
      source,
      vendor,
      cheapestModel: cheapest?.model ?? null,
      unit,
      models: list.map((row) => ({
        model: row.model,
        turns: row.turns,
        inferenceCalls: row.inferenceCalls,
        sessions: row.sessions,
        sidechainTurns: row.sidechainTurns,
        costPerTurn: toMoneyOrNull(row.costPerTurn, row.unit),
        relativeToCheapest:
          row.costPerTurn === null || base === null || base === 0
            ? null
            : round4(row.costPerTurn / base),
        totalCost: toMoney(row.totalCost, row.unit),
        turnsPerSession: round4(row.turnsPerSession),
        cacheHitRate: round4(row.cacheHitRate),
        unpricedTurns: row.unpricedTurns,
        // A Copilot turn's cost is measured rather than looked up, so a rate
        // table miss does not make it unpriced.
        priced: row.unit === "aiu_nano" || resolveRates(row.model, ctx.table) !== null,
      })),
    });
  }
  vendors.sort((a, b) =>
    a.source === b.source ? a.vendor.localeCompare(b.vendor) : a.source.localeCompare(b.source),
  );

  const notes = costNotes(ctx, turns, r);
  if (vendors.length > 1) {
    notes.push(
      "More than one vendor appears in this range. Rows are grouped by vendor and the " +
        "relative multiple is computed only within a group; Modelog emits no cross-vendor " +
        "cost ratio, because metered and prepaid billing are not commensurable.",
    );
  }
  const filters = activeFilters(args);
  if (filters.length > 0) {
    notes.push(
      `Filtered by ${filters.join(", ")}. Every figure covers only the matching turns.`,
    );
  }
  const unevaluable = unevaluableNote(filtered);
  if (unevaluable) notes.push(unevaluable);
  const clipped = rangeClippedSessions(ctx.turns, new Set(turns.map((t) => t.sessionId)), r);
  if (clipped > 0) {
    notes.push(
      `${clipped} sessions extend beyond this range. turnsPerSession divides in-range turns ` +
        "by sessions touching the range, so it understates the length of those sessions.",
    );
  }

  return { ok: true, envelope: buildEnvelope(ctx, r, { vendors }, notes) };
}

// --- §8.4 modelog_list_sessions ------------------------------------------------

export interface SessionSummary {
  sessionId: string;
  /** First and last turn inside the requested range — not the session's own bounds. */
  firstTurnInRange: string;
  lastTurnInRange: string;
  /** Last in-range turn minus first; wall-clock span, not time spent working. */
  activeMsInRange: number;
  turnsInRange: number;
  inferenceCalls: number;
  sidechainTurns: number;
  models: string[];
  entrypoints: string[];
  /** Fields not captured for at least one turn here; their other values may mean unknown. */
  uncapturedFields: string[];
  /** Turns with at least one uncaptured field. */
  uncapturedTurns: number;
  branches: string[];
  cwds: string[];
  totalCost: Money;
  unpricedTurns: number;
  cacheHitRate: number;
}

export interface SessionListData {
  sessions: SessionSummary[];
  /** How many matched before `limit` was applied. */
  matched: number;
  returned: number;
  limit: number;
  truncated: boolean;
}

export function listSessions(
  ctx: ToolContext,
  args: RangeArgsInput & FilterArgsInput & { limit?: number },
): ToolResult<SessionListData> {
  const r = parseRange(args, ctx.now);
  if (!r.ok) return { ok: false, error: r.error };

  const requested = args.limit ?? DEFAULT_SESSION_LIMIT;
  if (!Number.isInteger(requested) || requested <= 0) {
    return {
      ok: false,
      error: `"limit" must be a positive integer, got ${JSON.stringify(args.limit)}.`,
    };
  }
  const limit = Math.min(requested, MAX_SESSION_LIMIT);

  const filtered = applyFilters(filterByRange(ctx.turns, r.from, r.to), args);
  const turns = filtered.matched;
  const rows = sessionRows(turns, ctx.table);
  const page = rows.slice(0, limit);

  const data: SessionListData = {
    sessions: page.map((s) => ({
      sessionId: s.sessionId,
      firstTurnInRange: new Date(s.firstTs).toISOString(),
      lastTurnInRange: new Date(s.lastTs).toISOString(),
      activeMsInRange: s.durationMs,
      turnsInRange: s.turns,
      inferenceCalls: s.inferenceCalls,
      sidechainTurns: s.sidechainTurns,
      models: s.models,
      entrypoints: s.entrypoints,
      uncapturedFields: s.uncapturedFields,
      uncapturedTurns: s.uncapturedTurns,
      branches: s.branches,
      cwds: s.cwds,
      totalCost: toMoney(s.totalCost, s.unit),
      unpricedTurns: s.unpricedTurns,
      cacheHitRate: round4(s.cacheHitRate),
    })),
    matched: rows.length,
    returned: page.length,
    limit,
    truncated: rows.length > page.length,
  };

  const notes = costNotes(ctx, turns, r);
  if (requested > MAX_SESSION_LIMIT) {
    notes.push(
      `A limit of ${requested} was requested; ${MAX_SESSION_LIMIT} is the maximum and was ` +
        "used instead.",
    );
  }
  if (data.truncated) {
    // Silent truncation would let an agent read a partial list as the whole
    // picture, which is the same failure class as reporting a gap as a zero.
    notes.push(
      `${data.matched} sessions matched and the most recently active ${data.returned} are ` +
        "returned. Sessions are ordered by last activity, most recent first.",
    );
  }
  const filters = activeFilters(args);
  if (filters.length > 0) {
    notes.push(
      `Filtered by ${filters.join(", ")}. Each session's figures cover only its matching ` +
        "turns, so they may describe part of a longer session.",
    );
  }
  const unevaluable = unevaluableNote(filtered);
  if (unevaluable) notes.push(unevaluable);
  const clipped = rangeClippedSessions(ctx.turns, new Set(page.map((s) => s.sessionId)), r);
  if (clipped > 0) {
    notes.push(
      `${clipped} of ${data.returned} returned sessions have turns outside this range. ` +
        "Their InRange figures (turns, first and last turn, activeMs, cost, cache hit rate) " +
        "cover only the in-range part and understate the whole session.",
    );
  }

  return { ok: true, envelope: buildEnvelope(ctx, r, data, notes) };
}

// --- §8.5 modelog_get_markers --------------------------------------------------

export interface Marker {
  type: "model-switch";
  /** v1 returns observed anchors only; inferred ones will be labelled (PRD §6). */
  provenance: "observed";
  at: string;
  from: string;
  to: string;
  intraSession: boolean;
}

export interface MarkerData {
  markers: Marker[];
  /** Subagent turns dropped before detection. See the note below. */
  sidechainTurnsExcluded: number;
}

export function getMarkers(ctx: ToolContext, args: RangeArgsInput): ToolResult<MarkerData> {
  const r = parseRange(args, ctx.now);
  if (!r.ok) return { ok: false, error: r.error };

  const inRange = filterByRange(ctx.turns, r.from, r.to);

  // `developerModelSwitches` owns the exclusion, so the dashboard and this
  // tool cannot drift on what counts as a switch. The count is recomputed
  // here only to report how many turns it dropped.
  const excluded = inRange.filter((t) => t.isSidechain).length;

  const markers: Marker[] = developerModelSwitches(inRange).map((s) => ({
    type: "model-switch",
    provenance: "observed",
    at: new Date(s.ts).toISOString(),
    from: s.from,
    to: s.to,
    intraSession: s.intraSession,
  }));

  const notes: string[] = [];
  if (excluded > 0) {
    notes.push(
      `${excluded} subagent turns in this range were excluded before detecting switches. ` +
        "A subagent runs on a model the developer did not choose and returns to the " +
        "original model afterwards, so counting those transitions would report switches " +
        "that never happened.",
    );
  }
  const unknownSidechain = inRange.filter((t) => !isCaptured(t, "isSidechain")).length;
  if (unknownSidechain > 0) {
    notes.push(
      `${unknownSidechain} turns in this range were ingested before isSidechain was captured ` +
        "and were treated as main-conversation turns. Any of them that were subagent turns " +
        "may have produced switches that never happened.",
    );
  }
  const stale = staleRateTableNote(ctx.table.effectiveDate, ctx.now);
  if (stale) notes.push(stale);

  return {
    ok: true,
    envelope: buildEnvelope(ctx, r, { markers, sidechainTurnsExcluded: excluded }, notes),
  };
}

// --- the `tools/list` surface ---------------------------------------------------

const RANGE_PROPERTIES = {
  days: {
    type: "integer",
    minimum: 1,
    description: "Number of days back from now. Mutually exclusive with from/to.",
  },
  from: {
    type: "string",
    description: "Start of the range, ISO-8601. Mutually exclusive with days.",
  },
  to: {
    type: "string",
    description: "End of the range, ISO-8601. Mutually exclusive with days.",
  },
} as const;

const FILTER_PROPERTIES = {
  model: { type: "string", description: "Exact model id to restrict to." },
  branch: { type: "string", description: "Exact git branch name to restrict to." },
  entrypoint: {
    type: "string",
    description:
      "Restrict to one surface, e.g. claude-vscode for the IDE extension or " +
      "claude-cli for the terminal. Turns ingested before the field was captured are " +
      "excluded and counted in a note.",
  },
  isSidechain: {
    type: "boolean",
    description:
      "true for subagent turns only, false to exclude them. Omitted includes both. " +
      "Turns ingested before the field was captured match neither value; they are " +
      "excluded and counted in a note.",
  },
} as const;

/** The range note repeated on every range-taking tool's schema. */
const RANGE_NOTE = "Omitting all range arguments means the last 30 days.";

export const TOOLS = [
  {
    name: "modelog_get_definitions",
    description: DEFINITIONS_DESCRIPTION,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "modelog_get_summary",
    description:
      "Totals over a date range: turns, inference calls, sessions, total and per-turn " +
      "cost, unpriced turn count with its causes, cache hit rate, and the first and " +
      "last turn in range. " +
      RANGE_NOTE,
    inputSchema: {
      type: "object",
      properties: { ...RANGE_PROPERTIES },
      additionalProperties: false,
    },
  },
  {
    name: "modelog_compare_models",
    description:
      "One row per model over a date range: turns, sessions, subagent turns, cost per " +
      "turn, the multiple against the cheapest model, turns per session, cache hit rate, " +
      "total cost and unpriced count. Rows are grouped by vendor and no cross-vendor " +
      "cost ratio is produced. " +
      RANGE_NOTE,
    inputSchema: {
      type: "object",
      properties: { ...RANGE_PROPERTIES, ...FILTER_PROPERTIES },
      additionalProperties: false,
    },
  },
  {
    name: "modelog_list_sessions",
    description:
      "Sessions in a date range, most recently active first: id, first and last turn " +
      "in range, in-range span, models used, in-range turn and subagent counts, cost, " +
      "git branches and working directories. Every per-session figure covers only the " +
      "turns inside the range; a session that began earlier or ran later is clipped, " +
      "and a note says when that happened. uncapturedFields lists values Modelog had " +
      "not yet started recording for that session's turns: for those, an empty or " +
      "false value means unknown. Reports how many sessions matched, so a " +
      "truncated page is visible as truncated. " +
      RANGE_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        ...RANGE_PROPERTIES,
        ...FILTER_PROPERTIES,
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SESSION_LIMIT,
          description: `Maximum sessions to return. Default ${DEFAULT_SESSION_LIMIT}, maximum ${MAX_SESSION_LIMIT}.`,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "modelog_get_markers",
    description:
      "Observed behavioural anchors in a date range — currently model switches, each " +
      "with its timestamp, the model before and after, and whether the switch happened " +
      "inside a single session. Subagent turns are excluded, because a subagent runs on " +
      "a model the developer did not choose. " +
      RANGE_NOTE,
    inputSchema: {
      type: "object",
      properties: { ...RANGE_PROPERTIES },
      additionalProperties: false,
    },
  },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

/**
 * Dispatch by name. Returns a `ToolResult` rather than throwing, so 2.4's
 * transport layer decides how an argument error is reported on the wire.
 */
export function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): ToolResult<unknown> {
  switch (name) {
    case "modelog_get_definitions":
      return getDefinitions(ctx);
    case "modelog_get_summary":
      return getSummary(ctx, args as RangeArgsInput);
    case "modelog_compare_models":
      return compareModels(ctx, args as RangeArgsInput & FilterArgsInput);
    case "modelog_list_sessions":
      return listSessions(ctx, args as RangeArgsInput & FilterArgsInput & { limit?: number });
    case "modelog_get_markers":
      return getMarkers(ctx, args as RangeArgsInput);
    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}
