import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createStore, type Store } from "./store/index.ts";
import { scan } from "./ingest/scanner.ts";
import { claudeCodeAdapter } from "./ingest/claudeCode.ts";
import { copilotAdapter } from "./ingest/copilot.ts";
import {
  buildRateTable,
  formatMoney,
  AIU_NANO,
  type RateTable,
  type PricingFile,
  type Unit,
} from "./metrics/cost.ts";
import {
  modelRows,
  totals,
  developerModelSwitches,
  filterByRange,
  dailySeries,
  partitionBySource,
} from "./metrics/aggregate.ts";
import type { ViewState, ModelRowView, ChartData, SourceView, ChartAxis } from "./ui/protocol.ts";
import {
  detectBilling,
  billingCopy,
  copilotBillingCopy,
  type BillingInfo,
} from "./ingest/billing.ts";
import type { Turn, TurnSource } from "./ingest/types.ts";

const DAY_MS = 86_400_000;
const MICRO = 1_000_000;

/** Display names for the sources. An unknown id falls back to the id itself. */
/** The folded "Other" bucket. Deliberately not a series hue — it is an absence of identity, not a seventh one. */
const OVERFLOW_COLOR = "--vscode-descriptionForeground";

const SOURCE_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  copilot: "GitHub Copilot",
};

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
  /**
   * Where Copilot's per-workspace debug logs live. Empty disables Copilot
   * ingest entirely — which is the state for any user who has never turned
   * Copilot's own logging on, and is not an error.
   */
  copilotLogPaths?: readonly string[];
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
    this.warnings = this.warnings.filter((w) => !w.startsWith("Ingest:"));

    // Each source gets its own roots: Claude Code's logs and Copilot's live in
    // unrelated places, and offering every adapter every root would mean
    // walking a large tree looking for files that cannot be there.
    const res = scan(this.store, this.opts.logPaths, [claudeCodeAdapter]);
    const copilotPaths = this.opts.copilotLogPaths ?? [];
    const copilotRes =
      copilotPaths.length > 0
        ? scan(this.store, copilotPaths, [copilotAdapter])
        : null;

    // A missing Claude Code directory is worth saying; a missing Copilot one
    // is the normal state for anyone not using Copilot and is not reported.
    if (res.missingPaths.length) {
      this.warnings.push(`Ingest: no log directory at ${res.missingPaths.join(", ")}`);
    }

    const byKind = new Map<string, number>();
    for (const d of [...res.diagnostics, ...(copilotRes?.diagnostics ?? [])]) {
      byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1);
    }
    for (const [kind, n] of byKind) {
      this.warnings.push(`Ingest: ${n} record(s) with "${kind}".`);
    }
  }

  /**
   * The sources present in the store, most-used first.
   *
   * The dashboard shows one at a time rather than merging them. That is not a
   * simplification: a dollar total and a credit total cannot be summed or put
   * on one axis (PRD §4.5), so a combined view would have to either invent a
   * conversion or show a number denominated in nothing.
   */
  private sourceViews(): SourceView[] {
    const parts = partitionBySource(this.store.allTurns());
    return [...parts.entries()]
      .map(([id, list]) => ({ id, label: SOURCE_LABELS[id] ?? id, turns: list.length }))
      .sort((a, b) => b.turns - a.turns || a.id.localeCompare(b.id));
  }

  /**
   * Colour per model, assigned from a stable ordering over the WHOLE store
   * rather than over the filtered range.
   *
   * Two rules this exists to keep. Colour follows the model, not its rank, so
   * narrowing the date range cannot repaint the models that survive. And hues
   * are never cycled: past the palette's six distinguishable series the
   * remainder folds into one "Other" bucket, because a seventh model drawn in
   * a repeated colour is worse than one drawn as "other".
   */
  private modelColors(): Map<string, string> {
    const byModel = new Map<string, number>();
    for (const t of this.store.allTurns()) {
      byModel.set(t.model, (byModel.get(t.model) ?? 0) + 1);
    }
    const ordered = [...byModel.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([model]) => model);

    const out = new Map<string, string>();
    ordered.forEach((model, i) => {
      if (i < SERIES_COLORS.length) out.set(model, SERIES_COLORS[i]!);
    });
    return out;
  }

  /**
   * One line, so one source: the most-used one. Its unit is shown rather than
   * converted, so a credits figure reads as credits and is never mistaken for
   * dollars — which is also why there is no combined figure here.
   */
  statusText(): string {
    const now = Date.now();
    const primary = (this.sourceViews()[0]?.id ?? "claude-code") as TurnSource;
    const turns = partitionBySource(this.store.allTurns()).get(primary) ?? [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTot = totals(filterByRange(turns, today.getTime(), now), this.table);
    const monthTot = totals(filterByRange(turns, now - 30 * DAY_MS, now), this.table);
    const fmt = (t: { totalCost: number; unit: Unit }) =>
      formatMoney({ amount: t.totalCost, unit: t.unit });
    return `$(pulse) ${fmt(todayTot)} · ${fmt(monthTot)}/30d`;
  }

  /**
   * The dashboard for ONE source.
   *
   * `source` selects which; an unknown or absent one falls back to the
   * most-used source present. Every figure in the returned state is in that
   * source's own unit, which is what makes a single-unit chart axis and a
   * single-unit total honest.
   */
  viewState(rangeDays: number | null, source?: string): ViewState {
    const now = Date.now();
    const from = rangeDays === null ? 0 : now - rangeDays * DAY_MS;
    const sources = this.sourceViews();
    const active: TurnSource =
      source && sources.some((s) => s.id === source)
        ? (source as TurnSource)
        : ((sources[0]?.id ?? "claude-code") as TurnSource);

    const inRange = filterByRange(this.store.allTurns(), from, now);
    const turns: readonly Turn[] = partitionBySource(inRange).get(active) ?? [];

    const tot = totals(turns, this.table);
    const rows = modelRows(turns, this.table);
    const cheapest = rows.find((r) => r.costPerTurn !== null)?.costPerTurn ?? null;
    const money = (amount: number) => formatMoney({ amount, unit: tot.unit });

    const viewRows: ModelRowView[] = rows.map((r) => ({
      model: r.model,
      turns: r.turns,
      sessions: r.sessions,
      costPerTurn: r.costPerTurn === null ? "unavailable" : money(r.costPerTurn),
      // The relative column leads over absolute money (PRD §8.2). It is a
      // ratio within one source, so it stays dimensionless and comparable.
      relative:
        r.costPerTurn === null || cheapest === null || cheapest === 0
          ? "—"
          : `${(r.costPerTurn / cheapest).toFixed(2)}x`,
      turnsPerSession: r.turnsPerSession.toFixed(1),
      cacheHitRate: `${(r.cacheHitRate * 100).toFixed(1)}%`,
      total: money(r.totalCost),
      unpricedTurns: r.unpricedTurns,
    }));

    const chart = this.buildChart(turns, tot.unit);

    const switches = developerModelSwitches(turns).map((s) => ({
      when: new Date(s.ts).toLocaleString(),
      label: `${s.from} → ${s.to}`,
      intraSession: s.intraSession,
    }));

    // Billing copy belongs to the source being shown: Copilot's figures are
    // measured credits against an allowance Modelog cannot see, which is a
    // different claim from Claude Code's derived dollars.
    const billing =
      active === "copilot"
        ? { ...copilotBillingCopy(), detected: true }
        : { ...billingCopy(this.billing), detected: this.billing.detected };

    return {
      sources,
      activeSource: active,
      billing,
      backend: this.store.backend,
      rangeLabel: rangeDays === null ? "All time" : `Last ${rangeDays} days`,
      empty: tot.turns === 0,
      totals: {
        turns: tot.turns,
        sessions: tot.sessions,
        total: money(tot.totalCost),
        unpricedTurns: tot.unpricedTurns,
      },
      rows: viewRows,
      chart,
      switches,
      warnings: [...this.warnings],
    };
  }

  private buildChart(turns: readonly Turn[], unit: Unit): ChartData {
    const { days, series } = dailySeries(turns, this.table);
    const colors = this.modelColors();

    // Models past the palette fold into one bucket rather than repeating a
    // hue. Their turns still count; only their identity is merged.
    const named = series.filter((s) => colors.has(s.model));
    const overflow = series.filter((s) => !colors.has(s.model));
    const folded = overflow.length
      ? [
          {
            model: `Other (${overflow.length} models)`,
            // Cost per turn cannot be averaged across models meaningfully, so
            // the folded bucket contributes turns only and draws no cost line.
            values: days.map(() => null as number | null),
            turns: days.map((_, i) => overflow.reduce((n, s) => n + (s.turns[i] ?? 0), 0)),
          },
        ]
      : [];

    const scale = unit === "aiu_nano" ? AIU_NANO : MICRO;
    const display = (amount: number) => amount / scale;

    let costMax = 0;
    for (const s of named) {
      for (const v of s.values) if (v !== null && v > costMax) costMax = v;
    }
    let turnsMax = 0;
    for (let i = 0; i < days.length; i++) {
      const total = series.reduce((n, s) => n + (s.turns[i] ?? 0), 0);
      if (total > turnsMax) turnsMax = total;
    }

    const costCeiling = niceCeiling(display(costMax));
    const turnCeiling = turnsCeiling(turnsMax);

    return {
      days,
      dayLabels: days.map(shortDay),
      series: [...named, ...folded].map((s) => ({
        model: s.model,
        colorVar: colors.get(s.model) ?? OVERFLOW_COLOR,
        values: s.values.map((v) => (v === null ? null : display(v))),
        turns: s.turns,
        labels: s.values.map((v) => (v === null ? null : formatMoney({ amount: v, unit }))),
      })),
      cost: axisFor(costCeiling, (v) => formatMoney({ amount: Math.round(v * scale), unit })),
      turns: axisFor(turnCeiling, (v) => String(Math.round(v))),
      costLabel: unit === "aiu_nano" ? "Cost per turn (credits)" : "Cost per turn ($)",
    };
  }

  /** Turns held per source. Used by the Copilot status command to report what was actually ingested, rather than only what is configured. */
  sourceCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [source, list] of partitionBySource(this.store.allTurns())) {
      out[source] = list.length;
    }
    return out;
  }

  exportJson(): string {
    return this.store.exportJson();
  }

  dispose(): void {
    this.store?.close();
  }
}


