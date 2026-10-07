import { formatMoney, type Unit } from "../metrics/cost.ts";
import type { StoreOpenResult, StoreStatus } from "./readOnlyStore.ts";

/**
 * The §8.7 response envelope, built once and routed through by every tool.
 *
 * Centralising this is what makes "a tool must never turn no-data into
 * zeros" (MCP.md §8.7) structural rather than a convention each handler has
 * to remember: `buildEnvelope` forces `data` to `null` whenever the store
 * status is not "ok", regardless of what a handler computed.
 */

const DAY_MS = 86_400_000;
const DEFAULT_RANGE_DAYS = 30;
const STALE_RATE_TABLE_MS = 90 * DAY_MS;

/**
 * Money is always an integer plus an explicit unit (PRD §8.2, MCP.md §8.7).
 *
 * The unit is never implied by context, because there is more than one: a
 * Claude Code figure is `usd_micro` (derived from tokens and rates) and a
 * Copilot figure is `aiu_nano` (measured and reported by Copilot itself).
 * **No conversion between them exists**, so an agent must not add or divide
 * two amounts without checking that their units match.
 */
export interface Money {
  amount: number;
  unit: Unit;
  formatted: string;
}

export function toMoney(amount: number, unit: Unit = "usd_micro"): Money {
  return { amount, unit, formatted: formatMoney({ amount, unit }) };
}

/** A cost can be null — unknown model, unknown pricing modifier, or a source that reported none — and that must survive into the envelope rather than becoming $0. */
export function toMoneyOrNull(amount: number | null, unit: Unit = "usd_micro"): Money | null {
  return amount === null ? null : toMoney(amount, unit);
}

/**
 * `range` is nullable because a tool need not take one. `get_definitions`
 * describes the whole store, so its range is the store's own extent — and an
 * empty store has no extent. Reporting `now..now` there would assert a range
 * that does not exist, which is the same class of error as reporting a gap as
 * a zero.
 */
export interface Envelope<T> {
  status: StoreStatus;
  range: { from: string | null; to: string | null };
  data: T | null;
  notes: string[];
}

/**
 * Assemble the envelope from the store's open result. `data` is discarded in
 * favour of `null` whenever `status` is not "ok" — a handler cannot
 * accidentally report emptiness as a zero reading.
 */
export function buildEnvelope<T>(
  opened: Pick<StoreOpenResult, "status" | "note">,
  range: { from: number | null; to: number | null },
  data: T,
  notes: string[] = [],
): Envelope<T> {
  return {
    status: opened.status,
    range: toIsoRange(range),
    data: opened.status === "ok" ? data : null,
    notes: opened.note ? [opened.note, ...notes] : notes,
  };
}

function toIsoRange(range: { from: number | null; to: number | null }): {
  from: string | null;
  to: string | null;
} {
  return { from: toIso(range.from), to: toIso(range.to) };
}

function toIso(ts: number | null): string | null {
  return ts === null ? null : new Date(ts).toISOString();
}

export interface RangeArgs {
  days?: number;
  from?: string;
  to?: string;
}

export type RangeResult =
  | { ok: true; from: number; to: number }
  | { ok: false; error: string };

/**
 * Shared range parsing for every tool (MCP.md §8). `days` and `from`/`to` are
 * mutually exclusive — rejected rather than one silently winning, per
 * PLAN-part2.md 2.1. Omitting everything means the last 30 days. Given only
 * one of `from`/`to`, the other defaults relative to it rather than being
 * rejected, so a half-open query still does something sensible.
 */
export function parseRange(args: RangeArgs, now: number = Date.now()): RangeResult {
  const hasDays = args.days !== undefined;
  const hasFrom = args.from !== undefined;
  const hasTo = args.to !== undefined;

  if (hasDays && (hasFrom || hasTo)) {
    return { ok: false, error: 'Pass either "days" or "from"/"to", not both.' };
  }

  if (hasDays) {
    if (!Number.isInteger(args.days) || args.days! <= 0) {
      return { ok: false, error: `"days" must be a positive integer, got ${JSON.stringify(args.days)}.` };
    }
    return { ok: true, from: now - args.days! * DAY_MS, to: now };
  }

  if (!hasFrom && !hasTo) {
    return { ok: true, from: now - DEFAULT_RANGE_DAYS * DAY_MS, to: now };
  }

  const to = hasTo ? Date.parse(args.to!) : now;
  if (Number.isNaN(to)) {
    return { ok: false, error: `"to" is not a valid ISO-8601 date: ${JSON.stringify(args.to)}.` };
  }

  const from = hasFrom ? Date.parse(args.from!) : to - DEFAULT_RANGE_DAYS * DAY_MS;
  if (Number.isNaN(from)) {
    return { ok: false, error: `"from" is not a valid ISO-8601 date: ${JSON.stringify(args.from)}.` };
  }

  if (from > to) {
    return { ok: false, error: `"from" (${args.from}) is after "to" (${args.to}).` };
  }

  return { ok: true, from, to };
}

/**
 * Shared across every cost-bearing tool (MCP.md §9: "Rate table older than
 * 90 days" is a notes-level warning, not a blocking failure). Mirrors the
 * wording `ModelogService` already shows in the dashboard, so the same
 * staleness reads the same way in both surfaces.
 */
export function staleRateTableNote(effectiveDate: string, now: number = Date.now()): string | null {
  const age = now - Date.parse(effectiveDate);
  if (age > STALE_RATE_TABLE_MS) {
    return `Rate table is dated ${effectiveDate} — prices may have changed since.`;
  }
  return null;
}
