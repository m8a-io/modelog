# Changelog

All notable changes to Modelog are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — First preview release

Modelog's first public release. **Beta** — core local analysis works end-to-end against real data, but interfaces and stored data may still change release to release.

### Added

- **Local capture for Claude Code**, read from `~/.claude/projects/**/*.jsonl` — model, tokens (fresh input, cache read, 5-minute and 1-hour cache write, output), cost, session and timing data. Never reads prompt or code content.
- **Local capture for GitHub Copilot** (explicit opt-in — `Modelog: Enable Copilot Analysis`), read from Copilot's own debug logs across both its workspace-bound and no-folder storage locations. Costs, token counts, and cache-write amounts recovered through a closed-form solve against each session's own rate card.
- **A per-source dashboard**: one assistant at a time, in that assistant's own unit (dollars for Claude Code, credits for Copilot) — a dollar total and a credit total are never summed, compared, or placed on the same axis.
- **A two-panel trend chart** — cost per turn and turn volume per model, stacked by day, sharing one linked crosshair.
- **A model comparison table** — cost per turn, turns per session, cache hit rate, relative cost — normalized metrics rather than raw totals.
- **Model-switch detection**, anchored on real, observed events in the logs rather than inferred boundaries.
- **An MCP server** exposing the same metrics to Claude Code itself (and any other MCP client), so an agent can reason over your own usage data — registered with both VS Code's native MCP client and Claude Code's own config, each behind an explicit opt-in command.
- **Honest-gap handling throughout**: an unrecognized model is reported as cost-unavailable rather than priced at a guess; a subscription plan's figures are labeled as estimates rather than real spend; every ambiguous or unmeasurable figure says so rather than picking a plausible number.
- Full theming via VS Code's own CSS variables — the dashboard follows your editor's theme, including live switches and high-contrast, enforced in CI.

### Privacy

Nothing leaves your machine. No network calls, no telemetry, no account. `message.content` (Claude Code) and prompt/code attributes (Copilot) are never read by the parser — asserted by tests, not just by intent.
