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
  cache_multipliers: {
    cache_read: number;
    cache_write_5m: number;
    cache_write_1h: number;
  };
  models: Record<string, { input: number; output: number }>;
  unknown_model_policy: string;
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
 * Derive the integer rate table once, at load. Cache tiers are multipliers on
 * base input (read 0.1x, 5m write 1.25x, 1h write 2.0x) rather than nine
 * separate published numbers, so a price change touches one field.
 */
export function buildRateTable(file: PricingFile): RateTable {
  const m = file.cache_multipliers;
  const rates = new Map<string, ModelRates>();

  for (const [model, r] of Object.entries(file.models)) {
    const inputMicro = Math.round(r.input * MICRO);
    rates.set(model, {
      input: inputMicro,
      cacheRead: Math.round(inputMicro * m.cache_read),
      cacheWrite5m: Math.round(inputMicro * m.cache_write_5m),
      cacheWrite1h: Math.round(inputMicro * m.cache_write_1h),
      output: Math.round(r.output * MICRO),
    });
  }

  return { effectiveDate: file.effective_date, rates };
}

/**
 * Cost of one turn in micro-dollars, or null when the model is unknown.
 *
 * null is load-bearing: an unrecognised model must surface as "cost
 * unavailable", never silently fall back to a default rate. A confidently
 * wrong number is worse than a visible gap.
 */
export function turnCostMicro(turn: Turn, table: RateTable): number | null {
  const r = resolveRates(turn.model, table);
  if (!r) return null;

  // Accumulate the numerator, divide once. Thinking tokens are already inside
  // outputTokens and are deliberately not added again.
  const numerator =
    turn.inputTokens * r.input +
    turn.cacheReadTokens * r.cacheRead +
    turn.cacheWrite5mTokens * r.cacheWrite5m +
    turn.cacheWrite1hTokens * r.cacheWrite1h +
    turn.outputTokens * r.output;

  return Math.round(numerator / MICRO);
}

/** Format micro-dollars for display. Never used in arithmetic. */
export function formatMicroUsd(micro: number): string {
  const usd = micro / MICRO;
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  if (usd < 1000) return `$${usd.toFixed(2)}`;
  return `$${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
