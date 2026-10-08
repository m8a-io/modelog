import * as echarts from "echarts/core";
import { LineChart, BarChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  AxisPointerComponent,
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import type { ChartData } from "../ui/protocol.ts";
import { readTheme, onThemeChange, resolveColorVar, type ChartTheme } from "./theme.ts";

/**
 * Trend chart, built on Apache ECharts.
 *
 * Only the components actually used are registered, so esbuild tree-shakes
 * the rest of the library out of the bundle. The SVG renderer is chosen over
 * canvas because it keeps text crisp at any zoom and stays inspectable in the
 * webview devtools.
 *
 * **Two panels, one shared x-axis — never two y-scales on one panel.** Cost
 * per turn and turn counts are different measures at different magnitudes;
 * overlaying them on a single plot with a second axis is the most common way
 * a chart invites a conclusion the data does not support. They are stacked
 * instead, sharing the date axis and one linked crosshair, so a day can be
 * read across both without either scale distorting the other.
 *
 * Theming: colours are read out of VS Code's CSS variables at render time and
 * re-read when the theme changes, so the chart tracks the editor exactly
 * rather than approximating with a light/dark pair (DESIGN.md §4).
 */
echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  AxisPointerComponent,
  SVGRenderer,
]);

export interface ChartHandle {
  dispose(): void;
}

export function renderChart(container: HTMLElement, data: ChartData): ChartHandle {
  const chart = echarts.init(container, undefined, { renderer: "svg" });

  const paint = () => chart.setOption(buildOption(data, readTheme()), true);
  paint();

  const stopTheme = onThemeChange(paint);
  const ro = new ResizeObserver(() => chart.resize());
  ro.observe(container);

  return {
    dispose() {
      stopTheme();
      ro.disconnect();
      chart.dispose();
    },
  };
}

/**
 * Panel geometry, in the 448px container `.chart` reserves.
 *
 * Laid out so nothing collides: the cost panel ends at 176, a deliberate 56px
 * gap separates it from the turns panel (204px would abut tightly enough to
 * read as one messy chart rather than two), the turns panel runs 232–344 with
 * ~22px of date labels beneath it, the zoom slider sits at 390–404, and the
 * legend has the remaining ~44px to wrap into.
 */
const COST_TOP = 28;
const COST_HEIGHT = 148;
const TURNS_TOP = 232;
const TURNS_HEIGHT = 112;
const SLIDER_BOTTOM = 44;

