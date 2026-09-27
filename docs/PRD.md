# Modelog — Product Requirements Document

**Version:** 1.0
**Status:** In implementation — Part 1
**Data-source verification:** 2026-09-20, against a sample of local Claude Code sessions

---

## 1. Problem Statement

AI coding assistants (Claude Code, GitHub Copilot, Codex, etc.) are billed and used as if they were team infrastructure, but for most developers they are a deeply personal tool — the choice of model, prompting habits, and session patterns are individual decisions made many times a day. Yet no existing tool lets a single developer answer, with real numbers, a question as simple as:

> *"I switched from Model A to Model B on Monday. By Friday, was that actually better for me — in cost, in speed, in outcome — or did it just feel better?"*

Three things are missing from the current tooling landscape:

- **Normalized, per-model comparison metrics.** Total credit burn is dominated by workload volume and personal habits, not model choice. What's needed is credits/turn and turns/session, segmented by model.
- **Behavioral confound tracking.** A cheaper-feeling model changes behavior (e.g. opening more parallel sessions), which can raise total spend independent of the model's actual per-unit cost.
- **Task-context normalization.** A "bad week" for a model may just be a hard week of tickets. Without knowing what kind of work a session involved, cost/speed comparisons across time periods are confounded by workload difficulty.

Existing tools cover raw capture and totals. None combine all three at the individual-developer level (see §4).

---

## 2. Goals

- Give an individual developer a trustworthy, self-service way to run informal A/B experiments on their own AI usage and see the effect on cost, speed, and effort.
- Make this fully useful with zero server dependency (personal tier), while enabling a natural upsell path to team-level rollups (enterprise tier).
- Turn categorized work logs into a bridge that lets an AI agent auto-draft time-tracking / PM entries, closing the loop between "what the AI helped with" and "what gets reported."

---

## 3. Non-Goals

- **Not a scientific / statistically rigorous causal-inference tool.** It supports self-experimentation, not proof.
- **Not a multi-assistant tool at launch.** Claude Code in VS Code is the initial, laser-focused data source (see §7.1 for why this changed from v0.3). The capture layer is built as a source-agnostic receiver to make later adapters cheap.
- **Not a cross-vendor cost comparator.** Modelog will never publish a figure of the form "Tool A costs N× Tool B". See §4.5 — this is a hard product constraint, not a roadmap gap.
- **Not an invented-value calculator.** Modelog will not compute "hours saved," "value generated," or an ROI multiplier. Those numbers require assumptions the tool cannot verify, and publishing them would undermine the trust the entire product depends on. Modelog reports what it measures and labels what it estimates.
- **Not a replacement for enterprise Copilot admin metrics.**

---

## 4. Prior Art

### AI Insights (`milan-holes/ai-insights-extension`)

The closest existing tool. It reads local session logs from Copilot (`workspaceStorage/*/chatSessions/`), Claude Code (`~/.claude/projects/{project}/*.jsonl`), Codex (`~/.codex/sessions/`), and Antigravity; prices 30+ models; and ships a dashboard webview, a status bar summary, a filterable session history, a context-quality score, and a prompt A/B panel using disposable git worktrees.

**What this tells us:**

1. **The capture layer is proven and is commodity.** Reading Claude Code JSONL and deriving per-model cost is a solved problem. Modelog should not spend its innovation budget there — it should match this baseline efficiently and move on.
2. **Useful techniques to borrow.** Multi-IDE path resolution (VS Code / Cursor / VSCodium / Insiders, incl. WSL mounts); a per-model pricing table as data; turn-over-turn context diffing to estimate cache behaviour when real data is absent; opt-in provider debug logging to upgrade estimates to measurements.
3. **Where Modelog must differ.** AI Insights is framed around ROI and justification — "hours saved," "value generated," a ROI multiplier. That is precisely the procurement-audience framing §13 positions Modelog against. It has no behavioral confound tracking, no task-context normalization, and no anchored before/after comparison engine. Its A/B feature compares *prompts* in worktrees; Modelog compares *periods of real work* separated by a behavioral anchor.

**Modelog's defensible core is therefore §1's gaps two and three — confound tracking and task normalization — plus the anchored trend engine.** Everything in Part 1 below exists to make those possible, not as the product in itself.

### 4.5 Comparability — a hard constraint

Not every comparison Modelog *could* render is one it *may* render. Comparability has three tiers, and only the first two support cost.

| Tier | Example | Cost comparison | Behavioural comparison |
| :--- | :--- | :--- | :--- |
| Same tool, different model | `opus-4-7` vs `sonnet-5` | **Yes** — one vendor, one published rate card, one token unit | Yes |
| Same tool, different surface | Claude Code CLI vs VS Code | **Yes** — identical billing and units | Yes |
| **Different tool or vendor** | Claude Code vs Copilot | **Never** | Yes |

