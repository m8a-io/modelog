# Contributing to Modelog

Requires Node 24+. If `node --version` shows 20, the nvm default is stale: `nvm alias default 24 && nvm use 24`.

```bash
npm install
npm run build        # esbuild: extension host (cjs) + webview (esm) + css
npm run watch         # same, watching
npm run typecheck     # tsc --noEmit
npm run lint:theme    # fails on literal colours in src/webview/
npm test              # node --test test/*.test.ts
npm run check          # typecheck + theme lint + tests — run before committing
```

Tests are plain TypeScript run by `node --test` — no test framework dependency. `node --test test/` does **not** work (the directory isn't a glob); use `test/*.test.ts`.

## Running the extension

Press <kbd>F5</kbd> with `modelog` as the workspace root. A second window opens titled **[Extension Development Host]** — it opens with no folder, which is correct and expected. Run **Modelog: Open Dashboard** from the command palette there.

## Architecture

```
src/
  extension.ts      activate() — the only place with real VS Code wiring
  service.ts        ModelogService — owns store, rates, ingest. NO vscode import.
  ingest/           adapters (claudeCode, copilot), scanner, billing detect
  metrics/          cost.ts (integer engine), aggregate.ts (pure)
  store/            Store interface; sqliteStore (node:sqlite) + fileStore fallback
  ui/               panel.ts (webview host), protocol.ts (shared message contract)
  webview/          runs in the browser context — renders only
```

`service.ts`, `metrics/`, `ingest/`, and `store/` import no `vscode`, so they're exercisable headlessly with a plain Node script. The webview computes nothing — the host sends a finished, pre-formatted view model.

## Documentation

| Document | Contents |
| :--- | :--- |
| [`docs/PRD.md`](docs/PRD.md) | Product requirements — what and why |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Part 1 technical design — how |
| [`docs/MCP.md`](docs/MCP.md) | MCP bridge requirements (Part 2) |
| [`docs/INSTALL-ux.md`](docs/INSTALL-ux.md) | Install, activation and first-run UX |

## Invariants

A handful of rules are load-bearing for promises the product makes to users, and some are enforced by tests or CI — never read `message.content` or any prompt/code attribute, money is integer-plus-explicit-unit with no guessed defaults, no literal colours in `src/webview/`. They're documented in full in `docs/PRD.md` §8 and `CLAUDE.md`; read them before touching cost, storage, ingest, or the webview.

## Commit attribution

If you use an AI assistant to help with a contribution, disclose it as a prose line in the commit body (e.g. "Assisted by Claude Code") rather than a `Co-Authored-By:` trailer — that trailer gets parsed into GitHub's contributor graph, which misrepresents authorship.
