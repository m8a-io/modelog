import type { Turn } from "../ingest/types.ts";
import {
  CAPTURED_FIELDS,
  uncapturedFields,
  type CapturedField,
} from "../ingest/capture.ts";
import { resolveRates, turnCostMicro, type PricingFile, type RateTable } from "../metrics/cost.ts";
import { totals } from "../metrics/aggregate.ts";
import { billingCopy, type BillingInfo } from "../ingest/billing.ts";
import { staleRateTableNote } from "./envelope.ts";

/**
 * `modelog_get_definitions` (MCP.md §8.1).
 *
 * This tool exists to stop an agent reasoning from field names. Several of
 * Modelog's counts mean something other than what they appear to: a turn is
 * not an inference call, subagent turns are inside the per-model figures, and
 * a null cost is a gap rather than a zero.
 *
 * Two rules govern everything below.
 *
 * **Measured facts are computed, never asserted.** The sidechain breakdown is
 * derived from the store on every call rather than written into prose, because
 * "all Haiku traffic here is subagent calls" is a property of one developer's
 * data, not a definition. Hardcoding it would be false on someone else's
 * machine and would rot on this one.
 *
 * **The prose is declarative, never imperative** (MCP.md §4.2). It states what
 * the numbers mean; it does not tell the agent what to do about them. "Turns
 * made by subagents are included in every per-model figure" — not "exclude
 * subagent turns before comparing models." Stating the semantics is this
 * tool's job; drawing the conclusion is the agent's.
 */

/** Surfaced in `tools/list`. Its purpose is to get itself called first. */
export const DEFINITIONS_DESCRIPTION =
  "Metric definitions and data provenance for Modelog's other tools: what a " +
  "turn is and is not, how cost is computed, why a cost may be unavailable, " +
  "which billing mode applies, how subagent turns are counted, and the span " +
  "and schema version of the stored data. Several of these metrics have " +
  "semantics that field names do not convey — a turn is not an inference " +
  "call, subagent turns are included in per-model figures, and an unavailable " +
  "cost is a gap rather than a zero. The other Modelog tools return numbers " +
  "whose meaning depends on these definitions. Takes no arguments.";

export interface ModifierDefinition {
  field: string;
  recognisedValues: Array<{ value: string; multiplier: string }>;
  unrecognisedValuePolicy: string;
}

export interface ObservedModel {
  model: string;
  turns: number;
  /** Turns made by a subagent rather than in the main conversation. */
  sidechainTurns: number;
  /** False when this model id resolves to no entry in the rate table. */
  priced: boolean;
}

export interface Definitions {
  turn: {
    definition: string;
    notAnInferenceCall: string;
    excludedRecords: string;
  };
  sidechain: {
    definition: string;
    treatment: string;
    observed: {
      turns: number;
      sidechainTurns: number;
      mainConversationTurns: number;
    };
  };
  cost: {
    method: string;
    tokenClasses: string[];
    thinkingTokens: string;
    cacheMultipliers: {
      note: string;
      cacheRead: string;
      cacheWrite5m: string;
      cacheWrite1h: string;
      perModelCacheReadOverrides: Array<{ model: string; multiplier: string }>;
    };
    modifiers: ModifierDefinition[];
    rateTable: {
      effectiveDate: string;
      modelsPriced: number;
      /** The honest statement of a known limitation. See PRD §11 Q18, issue #3. */
      historicalAccuracy: string;
    };
    unavailableCost: {
      meaning: string;
      causes: string[];
      observed: {
        unpricedTurns: number;
        unknownModelTurns: number;
        unknownModifierTurns: number;
      };
    };
  };
  /** Metrics the query tools return whose definition is not in their name. */
  derivedMetrics: {
    cacheHitRate: string;
    costPerTurn: string;
    relativeToCheapest: string;
    modelSwitch: string;
  };
  billing: {
    mode: string;
    label: string;
    detail: string;
    detected: boolean;
    source: string;
  };
  models: {
    note: string;
    observed: ObservedModel[];
  };
  store: {
    schemaVersion: number;
    turns: number;
    sessions: number;
    firstTurn: string | null;
    lastTurn: string | null;
    durability: string;
    uncaptured: {
      meaning: string;
      filterRule: string;
      observed: { turnsWithAnyUncapturedField: number; byField: Record<CapturedField, number> };
    };
  };
}

