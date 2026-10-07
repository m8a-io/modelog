import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Copilot's per-session rate card (`models.json`, written beside each session's
 * log).
 *
 * Used for exactly one thing: recovering the cache-write token count, which
 * the request event does not report (PRD §7.1 Correction 4). It is **not** a
 * pricing source — Copilot measures and reports the cost of every request
 * itself, so the card never determines what a turn cost.
 *
 * Copilot writing the card in force beside the session it applies to is better
 * provenance than Modelog's own single global `data/pricing.json` snapshot, and
 * is why this is read per session rather than pinned.
 */

/** Prices in nano-AIU per token. */
export interface CopilotPrices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type CopilotCard = ReadonlyMap<string, CopilotPrices>;

/**
 * Card prices are credits per 1M tokens; 1 credit is 1e9 nano-AIU, so a
 * per-token nano-AIU price is `credits_per_1M * 1000`.
 */
const NANO_AIU_PER_CREDIT_PER_TOKEN = 1000;

function scale(price: unknown): number | null {
  if (typeof price !== "number" || !Number.isFinite(price)) return null;
  const scaled = price * NANO_AIU_PER_CREDIT_PER_TOKEN;
  // A card could publish more decimal places than the scale absorbs. Refusing
  // is correct; rounding would silently shift every solve that uses it.
  return Number.isInteger(scaled) ? scaled : null;
}

/**
 * Parse a card. Pure — takes the already-read JSON.
 *
 * A model whose prices do not scale to integers is omitted rather than
 * rounded, which makes its turns unsolvable and therefore visibly `unknown`
 * instead of quietly wrong.
 */
export function parseCard(json: unknown): CopilotCard {
  const out = new Map<string, CopilotPrices>();
  const models = Array.isArray(json)
    ? json
    : Array.isArray((json as { models?: unknown })?.models)
      ? (json as { models: unknown[] }).models
      : [];

  for (const m of models) {
    if (typeof m !== "object" || m === null) continue;
    const entry = m as Record<string, any>;
    const id = entry.id;
    const prices = entry.billing?.token_prices?.default;
    if (typeof id !== "string" || typeof prices !== "object" || prices === null) continue;

    const input = scale(prices.input_price);
    const output = scale(prices.output_price);
    const cacheRead = scale(prices.cache_read_price);
    const cacheWrite = scale(prices.cache_write_price);
    if (input === null || output === null || cacheRead === null || cacheWrite === null) continue;

    out.set(id, { input, output, cacheRead, cacheWrite });
  }
  return out;
}

/** Read the card sitting beside a session log. Missing or unreadable yields an empty card, which makes every turn in that session visibly unsolved rather than wrong. */
export function loadCard(dir: string): CopilotCard {
  try {
    return parseCard(JSON.parse(readFileSync(join(dir, "models.json"), "utf8")));
  } catch {
    return new Map();
  }
}
