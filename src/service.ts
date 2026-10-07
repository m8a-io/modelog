import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createStore, type Store } from "./store/index.ts";
import { scan } from "./ingest/scanner.ts";
import { buildRateTable, formatMicroUsd, type RateTable, type PricingFile } from "./metrics/cost.ts";
import {
  modelRows,
  totals,
  developerModelSwitches,
  filterByRange,
  dailySeries,
  dayKey,
  partitionBySource,
} from "./metrics/aggregate.ts";
import type { ViewState, ModelRowView, ChartData } from "./ui/protocol.ts";
import { detectBilling, billingCopy, type BillingInfo } from "./ingest/billing.ts";
import type { Turn } from "./ingest/types.ts";

const DAY_MS = 86_400_000;

/**
 * VS Code's themed categorical palette. Six distinguishable series is the
 * practical ceiling (DESIGN.md §4.4) — beyond that, colors stop being a
 * reliable distinction and the chart needs a different approach.
 */
const SERIES_COLORS = [
  "--vscode-charts-blue",
  "--vscode-charts-green",
  "--vscode-charts-orange",
  "--vscode-charts-purple",
  "--vscode-charts-red",
  "--vscode-charts-yellow",
];

export interface ServiceOptions {
  storageDir: string;
  extensionDir: string;
  logPaths: readonly string[];
  /** "auto" detects from Claude Code's config; otherwise an explicit override. */
  billingMode: string;
}

/**
 * Owns the store, the rate table and ingest. All aggregation happens here on
 * the host side; the webview receives a finished, pre-formatted view model and
 * computes nothing (DESIGN.md §8).
 */
export class ModelogService {
  private store!: Store;
  private table!: RateTable;
  private warnings: string[] = [];
  private opts: ServiceOptions;
  private billing!: BillingInfo;

  constructor(opts: ServiceOptions) {
    this.opts = opts;
  }

  async init(): Promise<void> {
    const configured = this.opts.billingMode;
    this.billing =
      configured === "api" || configured === "subscription"
        ? { mode: configured, detected: false, rawType: null }
        : detectBilling();

    const { store, warning } = await createStore(this.opts.storageDir);
    this.store = store;
    if (warning) this.warnings.push(warning);

    const pricing: PricingFile = JSON.parse(
      readFileSync(join(this.opts.extensionDir, "data", "pricing.json"), "utf8"),
    );
    this.table = buildRateTable(pricing);

    const age = Date.now() - Date.parse(pricing.effective_date);
    if (age > 90 * DAY_MS) {
      this.warnings.push(
        `Rate table is dated ${pricing.effective_date} — prices may have changed since.`,
      );
    }
  }