export interface DefinitionsInput {
  turns: readonly Turn[];
  pricing: PricingFile;
  table: RateTable;
  billing: BillingInfo;
  /** True when the mode came from the client config rather than detection. */
  billingFromEnv: boolean;
  schemaVersion: number;
}

export function buildDefinitions(input: DefinitionsInput): Definitions {
  const { turns, pricing, table, billing, billingFromEnv, schemaVersion } = input;
  const tot = totals(turns, table);

  return {
    turn: {
      definition:
        "One assistant response recorded in the session log, carrying a usage " +
        "object with its token counts. Turns are the unit of every count and " +
        "every cost figure Modelog reports.",
      notAnInferenceCall:
        "A turn is not necessarily a single inference call. The log's " +
        "usage.iterations array lists the underlying calls a turn made, and a " +
        "turn may contain several. Every count Modelog reports as 'turns' " +
        "counts assistant responses, not inference calls.",
      excludedRecords:
        "Records whose model is <synthetic> are generated locally rather than " +
        "by a model, carry all-zero usage, and are never ingested. Assistant " +
        "records with no usage object are also skipped, and counted as an " +
        "ingest diagnostic instead.",
    },

    sidechain: {
      definition:
        "A sidechain turn was made by a subagent — a task the assistant " +
        "delegated to itself — rather than in the main conversation with the " +
        "developer. The session log marks these with isSidechain.",
      treatment:
        "Sidechain turns are included in every turn count, cost total and " +
        "per-model figure Modelog currently reports, and are not separated " +
        "out. Subagent work is often routed to a different and cheaper model " +
        "than the developer selected, so a model's share of turns need not " +
        "reflect a choice the developer made.",
      observed: {
        turns: turns.length,
        sidechainTurns: turns.filter((t) => t.isSidechain).length,
        mainConversationTurns: turns.filter((t) => !t.isSidechain).length,
      },
    },

    cost: {
      method:
        "Cost is computed from the token counts the provider recorded for each " +
        "turn, multiplied by published list rates. It is derived from measured " +
        "token counts, not measured directly, and Modelog cannot see an " +
        "invoice.",
      tokenClasses: [
        "input — fresh input tokens, billed at the model's base input rate",
        "cache_read — tokens read from an existing prompt cache",
        "cache_write_5m — tokens written to the cache with a 5-minute TTL",
        "cache_write_1h — tokens written to the cache with a 1-hour TTL",
        "output — tokens generated by the model",
      ],
      thinkingTokens:
        "Thinking tokens are already counted inside output tokens and are " +
        "never added a second time.",
      cacheMultipliers: {
        note:
          "Cache rates are ratios applied to the model's base input rate " +
          "rather than independently published numbers, so a price change " +
          "touches one figure per model.",
        cacheRead: formatRatio(pricing.cache_multipliers.cache_read, pricing.ratio_scale),
        cacheWrite5m: formatRatio(pricing.cache_multipliers.cache_write_5m, pricing.ratio_scale),
        cacheWrite1h: formatRatio(pricing.cache_multipliers.cache_write_1h, pricing.ratio_scale),
        perModelCacheReadOverrides: cacheReadOverrides(pricing),
      },
      modifiers: modifierDefinitions(table),
      rateTable: {
        effectiveDate: table.effectiveDate,
        modelsPriced: table.rates.size,
        historicalAccuracy:
          `Every turn is priced at the rates effective ${table.effectiveDate}, ` +
          "including turns that ran before that date. Modelog does not " +
          "currently price a turn at the rate that was in force when it ran, " +
          "so updating the rate table changes historical figures. A cost " +
          "difference between two periods may therefore reflect a rate change " +
          "rather than a change in usage.",
      },
      unavailableCost: {
        meaning:
          "An unavailable cost is reported as null and excluded from totals. " +
          "It is never reported as zero and never priced at a default rate, " +
          "because a turn whose cost is unknown and a turn that cost nothing " +
          "are different facts.",
        causes: [
          "unknown model — the model id in the log resolves to no entry in the rate table, which happens for a model released after the rate table was published",
          "unknown pricing modifier — the model is known, but the turn recorded a speed or inference_geo value the rate table has no ratio for, and pricing it at standard rates would report a known model at the wrong cost",
        ],
        observed: unavailableCostCounts(turns, table),
      },
    },

    derivedMetrics: {
      cacheHitRate:
        "Cache-read tokens divided by all input-side tokens — fresh input plus " +
        "cache reads plus both cache-write classes. Output tokens are not in " +
        "the denominator. It is a property of how much of the input was served " +
        "from cache, not a measure of cost saved.",
      costPerTurn:
        "Total cost divided by the number of turns that could be priced. Turns " +
        "with an unavailable cost are excluded from both the numerator and the " +
        "denominator, because averaging them in as zero would understate the " +
        "figure.",
      relativeToCheapest:
        "A model's cost per turn as a multiple of the cheapest model's cost per " +
        "turn within the same vendor. It is computed only inside one vendor's " +
        "rows; Modelog emits no cross-vendor cost ratio.",
      modelSwitch:
        "Two consecutive turns, ordered by time, that ran on different models. " +
        "Turns made by subagents are excluded before switches are detected: a " +
        "subagent runs on a model the developer did not choose and returns to " +
        "the original model afterwards, so including those transitions would " +
        "report switches that never happened. A switch is marked intraSession " +
        "when both turns belong to one session.",
    },

    billing: {
      mode: billing.mode,
      ...billingCopy(billing),
      detected: billing.detected,
      source: billingSource(billing, billingFromEnv),
    },

    models: {
      note:
        "Model ids as they appear in the session log. A dated snapshot id such " +
        "as claude-haiku-4-5-20251001 is priced at the rates of its bare id, " +
        "because a snapshot and its bare id are the same model at the same " +
        "price. An id that resolves to no rate entry has priced set to false.",
      observed: observedModels(turns, table),
    },

    store: {
      schemaVersion,
      turns: tot.turns,
      sessions: tot.sessions,
      firstTurn: toIso(tot.firstTs),
      lastTurn: toIso(tot.lastTs),
      durability:
        "The store is a durable superset of the session logs. Turns remain " +
        "after the log files they came from are deleted or rotated, so the " +
        "store can cover a longer span than the logs currently on disk. Turns " +
        "whose source file no longer exists keep whatever fields were captured " +
        "when they were first read; fields added by a later version of Modelog " +
        "stay null for them (isSidechain stays false), because a backfill can " +
        "only re-read a file that still exists.",
      uncaptured: {
        meaning:
          "A turn ingested before Modelog recorded a field has that field " +
          "uncaptured. For such a turn an empty entrypoint or a false isSidechain " +
          "means unknown, not none and not main-conversation, and an " +
          "uncaptured speed or inference_geo is priced as unmodified, as for " +
          "any turn whose record does not carry them. Sessions list their " +
          "uncapturedFields and uncapturedTurns.",
        filterRule:
          "A turn whose filtered field is uncaptured is excluded from a filtered " +
          "query and counted in a note, separately from turns that did not match. " +
          "That includes isSidechain: false, so an unknown is never treated as false.",
        observed: uncapturedCounts(turns),
      },
    },
  };
}

