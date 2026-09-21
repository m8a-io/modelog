import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createStore, type Store } from "./store/index.ts";
import { scan } from "./ingest/scanner.ts";
import { buildRateTable, formatMicroUsd, type RateTable, type PricingFile } from "./metrics/cost.ts";
import { modelRows, totals, modelSwitches, filterByRange, dailySeries, dayKey } from "./metrics/aggregate.ts";
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

  statusText(): string {
    const now = Date.now();
    const turns = this.store.allTurns();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayCost = totals(filterByRange(turns, today.getTime(), now), this.table).totalCostMicro;
    const monthCost = totals(filterByRange(turns, now - 30 * DAY_MS, now), this.table).totalCostMicro;
    return `$(pulse) ${formatMicroUsd(todayCost)} · ${formatMicroUsd(monthCost)}/30d`;
  }

  viewState(rangeDays: number | null): ViewState {
    const now = Date.now();
    const from = rangeDays === null ? 0 : now - rangeDays * DAY_MS;
    const turns = filterByRange(this.store.allTurns(), from, now);

    const tot = totals(turns, this.table);
    const rows = modelRows(turns, this.table);
    const cheapest = rows.find((r) => r.costPerTurnMicro !== null)?.costPerTurnMicro ?? null;

    const viewRows: ModelRowView[] = rows.map((r) => ({
      model: r.model,
      turns: r.turns,
      sessions: r.sessions,
      costPerTurn: r.costPerTurnMicro === null ? "unavailable" : formatMicroUsd(r.costPerTurnMicro),
      // The relative column leads over absolute dollars (PRD §8.2).
      relative:
        r.costPerTurnMicro === null || cheapest === null || cheapest === 0
          ? "—"
          : `${(r.costPerTurnMicro / cheapest).toFixed(2)}x`,
      turnsPerSession: r.turnsPerSession.toFixed(1),
      cacheHitRate: `${(r.cacheHitRate * 100).toFixed(1)}%`,
      total: formatMicroUsd(r.totalCostMicro),
      unpricedTurns: r.unpricedTurns,
    }));

    const chart = this.buildChart(turns);

    const switches = modelSwitches(turns).map((s) => ({
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
        total: formatMicroUsd(tot.totalCostMicro),
        unpricedTurns: tot.unpricedTurns,
      },
      rows: viewRows,
      chart,
      switches,
      warnings: [...this.warnings],
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
    const switches = modelSwitches(turns)
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