  rescan(): void {
    const res = scan(this.store, this.opts.logPaths);
    this.warnings = this.warnings.filter((w) => !w.startsWith("Ingest:"));
    if (res.missingPaths.length) {
      this.warnings.push(`Ingest: no log directory at ${res.missingPaths.join(", ")}`);
    }
    const byKind = new Map<string, number>();
    for (const d of res.diagnostics) byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1);
    for (const [kind, n] of byKind) {
      this.warnings.push(`Ingest: ${n} record(s) with "${kind}".`);
    }
  }

  /**
   * The Claude Code turns only.
   *
   * The dashboard and status bar render one money unit end to end, so they
   * show one source. Copilot's figures are credits and must never be drawn on
   * a dollar axis or summed into a dollar total (PRD §4.5, §8.2); presenting
   * both properly is a design question, not plumbing, and is deferred. Until
   * then Copilot data is reachable through the MCP tools, and its absence
   * here is reported rather than left silent — see `sourceGapWarnings`.
   */
  private claudeCodeTurns(turns: readonly Turn[]): Turn[] {
    return partitionBySource(turns).get("claude-code") ?? [];
  }

  /** Says so when a source exists in the store but is not on this surface. */
  private sourceGapWarnings(turns: readonly Turn[]): string[] {
    const copilot = partitionBySource(turns).get("copilot") ?? [];
    if (copilot.length === 0) return [];
    return [
      `${copilot.length} Copilot turn(s) in range are not shown here. Copilot bills in ` +
        `credits, which cannot share an axis or a total with dollars, so this view is ` +
        `Claude Code only. Copilot figures are available through the MCP tools.`,
    ];
  }

  statusText(): string {
    const now = Date.now();
    const turns = this.claudeCodeTurns(this.store.allTurns());
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayCost = totals(filterByRange(turns, today.getTime(), now), this.table).totalCost;
    const monthCost = totals(filterByRange(turns, now - 30 * DAY_MS, now), this.table).totalCost;
    return `$(pulse) ${formatMicroUsd(todayCost)} · ${formatMicroUsd(monthCost)}/30d`;
  }

  viewState(rangeDays: number | null): ViewState {
    const now = Date.now();
    const from = rangeDays === null ? 0 : now - rangeDays * DAY_MS;
    const inRange = filterByRange(this.store.allTurns(), from, now);
    const turns = this.claudeCodeTurns(inRange);

    const tot = totals(turns, this.table);
    const rows = modelRows(turns, this.table);
    const cheapest = rows.find((r) => r.costPerTurn !== null)?.costPerTurn ?? null;

    const viewRows: ModelRowView[] = rows.map((r) => ({
      model: r.model,
      turns: r.turns,
      sessions: r.sessions,
      costPerTurn: r.costPerTurn === null ? "unavailable" : formatMicroUsd(r.costPerTurn),
      // The relative column leads over absolute dollars (PRD §8.2).
      relative:
        r.costPerTurn === null || cheapest === null || cheapest === 0
          ? "—"
          : `${(r.costPerTurn / cheapest).toFixed(2)}x`,
      turnsPerSession: r.turnsPerSession.toFixed(1),
      cacheHitRate: `${(r.cacheHitRate * 100).toFixed(1)}%`,
      total: formatMicroUsd(r.totalCost),
      unpricedTurns: r.unpricedTurns,
    }));

    const chart = this.buildChart(turns);

    const switches = developerModelSwitches(turns).map((s) => ({
      when: new Date(s.ts).toLocaleString(),
      label: `${s.from} → ${s.to}`,
      intraSession: s.intraSession,
    }));

    return {
      billing: { ...billingCopy(this.billing), detected: this.billing.detected },
      backend: this.store.backend,
      rangeLabel: rangeDays === null ? "All time" : `Last ${rangeDays} days`,
      empty: tot.turns === 0,
      totals: {
        turns: tot.turns,
        sessions: tot.sessions,
        total: formatMicroUsd(tot.totalCost),
        unpricedTurns: tot.unpricedTurns,
      },
      rows: viewRows,
      chart,
      switches,
      warnings: [...this.warnings, ...this.sourceGapWarnings(inRange)],
    };
  }

  private buildChart(turns: readonly Turn[]): ChartData {
    const { days, series } = dailySeries(turns, this.table);

    let max = 0;
    for (const s of series) {
      for (const v of s.values) if (v !== null && v > max) max = v;
    }
    const yMax = niceCeiling(max);

    const dayIndex = new Map(days.map((d, i) => [d, i]));
    // Chart markers use the developer's switches for the same reason the list
    // does; the cost series above deliberately keeps every turn, including
    // subagent ones, because that spend is real.
    const switches = developerModelSwitches(turns)
      .map((s) => ({ dayIndex: dayIndex.get(dayKey(s.ts)) ?? -1, label: `${s.from} → ${s.to}` }))
      .filter((s) => s.dayIndex >= 0);

    return {
      days,
      dayLabels: days.map(shortDay),
      series: series.map((s, i) => ({
        model: s.model,
        colorVar: SERIES_COLORS[i % SERIES_COLORS.length]!,
        values: s.values,
        turns: s.turns,
        labels: s.values.map((v) => (v === null ? null : formatMicroUsd(v))),
      })),
      switches,
      yMaxMicro: yMax,
      yTicks: ticksFor(yMax),
    };
  }

  exportJson(): string {
    return this.store.exportJson();
  }

  dispose(): void {
    this.store?.close();
  }
}


/** Round a max value up to a readable axis ceiling. */
function niceCeiling(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * mag;
    if (candidate >= v) return Math.round(candidate);
  }
  return Math.round(10 * mag);
}

function ticksFor(yMax: number): Array<{ value: number; label: string }> {
  const out = [];
  for (let i = 0; i <= 4; i++) {
    const value = Math.round((yMax / 4) * i);
    out.push({ value, label: formatMicroUsd(value) });
  }
  return out;
}

function shortDay(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${m}/${d}`;
}
