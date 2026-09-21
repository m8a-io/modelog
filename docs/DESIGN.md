# Modelog — Technical Design (Part 1)

**Version:** 0.1
**Scope:** PRD Part 1 only — local capture, storage, metrics, and the first dashboard.
**Companion to:** `PRD.md` (what and why) and `MCP.md` (the Part 2 bridge). This document is how.

---

## 1. Repo Layout

```
modelog/
  package.json          # npm manifest AND the VS Code extension manifest
  tsconfig.json
  esbuild.mjs           # build script, two targets
  data/
    pricing.json        # versioned rate table
  src/
    extension.ts        # activate() — the entry point
    ingest/
      watcher.ts        # filesystem watch on the Claude Code log dir
      claudeCode.ts     # source adapter: JSONL -> normalized events
      types.ts          # the internal event model all adapters emit
    store/
      store.ts          # storage interface (deliberately narrow)
      fileStore.ts      # the v1 implementation
    metrics/
      cost.ts           # integer micro-dollar cost engine
      aggregate.ts      # cost/turn, turns/session, cache hit rate
      anchors.ts        # model-switch detection
    ui/
      panel.ts          # webview lifecycle, host side
      protocol.ts       # message types shared by host and webview
    webview/
      main.ts           # runs in the webview (browser context)
      style.css         # theme-variable-only styles
      chart.ts          # hand-rolled SVG rendering
  test/
    fixtures/           # recorded JSONL samples, pinned to a source version
```

---

## 2. Extension Anatomy

Three concepts do most of the work; the rest of this document assumes them.

**The manifest.** `package.json` is both the npm manifest and the extension manifest. Its `contributes` section *declares* what Modelog adds to the UI — commands, settings, views — as static JSON. VS Code reads this at startup without running any of our code, which is how it can show our command in the palette while the extension is still dormant.

**Activation.** `activationEvents` tells VS Code when to actually load us. Modelog uses `onStartupFinished` — we are a background collector, so we need to run without the user asking, but `onStartupFinished` defers us until the editor has finished its own startup so we never sit on the critical path. Our exported `activate(context)` is then called once. Everything disposable (watchers, panels, the store) gets pushed onto `context.subscriptions` so VS Code tears it down cleanly.

**The extension host.** Our code runs in a separate Node process from the editor UI. There is no DOM. Anything visual is either a built-in UI type (status bar item, tree view, quick pick) or a **webview** — an iframe we hand HTML to, which can only talk to us by message passing. This process boundary is the reason for §8's protocol.

### Contribution points (v1)

| Type | Id | Purpose |
|---|---|---|
| Command | `modelog.openDashboard` | Opens the webview panel |
| Command | `modelog.rescan` | Forces a full re-ingest |
| Command | `modelog.exportData` | Writes the store to a user-chosen file |
| Status bar | — | Today / 30-day summary, click opens dashboard |
| Settings | `modelog.*` | See §10 |

---

## 3. Build Pipeline

**Two targets, because they run in different places.**

| Target | Entry | Platform | Format | Notes |
|---|---|---|---|---|
| Extension host | `src/extension.ts` | `node` | `cjs` | `vscode` marked **external** — it is injected at runtime, never bundled |
| Webview | `src/webview/main.ts` | `browser` | `esm` | Plain DOM, no framework |

**Use esbuild, not Vite.** Vite is excellent, but its value is a dev server with hot module replacement against a browser — and a webview can't use that server, because its content is loaded through the `vscode-webview:` scheme under a content security policy that forbids arbitrary origins. You would spend the setup cost and not collect the benefit. esbuild is what the VS Code extension ecosystem standardises on, handles both targets from one ~30-line script, and rebuilds in milliseconds. If the dashboard later grows into a full framework app, revisiting this is cheap.

**TypeScript** for both targets. `tsc --noEmit` type-checks in CI; esbuild strips types for the bundle (it does not type-check — that separation is deliberate and normal).

---

## 4. Theming — Hard Rules

VS Code injects the active theme into every webview. We consume it and add nothing of our own.

1. **No literal colors. Ever.** No hex, no `rgb()`, no named colors in `style.css` or in component code. Every color is `var(--vscode-…)`. Enforced in CI by `scripts/check-theme.sh`.
   - **One narrow exception:** `src/webview/theme.ts` is the single place that resolves VS Code CSS variables into colour strings for the charting library, and each read carries a fallback for an absent variable. Literals are permitted there *only* as an argument to the `v("--vscode-…", …)` reader; the lint fails on any other literal in that file.