**Why cross-vendor cost is forbidden.** The units are not the same kind of thing. Claude Code bills tokens, which convert to currency at a published rate. Copilot bills *premium requests* against a monthly quota, with per-model multipliers and no token counts at all. Converting one into the other requires allocating a plan's fixed price across its included requests — an *allocation*, not a measurement — and marginal cost diverges sharply from average cost once a quota is exceeded. Any resulting ratio would be an artefact of the allocation method, not a property of the tools.

> **Revised again 2026-09-27, after finding Copilot's rate card on disk.** This section's factual premise — that Copilot carries "no token counts at all" and that its cost can only be *allocated* — is **wrong, and the correction is larger than first thought.**
>
> `debug-logs/{sessionId}/models.json` (§7.1) is a 43-model, cross-vendor, per-token rate card written to local disk, denominated in credits per 1M tokens, with separate `input_price`, `output_price`, `cache_price` and `cache_write_price`. Calibrated against `data/pricing.json`, **1 credit = 1 cent exactly**:
>
> | Model | Copilot card | Modelog USD/1M |
> | :--- | :--- | :--- |
> | `claude-sonnet-5` | 200 / 1000 | $2.00 / $10.00 |
> | `claude-haiku-4.5` | 100 / 500 | $1.00 / $5.00 |
> | `claude-opus-4.7` | 500 / 2500 | $5.00 / $25.00 |
>
> The card's own cache tiers are 0.10× and 1.25× on base input — the same multipliers §8.2 derives — which independently corroborates Modelog's rate table. A per-turn Copilot cost is therefore **exactly computable from local data**: `llm_request` token counts × this card. It is a measurement, not an allocation, and that is presumably what Copilot's own per-turn hover tooltip renders.
>
> **What this means for the constraint.** The units are commensurable after all: both tools price tokens, and for Anthropic models Copilot's card matches the vendor's published rates to the cent. Tier 3 cannot be justified on incommensurable units any more.
>
> **The surviving distinction is not vendor, it is billing mode.** A Pro subscriber's credits are drawn against an included monthly allowance, so credits consumed is a *rate-card* figure — "what this turn would cost at list" — not cash out of pocket. But Modelog already faces exactly this for Claude Code on a Max subscription, and already models it (`ingest/billing.ts`, `detectBilling`). So the honest axis is **metered vs. prepaid**, which cuts *across* vendors rather than between them:
>
> - Rate-card cost vs rate-card cost — commensurable, and now measurable for both tools.
> - Cash-out-of-pocket across different billing modes — not commensurable, and never was, *within* a vendor as much as across.
>
> **This is not yet a decision to relax the constraint, and reason 2 below is untouched by any of it** — publishing quantitative comparative claims about a named third party's product still needs legal review, and that reason never depended on units. Tracked as open question 16.

**The two reasons, in order of weight:**

1. **It would be wrong.** A confidently-wrong comparison destroys the trust the entire product depends on (§8.2). This alone settles it.
2. **It would be a claim about third parties.** Publishing quantitative comparative claims about named vendors' products invites scrutiny Modelog cannot meet with a number it knows to be an artefact. If any comparative positioning is ever contemplated, it needs actual legal review first — not a disclaimer bolted on.

**What Modelog does instead.** Cross-tool comparison is **behavioural only**, using metrics that need no shared billing unit: turns per session, sessions per day, session duration, mode shifts, and the §7.4 markers. *"You open 40% more parallel sessions on Copilot"* is measurable, defensible, and more interesting than a price ratio. Where a currency figure exists for one tool and not another, they are never placed in the same ratio, table column, or chart axis.

**Aggregate outcome claims are covered by the same rule.** A marketing claim such as *"Modelog users cut AI spend 20%"* is a measurement claim and needs a stated counterfactual and method, or it is the same error wearing different clothes. The defensible form is tied to an observed anchor: *"developers who changed model within 24h of a flagged shift reduced cost per turn by X%"* — which is already §11's Actionability metric.

---

## 5. Target Users

| Tier | User | Primary need |
| :--- | :--- | :--- |
| Personal (free) | Individual developer using an AI coding assistant | "Did my change actually help me?" |
| Enterprise (paid, per seat) | Eng managers / platform teams | Team-wide cost-per-outcome visibility, budget alerts — without seeing raw code or prompts |

---

## 6. Core Data Model

- **Session** — an IDE chat/agent session: id, start/end timestamp, model(s) used, repo/branch, duration.
- **Turn** — one exchange within a session: timestamp, model, input/output/cached tokens, cost (measured or derived — see §8.2).
- **Marker** — a point-in-time event that can anchor a comparison. Carries an explicit `provenance` field:
  - `observed` — a fact read directly from the logs (model switch, instruction-file save). Trusted; may anchor comparisons.
  - `inferred` — a heuristic detection (frustration loop, context bloat). Shown to the user, but flagged as a guess.
  - `user` — a manual annotation.
