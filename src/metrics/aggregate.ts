import type { Turn, TurnSource } from "../ingest/types.ts";
import { uncapturedFields, type CapturedField } from "../ingest/capture.ts";
import { turnCost, type RateTable, type Unit } from "./cost.ts";

/**
 * Split turns by which assistant produced them.
 *
 * Every function below that touches money takes **one** partition, because
 * the sources do not share a unit and summing across them would produce a
 * number denominated in nothing (PRD §4.5, §8.2). Callers partition first and
 * aggregate per source; there is no "all sources" total and there should not
 * be one.
 */
export function partitionBySource(turns: readonly Turn[]): Map<TurnSource, Turn[]> {
  const out = new Map<TurnSource, Turn[]>();
  for (const t of turns) {
    let list = out.get(t.source);
    if (!list) out.set(t.source, (list = []));
    list.push(t);
  }
  return out;
}

/**
 * The unit a set of turns is denominated in, asserting they agree.
 *
 * A mixed set is a programming error — a caller that forgot to partition —
 * and is caught here rather than silently producing a sum of two currencies.
 * An empty set reports `usd_micro`, which cannot mislead: there is no nonzero
 * figure for the unit to be wrong about.
 */
export function unitOf(turns: readonly Turn[]): Unit {
  let unit: Unit | null = null;
  for (const t of turns) {
    const u: Unit = t.source === "copilot" ? "aiu_nano" : "usd_micro";
    if (unit === null) unit = u;
    else if (unit !== u) {
      throw new Error(
        "aggregate: turns from more than one source were passed together; " +
          "partitionBySource() first — their costs are in different units and cannot be summed",
      );
    }
  }
  return unit ?? "usd_micro";
}

/** One row of the model comparison table — the hero surface (DESIGN.md §10.2). */
export interface ModelRow {
  model: string;
  turns: number;
  sessions: number;
  /** Denominated in `unit`. Not micro-dollars unless `unit` says so. */
  totalCost: number;
  unit: Unit;
  /** Turns whose cost was unavailable; excluded from `totalCost`. */
  unpricedTurns: number;
  costPerTurn: number | null;
  turnsPerSession: number;
  cacheHitRate: number;
  inferenceCalls: number;
  /** Turns made by a subagent. A model may be used entirely by subagents. */
  sidechainTurns: number;
}

export interface Totals {
  turns: number;
  sessions: number;
  /** Denominated in `unit`. */
  totalCost: number;
  unit: Unit;
  unpricedTurns: number;
  firstTs: number | null;
  lastTs: number | null;
  /** Sum of `iterations` — the underlying inference calls, not the turns. */
  inferenceCalls: number;
  /** Cache-read tokens over all input-side tokens. 0 when there are none. */
  cacheHitRate: number;
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
  const unit = unitOf(turns);
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
    let sidechain = 0;
    const sessions = new Set<string>();

    for (const t of list) {
      const c = turnCost(t, table);
      if (c === null) unpriced++;
      else cost += c.amount;

      cacheRead += t.cacheReadTokens;
      inputSide +=
        t.inputTokens + t.cacheReadTokens + t.cacheWrite5mTokens + t.cacheWrite1hTokens;
      calls += t.iterations;
      if (t.isSidechain) sidechain++;
      sessions.add(t.sessionId);
    }

    const priced = list.length - unpriced;
    rows.push({
      model,
      turns: list.length,
      sessions: sessions.size,
      totalCost: cost,
      unit,
      unpricedTurns: unpriced,
      costPerTurn: priced > 0 ? Math.round(cost / priced) : null,
      turnsPerSession: sessions.size > 0 ? list.length / sessions.size : 0,
      cacheHitRate: inputSide > 0 ? cacheRead / inputSide : 0,
      inferenceCalls: calls,
      sidechainTurns: sidechain,
    });
  }

  // Cheapest per turn first — the comparison the product exists to make.
  // Safe to sort across rows because every row here shares one unit.
  rows.sort((a, b) => (a.costPerTurn ?? Infinity) - (b.costPerTurn ?? Infinity));
  return rows;
}

export function totals(turns: readonly Turn[], table: RateTable): Totals {
  const unit = unitOf(turns);
  let cost = 0;
  let unpriced = 0;
  let first: number | null = null;
  let last: number | null = null;
  let calls = 0;
  let cacheRead = 0;
  let inputSide = 0;
  const sessions = new Set<string>();

  for (const t of turns) {
    const c = turnCost(t, table);
    if (c === null) unpriced++;
    else cost += c.amount;
    sessions.add(t.sessionId);
    if (first === null || t.ts < first) first = t.ts;
    if (last === null || t.ts > last) last = t.ts;
    calls += t.iterations;
    cacheRead += t.cacheReadTokens;
    inputSide += t.inputTokens + t.cacheReadTokens + t.cacheWrite5mTokens + t.cacheWrite1hTokens;
  }

  return {
    turns: turns.length,
    sessions: sessions.size,
    totalCost: cost,
    unit,
    unpricedTurns: unpriced,
    firstTs: first,
    lastTs: last,
    inferenceCalls: calls,
    cacheHitRate: inputSide > 0 ? cacheRead / inputSide : 0,
  };
}

