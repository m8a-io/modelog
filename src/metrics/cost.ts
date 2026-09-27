import type { Turn } from "../ingest/types.ts";

/**
 * Cost engine.
 *
 * Everything here is integer arithmetic in MICRO-DOLLARS (1e-6 USD).
 * Floating point is not merely imprecise here, it is visibly wrong: building
 * the rate table in floats already yields 3.0 * 0.1 = 0.30000000000000004, and
 * accumulating that across tens of millions of tokens produces totals a user
 * cannot reconcile against their invoice. See PRD §8.2.
 *
 * Unit convention: a rate of $5.00 per 1M tokens is 5_000_000 micro-dollars
 * per 1M tokens, so cost_micro = tokens * rate_micro / 1_000_000.
 */

export interface PricingFile {
  schema_version: number;
  effective_date: string;
  /** Denominator for every ratio in this file. */
  ratio_scale: number;
  cache_multipliers: {
    cache_read: number;
    cache_write_5m: number;
    cache_write_1h: number;
  };
  /**
   * Request-level repricing, keyed by the field name then the observed value.
   * A value missing from a table is unknown, not neutral.
   */
  modifiers: Record<string, Record<string, number>>;
  models: Record<string, { input: number; output: number; cache_read?: number }>;
  unknown_model_policy: string;
  unknown_modifier_policy: string;
}

/** Per-model integer rates, in micro-dollars per 1M tokens. */
export interface ModelRates {
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}

export interface RateTable {
  effectiveDate: string;
  rates: Map<string, ModelRates>;
  /** Ratio numerators over `ratioScale`, by modifier field then value. */
  modifiers: Map<string, Map<string, number>>;
  ratioScale: number;
}

/** Trailing dated-snapshot suffix, e.g. "-20251001". */
const DATE_SUFFIX = /-\d{8}$/;

/**
 * Resolve a logged model id to a rate entry.
 *
 * Logs carry dated snapshot ids ("claude-haiku-4-5-20251001") alongside bare
 * ids. Stripping a trailing 8-digit date is a deterministic rule about how
 * Anthropic names snapshots, not a guess about which model was meant — the
 * snapshot and the bare id are the same model at the same price. Anything
 * that does not resolve under that rule stays unknown.
 */
export function resolveRates(model: string, table: RateTable): ModelRates | null {
  const exact = table.rates.get(model);
  if (exact) return exact;

  if (DATE_SUFFIX.test(model)) {
    const bare = model.replace(DATE_SUFFIX, "");
    const aliased = table.rates.get(bare);
    if (aliased) return aliased;
  }
  return null;
}

const MICRO = 1_000_000;

/**
 * Derive the integer rate table once, at load.
 *
 * Cache tiers are ratios on base input rather than nine published numbers, so
 * a price change touches one field. The card sets cache-read per-model (0.1x
 * standard, 0.05x on Opus 5.5, 0.025x on Fable 5.1), so a model may override
 * it; the write tiers are uniform so far.
 *
 * Multipliers are integer-over-integer, divided once. The base rate is the
 * only float, read from a human-authored decimal that matches the card.
 */
export function buildRateTable(file: PricingFile): RateTable {
  const scale = file.ratio_scale;
  const m = file.cache_multipliers;
  const rates = new Map<string, ModelRates>();

  for (const [model, r] of Object.entries(file.models)) {
    const inputMicro = Math.round(r.input * MICRO);
    rates.set(model, {
      input: inputMicro,
      cacheRead: ratio(inputMicro, r.cache_read ?? m.cache_read, scale),
      cacheWrite5m: ratio(inputMicro, m.cache_write_5m, scale),
      cacheWrite1h: ratio(inputMicro, m.cache_write_1h, scale),
      output: Math.round(r.output * MICRO),
    });
  }

  const modifiers = new Map<string, Map<string, number>>();
  for (const [field, table] of Object.entries(file.modifiers)) {
    const byValue = new Map<string, number>();
    for (const [value, num] of Object.entries(table)) {
      if (typeof num === "number") byValue.set(value, num);
    }
    modifiers.set(field, byValue);
  }

  return { effectiveDate: file.effective_date, rates, modifiers, ratioScale: scale };
}

function ratio(value: number, numerator: number, scale: number): number {
  return Math.round((value * numerator) / scale);
}

/**
 * Combined modifier numerator for a turn, or null if any recorded value is
 * unrecognised.
 *
 * Modifiers stack multiplicatively per the published card. A field the source
 * did not record is absent, not unknown — records predating `speed` carry no
 * such field — and absent means unmodified. A field that IS recorded with a
 * value we have no ratio for is the dangerous case, and it returns null.
 */
function modifierNumerator(turn: Turn, table: RateTable): number | null {
  const observed: Array<[string, string | null]> = [
    ["speed", turn.speed],
    ["inference_geo", turn.inferenceGeo],
  ];

  let numerator = table.ratioScale;
  for (const [field, value] of observed) {
    if (value === null) continue;
    const ratios = table.modifiers.get(field);
    if (!ratios) return null;
    const found = ratios.get(value);
    if (found === undefined) return null;
    numerator = (numerator * found) / table.ratioScale;
  }
  return numerator;
}

/**
 * Cost of one turn in micro-dollars, or null when the model **or any recorded
 * pricing modifier** is unknown.
 *
 * null is load-bearing in both cases. An unrecognised model must surface as
 * "cost unavailable" rather than fall back to a default rate — and so must an
 * unrecognised modifier, because a fast-mode turn priced at standard rates is
 * a known model reported at half its true cost. Same confidently-wrong
 * number, different door.
 */
export function turnCostMicro(turn: Turn, table: RateTable): number | null {
  const r = resolveRates(turn.model, table);
  if (!r) return null;

  const mod = modifierNumerator(turn, table);
  if (mod === null) return null;

  // Accumulate the numerator, divide once. Thinking tokens are already inside
  // outputTokens and are deliberately not added again.
  const numerator =
    turn.inputTokens * r.input +
    turn.cacheReadTokens * r.cacheRead +
    turn.cacheWrite5mTokens * r.cacheWrite5m +
    turn.cacheWrite1hTokens * r.cacheWrite1h +
    turn.outputTokens * r.output;

  return Math.round((numerator * mod) / (MICRO * table.ratioScale));
}

/** Format micro-dollars for display. Never used in arithmetic. */
export function formatMicroUsd(micro: number): string {
  const usd = micro / MICRO;
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  if (usd < 1000) return `$${usd.toFixed(2)}`;
  return `$${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
