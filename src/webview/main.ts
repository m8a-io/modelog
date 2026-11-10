import type {
  HostMessage,
  ViewState,
  ModelRowView,
  DelegationView,
  ChartData,
} from "../ui/protocol.ts";
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
let activeSource = "";
/** The live charts, disposed before each re-render so ECharts frees their DOM. */
let charts: ChartHandle[] = [];

/**
 * The Dashboard's sections (PRD §7.25 W10). Switching tabs is local: the host
 * sends every section's view model in one state, so nothing is recomputed.
 */
type Tab = "home" | "delegation" | "switches" | "work";
let activeTab: Tab = "home";
let lastState: ViewState | null = null;

function render(state: ViewState): void {
  for (const c of charts) c.dispose();
  charts = [];
  lastState = state;
  activeSource = state.activeSource;
  app.replaceChildren();
  app.append(header(state));
  app.append(tabBar(state));

  for (const w of state.warnings) app.append(banner(w, "warn"));

  if (activeTab === "work") {
    app.append(workSessionList(state));
    return;
  }

  if (state.empty) {
    app.append(el("p", `No ${sourceLabel(state)} sessions in this range.`, "muted"));
    if (activeTab === "home" && state.markedChanges.length) appendMarkedChanges(state);
    return;
  }

  switch (activeTab) {
    case "home":
      app.append(summary(state));
      if (state.chart.days.length > 0) {
        app.append(el("h2", "Cost and turns per day"));
        mountChart(state.chart);
      }
      app.append(el("h2", "Model comparison"));
      app.append(comparisonTable(state.rows));
      if (state.markedChanges.length) appendMarkedChanges(state);
      return;
    case "delegation":
      app.append(el("h2", "Delegation"));
      app.append(delegationBlock(state.delegation));
      if (state.delegation.chart && state.delegation.chart.days.length > 0) {
        app.append(el("h2", "Delegation per day"));
        mountChart(state.delegation.chart);
      }
      return;
    case "switches":
      if (state.switches.length) {
        app.append(el("h2", `Model switches (${state.switches.length})`));
        app.append(switchList(state));
      } else {
        app.append(el("p", "No model switches in this range.", "muted"));
      }
      return;
  }
}

function appendMarkedChanges(state: ViewState): void {
  app.append(el("h2", `Marked changes (${state.markedChanges.length})`));
  app.append(markedChangeList(state));
}

/** Section tabs. A count badge only where it says something at a glance. */
function tabBar(state: ViewState): HTMLElement {
  const tabs: Array<[Tab, string, number | null]> = [
    ["home", "Home", null],
    ["delegation", "Delegation", null],
    ["switches", "Model switches", state.switches.length],
    ["work", "Work sessions", state.workSessions.length],
  ];
  const wrap = el("div", "", "tabs");
  wrap.setAttribute("role", "tablist");
  for (const [id, label, count] of tabs) {
    const on = id === activeTab;
    const b = el("button", "", on ? "tab active" : "tab");
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(on));
    b.append(el("span", label, "tab-label"));
    if (count) b.append(el("span", String(count), "tab-count"));
    b.addEventListener("click", () => {
      if (id === activeTab || !lastState) return;
      activeTab = id;
      render(lastState);
    });
    wrap.append(b);
  }
  return wrap;
}

/**
 * Work sessions (PRD §7.25), newest first, from their records alone. The
 * summary and open items are developer-approved text, set as text only.
 */
function workSessionList(state: ViewState): HTMLElement {
  const wrap = el("div", "", "work-sessions");
  wrap.append(
    el(
      "p",
      "A work session is your stretch of work: one or more chats joined by /handoff, " +
        "closed by /done. All tools, all time. Cost and active time per work session " +
        "are not measured yet.",
      "muted small",
    ),
  );
  if (state.workSessions.length === 0) {
    wrap.append(
      el("p", "No work sessions yet. Run /start in a chat to begin one, and /done to close it.", "muted"),
    );
    return wrap;
  }
  const ul = el("ul", "", "switches");
  for (const w of state.workSessions) {
    const li = el("li");
    li.append(el("span", w.started, "when"), el("span", w.status, `pill status-${w.status}`));
    const parts = [
      `${w.chats} chat${w.chats === 1 ? "" : "s"}`,
      `${w.handoffs} handoff${w.handoffs === 1 ? "" : "s"}`,
    ];
    if (w.rating) parts.push(`rated ${w.rating}`);
    li.append(el("span", parts.join(" · "), "label"));
    li.append(el("span", w.timing, "when"));
    if (w.closedLate) li.append(el("span", "closed late", "pill"));
    if (w.startedImplicitly) li.append(el("span", "started without /start", "pill"));
    li.append(el("span", w.tool, "pill"));
    if (w.summary) li.append(el("div", w.summary, "statement"));
    if (w.openItemsHeading) {
      li.append(el("div", w.openItemsHeading, "provenance"));
      const items = el("ul", "", "open-items");
      for (const item of w.openItems) items.append(el("li", item));
      li.append(items);
    }
    if (w.provenanceNote) li.append(el("div", w.provenanceNote, "provenance"));
    ul.append(li);
  }
  wrap.append(ul);
  return wrap;
}

function mountChart(data: ChartData): void {
  const host = el("div", "", "chart");
  app.append(host);
  // ECharts measures its container, so it must be in the DOM first.
  requestAnimationFrame(() => {
    charts.push(renderChart(host, data));
  });
}

/**
 * The delegation split: the headline share sentence, the two proportion
 * bars, and the per-population figures. Everything arrives computed — the
 * shares are drawn from host-sent percentages, never derived here.
 */
