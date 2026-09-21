import type { Turn } from "../ingest/types.ts";
import { turnCostMicro, type RateTable } from "./cost.ts";

/** One row of the model comparison table — the hero surface (DESIGN.md §10.2). */
export interface ModelRow {
  model: string;
  turns: number;
  sessions: number;
  totalCostMicro: number;
  /** Turns whose model had no rate; their cost is excluded from totals. */
  unpricedTurns: number;
  costPerTurnMicro: number | null;
  turnsPerSession: number;
  cacheHitRate: number;
  inferenceCalls: number;
}

export interface Totals {
  turns: number;
  sessions: number;
  totalCostMicro: number;
  unpricedTurns: number;
  firstTs: number | null;
  lastTs: number | null;
}

export interface ModelSwitch {
  ts: number;
  from: string;
  to: string;
  /** True when the switch happened inside one session (PRD risk #11). */
  intraSession: boolean;
}

export function filterByRange(turns: readonly Turn[], from: number, to: number): Turn[] {
  return turns.filter((t) => t.ts >= from && t.ts <= to);
}

export function modelRows(turns: readonly Turn[], table: RateTable): ModelRow[] {
  const byModel = new Map<string, Turn[]>();
  for (const t of turns) {
    let list = byModel.get(t.model);
    if (!list) byModel.set(t.model, (list = []));
    list.push(t);
  }

  const rows: ModelRow[] = [];
  for (const [model, list] of byModel) {
    let cost = 0;
    let unpriced = 0;
    let cacheRead = 0;
    let inputSide = 0;
    let calls = 0;
    const sessions = new Set<string>();

    for (const t of list) {
      const c = turnCostMicro(t, table);
      if (c === null) unpriced++;
      else cost += c;

      cacheRead += t.cacheReadTokens;
      inputSide +=
        t.inputTokens + t.cacheReadTokens + t.cacheWrite5mTokens + t.cacheWrite1hTokens;
      calls += t.iterations;
      sessions.add(t.sessionId);
    }

    const priced = list.length - unpriced;
    rows.push({
      model,
      turns: list.length,
      sessions: sessions.size,
      totalCostMicro: cost,
      unpricedTurns: unpriced,
      costPerTurnMicro: priced > 0 ? Math.round(cost / priced) : null,
      turnsPerSession: sessions.size > 0 ? list.length / sessions.size : 0,
      cacheHitRate: inputSide > 0 ? cacheRead / inputSide : 0,
      inferenceCalls: calls,
    });
  }

  // Cheapest per turn first — the comparison the product exists to make.
  rows.sort((a, b) => (a.costPerTurnMicro ?? Infinity) - (b.costPerTurnMicro ?? Infinity));
  return rows;
}

export function totals(turns: readonly Turn[], table: RateTable): Totals {
  let cost = 0;
  let unpriced = 0;
  let first: number | null = null;
  let last: number | null = null;
  const sessions = new Set<string>();

  for (const t of turns) {
    const c = turnCostMicro(t, table);
    if (c === null) unpriced++;
    else cost += c;
    sessions.add(t.sessionId);
    if (first === null || t.ts < first) first = t.ts;
    if (last === null || t.ts > last) last = t.ts;
  }

  return {
    turns: turns.length,
    sessions: sessions.size,
    totalCostMicro: cost,
    unpricedTurns: unpriced,
    firstTs: first,
    lastTs: last,
  };
}

/**
 * Observed anchors (PRD §6): two consecutive turns with different models.
 * Ordered globally by timestamp, so a switch is detected whether the user
 * changed model mid-session or between sessions.
 */
export function modelSwitches(turns: readonly Turn[]): ModelSwitch[] {
  const ordered = [...turns].sort((a, b) => a.ts - b.ts);
  const out: ModelSwitch[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    if (prev.model !== cur.model) {
      out.push({
        ts: cur.ts,
        from: prev.model,
        to: cur.model,
        intraSession: prev.sessionId === cur.sessionId,
      });
    }
  }
  return out;
}

/** Local calendar date key, per the sessions/day definition in DESIGN.md §9. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export interface DailySeries {
  /** Continuous local dates spanning the range — gaps included, so the x axis is even. */
  days: string[];
  series: Array<{
    model: string;
    /** Cost per turn in micro-dollars, or null on a day with no turns. */
    values: Array<number | null>;
    turns: number[];
  }>;
}

/**
 * Cost per turn per model, bucketed by local day. Days where a model was not
 * used are null rather than zero — an unused model costs nothing, but drawing
 * it at zero would imply it got cheaper.
 */
export function dailySeries(turns: readonly Turn[], table: RateTable): DailySeries {
  if (turns.length === 0) return { days: [], series: [] };

  let min = Infinity;
  let max = -Infinity;
  for (const t of turns) {
    if (t.ts < min) min = t.ts;
    if (t.ts > max) max = t.ts;
  }

  const days: string[] = [];
  const cursor = new Date(min);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(max);
  end.setHours(0, 0, 0, 0);
  while (cursor.getTime() <= end.getTime()) {
    days.push(dayKey(cursor.getTime()));
    cursor.setDate(cursor.getDate() + 1);
  }
  const dayIndex = new Map(days.map((d, i) => [d, i]));

  // model -> day index -> running { cost, turns }
  const acc = new Map<string, Array<{ cost: number; turns: number }>>();
  for (const t of turns) {
    const i = dayIndex.get(dayKey(t.ts));
    if (i === undefined) continue;
    let row = acc.get(t.model);
    if (!row) {
      row = days.map(() => ({ cost: 0, turns: 0 }));
      acc.set(t.model, row);
    }
    const c = turnCostMicro(t, table);
    if (c === null) continue; // unpriced turns cannot enter a cost series
    row[i]!.cost += c;
    row[i]!.turns += 1;
  }

  const series = [...acc.entries()]
    .map(([model, row]) => ({
      model,
      values: row.map((cell) => (cell.turns > 0 ? Math.round(cell.cost / cell.turns) : null)),
      turns: row.map((cell) => cell.turns),
    }))
    .sort((a, b) => a.model.localeCompare(b.model));

  return { days, series };
}
