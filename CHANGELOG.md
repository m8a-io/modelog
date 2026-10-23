# Changelog

All notable changes to Modelog are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.6.0] — Setting up, and cleaning up

### Added

- **`Modelog: Enable MCP Server (Copilot)` and `Modelog: Enable MCP Server (Codex)`**, with matching `Disable` commands. Until now only Claude Code had a setup command, so every other client meant discovering the MCP bridge existed and then hand-writing config for it.
- **"Copilot" asks which Copilot**, because they are two products with two unrelated mechanisms. The **Copilot CLI** branch runs `copilot mcp add`, writing `~/.copilot/mcp-config.json`. The **Copilot Chat** branch writes nothing at all — Modelog has always registered with VS Code's own MCP client at startup, so the real gap was never configuration: you still have to start the server in VS Code's MCP servers list and tick its tools in the Chat tool picker, and agent mode caps how many tools can be active at once. A registered, running server with no tools selected looks exactly like one that was never set up. The command opens that view and names both steps instead of reporting a success it cannot verify.
- **Codex registration runs `codex mcp add`**, writing `~/.codex/config.toml`. For both CLIs Modelog shells out to the vendor's own tool rather than editing the file: Codex's config is TOML carrying model settings and a `trust_level` per project, and the Copilot CLI coordinates writes through a lock file. Neither format becomes Modelog's to get right, and comments and unrelated sections survive. The guarantees are unchanged — the exact command and the exact file are shown and confirmed, a `.bak` is taken first, and a failure surfaces the CLI's own error.
- **A "Setting up" section in the README**, per assistant: what needs no setup (Claude Code and Codex log by default), what will stay empty until you act (Copilot Chat writes no usage log until `Modelog: Enable Copilot Analysis` turns one on), and which command registers the MCP bridge where.

- **`Modelog: Remove Modelog's Changes`, and an uninstall hook that runs it for you.** Modelog writes four things outside its own storage — Copilot's debug-logging setting, and an MCP entry in Claude Code's, the Copilot CLI's and Codex's configs — and none of them went away when the extension did. Left behind, the MCP entries point at a server file VS Code has deleted, so three assistants try to spawn a missing file every session, and Copilot keeps writing prompt-and-code debug files indefinitely. The command lists only what is actually present, ticks the restorative items, leaves destructive ones (backup files, collected history) unticked, and reports each separately. A `vscode:uninstall` hook runs the same plan unattended on the next VS Code start for anyone who simply uninstalls — restorative items only, since it has no way to ask.
- Copilot's logging is switched back off **only when Modelog is on record as having switched it on**. `Enable Copilot Analysis` returns early when the setting is already true, so a user who turned it on themselves must get it back untouched; a small `~/.modelog/uninstall.json` records that distinction, and the hook deletes it as its last act. The settings file is **located by reading it back**, not by computing a path — VS Code exposes no API for where `ConfigurationTarget.Global` actually wrote, and the obvious derivation is wrong in a remote window, where the user settings file is not even on the same machine as the extension host. When it cannot be found, the cleanup says so and names the key, rather than editing a guess.
- Modelog's own data is deliberately **not** cleaned up by either path: VS Code deletes an extension's storage directory on uninstall by itself. Deleting the collected history is offered by the command only, unticked, for starting over without uninstalling.

### Changed

- **Config writes are atomic** — a sibling temp file and a rename, rather than writing in place. The uninstall hook shares this code and is SIGKILLed by VS Code after five seconds, so a kill landing inside a plain write could have truncated `~/.claude.json`, which holds Claude Code's auth state.
- **`Modelog: MCP Server Status` now reports all four clients separately**, not two. They fail for four unrelated reasons — a bundle that would not deploy, a project Claude Code has never seen, a CLI that is not on `PATH`, an entry that was never written — and an assistant that is not installed is reported as such rather than as one that merely has not been set up.

## [0.5.1] — Price Claude Sonnet 5.5

### Fixed

- **`claude-sonnet-5-5` had no entry in the rate table at all**, so every turn on it showed as completely unpriced — "unavailable" rather than a number. Added at $2.00/$10.00 per 1M input/output tokens, with its published 0.05x cache-read discount (not the 0.1x default most models get).
- Re-verified every other model already in `data/pricing.json` against Anthropic's and OpenAI's current published list pricing. No other rate has changed since the last check.

## [0.5.0] — See what delegation costs (and doesn't)

### Added