function buildOption(data: ChartData, t: ChartTheme): echarts.EChartsCoreOption {
  // The host picked the slot; this only resolves it. Using a positional index
  // here instead would repaint every model whenever the filter changed the
  // series count, which is exactly what the host's assignment prevents.
  const colorOf = (i: number) => resolveColorVar(data.series[i]?.colorVar ?? "", t.muted);

  // One line per model on the cost panel. A model that never resolved a cost
  // (the folded "Other" bucket) contributes only bars, so its line is absent
  // rather than drawn flat at zero.
  const costSeries = data.series
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.values.some((v) => v !== null))
    .map(({ s, i }) => ({
      name: s.model,
      type: "line" as const,
      xAxisIndex: 0,
      yAxisIndex: 0,
      // A gap means the model was unused that day, not that cost fell to zero.
      connectNulls: false,
      showSymbol: true,
      symbolSize: 8,
      lineStyle: { width: 2 },
      itemStyle: { color: colorOf(i) },
      data: s.values,
    }));

  // Turns per model per day, stacked. Absolute height rather than 100%, so a
  // light day reads as a short bar instead of looking like a heavy one.
  const turnSeries = data.series.map((s, i) => ({
    name: s.model,
    type: "bar" as const,
    xAxisIndex: 1,
    yAxisIndex: 1,
    stack: "turns",
    barMaxWidth: 18,
    itemStyle: {
      color: colorOf(i),
      // A 2px surface gap between stacked segments keeps the boundary legible
      // without a border colour competing with the fills.
      borderColor: t.background,
      borderWidth: 2,
      borderRadius: 0,
    },
    emphasis: { focus: "series" as const },
    data: s.turns,
  }));

  const axisLabel = {
    color: t.muted,
    fontFamily: t.monoFamily,
    fontSize: 10,
  };

  /**
   * Labels come from the host, already formatted for the active unit.
   *
   * Matched by nearest value rather than exact equality: the axis maximum can
   * be fractional (a cost-per-turn axis is routinely well under a dollar), and
   * ECharts recomputes tick positions in floating point, so `0.0015` here need
   * not be bit-identical to the `0.0015` the host sent.
   */
  const tickLabels = (ticks: ChartData["cost"]["ticks"]) => {
    const tolerance = Math.max(...ticks.map((k) => Math.abs(k.value))) / 1000 || 1e-9;
    return (v: number) => {
      let best = "";
      let bestDelta = Infinity;
      for (const k of ticks) {
        const delta = Math.abs(k.value - v);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = k.label;
        }
      }
      return bestDelta <= tolerance ? best : "";
    };
  };

  return {
    animation: false,
    backgroundColor: "transparent",
    textStyle: { fontFamily: t.fontFamily, color: t.foreground },
    // Linked so one hover reads both panels at the same day.
    axisPointer: { link: [{ xAxisIndex: [0, 1] }], label: { show: false } },
    grid: [
      { left: 64, right: 20, top: COST_TOP, height: COST_HEIGHT, containLabel: false },
      { left: 64, right: 20, top: TURNS_TOP, height: TURNS_HEIGHT, containLabel: false },
    ],
    legend: {
      bottom: 0,
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { color: t.muted, fontFamily: t.fontFamily, fontSize: 11 },
      inactiveColor: t.border,
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: t.tooltipBg,
      borderColor: t.tooltipBorder,
      textStyle: { color: t.tooltipFg, fontFamily: t.fontFamily, fontSize: 12 },
      axisPointer: { type: "line", lineStyle: { color: t.focus, width: 1 } },
      // Built from the host's pre-formatted strings: the cost panel shows
      // money in its own unit, the turns panel shows counts and the day's
      // total, and neither is computed here.
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [params];
        const first = list[0] as { dataIndex?: number } | undefined;
        const day = first?.dataIndex ?? -1;
        if (day < 0) return "";

        const lines = [`<strong>${data.dayLabels[day] ?? ""}</strong>`];
        let totalTurns = 0;
        for (let i = 0; i < data.series.length; i++) {
          const s = data.series[i]!;
          const turns = s.turns[day] ?? 0;
          totalTurns += turns;
          if (turns === 0) continue;
          const cost = s.labels[day];
          const swatch =
            `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;` +
            `background:${colorOf(i)};margin-right:6px"></span>`;
          lines.push(
            `${swatch}${s.model} — ${turns} turn${turns === 1 ? "" : "s"}` +
              (cost ? ` · ${cost}/turn` : ""),
          );
        }
        if (totalTurns > 0) lines.push(`<em>${totalTurns} turns total</em>`);
        return lines.join("<br>");
      },
    },
    xAxis: [
      // Cost panel: ticks shared with the panel below, labels suppressed so
      // the dates are written once, under both.
      {
        type: "category",
        gridIndex: 0,
        data: data.dayLabels,
        boundaryGap: false,
        axisLine: { lineStyle: { color: t.border } },
        axisTick: { show: false },
        axisLabel: { show: false },
      },
      {
        type: "category",
        gridIndex: 1,
        data: data.dayLabels,
        axisLine: { lineStyle: { color: t.border } },
        axisTick: { show: false },
        axisLabel: { ...axisLabel, hideOverlap: true },
      },
    ],
    yAxis: [
      {
        type: "value",
        gridIndex: 0,
        name: data.costLabel,
        nameLocation: "end" as const,
        nameGap: 8,
        nameTextStyle: { color: t.muted, fontFamily: t.fontFamily, fontSize: 10, align: "left" },
        min: 0,
        max: data.cost.max,
        interval: data.cost.max / 4,
        axisLabel: { ...axisLabel, formatter: tickLabels(data.cost.ticks) },
        splitLine: { lineStyle: { color: t.border, opacity: 0.6 } },
      },
      {
        type: "value",
        gridIndex: 1,
        name: "Turns",
        nameLocation: "end" as const,
        nameGap: 8,
        nameTextStyle: { color: t.muted, fontFamily: t.fontFamily, fontSize: 10, align: "left" },
        min: 0,
        max: data.turns.max,
        interval: data.turns.max / 4,
        axisLabel: { ...axisLabel, formatter: tickLabels(data.turns.ticks) },
        splitLine: { lineStyle: { color: t.border, opacity: 0.6 } },
      },
    ],
    // Scrub a sub-range without leaving the panel, across both at once.
    dataZoom: [
      { type: "inside", xAxisIndex: [0, 1], throttle: 50 },
      {
        type: "slider",
        xAxisIndex: [0, 1],
        height: 14,
        bottom: SLIDER_BOTTOM,
        borderColor: t.border,
        fillerColor: t.focus + "22",
        handleStyle: { color: t.focus },
        moveHandleStyle: { color: t.border },
        textStyle: { color: t.muted, fontFamily: t.monoFamily, fontSize: 9 },
        dataBackground: {
          lineStyle: { color: t.border },
          areaStyle: { color: t.border, opacity: 0.3 },
        },
        selectedDataBackground: {
          lineStyle: { color: t.muted },
          areaStyle: { color: t.muted, opacity: 0.25 },
        },
      },
    ],
    series: [...costSeries, ...turnSeries],
  };
}
