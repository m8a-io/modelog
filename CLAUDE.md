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
| `docs/INSTALL-ux.md` | How Modelog installs and activates; MCP's two registration targets; the environment matrix. Claims are tagged `[verified]` / `[untested]` |
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

## Invariants

Seven rules are load-bearing for promises the product makes, and several are enforced by tests or CI. **They live in `docs/PRD.md` §8.0, not here** — they describe how Modelog must behave, which is product specification, not repo workflow.

Read them before touching cost, storage, ingest or the webview. The two with teeth in CI: no literal colours in `src/webview/` (`scripts/check-theme.sh`), and the store never reads `message.content` (asserted by `test/parser.test.ts`).

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
  ingest/           adapters (claudeCode, copilot), scanner, watcher, billing detect
  metrics/          cost.ts (integer engine), aggregate.ts (pure)
  store/            Store interface; sqliteStore (node:sqlite) + fileStore fallback
  ui/               panel.ts (webview host), protocol.ts (shared message contract)
  webview/          runs in the browser context — renders only
```

**Layering rules that keep the tests useful:**

- **Two sources, two money units.** `Turn.source` is `claude-code` or `copilot`. Their costs are in different units (`usd_micro` vs `aiu_nano`) and **no conversion between them exists** — do not add one. Aggregates refuse a mixed set; call `partitionBySource()` first. This is what makes PRD §4.5's ban on cross-vendor cost comparison structural rather than a rule to remember.
- `service.ts`, `metrics/`, `ingest/`, and `store/` import **no `vscode`**. That is why they can be exercised headlessly with a plain Node script, and why the cost engine is testable at all. Keep it that way.
- **The webview computes nothing.** The host sends a finished, pre-formatted view model; the webview renders. All aggregation stays host-side.
- `ui/protocol.ts` is imported by **both** processes, so a message-shape change breaks the build rather than the runtime.

---

## Working style

- Explain VS Code-specific concepts as they come up — the maintainer is an experienced developer but new to extension development. Do not explain general programming or TypeScript.
- Verify claims against the machine rather than asserting from memory. Most of this file's contents were established that way, and several confident assumptions turned out wrong.
- Prefer a visible gap to a plausible guess, in code and in conversation alike. That is the product's thesis; it should also be how it gets built.