/** Round a max value up to a readable axis ceiling. */
/**
 * A round number at or above `v`.
 *
 * Deliberately NOT rounded to an integer: a cost-per-turn axis is routinely
 * well under a dollar, and rounding 0.002 to 0 would collapse the scale to
 * nothing. Callers that need whole numbers (a turn count) round themselves.
 */
function niceCeiling(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * mag;
    if (candidate >= v) return candidate;
  }
  return 10 * mag;
}

/** A turn-count ceiling divisible by four, so all five ticks are whole turns. */
function turnsCeiling(v: number): number {
  return Math.max(4, Math.ceil(niceCeiling(v) / 4) * 4);
}

/** Five evenly spaced ticks with labels formatted host-side, since the webview computes nothing. */
function axisFor(max: number, label: (v: number) => string): ChartAxis {
  const ticks = [];
  for (let i = 0; i <= 4; i++) {
    const value = (max / 4) * i;
    ticks.push({ value, label: label(value) });
  }
  return { max, ticks };
}

/**
 * Locale-aware, matching the "Model switches" list's `toLocaleString()` — not
 * a hardcoded month/day order. `iso` is a local calendar-date key (`dayKey`),
 * so it's parsed into y/m/d and rebuilt with the local-time constructor
 * rather than `new Date(iso)`, which parses as UTC midnight and can land on
 * the wrong calendar day once formatted in a locale behind UTC.
 */
function shortDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" });
}
