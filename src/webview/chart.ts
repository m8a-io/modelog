import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  DataZoomComponent,
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import type { ChartData } from "../ui/protocol.ts";
import { readTheme, onThemeChange, type ChartTheme } from "./theme.ts";

/**
 * Trend chart, built on Apache ECharts.
 *
 * Only the components actually used are registered, so esbuild tree-shakes
 * the rest of the library out of the bundle. The SVG renderer is chosen over
 * canvas because it keeps text crisp at any zoom and stays inspectable in the
 * webview devtools.
 *
 * Theming: colours are read out of VS Code's CSS variables at render time and
 * re-read when the theme changes, so the chart tracks the editor exactly
 * rather than approximating with a light/dark pair (DESIGN.md §4).
 */
echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  DataZoomComponent,
  SVGRenderer,
]);

const MICRO = 1_000_000;

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

function buildOption(data: ChartData, t: ChartTheme): echarts.EChartsCoreOption {
  const usd = (micro: number) => micro / MICRO;

  const series = data.series.map((s, i) => ({
    name: s.model,
    type: "line" as const,
    // A gap means the model was unused that day, not that cost fell to zero.
    connectNulls: false,
    showSymbol: true,
    symbolSize: 6,
    lineStyle: { width: 2 },
    itemStyle: { color: t.series[i % t.series.length] },
    data: s.values.map((v) => (v === null ? null : usd(v))),
    // Model switches are observed anchors, drawn on the first series only so
    // they appear once rather than once per model.
    ...(i === 0 && data.switches.length
      ? {
          markLine: {
            silent: false,
            symbol: "none",
            label: {
              show: true,
              formatter: (p: { name?: string }) => p.name ?? "",
              color: t.muted,
              fontFamily: t.fontFamily,
              fontSize: 10,
              rotate: 90,
              position: "insideEndTop" as const,
            },
            lineStyle: { color: t.muted, type: "dashed" as const, width: 1, opacity: 0.8 },
            data: data.switches.map((sw) => ({ xAxis: sw.dayIndex, name: sw.label })),
          },
        }
      : {}),
  }));

  return {
    animation: false,
    backgroundColor: "transparent",
    textStyle: { fontFamily: t.fontFamily, color: t.foreground },
    grid: { left: 58, right: 20, top: 16, bottom: 56, containLabel: false },
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
      valueFormatter: (v: unknown) =>
        typeof v === "number" ? `$${v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}` : "—",
    },
    xAxis: {
      type: "category",
      data: data.dayLabels,
      boundaryGap: false,
      axisLine: { lineStyle: { color: t.border } },
      axisTick: { show: false },
      axisLabel: { color: t.muted, fontFamily: t.monoFamily, fontSize: 10, hideOverlap: true },
    },
    yAxis: {
      type: "value",
      min: 0,
      max: usd(data.yMaxMicro),
      axisLabel: {
        color: t.muted,
        fontFamily: t.monoFamily,
        fontSize: 10,
        formatter: (v: number) => `$${v.toFixed(2)}`,
      },
      splitLine: { lineStyle: { color: t.border, opacity: 0.6 } },
    },
    // Scrub a sub-range without leaving the panel — the first of the
    // interactions this library was chosen for.
    dataZoom: [
      { type: "inside", throttle: 50 },
      {
        type: "slider",
        height: 16,
        bottom: 24,
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
    series,
  };
}
