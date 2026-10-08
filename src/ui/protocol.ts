/**
 * Message types shared by the extension host and the webview.
 *
 * The two sides run in separate processes and can only communicate by
 * postMessage, so this file is the contract between them. Importing it from
 * both halves means a shape change breaks the build rather than the runtime.
 *
 * Everything here is already formatted for display. The webview renders; it
 * never computes (DESIGN.md §8).
 */

export type HostMessage = { type: "state"; state: ViewState };

export type WebviewMessage =
  | { type: "ready" }
  | { type: "setRange"; days: number | null }
  | { type: "setSource"; source: string }
  | { type: "rescan" };

export interface ModelRowView {
  model: string;
  turns: number;
  sessions: number;
  costPerTurn: string;
  /** Multiple of the cheapest model's cost per turn, e.g. "2.30x". */
  relative: string;
  turnsPerSession: string;
  cacheHitRate: string;
  total: string;
  unpricedTurns: number;
}

export interface SwitchView {
  when: string;
  label: string;
  intraSession: boolean;
}

export interface ChartSeries {
  model: string;
  /** A VS Code theme variable name, e.g. "--vscode-charts-blue". */
  colorVar: string;
  /**
   * Cost per turn, already scaled to the display unit (dollars, or credits)
   * because the webview computes nothing. Null where the model was unused
   * that day — a gap, not a fall to zero.
   */
  values: Array<number | null>;
  /** Turns per day, parallel to `values`. Drawn as the stacked bar panel. */
  turns: number[];
  /** Pre-formatted cost for the tooltip, parallel to `values`. */
  labels: Array<string | null>;
}

/** One panel's vertical scale, with its ticks already formatted. */
export interface ChartAxis {
  max: number;
  ticks: Array<{ value: number; label: string }>;
}

export interface ChartData {
  days: string[];
  /** Pre-formatted short labels for the x axis, parallel to `days`. */
  dayLabels: string[];
  series: ChartSeries[];
  /**
   * Two panels, never two scales on one panel: cost per turn and turn counts
   * are different measures, and overlaying them on a shared y-axis is the
   * single most common way a chart misleads. They share the x-axis instead.
   */
  cost: ChartAxis;
  turns: ChartAxis;
  /** Heading for the cost panel, naming its unit, e.g. "Cost per turn ($)". */
  costLabel: string;
}

export interface BillingView {
  /** Short label shown beside the title, e.g. "API credits". */
  label: string;
  /** Long explanation revealed by the info control. */
  detail: string;
  detected: boolean;
}

/** One ingested assistant, for the source switcher. */
export interface SourceView {
  id: string;
  label: string;
  turns: number;
}

export interface ViewState {
  /**
   * Every source with data, and which one this state describes.
   *
   * The dashboard shows exactly one source at a time. Its figures are in that
   * source's own unit, and there is no combined view, because a dollar total
   * and a credit total cannot be added or placed on one axis (PRD §4.5).
   */
  sources: SourceView[];
  activeSource: string;
  billing: BillingView;
  backend: string;
  rangeLabel: string;
  empty: boolean;
  totals: { turns: number; sessions: number; total: string; unpricedTurns: number };
  rows: ModelRowView[];
  chart: ChartData;
  switches: SwitchView[];
  warnings: string[];
}
