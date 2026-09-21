import type { HostMessage, ViewState, ModelRowView } from "../ui/protocol.ts";
import { renderChart, type ChartHandle } from "./chart.ts";

/**
 * Runs in the webview (a browser context). Renders what the host sends and
 * computes nothing — every number arrives pre-formatted.
 */

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

const vscode = acquireVsCodeApi();
const app = document.getElementById("app")!;

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  if (event.data.type === "state") render(event.data.state);
});

vscode.postMessage({ type: "ready" });

const RANGES: Array<[string, number | null]> = [
  ["7d", 7],
  ["30d", 30],
  ["90d", 90],
  ["All", null],
];
let activeRange: number | null = 30;
/** The live chart, disposed before each re-render so ECharts frees its DOM. */
let chart: ChartHandle | undefined;

function render(state: ViewState): void {
  chart?.dispose();
  chart = undefined;
  app.replaceChildren();
  app.append(header(state));

  for (const w of state.warnings) app.append(banner(w, "warn"));

  if (state.empty) {
    app.append(
      el("p", "No sessions found yet. Modelog reads ~/.claude/projects.", "muted"),
    );
    return;
  }

  app.append(summary(state));

  if (state.chart.days.length > 1) {
    app.append(el("h2", "Cost per turn"));
    const host = el("div", "", "chart");
    app.append(host);
    // ECharts measures its container, so it must be in the DOM first.
    requestAnimationFrame(() => {
      chart = renderChart(host, state.chart);
    });
  }

  app.append(el("h2", "Model comparison"));
  app.append(comparisonTable(state.rows));

  if (state.switches.length) {
    app.append(el("h2", `Model switches (${state.switches.length})`));
    app.append(switchList(state));
  }
}

function header(state: ViewState): HTMLElement {
  const bar = el("div", "", "header");

  const title = el("div", "", "title");
  title.append(el("h1", "Modelog"), billingTag(state));
  bar.append(title);

  const controls = el("div", "", "controls");
  for (const [label, days] of RANGES) {
    const b = el("button", label, days === activeRange ? "active" : "");
    b.addEventListener("click", () => {
      activeRange = days;
      vscode.postMessage({ type: "setRange", days });
    });
    controls.append(b);
  }
  const rescan = el("button", "Rescan", "ghost");
  rescan.addEventListener("click", () => vscode.postMessage({ type: "rescan" }));
  controls.append(rescan);

  bar.append(controls);
  return bar;
}

/**
 * Billing mode as a quiet label beside the title, with the full explanation
 * behind an info control rather than occupying a banner on every render.
 */
function billingTag(state: ViewState): HTMLElement {
  const wrap = el("span", "", "billing");
  wrap.append(el("span", state.billing.label, "billing-label"));

  const btn = document.createElement("button");
  btn.className = "info-btn";
  btn.type = "button";
  btn.setAttribute("aria-label", `About ${state.billing.label} mode`);
  btn.setAttribute("aria-expanded", "false");
  btn.append(infoIcon());

  const pop = el("div", state.billing.detail, "info-pop");
  pop.hidden = true;
  pop.setAttribute("role", "tooltip");

  const open = (on: boolean) => {
    pop.hidden = !on;
    btn.setAttribute("aria-expanded", String(on));
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    open(pop.hidden);
  });
  btn.addEventListener("mouseenter", () => open(true));
  wrap.addEventListener("mouseleave", () => open(false));
  btn.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") open(false);
  });
  document.addEventListener("click", () => open(false));

  wrap.append(btn, pop);
  return wrap;
}

function infoIcon(): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("aria-hidden", "true");
  const circle = document.createElementNS(ns, "circle");
  circle.setAttribute("cx", "8"); circle.setAttribute("cy", "8"); circle.setAttribute("r", "6.9");
  circle.setAttribute("fill", "none"); circle.setAttribute("stroke", "currentColor");
  circle.setAttribute("stroke-width", "1.2");
  const dot = document.createElementNS(ns, "rect");
  dot.setAttribute("x", "7.35"); dot.setAttribute("y", "4"); dot.setAttribute("width", "1.3");
  dot.setAttribute("height", "1.3"); dot.setAttribute("fill", "currentColor");
  const stem = document.createElementNS(ns, "rect");
  stem.setAttribute("x", "7.35"); stem.setAttribute("y", "6.5"); stem.setAttribute("width", "1.3");
  stem.setAttribute("height", "5.5"); stem.setAttribute("fill", "currentColor");
  svg.append(circle, dot, stem);
  return svg;
}

function summary(state: ViewState): HTMLElement {
  const wrap = el("div", "", "stats");
  const stat = (label: string, value: string) => {
    const s = el("div", "", "stat");
    s.append(el("div", value, "stat-value"), el("div", label, "stat-label"));
    return s;
  };
  wrap.append(
    stat(state.rangeLabel, state.totals.total),
    stat("Turns", String(state.totals.turns)),
    stat("Sessions", String(state.totals.sessions)),
  );
  if (state.totals.unpricedTurns > 0) {
    wrap.append(stat("Unpriced turns", String(state.totals.unpricedTurns)));
  }
  return wrap;
}

function comparisonTable(rows: ModelRowView[]): HTMLElement {
  const table = el("table");
  const thead = el("thead");
  const hr = el("tr");
  for (const [h, cls] of [
    ["Model", ""],
    ["Cost / turn", "num emph"],
    ["Relative", "num emph"],
    ["Turns", "num"],
    ["Sessions", "num"],
    ["Turns / session", "num"],
    ["Cache hit", "num"],
    ["Total", "num"],
  ] as const) {
    hr.append(el("th", h, cls));
  }
  thead.append(hr);
  table.append(thead);

  const tbody = el("tbody");
  for (const r of rows) {
    const tr = el("tr");
    const name = el("td", r.model);
    if (r.unpricedTurns > 0) {
      name.append(el("span", `${r.unpricedTurns} unpriced`, "pill"));
    }
    tr.append(name);
    tr.append(el("td", r.costPerTurn, "num emph"));
    tr.append(el("td", r.relative, "num emph"));
    tr.append(el("td", String(r.turns), "num"));
    tr.append(el("td", String(r.sessions), "num"));
    tr.append(el("td", r.turnsPerSession, "num"));
    tr.append(el("td", r.cacheHitRate, "num"));
    tr.append(el("td", r.total, "num"));
    tbody.append(tr);
  }
  table.append(tbody);

  const wrap = el("div", "", "table-wrap");
  wrap.append(table);
  return wrap;
}

function switchList(state: ViewState): HTMLElement {
  const ul = el("ul", "", "switches");
  for (const s of state.switches) {
    const li = el("li");
    li.append(el("span", s.when, "when"), el("span", s.label, "label"));
    if (s.intraSession) li.append(el("span", "intra-session", "pill"));
    ul.append(li);
  }
  return ul;
}

function banner(text: string, kind: "info" | "warn"): HTMLElement {
  return el("div", text, `banner ${kind}`);
}

function el(tag: string, text = "", cls = ""): HTMLElement {
  const n = document.createElement(tag);
  if (text) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