2. **Use the semantically correct variable**, not one that happens to look right: `--vscode-editor-background`, `--vscode-foreground`, `--vscode-descriptionForeground` for secondary text, `--vscode-panel-border` for rules, `--vscode-list-hoverBackground` for row hover, `--vscode-button-background` / `--vscode-button-foreground` for buttons, `--vscode-errorForeground` and `--vscode-charts-*` for status and series.
3. **Fonts too:** `--vscode-font-family`, `--vscode-editor-font-family` for anything numeric or tabular.
4. **Series colors come from `--vscode-charts-red|blue|yellow|orange|green|purple|foreground`.** This is the one place VS Code gives us a real categorical palette that themes correctly. It caps us at ~6 distinguishable series, which is a reason to keep charts to a handful of models at a time.
5. **Theme switches live.** VS Code re-evaluates the variables, so CSS follows automatically. JavaScript-supplied colours (the chart) must not cache: `theme.ts` re-reads on every render, and a `MutationObserver` on `document.body`'s `class` / `data-vscode-theme-id` triggers a repaint when the user switches theme. Handling this properly costs ~30 lines, which is why the chart tracks the editor exactly rather than approximating with a light/dark pair.
6. **Respect high contrast.** Never encode meaning in color alone; pair it with a label, shape, or dash pattern.

The payoff: Modelog looks native in every theme the user already trusts, including ones that did not exist when we shipped.

---

## 5. Data Flow

```
~/.claude/projects/**/*.jsonl
        |  fs.watch (debounced)
        v
  watcher.ts  -- byte offset per file, reads only what is new
        |
        v
  claudeCode.ts  -- parse JSONL -> normalized Turn/Session events
        |            filter <synthetic>, attach provenance
        v
  store.ts  -- idempotent upsert keyed on record uuid
        |
        v
  aggregate.ts + cost.ts  -- metrics computed on read, not on write
        |
        v
  panel.ts  --postMessage-->  webview/main.ts  -->  DOM + SVG
```

Metrics are computed on read. The volume is small enough (§11) that precomputation would buy nothing and would add a cache-invalidation problem.

---

## 6. Ingest

**Incremental tailing.** Claude Code's JSONL files are append-only. We keep a per-file cursor of `{path, size, mtime, byteOffset}` and on change read only from `byteOffset`. A file whose size *decreased* was rotated or rewritten — re-read it whole.

**Idempotency.** Every record carries a `uuid`. Upserts key on it, so a full rescan is always safe and never double-counts. `modelog.rescan` relies on this.

**Partial lines.** A watch can fire mid-write, leaving a truncated final line. Parse line-by-line; on a JSON error at the *last* line, retain the partial buffer and retry on the next event. A JSON error on any *earlier* line is real corruption — log it, skip that line, count it in a health stat.

**What we keep.** Timestamps, model, token counts, session/branch/cwd identifiers, record uuids. **We never read or store `message.content`.** Prompts and code do not enter the store. This is PRD §8.1 and it is easier to guarantee at the parser than anywhere downstream.

**Filtering.** Drop assistant records with `model: "<synthetic>"` — locally generated, zero usage, not API calls (PRD §7.1).

---

## 7. Storage — Decision

**v1 uses SQLite via the built-in `node:sqlite` module.** This confirms PRD §7.2 and reverses an earlier proposed amendment.

*Verified 2026-09-20:* VS Code 1.138's remote extension host runs **Node 24.18.1**, where `node:sqlite` is present and functional (`DatabaseSync`, `StatementSync`, `Session`, `backup`). Create/insert/query round-trips cleanly.

*Why this changes the decision:* the case against SQLite was never SQLite — it was `better-sqlite3`, a native module compiled against the extension host's ABI, requiring per-platform binaries and a rebuild on every VS Code upgrade. A runtime built-in has none of those properties. It is a zero-dependency, zero-maintenance SQLite.

*Known limits:*

- `node:sqlite` is still marked experimental. The API may shift; pin behaviour behind the `Store` interface and do not leak `DatabaseSync` types above it.
- Verified on the **remote/server** extension host only. Desktop VS Code runs extensions in Electron's Node, which was unavailable to probe. `node:sqlite` required `--experimental-sqlite` on Node 22 and is unflagged only from 23.4 — so a desktop host on an older Electron will throw on require.

