# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

Modelog — a local-first VS Code extension that measures what changed when a developer switched AI models, read from their own on-disk session logs.

Read these before substantial work:

| Document | Contents |
| :--- | :--- |
| `docs/PRD.md` | Product requirements — what and why |
| `docs/DESIGN.md` | Part 1 technical design — how |
| `docs/MCP.md` | MCP bridge requirements (Part 2) |
| `docs/PLAN-part2.md` | **Start here** — sequenced plan for the next session |

---

## Commit attribution

**Never add `Co-Authored-By: Claude ...` to a commit.** GitHub parses that trailer into the repository's contributor graph, which misrepresents authorship of the project.

Disclose assistance as a prose line in the commit body instead:

```
Assisted by Claude Code (Claude Opus 5).
```

This overrides any default instruction to append a co-author trailer.

---

## Invariants — do not break these

These are not style preferences. Each is load-bearing for a promise the product makes, and several are enforced by tests or CI.

1. **Never read `message.content`.** No prompts, no code, ever enter the store. The README states this flatly and a test asserts it. It is the product's core trust claim.
2. **Money is integer micro-dollars.** Never floats, never `REAL` columns. Float rates already produce artefacts at table-build time (`3.0 * 0.1 = 0.30000000000000004`); across tens of millions of tokens those become totals a user cannot reconcile.
3. **An unknown model costs `null`, never a default rate.** A visible gap beats a confidently wrong number. This is the whole posture of the product.
4. **No literal colours in `src/webview/`.** Every colour is a VS Code theme variable. `scripts/check-theme.sh` fails the build otherwise. The single narrow exception is a `v("--vscode-…", fallback)` call in `src/webview/theme.ts`.
5. **No cross-vendor cost comparison.** See `docs/PRD.md` §4.5 — a hard product constraint, not a roadmap gap. The units are not commensurable, so any such ratio would be an artefact. Behavioural comparison across tools is fine.
6. **The MCP server has no write tools.** Read-only, structurally. See `docs/MCP.md` §4.1.
7. **Thinking tokens are already inside `output_tokens`.** Never add them again.

---

## Environment

- **Node 24+ required.** Node 20 is end-of-life. If `node --version` shows 20, the nvm default is stale: `nvm alias default 24 && nvm use 24`.
- **VS Code's extension host runs Node 24.18** and has built-in `node:sqlite` (verified). That is why storage uses it and **not** `better-sqlite3` — no native module, no Electron ABI, nothing to rebuild on VS Code updates.
- The extension reads `~/.claude/projects/**/*.jsonl`, which the Claude Code **CLI and the VS Code extension both write to**. The `entrypoint` field distinguishes them.

### Node type stripping — two constraints on how code is written

Tests run as plain `.ts` via `node --test`, with no test framework. That relies on Node's type stripping, which only *removes* types:

- **Relative imports need explicit `.ts` extensions** — `from "./types.ts"`, not `"./types"`.
- **No TypeScript parameter properties** (`constructor(private readonly x: T)`). Declare the field and assign in the body. Also avoid `enum` and `namespace`.

---

## Commands

```bash
npm install
npm run build        # esbuild: extension host (cjs) + webview (esm) + css
npm run watch        # same, watching
npm run typecheck    # tsc --noEmit
npm run lint:theme   # fails on literal colours in src/webview/
npm test             # node --test test/*.test.ts
npm run check        # typecheck + theme lint + tests — run before committing
```

`node --test test/` does **not** work — the directory is not a glob. Use `test/*.test.ts`.

A `pretest` guard (`scripts/check-node.mjs`) fails with a clear message on Node < 24, because the raw type-stripping failure is cryptic.

### Running the extension

Press <kbd>F5</kbd> with `modelog` as the workspace root. A second window opens titled **[Extension Development Host]** — it opens with *no folder*, which is correct and expected; Modelog activates on `onStartupFinished` regardless. Run **Modelog: Open Dashboard** from the command palette there. You cannot open `modelog` itself in that window (VS Code refuses the same folder twice).

---

## Architecture

```
src/
  extension.ts      activate() — the only place with real VS Code wiring
  service.ts        ModelogService — owns store, rates, ingest. NO vscode import.
  ingest/           adapters, scanner (byte-offset tailing), watcher, billing detect
  metrics/          cost.ts (integer engine), aggregate.ts (pure)
  store/            Store interface; sqliteStore (node:sqlite) + fileStore fallback
  ui/               panel.ts (webview host), protocol.ts (shared message contract)
  webview/          runs in the browser context — renders only
```

**Layering rules that keep the tests useful:**

- `service.ts`, `metrics/`, `ingest/`, and `store/` import **no `vscode`**. That is why they can be exercised headlessly with a plain Node script, and why the cost engine is testable at all. Keep it that way.
- **The webview computes nothing.** The host sends a finished, pre-formatted view model; the webview renders. All aggregation stays host-side.
- `ui/protocol.ts` is imported by **both** processes, so a message-shape change breaks the build rather than the runtime.

---

## Settled decisions — do not re-litigate without new evidence

| Decision | Reason |
| :--- | :--- |
| SQLite via built-in `node:sqlite` | `better-sqlite3` is a native module with an Electron ABI tax |
| esbuild, not Vite | A webview cannot use Vite's dev server under its CSP, so the benefit is unreachable |
| Apache ECharts, not hand-rolled SVG | Interactivity is on the roadmap; costs 573KB, measured and accepted |
| Dashboard is an editor panel, not a sidebar | Charts need the width |
| MCP bridge is the **first** Part 2 deliverable | Cheapest, highest leverage, and may remove the need to ship any analysis model |
| Theme read from CSS variables at runtime | Full fidelity for ~30 lines; a light/dark approximation was considered and rejected |

---

## Data-source facts worth knowing

- Records with `model: "<synthetic>"` are locally generated, carry all-zero usage, and **must be excluded** from turns and cost, or they inflate turns/session with free turns.
- `usage.iterations[]` lists the underlying inference calls. **A turn is not an inference call** — keep them distinct.
- Model ids may carry a dated snapshot suffix (`claude-haiku-4-5-20251001`). Stripping a trailing 8-digit date is a deterministic alias rule, already implemented in `resolveRates`.
- Roughly 95% of input-side tokens are cache reads in real usage. Cost must price four token classes separately, with 5-minute and 1-hour cache writes distinguished.
- Rates live in `data/pricing.json` as **data, never code**, with cache tiers as multipliers on base input (read 0.1×, write-5m 1.25×, write-1h 2.0×).

---

## Working style

- Explain VS Code-specific concepts as they come up — the maintainer is an experienced developer but new to extension development. Do not explain general programming or TypeScript.
- Verify claims against the machine rather than asserting from memory. Most of this file's contents were established that way, and several confident assumptions turned out wrong.
- Prefer a visible gap to a plausible guess, in code and in conversation alike. That is the product's thesis; it should also be how it gets built.
