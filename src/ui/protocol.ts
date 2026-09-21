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
  /** Cost per turn in micro-dollars; null where the model was unused that day. */
  values: Array<number | null>;
  turns: number[];
  /** Pre-formatted for the tooltip, parallel to `values`. */
  labels: Array<string | null>;
}

export interface ChartData {
  days: string[];
  /** Pre-formatted short labels for the x axis, parallel to `days`. */
  dayLabels: string[];
  series: ChartSeries[];
  switches: Array<{ dayIndex: number; label: string }>;
  yMaxMicro: number;
  yTicks: Array<{ value: number; label: string }>;
}

export interface BillingView {
  /** Short label shown beside the title, e.g. "API credits". */
  label: string;
  /** Long explanation revealed by the info control. */
  detail: string;
  detected: boolean;
}

export interface ViewState {
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