*Therefore: feature-detect, with fallback.* At activation, attempt `require("node:sqlite")`. On success use `SqliteStore`; on failure fall back to `FileStore` (append-only NDJSON under `globalStorageUri`) and raise an ingest-health notice. Because source logs are append-only, the store is a rebuildable cache — a fallback degrades performance, never correctness. Delete the fallback once all supported hosts ship Node 24+.

*Design:* both implementations sit behind one narrow interface, and nothing above it knows which is active:*Design:* an append-only NDJSON store under `context.globalStorageUri` (the per-extension directory VS Code provides for exactly this), loaded into memory on activation, with a narrow interface:

```ts
interface Store {
  upsertTurns(turns: Turn[]): void;
  allTurns(): readonly Turn[];
  cursor(path: string): FileCursor | undefined;
  setCursor(path: string, c: FileCursor): void;
  export(): string;
  clear(): void;
}
```

**Schema (SQLite path).** Two tables: `turns` keyed on the record `uuid` (making re-ingest idempotent by `INSERT OR REPLACE`), and `cursors` keyed on file path. Token counts and cost are `INTEGER` — cost in micro-dollars, per §8.2 of the PRD. Indexes on `(ts)` and `(model)` cover every §9 aggregate.

Money and token counts stay integers all the way through SQLite; nothing is stored as `REAL`.

---

## 8. Host <-> Webview Protocol

The webview cannot read files or query the store; it only renders what it is sent. Messages are typed in `ui/protocol.ts` and shared by both sides.

| Direction | Message | Payload |
|---|---|---|
| host -> webview | `state` | full view model: metrics, series, session rows, health |
| host -> webview | `health` | ingest warnings (unknown model, parse errors, format drift) |
| webview -> host | `ready` | webview has loaded; host replies with `state` |
| webview -> host | `setRange` | `{from, to}` — triggers recompute and a new `state` |
| webview -> host | `setFilter` | `{models?, repos?}` |
| webview -> host | `openSession` | `{sessionId}` — host reveals detail |

The host sends a complete view model rather than raw turns. The webview does no aggregation and owns no business logic — which keeps the cost engine testable in plain Node, with no VS Code or DOM in the loop.

**Security.** CSP `default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};` with `localResourceRoots` limited to our bundle directory. No remote content, no inline script beyond a nonce'd bootstrap.

---

## 9. Metric Definitions

Ambiguity here becomes a wrong number on screen, so these are normative.