- **A Delegation section on the dashboard** ([#17](https://github.com/m8a-io/modelog/issues/17)). Cost per turn blends two populations — your own conversation and sub-agent traffic — and dozens of cheap sub-agent calls drag the blended average down without your own turns getting any cheaper. The dashboard now segments instead: each population gets its own turn count, total, and cost per turn, two proportion bars show turn share against cost share, and the headline states the measured asymmetry outright, e.g. *"Sub-agents handled 5.0% of turns for 1.6% of the cost."* Measured on real data, never a counterfactual "you saved $X".
- **A per-day delegation trend** — the same two-panel chart (cost per turn above, turns below), keyed by population instead of by model, so days where delegation was heavy and main-thread cost per turn moved can be read side by side.
- **Sub-agent annotations in the model comparison table.** A model whose turns were partly or wholly sub-agent calls now carries an `N sub-agent` / `all sub-agent` pill — a model used only by sub-agents no longer reads as one you chose for work.
- Turns ingested before sub-agent capture existed are reported as belonging to **neither** population, not silently counted as main-thread: the stored `false` on those rows is a column default, not an observation. Sub-agent cost is included in every total either way — real calls, real money.

## [0.4.0] — One turn per API call

### Fixed

- **Claude Code turn counts and costs were inflated roughly 3×.** Claude Code writes one log record *per content block* — a single API call with text plus several tool calls appears as many records, each repeating the same token counts — and Modelog counted and priced every copy. Turns now deduplicate on the API message id, verified to the micro-dollar against Claude Code's own internal cost accounting on a real seven-hour session (290 API calls, $61.33 — where the old counting showed 710 turns and $182.23). **On first launch after this update, stored Claude Code history is rebuilt from the logs and the dashboard will show fewer turns and lower costs: that is the inflation leaving, not data loss.** History whose log files Claude Code has since deleted cannot be rebuilt and is dropped rather than kept at a figure known to be wrong.

### Added

- **`claude-haiku-5-5` pricing, including its prompt-length tier** — the only Claude model priced by prompt length: a request over 100,000 input-side tokens (cache reads and writes count toward the threshold) pays exactly 5× on every token class, output included. Without the tier a long-context Haiku turn would show a fifth of its real cost.
- **A third billing state: subscription + usage credits.** When a Claude subscription has extra usage enabled (`hasExtraUsageEnabled`), the dashboard and MCP tools now say so, including the honest limitation: the logs record nothing about *which* turns billed from the credit pool, so every figure remains an estimate at API list rates and no estimated/billed split exists.
- **Per-turn capture of `service_tier` and `fallback_credit`** — Anthropic's slots for request tiering and credit-pool billing. `service_tier` is a fail-closed pricing modifier ("standard" prices at 1×; an unrecognised tier shows cost-unavailable rather than a wrong number). `fallback_credit` has only ever been observed as null; a populated value is stored verbatim for the day Anthropic ships one.

## [0.3.0] — GitHub Copilot CLI support

### Added

- **Local capture for the standalone GitHub Copilot CLI**, read from `~/.copilot/session-state/**/*.jsonl` — a separate product from the Copilot Chat VS Code extension, with its own log format, but the same GitHub Copilot billing pool and credit unit, so its turns join the existing Copilot dashboard rather than needing one of their own. Model, tokens (input, cache read, cache write — including the cache's own stated 5-minute/1-hour TTL tier), and cost are all reported directly by the source, not solved or assumed, unlike the Chat extension's debug logs. Never reads prompt or tool-call content.

## [0.2.1] — Round out Codex pricing

### Added

- **`gpt-6-sol` and `gpt-6-luna`** added to the rate card, rounding out the current GPT-6 coding-model generation alongside `gpt-6-astra` and `gpt-6.1-sol`. A turn on either now shows a real dollar figure instead of "cost unavailable".

## [0.2.0] — Codex support

### Added

- **Local capture for Codex**, read from `~/.codex/sessions/**/*.jsonl` — the CLI and the official `openai.chatgpt` VS Code extension share this one on-disk store, so one adapter covers both. Model, tokens (input, cache read, cache write, reasoning, output), cost, session and timing data. Never reads prompt, reasoning, or tool-call content.
- **Codex pricing** — `gpt-6.1-sol` and `gpt-6-astra` added to the rate card, so Codex turns show a real dollar figure rather than "cost unavailable". Figures are always framed as an estimate, since Modelog cannot detect whether you pay for Codex through a ChatGPT subscription or metered API credits without reading Codex's credential file, which it will not do.
- Codex's request-level pricing tier (`service_tier`) is captured honestly: the default tier is priced, and a turn on an unconfirmed faster tier correctly shows as cost-unavailable rather than being silently priced at the wrong rate.

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
