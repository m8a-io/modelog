/**
 * Bridges VS Code's CSS theme variables into plain colour strings, which is
 * what a charting library needs.
 *
 * VS Code injects the active theme as CSS custom properties on the document.
 * getComputedStyle resolves them, so the chart can use real theme colours
 * rather than an approximation — and re-reading them on a theme change keeps
 * full fidelity instead of falling back to a generic light/dark pair.
 */

export interface ChartTheme {
  foreground: string;
  muted: string;
  background: string;
  border: string;
  focus: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipFg: string;
  fontFamily: string;
  monoFamily: string;
  /** Categorical series palette, in assignment order. */
  series: string[];
  /** True when the active theme is dark or high-contrast-dark. */
  isDark: boolean;
}

function v(name: string, fallback: string): string {
  const raw = getComputedStyle(document.body).getPropertyValue(name).trim();
  return raw || fallback;
}

export function readTheme(): ChartTheme {
  const cls = document.body.className;
  const isDark = cls.includes("vscode-dark") || cls.includes("vscode-high-contrast");

  return {
    foreground: v("--vscode-foreground", isDark ? "#ccc" : "#333"),
    muted: v("--vscode-descriptionForeground", isDark ? "#999" : "#666"),
    background: v("--vscode-editor-background", isDark ? "#1e1e1e" : "#fff"),
    border: v("--vscode-panel-border", isDark ? "#333" : "#ddd"),
    focus: v("--vscode-focusBorder", "#007acc"),
    tooltipBg: v("--vscode-editorHoverWidget-background", isDark ? "#252526" : "#f3f3f3"),
    tooltipBorder: v("--vscode-editorHoverWidget-border", isDark ? "#454545" : "#c8c8c8"),
    tooltipFg: v("--vscode-editorHoverWidget-foreground", isDark ? "#ccc" : "#333"),
    fontFamily: v("--vscode-font-family", "sans-serif"),
    monoFamily: v("--vscode-editor-font-family", "monospace"),
    series: [
      v("--vscode-charts-blue", "#3794ff"),
      v("--vscode-charts-green", "#89d185"),
      v("--vscode-charts-orange", "#d18616"),
      v("--vscode-charts-purple", "#b180d7"),
      v("--vscode-charts-red", "#f14c4c"),
      v("--vscode-charts-yellow", "#cca700"),
    ],
    isDark,
  };
}

/**
 * Calls back whenever VS Code swaps the theme. VS Code rewrites the body
 * class and data-vscode-theme-id, so observing those attributes is enough.
 */
export function onThemeChange(cb: () => void): () => void {
  const obs = new MutationObserver(cb);
  obs.observe(document.body, {
    attributes: true,
    attributeFilter: ["class", "data-vscode-theme-id"],
  });
  return () => obs.disconnect();
}