| Term | Definition |
|---|---|
| **Turn** | One `type: "assistant"` record with `model != "<synthetic>"`. |
| **Inference call** | One entry in that record's `usage.iterations[]`. A turn may contain several. Reported separately; never conflated with turns. |
| **Session** | One `sessionId`. Start/end are the first and last record timestamps. |
| **Active session** | A session with at least one turn. Sessions with none are excluded from all denominators. |
| **Cost** | `Σ over turns of (input×rate_in + cache_read×rate_in×0.1 + write_5m×rate_in×1.25 + write_1h×rate_in×2.0 + output×rate_out)`, in integer micro-dollars. |
| **Cost per turn** | Total cost / turn count, over the selected range and segment. |
| **Turns per session** | Turn count / active session count. |
| **Cache hit rate** | `cache_read / (cache_read + cache_creation + input)`. |
| **Sessions per day** | Active sessions grouped by local calendar date of session start. |
| **Model switch** | Two consecutive turns, ordered by timestamp, with different `model`. May occur *within* a session (PRD risk #11). |

Thinking tokens are reported from `output_tokens_details.thinking_tokens` for display only — they are already included in `output_tokens` and must not be added again.

---

## 10. First Dashboards & Reports (v1)

Four surfaces. The comparison table is the product; the rest support it.

### 10.1 Status bar
`$(pulse) $0.42 today · $11.30 / 30d`. Click opens the dashboard. Shows a warning icon when ingest health is degraded.

### 10.2 Model Comparison — the hero surface
One row per model over the selected range. This is the direct answer to PRD §1.

| Model | Turns | Sessions | **Cost/turn** | Turns/session | Cache hit | Total |
|---|---|---|---|---|---|---|

Sortable, with cost/turn emphasised. A relative column ("1.0x / 2.3x" against the cheapest) leads over absolute dollars, per PRD §8.2's subscription caveat.

### 10.3 Trend chart
Cost per turn over time, one line per model, daily buckets. Model-switch anchors as `markLine` rules. Hover gives exact values; `dataZoom` scrubs a sub-range.

**Built on Apache ECharts** (6.1.0, Apache-2.0, TypeScript source). Chosen over a hand-rolled renderer because Modelog's chart is expected to gain interactivity — range brushing, anchored before/after selection, session drill-down — and those are the things a library already solves. ECharts specifically: modular registration so unused components tree-shake out, SVG *and* canvas renderers, and `markLine` / `dataZoom` / `brush` already built.

*Costs, measured:* the webview bundle goes from ~4KB to **573KB minified**, tree-shaken and verified via esbuild metafile (echarts/component 123KB, zrender 79KB, the rest core/data/util). No `eval`, so the CSP in §8 is unaffected. For a local extension loading from disk this is acceptable; it is the main thing to re-examine if startup ever feels slow.

*Theming:* colours are resolved from VS Code CSS variables at render time by `theme.ts` and repainted on theme change (§4.5) — full theme fidelity, not a light/dark approximation.

*Attribution:* `NOTICE.md` records the Apache-2.0 dependency.

### 10.4 Session history
Sortable, filterable table: start time, duration, repo/branch, model(s), turns, cost. Row click expands to per-turn detail. Exportable to CSV.

**Explicitly not in v1:** inferred behavioral markers (PRD §7.4), work-log categories (Part 2), anything requiring the network.

---

## 11. Non-Functional Budgets

| Budget | Target |
|---|---|
| Activation cost | < 50ms before yielding; ingest runs after |
| Full ingest, 100k turns | < 2s |
| Incremental ingest | < 50ms per file change |
| Dashboard first paint | < 300ms from command |
| Memory | < 50MB for 100k turns |
| Watcher | debounced 500ms; never a busy poll |

---

## 12. Degradation & Health

Modelog never displays a number it cannot substantiate.

| Condition | Behavior |
|---|---|
| Log directory missing | Dashboard shows an empty state explaining where it looks |
| Unknown model id | That turn's cost is `null`; the row shows "cost unavailable"; a health warning names the id |
| Unrecognised record shape | Skip, count, warn. Never guess a mapping |
| Rate table older than 90 days | Banner suggesting an update |
| Subscription mode | Persistent label that figures are API-list-rate estimates |

Ingest health is a first-class surface, not a log line.

---

## 13. Settings

| Setting | Default | Purpose |
|---|---|---|
| `modelog.logPaths` | `["~/.claude/projects"]` | Additional or alternate source directories |
| `modelog.billingMode` | `"subscription"` | `subscription` \| `api` — controls the §12 label |
| `modelog.statusBar.enabled` | `true` | |
| `modelog.defaultRange` | `"30d"` | |

---

## 14. Testing

- **Cost engine** — pure functions over fixture turns; exact integer assertions. The highest-value tests in the project.
- **Parser** — recorded JSONL fixtures pinned to the Claude Code version they came from (PRD §7.1). Includes deliberately malformed and truncated lines.
- **Aggregates** — hand-computed expectations for a small fixture set.
- **Theming** — CI grep failing the build on any literal color in `src/webview/`.
- **Integration** — `@vscode/test-electron` launches a real VS Code, activates the extension against a fixture log dir, asserts the store fills.

---

## 15. Open Decisions

| # | Decision | Recommendation |
|---|---|---|
| 1 | ~~File store vs SQLite~~ | **Decided: SQLite via built-in `node:sqlite`**, with a `FileStore` fallback where the module is absent. PRD §7.2 stands as written. |
| 2 | ~~Dashboard as webview panel vs sidebar view~~ | **Decided: editor panel.** A sidebar summary may come later. |
| 3 | ~~Hand-rolled SVG vs chart library~~ | **Decided: Apache ECharts**, for the interactivity roadmap. Revisit the 573KB bundle cost only if load time suffers. |
| 4 | ~~Read-only metrics MCP server at end of Part 1~~ | **Decided: no.** Moved to Part 2, where it is now the *first* deliverable (PRD §7.9), with its own requirements document (`docs/MCP.md`) before any code. |