/**
 * The store's own extent, used as the envelope range for this tool. Null on an
 * empty store: a store with no turns has no span, and `now..now` would assert
 * a range that does not exist.
 */
export function storeExtent(turns: readonly Turn[]): { from: number | null; to: number | null } {
  if (turns.length === 0) return { from: null, to: null };
  let min = Infinity;
  let max = -Infinity;
  for (const t of turns) {
    if (t.ts < min) min = t.ts;
    if (t.ts > max) max = t.ts;
  }
  return { from: min, to: max };
}

/**
 * Notes for the definitions envelope. Only conditions that actually hold are
 * reported — a note that fires unconditionally teaches an agent to ignore the
 * array.
 *
 * `effectiveDate` is taken rather than read from the table so the 90-day
 * staleness warning (MCP.md §9, required on every cost-bearing response) comes
 * from the one shared helper, phrased identically to the dashboard's.
 */
export function definitionsNotes(
  turns: readonly Turn[],
  billing: BillingInfo,
  effectiveDate: string,
  now: number = Date.now(),
): string[] {
  const notes: string[] = [];

  if (turns.length === 0) {
    notes.push(
      "The store is readable and its schema matches, but it holds no turns. " +
        "This is an absence of data, not a measurement of zero usage.",
    );
  }

  const sidechain = turns.filter((t) => t.isSidechain).length;
  if (sidechain > 0) {
    notes.push(
      `${sidechain} of ${turns.length} stored turns were made by subagents and ` +
        "are included in every per-model figure.",
    );
  }

  const uncaptured = turns.filter((t) => uncapturedFields(t).length > 0).length;
  if (uncaptured > 0) {
    notes.push(
      `${uncaptured} of ${turns.length} stored turns were ingested before some fields ` +
        "were captured; see store.uncaptured for what that means for each field.",
    );
  }

  if (billing.mode === "subscription") {
    notes.push(
      "Billing mode is subscription, so every cost figure is a shadow price — " +
        "what this usage would have cost at API list rates — rather than an " +
        "amount billed.",
    );
  }

  const stale = staleRateTableNote(effectiveDate, now);
  if (stale) notes.push(stale);

  return notes;
}