- **Work Log Entry** — a per-session categorization (e.g. "bug fix", "docs") generated locally in Part 2.

*(v0.3's "Sync Boundary" is removed as a data-model entity — it is an operation, specified in §7.3.)*

---

## 7. Delivery Plan & Functional Requirements

The work splits into three parts. Each is independently shippable and independently valuable.

### Part 1 — The Modelog Extension

**Goal:** a local-only VS Code extension that captures Claude Code sessions, stores them durably, and answers the §1 question for a single developer.

#### 7.1 Data Capture

**Primary source: Claude Code.** `~/.claude/projects/<workspace-slug>/<session-uuid>.jsonl`, append-only JSONL. Each record carries `sessionId`, `timestamp`, `uuid`/`parentUuid` (turn threading), `cwd`, `gitBranch`, `version`, and `type`.

**Verified schema (2026-09-20).** Across every assistant record in a sample of local sessions, `message.model` and `message.usage` were present and populated — coverage is **total, not partial**. The `usage` object is uniform in shape:

```
input_tokens                 output_tokens
cache_creation_input_tokens  cache_read_input_tokens
cache_creation.{ephemeral_1h_input_tokens, ephemeral_5m_input_tokens}
output_tokens_details.thinking_tokens
server_tool_use.{web_search_requests, web_fetch_requests}
service_tier   speed   inference_geo   iterations[]
```

Record `type` values observed: `assistant`, `user`, `attachment`, `queue-operation`, `ai-title`, `last-prompt`, `atis-latch`, `file-history-delta`, `file-history-snapshot`. Only `assistant` carries usage.

**Two ingestion rules follow directly:**

- **Filter `<synthetic>` records.** Some assistant records carry `model: "<synthetic>"` with an all-zero usage object and null `service_tier` — locally generated, not API calls. They must be excluded from turn counts and cost, or they inflate turns/session with free turns.
- **A turn is not an inference call.** Each usage object carries an `iterations[]` array of the underlying calls. `turns/session` must define which it counts, consistently, and the dashboard must say which it means.

> **Changed from v0.3.** v0.3 named GitHub Copilot's OTel export and `workspaceStorage/*/chatSessions/` as the Phase 1 source. Verification on the target machine found **zero** `chatSessions` directories across 55 workspaces — Copilot Chat has moved that state into `globalStorage/github.copilot-chat/session-store.db` — and the primary user does not use Copilot at all. Claude Code's JSONL is a supported, structured, on-disk artifact with model and token data already present, making it both the better first adapter and the one the author can dogfood daily.

> **Copilot's local schema, verified 2026-09-27.** `globalStorage/github.copilot-chat/session-store.db` (25MB, `schema_version = 1`, macOS, VS Code) on a heavy day-to-day Copilot user:
>
> - `turns (id, session_id, turn_index, user_message, assistant_response, timestamp)` — 3,070 rows. **No model, token, cost or credit column exists in any table.**
> - `sessions (id, cwd, repository, host_type, branch, summary, agent_name, agent_description, created_at, updated_at)` — 203 rows. `host_type` and `agent_name` are Copilot's analogue of Claude Code's `entrypoint`.
> - `session_files (session_id, file_path, tool_name, turn_index, first_seen_at)` — 5,214 rows. Files touched per session, which Claude Code's JSONL does **not** expose.
> - An FTS5 `search_index` over 3,070 rows of message content.
> - Retention differs by table: sessions reach back to 2026-05-20, turns only to 2026-07-16. Turn-level history appears to be pruned or was added later — a local-first tool cannot assume the turn table spans the session table.
>
> **Copilot's local rate card — found 2026-09-27.** Beside `debug-logs/{sessionId}/main.jsonl` sits **`models.json`**: 43 models across Anthropic, OpenAI, Google, Microsoft and Moonshot, each with `billing.token_prices.{default,long_context}` carrying `input_price`, `output_price`, `cache_price`, `cache_write_price` per `batch_size` of 1M tokens, plus `restricted_to` listing the plans entitled to the model. Denominated in credits, where 1 credit = 1 cent (calibration in §4.5). Models included at no premium cost price at 0. `cache_write_price` is non-zero only for Anthropic models, matching those vendors' actual billing.
>
> **The card is volatile, and that is an architectural finding.** Two cards captured 84 days apart (2026-07-04 and 2026-09-27) differ sharply: 43 models grew to 60, 9 were removed, several were repriced (`mai-code-1-flash-secondary` 75/450 → 20/120), and **the schema itself changed** — `cache_price` was renamed `cache_read_price` and `cache_write_1h_price` was added. A pinned rate file cannot track this.
>
> But it does not need to: **Copilot writes the card that was in effect beside the session it applies to.** That is better provenance than Modelog's own `data/pricing.json`, a single global snapshot (currently dated 2026-06-24) which cannot price a historical Claude Code turn at the rate in force when it ran. A Copilot adapter should read the sibling `models.json` per session and never pin. Worth asking whether Claude Code pricing should move the same way (open question 18).
>
> **The current card matches Modelog's cost engine exactly.** `claude-sonnet-5` prices at input 200, output 1000, `cache_read_price` 20, `cache_write_price` 250, `cache_write_1h_price` 400 — i.e. 0.1×, 1.25× and 2.0× on base input, the identical four classes and multipliers §8.2 derives. The §8.2 engine therefore runs on Copilot data unchanged, resolving open question 17 on the rate side. Note `cache_read_price` can be fractional (`gemini-3.8-flash` = 7.5 credits/1M); since 1 credit = 1 cent = 10,000 micro-dollars, conversion stays integral for up to four decimal places, and the adapter must assert that rather than assume it.
>
> **The server returns the credit cost per request — resolved 2026-09-27 from Copilot Chat 0.66.0's own bundle.** The API response carries `usage.copilot_usage.total_nano_aiu`, which Copilot records as OTel attribute `copilot_chat.copilot_usage_nano_aiu` and emits on the `llm_request` span as `attrs.copilotUsageNanoAiu`. **Per-turn cost is measured, not derived** — which is a stronger position than Claude Code, where Modelog must compute cost from tokens × rates. For Copilot the §8.2 engine is not needed at all; `models.json` becomes a cross-check rather than the source.
>
> Full `llm_request` attrs in 0.66.0: `model`, `debugName`, `inputTokens`, `outputTokens`, `cachedTokens` (cache *read* only), `ttft`, `responseId`, `maxTokens`, `temperature`, `topP`, `requestOptions`, `requestShape`, `copilotUsageNanoAiu`, `error`, plus `systemPromptFile`/`toolsFile` — and span fields `ts`, `dur`, `sid`, `spanId`, `parentSpanId`, `status`, `name` (`chat:{model}`).
>
> **Three consequences.**
>
> 1. **Nano-AIU is finer-grained than micro-dollars, so invariant "money is integer micro-dollars" needs extending.** 1 AIU = 1 credit = 1 cent = 10,000 micro-dollars, so 1 micro-dollar = 100,000 nano-AIU. Converting on ingest would truncate a measured figure. Store the native integer and convert only at display, or widen the internal unit. This is the first case where §8.2's unit is not precise enough for a source's own measurement.
> 2. **Content and usage share one record.** `userRequest` and `inputMessages` are attrs on the *same* span as the token counts, exactly as `message.content` and `message.usage` share a Claude Code record. The adapter must select named attrs, never copy the attrs object.
> 3. **The span graph solves the turn↔call join.** `parentSpanId` plus dedicated `turn_start`/`turn_end` spans mean requests attach to turns by key, so the competitor's nearest-preceding-timestamp bucketing is unnecessary and lossy. There is also a first-class **`subagent`** span type (from `INVOKE_AGENT`, carrying `agentName`) — Copilot's exact analogue of Claude Code's `isSidechain`, which makes the confound comparable across both adapters.
>
> No cache-*write* token count reaches the span, though the telemetry vocabulary defines a `cache_creation.input_tokens` attribute. Immaterial for cost, since cost is measured.

> **The cost model is verified against measured data (2026-09-27).** A captured `gpt-5.6-terra` agent turn — 3 `llm_request` spans — reconciles to **zero delta** on all three against the card:
>
> `cost = plain_input×input_price + cache_write_tokens×cache_write_price + cached_tokens×cache_read_price + output×output_price`
>
> | req | plain | write | read | out | predicted | measured | delta |
> | --: | --: | --: | --: | --: | --: | --: | --: |
> | 1 | 3 | 23,623 | 0 | 221 | 6.171550 | 6.171550 | 0 |
> | 2 | 3 | 321 | 23,623 | 165 | 0.751310 | 0.751310 | 0 |
> | 3 | 3 | 682 | 23,944 | 84 | 0.750780 | 0.750780 | 0 |
>
> This confirms three things at once: **1 AIU = 1 credit = 1 cent**; Copilot bills on exactly the same four token classes §8.2 prices; and `copilotUsageNanoAiu` is authoritative to the nano-unit. Total for the turn: 7.67364 credits ($0.077).
>
> **Cache-write tokens are billed but not reported.** The span omits them, yet they dominate a first request (23,623 of 23,626 input tokens here). They are recoverable as the *next* request's `cachedTokens` minus this one's — an inference the adapter must make explicitly and flag, since the final request in a session has no successor and its write count is unverifiable.

> **Intra-session model switching works, and is detectable by key (verified 2026-09-27).** One captured session ran `gpt-5.6-terra` for 3 requests then `claude-sonnet-5` for 5, under a single session id. The two user turns are separated by `parentSpanId`, not inferred from timestamps. So §11 open question 11's intra-session anchor case is supported on Copilot. The same formula above reconciles **all 8 requests across both vendors to zero delta**, which is strong evidence it is Copilot's actual billing rule rather than a fit.
>
> That session also yields a tier-1 comparison directly: Sonnet cost more in total (9.90 vs 7.67 credits) but less per inference call (1.98 vs 2.56), because it made 5 calls to Terra's 3 — the "costing more or used more?" question, answered from one session.

> **Pro-plan entitlement is in the card.** `restricted_to` confirms `claude-opus-5`, `claude-opus-5.5`, `claude-fable-5.1`, `gpt-6-astra` and `gpt-5.6-sol` are unavailable on Pro — so a Copilot model comparison is bounded by plan, and the dashboard should say so rather than present an absent model as an unused one.
>
> AI Insights reads `main.jsonl` and **not** `models.json` in the same directory — which is why it falls back to a hardcoded model id while an authoritative rate card sits beside the file it parses.

> **Where model and token data actually live — resolved 2026-09-27 from AI Insights' source (§4).** `session-store.db` is the wrong file. Real per-request data is written to **`workspaceStorage/{hash}/GitHub.copilot-chat/debug-logs/{sessionId}/main.jsonl`** as `llm_request` events carrying `model`, `inputTokens`, `outputTokens` and `cachedTokens`. The companion `transcripts/{sessionId}.jsonl` holds conversation content and no usage data at all.
>
> Event shape, as far as that parser reads it: `{"type":"llm_request","ts":<ms>,"attrs":{"model","inputTokens","outputTokens","cachedTokens"}}`. Those are the four fields *AI Insights extracts*, not necessarily all the event carries — `models.json` prices cache writes, so a cache-write count may well be present and simply unread. **Unverified**: the only `main.jsonl` available locally holds a single `session_start` event. There is also no key joining a request to a user turn, so the competitor buckets events onto the nearest preceding interaction by timestamp — a heuristic join, not a real foreign key. Resolving both needs one real captured session (open question 17).
>
> **It is gated on a Copilot setting that is off by default:** `github.copilot.chat.agentDebugLog.fileLogging`. Real data exists only for sessions recorded *after* a user enables it.
>
> **This is a constraint on the product, not just the adapter.** Per AI Insights' own README, enabling that setting "makes the Copilot Chat extension write your full prompts and code context to local, unencrypted debug-log files that don't otherwise exist." Modelog's central trust claim (§8.1) is that it never reads prompts. Instructing a user to persist *more* prompt content to disk in order to be measured is in direct tension with that, however local it stays. Any Copilot adapter must decide this deliberately: refuse to prompt for it, or prompt with the trade-off stated plainly and default to a visible gap.
>
> **What the competitor does without it.** `providers/copilot.ts` falls back to `model: 'gpt-5-mini'` hardcoded for every turn and `estimateTokens(text)` from string length. Those estimates are surfaced as dashboard figures (cache metrics are flagged "(calc.)"; the model attribution is not flagged at all). This is the §4.3 differentiator made concrete — not a claim about a competitor's honesty, which their README addresses openly, but evidence that the commodity layer ships confident numbers where Modelog would show a gap (§8.2, invariant: an unknown model costs null).
>
> **Privacy inversion vs. Claude Code.** There, usage is separable from content, so the store honours §8.1 by simply not reading `message.content`. Copilot's `turns` table is content and nothing else, plus an FTS5 index over it — so an adapter must select only `timestamp`, `session_id` and `turn_index`.

**Adapter architecture.** Capture is an OTel-shaped internal event model behind a per-source adapter interface. Copilot, Codex, and others become later adapters without touching the metrics or UI layers. Each adapter ships recorded fixtures pinned to the source version it was built against.

**Format-drift rule.** When an adapter encounters a shape it does not recognise, it surfaces *no data* and a visible warning. It must never emit a number it is not sure of. In a measurement product a wrong number is worse than a gap.

#### 7.2 Local Persistent Storage

Local SQLite database, one growing store per user, no size-driven data loss. Full user visibility, export, and deletion control. Append-only ingest with idempotent re-reads (source logs may be re-scanned).

#### 7.3 Metrics & Trend Engine

Compute over any date range, segmented by model:

- cost per turn
- turns per session
- sessions per day
- cache hit rate

**Cost model (cache-aware) — required, not an optimization.** In the verified sample, **roughly 95% of all input-side tokens were cache reads**, with fresh input tokens numbering in the low thousands against tens of millions of cache reads. A naive `input_tokens x input_price` calculation would report a cost near zero and be wrong by orders of magnitude.

Cost must therefore be computed across four separately-priced token classes — fresh input, cache read, cache creation, and output — and cache creation must be split further, since `ephemeral_1h` and `ephemeral_5m` writes price differently (observed split: 2,144,830 vs 365,082 tokens, so both are live in practice). Thinking tokens are reported inside `output_tokens_details` and must not be double-counted against `output_tokens`.

This makes the pricing table (§8.2) multi-dimensional per model, not a single rate.

Comparisons are **anchored** on a marker: pick an anchor, get before/after for the windows either side. Part 1 ships with `observed` anchors only — primarily **model switch**, which is unambiguous and read directly from the logs.

#### 7.4 Behavioral Markers

The `inferred` detectors from v0.3 §6.3, reframed as a tuning problem rather than a launch requirement:

- **Frustration loop (churn)** — spike in turns/session at short intervals.
- **Mode shift** — Q&A chat → agentic usage, via tool-invocation records.
- **Context bloat / token spikes** — deviation from a baseline of input tokens/turn.
- **System instruction tweaks** — file-save events on `CLAUDE.md` / `.github/copilot-instructions.md`, anchoring before/after on prompt changes.
- **Session multitasking** — concurrent sessions in short windows.

Each is a heuristic that can misfire — a frustration loop and fast productive iteration look alike in turn rate. **These ship after the core metrics, tuned against the author's own captured data, and are always marked `inferred` in the UI.** Instruction-file saves are the exception: that is an `observed` marker and can ship with Part 1's core.

#### 7.5 UI

Following the shape AI Insights validated, with Modelog's own framing:

- **Status bar** — compact today / trailing-30-day summary with hover detail.
- **Dashboard (webview)** — per-model comparison table and trend charts; the anchored before/after view is the hero surface, not a totals readout.
- **Session history** — filterable, sortable, exportable table with per-session drill-down.
- **Marker timeline** — markers overlaid on the trend chart, visually distinguishing `observed` from `inferred`.

**Stack:** TypeScript, esbuild, VS Code webview API, `better-sqlite3` (or equivalent).

---

### Part 2 — Work Logs & the Analysis Bridge

**Goal:** turn captured sessions into categorized work, and let a capable model reason over the result — without Modelog shipping or hosting a model of its own.

#### 7.6 Two distinct jobs

Part 2 was previously framed as one "local analyst". It is two jobs with different volumes, different inputs, and different privacy properties. Conflating them is what makes the design look harder than it is.

| | **Job A — Labeling** | **Job B — Insight** |
| :--- | :--- | :--- |
| Cadence | Every session, in the background | On demand, occasional |
| Input | Session-level signal (see §7.7) | *Aggregates only* — "12 bug-fix sessions, 18 turns avg, up from 9" |
| Sees content? | Possibly — hence local-only | **Never** |
| Implementation | Metadata heuristics, optionally a local SLM | The user's own agent, over MCP (§7.9) |

**The privacy boundary is content vs. derived, not local vs. cloud.** Once data is derived aggregate metrics with no prompts and no code in it, where it is processed stops mattering. That is what makes Job B safe to hand to any model the user already trusts.

#### 7.7 Session labeling (Job A)

Assign each session a coarse category — "bug fix", "refactor", "docs", "exploration" — so task difficulty stops confounding cost comparisons (§1, gap three).

**Metadata-only by default.** The Part 1 parser never reads `message.content`, and Part 2 does not change that. Labels are derived from: git branch name, file extensions touched, which tools were invoked, error and retry counts, turn rhythm, and session duration. Branch names alone (`fix/login-timeout`, `refactor/store`) carry substantial signal.

This keeps *"Modelog never reads your code or prompts"* literally true, which is a trust asset rather than merely a constraint. If metadata proves insufficient, content-based labeling becomes an explicit opt-in — and doing so permanently forecloses any non-local processing of that job.

**Heuristics before models.** Ship rule-based labeling first and measure its accuracy against hand-labeled sessions. A model is justified only where rules demonstrably fail.

#### 7.8 Optional local SLM

Where heuristics are insufficient, auto-detect Ollama on `localhost:11434` and classify locally from a condensed structured summary — never a raw transcript. Fully offline; absent Ollama, the feature is cleanly off and everything else is unaffected.

**Pin the model.** Ship a Modelfile fixing model, system prompt and parameters. §1's third gap requires labels that are comparable *between users*; a free choice of local model makes them incomparable.

**No fine-tuning in Part 2.** Classifying into roughly eight labels from structured features is not a fine-tuning problem. If a small model underperforms, the remedy order is better input features, then better prompting, then a larger model. LoRA or a custom checkpoint would add training infrastructure, artifact distribution, versioning and an eval harness — none of it justified without evidence the task is genuinely hard.

#### 7.9 MCP Bridge (Job B) — **first deliverable of Part 2**

A local MCP server exposing Modelog's derived metrics and work logs, so the user's existing agent can reason over them.

**This is deliberately reordered to the front of Part 2.** It is the cheapest component, the highest leverage, and it may remove the need for an analysis model altogether: the user already has a capable model in their editor, and Modelog's job is to give it good data rather than to ship a second model beside it. It also delivers standalone value before any labeling exists.

Requirements live in a dedicated document (`docs/MCP.md`). Binding constraints:

- **Read-only in v1.** The server exposes no write tools. Draft-then-approve is satisfied structurally: the agent drafts, the user approves inside the target tool. Modelog never writes to Jira, Toggl or anything else.
- **Opt-in, always.** Registration modifies MCP client configuration outside Modelog's own storage and must never happen silently.
- **Derived data only.** The same content boundary as §7.6.

#### 7.10 Task-context normalization

Once labels exist, category becomes a filter and segment dimension on every Part 1 metric — "cost per turn on bug fixes, Model A vs Model B" — which is the actual answer to §1's third gap.

### Part 3 — Enterprise & Web

**Goal:** team-level value and the commercial surface. All opt-in and telemetry questions are deferred to here.

#### 7.11 Sync Boundary

An explicit user action pushing **derived metrics and labels only** — never raw content, prompts, or code — to enterprise servers.

#### 7.12 Team Rollup

Team-wide cost-per-outcome, waste detection, budget alerts, without exposing individual raw content.

#### 7.13 Opt-In Telemetry & Global Benchmark

Product usage metrics, strictly opt-in, incentivized by unlocking a "Global Benchmark" comparing anonymized efficiency against community averages.

> **Risk, carried from review:** this is a chicken-and-egg. The benchmark has no value until a population has opted in, and privacy-first early adopters are the group least likely to opt in. Parts 1 and 2 therefore cannot rely on telemetry to learn anything — see §11.

#### 7.14 Website (sub-project)

Marketing site, documentation, enterprise signup and billing. Scoped separately.

---

## 8. Non-Functional Requirements

### 8.1 Privacy / local-first
Zero raw content leaves the device without an explicit sync action. Parts 1 and 2 make no network calls except to `localhost`.

### 8.2 Honest numbers

**Rate table.** Pricing lives in `data/pricing.json`, versioned and dated, never in code. It stores base input/output rates per model plus three cache multipliers applied to the base input rate — cache read 0.1x, 5-minute cache write 1.25x, 1-hour cache write 2.0x — so a rate change touches one number, not nine. An unrecognised model id yields "cost unavailable" for that turn; it must never fall back to a default rate.

**Money is integer, never float.** Store and accumulate in micro-dollars (or cents) as integers. Floating-point rates already produce artifacts at table-build time (3.0 x 0.1 = 0.30000000000000004); accumulated across tens of millions of tokens those compound into visible, unexplainable discrepancies.

**Subscription vs. API billing — a first-class caveat.** Claude Code under a Pro/Max subscription is not billed per token. For those users every figure Modelog shows is a *shadow price*: "what this usage would have cost at API list rates." That is genuinely useful for comparing models and periods against each other, and actively misleading if presented as a bill. The UI must state which mode it is in, and the comparison framing ("Model A cost 2.3x Model B per turn") must lead over any absolute dollar total.
Where cost is derived rather than measured (e.g. Copilot premium-request multipliers, which are set server-side and change without notice), the multiplier/pricing table is a **versioned data file**, and every derived figure is labelled an estimate in the UI. A tool whose pitch is "with real numbers" cannot silently show numbers that drifted.

### 8.3 Low overhead
Background capture must not affect IDE performance. Incremental tailing rather than full re-scans; work off the extension host's critical path.

### 8.4 Graceful degradation
Every optional dependency (Ollama, a given assistant's logs, network) defaults cleanly to off.

---

## 9. Tiering / Business Model

| Feature | Personal | Enterprise |
| :--- | :--- | :--- |
| **Price** | Free | Paid, per seat |
| **Storage** | Local only | Local + central rollup |
| **Scope** | Individual trend/comparison | Team-wide cost-per-outcome, waste detection |

---

## 10. Success Metrics

**Parts 1 & 2 — qualitative, not instrumented.** Since telemetry does not exist until Part 3, success is judged by dogfooding and a small set of design partners:

- The author can point to a real decision changed by a Modelog reading.
- A design partner can, unprompted, describe a before/after comparison the tool showed them.
- Numbers reconcile against the provider's own billing within an acceptable margin.

**Part 3 — instrumented, via opt-in telemetry:**

- **Insight generation** — % of active users triggering at least one behavioral marker within their first 7 days.
- **Actionability** — % of users switching active model or clearing context within 24h of a flagged shift.
- **Retention** — % of users opening the dashboard at least twice a week.

---

## 11. Open Questions / Risks

| # | Item | Affects |
| :-- | :--- | :--- |
| 1 | ~~Are `message.usage` values populated on every assistant record?~~ **Resolved 2026-09-20: yes, 507/507.** Cost is measured, not interpolated. | Closed |
| 2 | ~~Does `session-store.db` expose per-turn model and cost data?~~ **Resolved 2026-09-27: no** — but it is the wrong file. Model and token data live in `debug-logs/{sessionId}/main.jsonl`, gated on a Copilot setting (§7.1). | Closed |
| 12 | ~~Is a per-turn credit or token figure persisted on disk?~~ **Resolved 2026-09-27.** Tokens and model: yes, in `debug-logs/`, opt-in and non-retroactive. Per-turn *credits*: nowhere — not on disk, not in the API, which is plan-level only. §4.5 revised accordingly. | Closed |
| 13 | ~~How is quota position represented?~~ **Resolved: `overage_permitted` per quota, plan-level.** Enough to know *whether* a user is past quota, never enough to attribute a marginal cost to a specific turn. | Closed |
| 21 | **`data/pricing.json` assumes, without ever having verified it, that the vendor it prices has no context-length pricing dimension.** The assumption is untested, and 218 of 885 real turns (24.6%) exceed 200,000 prompt tokens, peaking at 309,561 on `claude-opus-5` — so it is not a hypothetical range. Resolve only by reading Anthropic's current rate card. Copilot's `long_context` tier is **not** evidence about Anthropic and must not be used as a proxy: a rate found in one vendor's card says nothing about another's. | **Part 1 — verification gap** |
| 20 | **Does `money is integer micro-dollars` survive a source whose native unit is finer?** Copilot reports nano-AIU; 1 micro-dollar = 100,000 nano-AIU, so ingesting into micro-dollars truncates a measured value. Widen the unit, or store per-adapter native integers and convert at display. | Part 1 / later adapter |
| 18 | **Should Claude Code pricing be captured per-session rather than pinned?** Copilot writes its rate card beside each session, giving rates-as-of-that-turn. `data/pricing.json` is one global snapshot and silently reprices history when it is updated. Affects every historical cost figure Modelog shows. | Part 1 |
| 19 | **Copilot's debug logs are capped at 50 retained sessions and 100MB each, and the enabling setting is tagged `onExp`** — server-side experimentation can flip it. Measured Copilot data must therefore be treated as present-or-absent per session, never assumed. | Later adapter |
| 16 | **Does §4.5's tier 3 survive, now that units are commensurable?** The prohibition can no longer rest on incommensurable units; the real axis is metered vs. prepaid, which cuts across vendors. Reason 2 (comparative claims about a named third party) is untouched and still needs legal review. A product decision, not a technical one. | All |
| 17 | **What does a real `llm_request` event actually contain?** Only the four fields AI Insights reads are known. A cache-write count may be present and unread, which would let the §8.2 four-class engine work on Copilot data. Needs one captured session with `agentDebugLog.fileLogging` on. | Later adapter |
| 15 | **Does Modelog ask users to enable `github.copilot.chat.agentDebugLog.fileLogging`?** It is the only route to measured Copilot data, and it writes full prompts and code to unencrypted local files — in tension with §8.1's central claim. Options: never prompt and accept a permanent gap; prompt once with the trade-off stated; or read the logs only where they already exist. Decide before any Copilot adapter ships, not during. | Later adapter |
| 14 | Copilot's `session_files` + `tool_name` data has no Claude Code equivalent. Does a metric that exists for one adapter and not another belong in a cross-tool view at all, or only in a per-tool one? | Later adapter |
| 3 | Claude Code JSONL is stable but undocumented; schema may change between versions. Mitigated by §7.1's drift rule and fixtures. | Part 1 |
| 4 | Heuristic markers may misfire and erode trust. Mitigated by `provenance` labelling and post-core tuning. | Part 1 |
| 5 | Terms-of-service review for reading each provider's local session data. | All |
| 6 | Ollama model licensing for commercial recommendations. | Part 2 |
| 7 | Mis-categorization liability — handled via required draft-then-approve. | Part 2 |
| 8 | Benchmark chicken-and-egg (§7.13). | Part 3 |
| 9 | AI Insights is a live, actively developed competitor covering the commodity layer. Differentiation must be visible in the first release, not promised. | All |
| 10 | ~~Cache-tier pricing needs a sourced, versioned rate table.~~ **Resolved: `data/pricing.json`** (§8.2). | Closed |
| 11 | Three distinct models appear across local sessions, so the model-switch anchor is viable on real data — but sessions may mix models mid-session. Anchor logic must handle intra-session switches. | Part 1 |

---

## 12. Naming & Positioning

**Name:** Modelog

**Domain:** `modelog.dev` (registered). The `.dev` TLD is HSTS-preloaded, so the Part 3 site is HTTPS-only by default.

**Positioning:** A personal instrument, not a cost-cutting mandate — and not an ROI justification tool. Modelog tells an individual developer what actually changed when they changed how they work.