/** One row of per-session history. Also what Phase 0.1's session table needs. */
export interface SessionRow {
  sessionId: string;
  firstTs: number;
  lastTs: number;
  /** Last turn minus first turn. A session with one turn has a duration of 0. */
  durationMs: number;
  turns: number;
  inferenceCalls: number;
  sidechainTurns: number;
  /** Distinct, sorted. More than one means the model changed mid-session. */
  models: string[];
  /**
   * Distinct, sorted, nulls dropped. Arrays rather than a single value
   * because a session can span a branch change, and picking one of them
   * would be a quiet misreport.
   */
  branches: string[];
  cwds: string[];
  entrypoints: string[];
  /**
   * Distinct, sorted. Fields Modelog had not yet started recording for at
   * least one of these turns, so an empty `entrypoints` or a `false`
   * subagent flag on this session may mean unknown rather than none.
   */
  uncapturedFields: CapturedField[];
  /** Turns with at least one uncaptured field. */
  uncapturedTurns: number;
  /** Denominated in `unit`. */
  totalCost: number;
  unit: Unit;
  unpricedTurns: number;
  cacheHitRate: number;
}

/**
 * Group turns into sessions, most recently active first.
 *
 * Every figure covers exactly the turns passed in. When the caller has
 * filtered — by model, say — these are the stats of the matching turns, not
 * of the whole session, and the caller is responsible for saying so.
 */
export function sessionRows(turns: readonly Turn[], table: RateTable): SessionRow[] {
  const bySession = new Map<string, Turn[]>();
  for (const t of turns) {
    let list = bySession.get(t.sessionId);
    if (!list) bySession.set(t.sessionId, (list = []));
    list.push(t);
  }

  const rows: SessionRow[] = [];
  for (const [sessionId, list] of bySession) {
    let cost = 0;
    let unpriced = 0;
    let calls = 0;
    let sidechain = 0;
    let cacheRead = 0;
    let inputSide = 0;
    let first = Infinity;
    let last = -Infinity;
    const models = new Set<string>();
    const branches = new Set<string>();
    const cwds = new Set<string>();
    const entrypoints = new Set<string>();
    const uncaptured = new Set<CapturedField>();
    let uncapturedTurns = 0;

    for (const t of list) {
      const c = turnCost(t, table);
      if (c === null) unpriced++;
      else cost += c.amount;

      calls += t.iterations;
      if (t.isSidechain) sidechain++;
      cacheRead += t.cacheReadTokens;
      inputSide += t.inputTokens + t.cacheReadTokens + t.cacheWrite5mTokens + t.cacheWrite1hTokens;
      if (t.ts < first) first = t.ts;
      if (t.ts > last) last = t.ts;

      models.add(t.model);
      if (t.gitBranch !== null) branches.add(t.gitBranch);
      if (t.cwd !== null) cwds.add(t.cwd);
      if (t.entrypoint !== null) entrypoints.add(t.entrypoint);
      const missing = uncapturedFields(t);
      if (missing.length > 0) uncapturedTurns++;
      for (const f of missing) uncaptured.add(f);
    }

    rows.push({
      sessionId,
      firstTs: first,
      lastTs: last,
      durationMs: last - first,
      turns: list.length,
      inferenceCalls: calls,
      sidechainTurns: sidechain,
      models: [...models].sort(),
      branches: [...branches].sort(),
      cwds: [...cwds].sort(),
      entrypoints: [...entrypoints].sort(),
      uncapturedFields: [...uncaptured].sort(),
      uncapturedTurns,
      totalCost: cost,
      // Per session, not per call: a session belongs to exactly one source,
      // so a mixed list of sessions is legitimate here even though a mixed
      // list of turns is not legitimate anywhere that sums them.
      unit: unitOf(list),
      unpricedTurns: unpriced,
      cacheHitRate: inputSide > 0 ? cacheRead / inputSide : 0,
    });
  }

  rows.sort((a, b) => b.lastTs - a.lastTs);
  return rows;
}

/**
 * Observed anchors (PRD §6): two consecutive turns with different models.
 * Ordered globally by timestamp, so a switch is detected whether the user
 * changed model mid-session or between sessions.
 */
/**
 * Model switches the **developer** made.
 *
 * Subagent turns are dropped before detection. A subagent runs on a model the
 * developer did not choose and control returns to the original model
 * afterwards, so each isolated subagent turn otherwise manufactures TWO
 * switches that never happened. Measured on a real store: 29 sidechain turns
 * out of 1,603 (1.8%) produced 2 of 6 reported switches.
 *
 * This is the function every surface should use. `modelSwitches` below is the
 * raw primitive and will happily report subagent transitions; it exists so
 * the filtering stays visible at one call site rather than being baked in
 * where a caller cannot see it.
 */
export function developerModelSwitches(turns: readonly Turn[]): ModelSwitch[] {
  return modelSwitches(turns.filter((t) => !t.isSidechain));
}

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

  // model -> day index -> running { cost, turns, priced }
  //
  // `turns` counts every turn, including unpriced ones, because it is a
  // volume figure in its own right — it drives the turns-per-day bars, and a
  // model with no rate still did the work. `priced` is the divisor for the
  // cost average, so an unpriced turn cannot drag that average down.
  const acc = new Map<string, Array<{ cost: number; turns: number; priced: number }>>();
  for (const t of turns) {
    const i = dayIndex.get(dayKey(t.ts));
    if (i === undefined) continue;
    let row = acc.get(t.model);
    if (!row) {
      row = days.map(() => ({ cost: 0, turns: 0, priced: 0 }));
      acc.set(t.model, row);
    }
    row[i]!.turns += 1;
    const c = turnCost(t, table);
    if (c === null) continue; // an unpriced turn has no cost to average in
    row[i]!.cost += c.amount;
    row[i]!.priced += 1;
  }

  const series = [...acc.entries()]
    .map(([model, row]) => ({
      model,
      values: row.map((cell) => (cell.priced > 0 ? Math.round(cell.cost / cell.priced) : null)),
      turns: row.map((cell) => cell.turns),
    }))
    .sort((a, b) => a.model.localeCompare(b.model));

  return { days, series };
}
