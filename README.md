# Modelog

**Local-first VS Code extension that measures what actually changed when you switched AI models — from your own session logs, never your code.**

> **Status: in development.** Part 1 is partially built and runs against real data. Not yet released to the Marketplace.

---

## Why

You switch models, tweak your instructions file, change how you prompt — possibly many times a week. Then you judge the result by feel.

Existing tools show totals. Totals are dominated by how much work you did, not by the choices you made, so they cannot answer the only question that matters:

> *You switched models on Monday. By Friday, was it better — in cost, in speed, in effort — or did it just feel better?*

Modelog answers that from data already sitting on your disk.

## What it does

- **Reads your local session logs.** Claude Code today (`~/.claude/projects/**/*.jsonl`), built behind a source-agnostic adapter so other assistants can follow.
- **Prices every turn properly.** Four separately-billed token classes — fresh input, cache read, cache creation, output — with 5-minute and 1-hour cache writes priced apart. In real usage ~95% of input-side tokens are cache reads, so a naive calculation is wrong by orders of magnitude.
- **Compares models on normalised metrics.** Cost per turn, turns per session, cache hit rate — not raw totals.
- **Anchors comparisons on real events.** Model switches are detected from the logs, including mid-session, and drawn on the trend chart.
- **Looks like your editor.** Every colour is a VS Code theme variable, so the UI follows your theme — including live theme switches and high-contrast. Enforced in CI.

## Privacy

**Modelog never reads your prompts or your code.** The parser extracts timestamps, model ids, token counts and session identifiers, and nothing else — `message.content` is never touched. There is a test asserting this.

Nothing leaves your machine. Parts 1 and 2 make no network calls at all.

## Honest numbers

A measurement tool that shows a wrong number is worse than one that shows a gap, so:

- Costs are integer arithmetic in micro-dollars; floating point is never used for money.
- An unrecognised model is reported as **cost unavailable**, never priced at a default rate.
- Billing mode is auto-detected. On a subscription, figures are labelled as estimates at API list rates, because a subscription is not billed per token.
- Rates live in a versioned data file (`data/pricing.json`), not in code, and go stale visibly.

## Development

Requires Node 24+.

```bash
npm install
npm run build      # esbuild: extension host + webview
npm run check      # typecheck + theme lint + tests
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host, then run **Modelog: Open Dashboard** from the command palette.

Tests are plain TypeScript run by `node --test` — no test framework dependency.

## Documentation

| Document | Contents |
| :--- | :--- |
| [`docs/PRD.md`](docs/PRD.md) | Product requirements — what and why |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Part 1 technical design — how |
| [`docs/MCP.md`](docs/MCP.md) | MCP bridge requirements (Part 2) |

## Roadmap

1. **The extension** — local capture, storage, metrics, dashboard. *In progress.*
2. **Work logs & the analysis bridge** — a local MCP server so your existing agent can reason over your own data, plus optional session labelling.
3. **Enterprise & web** — team rollups, opt-in telemetry, modelog.dev.

## Licence

MIT — see [LICENSE](LICENSE). Third-party notices in [NOTICE.md](NOTICE.md).