function delegationBlock(d: DelegationView): HTMLElement {
  const wrap = el("div", "", "delegation");
  if (d.headline) wrap.append(el("p", d.headline, "delegation-headline"));

  if (d.slices.length > 0) {
    wrap.append(shareBars(d));

    const table = el("table");
    const thead = el("thead");
    const hr = el("tr");
    for (const [h, cls] of [
      ["", ""],
      ["Turns", "num"],
      ["Cost / turn", "num emph"],
      ["Total", "num"],
    ] as const) {
      hr.append(el("th", h, cls));
    }
    thead.append(hr);
    table.append(thead);

    const tbody = el("tbody");
    for (const s of d.slices) {
      const tr = el("tr");
      const name = el("td");
      const dot = el("span", "", "dot-sm");
      dot.style.background = `var(${s.colorVar})`;
      name.append(dot, document.createTextNode(s.label));
      if (s.unpricedTurns > 0) {
        name.append(el("span", `${s.unpricedTurns} unpriced`, "pill"));
      }
      tr.append(name);
      tr.append(el("td", String(s.turns), "num"));
      tr.append(el("td", s.costPerTurn, "num emph"));
      tr.append(el("td", s.total, "num"));
      tbody.append(tr);
    }
    table.append(tbody);

    const tableWrap = el("div", "", "table-wrap delegation-table");
    tableWrap.append(table);
    wrap.append(tableWrap);
  }

  if (d.note) wrap.append(el("p", d.note, "muted small"));
  return wrap;
}

/**
 * Two 100% split bars, Turns and Cost, so the asymmetry between them is the
 * visible thing: a wide sub-agent slice on Turns beside a sliver on Cost is
 * the whole point of the section.
 */
function shareBars(d: DelegationView): HTMLElement {
  const rows: Array<[string, (s: DelegationView["slices"][number]) => number]> = [
    ["Turns", (s) => s.turnsPct],
    ["Cost", (s) => s.costPct],
  ];
  const wrap = el("div", "", "share-rows");
  for (const [label, pctOf] of rows) {
    // When nothing in either slice could be priced, both cost shares arrive
    // as 0 and there is no cost proportion to draw.
    if (d.slices.every((s) => pctOf(s) === 0)) continue;
    const row = el("div", "", "share-row");
    row.append(el("span", label, "share-label"));
    const bar = el("div", "", "share-bar");
    bar.setAttribute("role", "img");
    bar.setAttribute(
      "aria-label",
      `${label}: ` + d.slices.map((s) => `${s.label} ${Math.round(pctOf(s))}%`).join(", "),
    );
    for (const s of d.slices) {
      const seg = el("span", "", "share-seg");
      seg.style.width = `${pctOf(s)}%`;
      seg.style.background = `var(${s.colorVar})`;
      seg.title = `${s.label} — ${Math.round(pctOf(s))}% of ${label.toLowerCase()}`;
      bar.append(seg);
    }
    row.append(bar);
    wrap.append(row);
  }
  return wrap;
}

/**
 * The assistant whose figures are shown, as a dropdown (W10). Shown only when
 * more than one has data. Each choice is a whole dashboard in that source's own
 * unit rather than a filter over a combined one, because a dollar total and a
 * credit total cannot be summed or share an axis.
 */
function sourcePicker(state: ViewState): HTMLElement {
  const select = document.createElement("select");
  select.className = "source-picker";
  select.setAttribute("aria-label", "Agent tool");
  for (const s of state.sources) {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = `${s.label} (${s.turns} turns)`;
    o.selected = s.id === state.activeSource;
    select.append(o);
  }
  select.addEventListener("change", () => {
    if (select.value === activeSource) return;
    activeSource = select.value;
    vscode.postMessage({ type: "setSource", source: select.value });
  });
  return select;
}

function sourceLabel(state: ViewState): string {
  return state.sources.find((s) => s.id === state.activeSource)?.label ?? "assistant";
}

function header(state: ViewState): HTMLElement {
  const bar = el("div", "", "header");

  const title = el("div", "", "title");
  title.append(el("h1", "Modelog"));
  if (activeTab !== "work") title.append(billingTag(state));
  bar.append(title);

  const controls = el("div", "", "controls");
  // The tool and the range choose measured figures. Work sessions are listed
  // from every tool and all time, so on that tab the controls would do nothing.
  if (activeTab !== "work") {
    if (state.sources.length > 1) controls.append(sourcePicker(state));
    for (const [label, days] of RANGES) {
      const b = el("button", label, days === activeRange ? "active" : "");
      b.addEventListener("click", () => {
        activeRange = days;
        vscode.postMessage({ type: "setRange", days });
      });
      controls.append(b);
    }
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
    if (r.sidechainNote) {
      name.append(el("span", r.sidechainNote, "pill"));
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

function markedChangeList(state: ViewState): HTMLElement {
  const ul = el("ul", "", "switches");
  for (const m of state.markedChanges) {
    const li = el("li");
    li.append(el("span", m.when, "when"), el("span", m.target ? `${m.signal} — ${m.target}` : m.signal, "label"));
    if (m.unmeasurable) li.append(el("span", "not measured yet", "pill"));
    // The host asks for confirmation; this only requests it.
    const remove = el("button", "Remove", "ghost remove");
    remove.addEventListener("click", () => vscode.postMessage({ type: "removeMarker", id: m.id }));
    li.append(remove);
    // textContent only (el): the wording is the developer's, stored verbatim.
    if (m.statement) li.append(el("div", `“${m.statement}”`, "statement"));
    if (m.provenanceNote) li.append(el("div", m.provenanceNote, "provenance"));
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