function billingSource(billing: BillingInfo, fromEnv: boolean): string {
  if (fromEnv) {
    return "Set explicitly in the Modelog MCP server's client configuration.";
  }
  if (billing.detected) {
    return (
      "Detected from Claude Code's own configuration. The Modelog extension " +
      "setting that can override this is not readable by the MCP server, " +
      "which runs as a separate process, so a configured override may not be " +
      "reflected here."
    );
  }
  return (
    "Not detected. Claude Code's configuration did not state a billing type, " +
    "so the more conservative of the two modes is assumed: costs are " +
    "described as estimates rather than as an amount billed."
  );
}

function uncapturedCounts(turns: readonly Turn[]): {
  turnsWithAnyUncapturedField: number;
  byField: Record<CapturedField, number>;
} {
  const byField = Object.fromEntries(CAPTURED_FIELDS.map((f) => [f, 0])) as Record<
    CapturedField,
    number
  >;
  let any = 0;
  for (const t of turns) {
    const missing = uncapturedFields(t);
    if (missing.length > 0) any++;
    for (const f of missing) byField[f]++;
  }
  return { turnsWithAnyUncapturedField: any, byField };
}

function unavailableCostCounts(
  turns: readonly Turn[],
  table: RateTable,
): { unpricedTurns: number; unknownModelTurns: number; unknownModifierTurns: number } {
  let unknownModel = 0;
  let unknownModifier = 0;

  for (const t of turns) {
    if (turnCostMicro(t, table) !== null) continue;
    // Splitting the two causes is the point: "unpriced" alone stopped being a
    // sufficient explanation once an unknown modifier could also yield null.
    if (resolveRates(t.model, table) === null) unknownModel++;
    else unknownModifier++;
  }

  return {
    unpricedTurns: unknownModel + unknownModifier,
    unknownModelTurns: unknownModel,
    unknownModifierTurns: unknownModifier,
  };
}

function observedModels(turns: readonly Turn[], table: RateTable): ObservedModel[] {
  const byModel = new Map<string, { turns: number; sidechainTurns: number }>();
  for (const t of turns) {
    let row = byModel.get(t.model);
    if (!row) byModel.set(t.model, (row = { turns: 0, sidechainTurns: 0 }));
    row.turns++;
    if (t.isSidechain) row.sidechainTurns++;
  }

  return [...byModel.entries()]
    .map(([model, row]) => ({
      model,
      turns: row.turns,
      sidechainTurns: row.sidechainTurns,
      priced: resolveRates(model, table) !== null,
    }))
    .sort((a, b) => b.turns - a.turns || a.model.localeCompare(b.model));
}

function modifierDefinitions(table: RateTable): ModifierDefinition[] {
  const out: ModifierDefinition[] = [];
  for (const [field, values] of table.modifiers) {
    out.push({
      field,
      recognisedValues: [...values.entries()].map(([value, numerator]) => ({
        value,
        multiplier: formatRatio(numerator, table.ratioScale),
      })),
      unrecognisedValuePolicy:
        "A value absent from this list is unknown rather than neutral, and " +
        "yields an unavailable cost for that turn.",
    });
  }
  return out;
}

function cacheReadOverrides(pricing: PricingFile): Array<{ model: string; multiplier: string }> {
  const out: Array<{ model: string; multiplier: string }> = [];
  for (const [model, rates] of Object.entries(pricing.models)) {
    if (typeof rates.cache_read === "number") {
      out.push({ model, multiplier: formatRatio(rates.cache_read, pricing.ratio_scale) });
    }
  }
  return out;
}

/**
 * Ratios are reported as display strings, not numbers. A multiplier is not an
 * amount, and handing an agent a bare 0.1 next to money invites it to be used
 * in arithmetic it does not belong in.
 */
function formatRatio(numerator: number, scale: number): string {
  return `${numerator / scale}x`;
}

function toIso(ts: number | null): string | null {
  return ts === null ? null : new Date(ts).toISOString();
}
