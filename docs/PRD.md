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
- **Subagent turns are a live confound, not a hypothetical one.** `isSidechain` marks a turn belonging to a spawned subagent rather than the user's own conversation. In the author's own data the correlation with model is **total**: every sidechain turn is Haiku and every Haiku turn is sidechain (29 of 1,141 stored turns). A per-model comparison that does not account for this presents Haiku as a model the user *chose for work*, with a cost-per-turn figure drawn from an entirely different population — subagent calls have different prompt shapes, different cache behaviour, and no human deciding anything. They are real API calls costing real money, so they belong in cost; whether they belong in *behavioural* per-model comparison is open question 23.
- **Dated snapshot ids alias to the bare model.** Ids may carry a trailing 8-digit date (`claude-haiku-4-5-20251001`). Stripping it is a deterministic rule about how snapshots are named — the snapshot and the bare id are the same model at the same price — not a guess about intent. Anything that does not resolve under that rule stays unknown, per invariant 3.
- **Roughly 95% of input-side tokens are cache reads** in real usage. Cost must therefore price the four token classes separately, with 5-minute and 1-hour cache writes distinguished; pricing input alone is wrong by an order of magnitude.
- **Rates are data, never code.** `data/pricing.json`, versioned and dated (§8.2).

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
> But it does not need to: **Copilot writes the card that was in effect beside the session it applies to.** That is better provenance than Modelog's own `data/pricing.json`, a single global snapshot (currently dated 2026-09-27) which cannot price a historical Claude Code turn at the rate in force when it ran. A Copilot adapter should read the sibling `models.json` per session and never pin. Worth asking whether Claude Code pricing should move the same way (open question 18).
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
>    — **WRONG on both counts. See Corrections 2 and 3 below.** The join is real but inverted (`parentSpanId` → `user_message`, and a Copilot "turn" is a Modelog *iteration*); the `subagent` span type does not exist, subagents are a separate log file.
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
> — **Superseded. See Correction 4 below:** a closed-form solve recovers the write count from the single request itself, including the final one, and agrees with this delta method wherever both are defined.

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
> — **Key is wrong, see Correction 1 below:** the real setting is `…fileLogging.enabled`. The non-retroactivity is correct and still holds.
>
> **This is a constraint on the product, not just the adapter.** Per AI Insights' own README, enabling that setting "makes the Copilot Chat extension write your full prompts and code context to local, unencrypted debug-log files that don't otherwise exist." Modelog's central trust claim (§8.1) is that it never reads prompts. Instructing a user to persist *more* prompt content to disk in order to be measured is in direct tension with that, however local it stays. Any Copilot adapter must decide this deliberately: refuse to prompt for it, or prompt with the trade-off stated plainly and default to a visible gap.
>
> **What the competitor does without it.** `providers/copilot.ts` falls back to `model: 'gpt-5-mini'` hardcoded for every turn and `estimateTokens(text)` from string length. Those estimates are surfaced as dashboard figures (cache metrics are flagged "(calc.)"; the model attribution is not flagged at all). This is the §4.3 differentiator made concrete — not a claim about a competitor's honesty, which their README addresses openly, but evidence that the commodity layer ships confident numbers where Modelog would show a gap (§8.2, invariant: an unknown model costs null).
>
> **Privacy inversion vs. Claude Code.** There, usage is separable from content, so the store honours §8.1 by simply not reading `message.content`. Copilot's `turns` table is content and nothing else, plus an FTS5 index over it — so an adapter must select only `timestamp`, `session_id` and `turn_index`.

> ## Corrections — measured against real captured sessions, 2026-10-07
>
> **Everything above this block was reconstructed without real `main.jsonl` data** — from AI Insights' source, from Copilot's own bundle, and from a single session that held only a `session_start`. Real data is now available locally, across **two Copilot versions**: a 2026-09-27 session on **0.66.0** / VS Code 1.138.0 (8 `llm_request` spans, two models) and a 2026-10-04 session on **0.68.0** / VS Code 1.140.0 (69 spans, plus a subagent child log). Five claims above are **wrong**, and three of them would produce silently wrong numbers rather than a visible failure. The text above is left intact as the record of what was believed; this block is what is true.
>
> **1. The setting key is wrong.** It is `github.copilot.chat.agentDebugLog.fileLogging.enabled` — the dossier's `github.copilot.chat.agentDebugLog.fileLogging` is the *section*, not the boolean, and reads as `undefined`. There is also a sibling `…fileLogging.maxRetainedSessionLogs`, user-settable (200 on this machine), so open question 19's "capped at 50 retained sessions" is a **default, not a cap**.
>
> **2. The turn↔call join is inverted — the most consequential error here.** `llm_request.parentSpanId` does **not** point at a `turn_start` span. It points at the **`user_message`** span. `turn_start`/`turn_end` carry no `parentSpanId` at all; their ids are `turn_start-{userMessageSpanId}-{turnId}` where `attrs.turnId` is a per-user-message counter that **resets with each user message** (0,1,2… then 0,1,2,3,4…).
>
> So **Copilot's "turn" is Modelog's *iteration*, and Copilot's `user_message` is Modelog's `Turn`.** Measured: the 58-line session has 2 `user_message` spans, 8 `turn_start` spans and 8 `llm_request` spans; the large session has 9 and 69. Reading `turn_start` as a turn would report 8 turns where there are 2 — inflating turns/session ~4x and deflating cost/turn ~4x, with no error surfaced.
>
> **Join rule: group `llm_request` spans by `parentSpanId`. One group is one `Turn`, with `iterations = group.length`.**
>
> **3. There is no `subagent` span type.** The dossier's "first-class `subagent` span (from `INVOKE_AGENT`, carrying `agentName`)" does not exist in 0.68.0. The real mechanism is a **separate file**: a `child_session_ref` record (`attrs: {childSessionId, childLogFile, label}`) points at a sibling `executionSubagent-{toolCallId}.jsonl`, itself a complete `main.jsonl`-shaped log whose `llm_request.debugName` is `executionSubagentTool`. **`isSidechain` is therefore a property of which file a turn came from**, not a field on any record.
>
> Separately, `debugName` on the main log distinguishes `panel/editAgent` (65 requests) from `backgroundTodoAgent` (4) — background traffic the developer did not initiate, a second confound with **no Claude Code analogue**. It maps to `entrypoint`, not to `isSidechain`.
>
> **4. Cache-write tokens are exactly solvable per request — the successor-delta inference is unnecessary.** Two equations, two unknowns:
>
> ```
> inputTokens = plain + cached + write
> nanoAiu     = plain·ip + write·wp + cached·rp + out·op
>
> ⇒  write = [ nanoAiu − (in − cached)·ip − cached·rp − out·op ] / (wp − ip)
> ```
>
> with every card price scaled to nano-AIU per token (`credits_per_1M × 1000`), so the whole computation is integer arithmetic with an exact-division check. Verified on all 8 requests of the small session: every row solves to a non-negative integer, and **agrees with the successor-delta method on every row where both are defined** — while additionally resolving rows 3 and 8, the last request of each turn group, which the delta method cannot reach. On the 69-request session, 65 solve exactly; the 4 that do not are `gpt-4o-mini`, whose card prices are all `0`, making `wp − ip = 0` and the equation degenerate. Those requests also *cost* 0, measured, so the correct result there is "unknown breakdown, known cost", not a zero.
>
> A non-integral, negative or degenerate solve is reported as unknown, never as zero. Naive floating-point produces `plain = 2.0000000000023306`, which is precisely why this must be integer arithmetic with an exactness assertion.
>
> **5. `workspaceStorage` needs no platform table.** It is derivable from a path VS Code already hands the extension: `resolve(globalStorageUri, "..", "..", "workspaceStorage")`. Verified to resolve correctly here, and correct by construction on macOS, Windows, VSCodium, Remote-SSH and dev containers alike, because it is *derived* rather than guessed from `homedir()`. The residual gap is narrower than §7.16 assumed: a user running **two** VS Code installs (Desktop plus a remote) has two `workspaceStorage` roots and Modelog only sees the one its own extension host lives in. That is covered by an explicit `modelog.copilotLogPaths` override, not by platform sniffing.
>
> **One further finding, not a correction.** The session directory also contains `system_prompt_*.json`, `tools_*.json` and a sibling `transcripts/{sessionId}.jsonl` — all pure prompt/content, and the transcripts file ends in `.jsonl`. Discovery must therefore be **path-shaped, not extension-shaped**: an adapter that globs `*.jsonl` under `workspaceStorage` would ingest conversation content. Only `main.jsonl` and `executionSubagent-*.jsonl` are ever read.
>
> **What this does to open question 17** ("What does a real `llm_request` event actually contain?"): **closed.** Measured attrs are `model`, `debugName`, `inputTokens`, `outputTokens`, `cachedTokens`, `ttft`, `responseId`, `userRequest`, `inputMessages`, `maxTokens`, `copilotUsageNanoAiu`, and optionally `systemPromptFile`, `toolsFile`, `temperature`, `topP`.
>
> **The attr set varies by request type within a single version, not just between versions.** In one 0.68.0 session, all 65 `panel/editAgent` requests carry **no** `temperature`/`topP`, while all 4 `backgroundTodoAgent` requests in the *same file* carry both; the subagent log's requests carry neither `systemPromptFile` nor `toolsFile`. So **every attr must be treated as optional and its absence must never be read as a version signal** — or as a zero. This is a stronger constraint than "pin the version," and it is the reason the parser reads named attrs defensively rather than assuming a fixed shape.
>
> **`responseId` is not unique per request.** In the subagent log both requests share one `responseId` (the originating tool-call id), and in the 0.68.0 main log two consecutive requests share one. It is therefore unusable as a primary key — the turn uuid is `{sid}:{parentSpanId}` instead.

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

#### 7.18 Effectiveness ratings (candidate — not scoped)

**Numbered out of sequence to avoid renumbering §7.11–§7.14, same as §7.15's note.**

Raised 2026-10-08, directly from a live MCP demo: asked whether switching to Opus was "actually worth it," the agent answered correctly and honestly that the logs show usage and cost, never answer quality — it could not settle whether the work was actually better, only how much it cost. That answer is right, and it's also the exact gap §1 names as unaddressed by any existing tool: Modelog measures everything *except* the one thing a developer actually judged a switch by.

**The idea:** a lightweight, explicit rating the developer attaches to a recent stretch of work — e.g. a Claude Code slash command, `/effectiveness 8` — logged against the turns it covers, so cost-per-turn and turns/session can eventually be read alongside *"and here's how it felt, over time, not just once."*

This is a genuinely different kind of data from anything Modelog stores today, and not a small addition. Three open questions before it could be scoped at all:

1. **It breaks the MCP read-only invariant.** §7.9 states "read-only in v1" deliberately — a write tool is a first for this product, asserted against by a named test (`no tool is a write tool`). A rating-write tool needs its own safety design: idempotency, undo, what happens if a client calls it unprompted.
2. **"Which turns" has no natural definition.** Claude Code has no native concept of "the 8 turns I just did with Opus." Last N turns? Everything since the last rating? Everything in the current session? Getting this wrong misattributes a rating to turns it wasn't actually about.
3. **Number-only, or a note too?** A bare 1–10 score stays clearly outside §8.1's content boundary. A free-text justification ("nailed the refactor in one shot") would be the first time anything resembling prompt-adjacent content enters the store, and needs its own explicit reasoning, not an assumption it's fine because the rest of the field is numeric.

The §6 Marker model already has a slot for exactly this: `provenance: "user"`, "a manual annotation," sitting alongside `observed` and `inferred` since the original data model was written — though in code today `provenance` is narrowed to the literal `"observed"` (`src/mcp/tools.ts`), so widening it is itself part of the work, not just reusing an existing type. The taxonomy isn't the gap — the write path and the turn-window definition are. Whatever ships must still keep a `user`-provenance rating visibly opinion, never blended into the honest/measured figures (§8.2) as if it were one of them.

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

### Cross-Cutting — Distribution & Environments

**Goal:** make Modelog install cleanly and behave honestly on machines that are not the one it was built on.

**Sequencing:** these are numbered 7.15–7.17 to avoid renumbering §7.11–§7.14, which are cross-referenced. They are *scheduled between Part 2 and Part 3* — Part 2's MCP bridge is what makes install UX load-bearing, and Part 3's commercial surface should not be built on untested platform assumptions.

Findings so far, with their verification status, live in `docs/INSTALL-ux.md`. That document is the reference; the phases below are the work.

#### 7.15 Install & First-Run UX

There is **no installation-time hook in VS Code** — no `postinstall`, no `onInstall` event. Everything a user might expect "during installation" happens on *first activation*, made idempotent via `context.globalState`. This constraint shapes the whole phase; see `INSTALL-ux.md` §1.

Deliverables:

- A `contributes.walkthroughs` entry for discovery, plus at most one first-activation prompt for the opt-ins. Not a modal wizard — both optional features default cleanly to off (§8), so nothing is broken by a user who never sees the prompt, and a walkthrough stays findable where a dismissed toast does not.
- **MCP registration split into two targets.** `vscode.lm.registerMcpServerDefinitionProvider` for VS Code's own MCP client, which writes no config files and can run the server on the editor's Node via `process.execPath`; config-file writing for Claude Code, which reads its configuration at session start only and therefore must never be told it is connected immediately. `INSTALL-ux.md` §2.
- **Three-state Ollama detection** — absent, reachable-with-no-models, reachable-with-models. The middle state must not be reported as "not found"; the remedy there is pulling a model. `INSTALL-ux.md` §3.
- Raising `engines.vscode` from `^1.90.0`, once the floor for the MCP provider API is established rather than guessed.

**Boundary:** detection is not enablement. Probing `localhost:11434` crosses nothing and is already sanctioned by §7.8. *Using* Ollama enters the content boundary and requires explicit opt-in. Likewise, MCP registration writes outside Modelog's own storage and stays an explicit confirmed action per `MCP.md` §7.3 — never a side effect of clicking through onboarding.

#### 7.16 Environment Matrix Validation

Every platform claim to date was measured on a single configuration (Remote-WSL, VS Code 1.138). This phase replaces assumption with measurement on the rest.

| Environment | The specific question to answer |
| :--- | :--- |
| macOS, GUI-launched | GUI processes inherit no shell `PATH` — no nvm, no Homebrew. Does the Claude Code registration path degrade correctly instead of failing opaquely? |
| Windows, no WSL | `process.execPath` is `Code.exe`, not a node binary. **Does the editor's-Node technique hold at all?** This is the highest-value unknown, because it underpins §7.15's config-free path |
| Remote-SSH / Dev Container | Remote-host assumptions on a non-WSL remote: `localhost` is the remote, log paths are the remote filesystem's |
| Coder | Deferred to §7.17 |

**Done when** each row is either verified or has a recorded, specific failure mode — and `INSTALL-ux.md`'s `[untested]` tags are replaced with results. A row that fails is a successful outcome for this phase; an untested row shipped as a claim is not.

#### 7.17 m8a / Coder Integration

Running Modelog inside m8a's Coder-based remote environments, which is expected to need changes **on both sides** — the extension, and plausibly the platform's environment definition too.

Kept as its own phase deliberately: it couples Modelog to another system's roadmap, and folding it into §7.16 would let platform work block plain cross-platform validation.

Known inputs from `INSTALL-ux.md` §4: the extension host runs on the remote workspace, so `~/.claude/projects` and `localhost:11434` both resolve there rather than on the user's laptop. `vscode.env.remoteName` and `Extension.extensionKind` are the detection primitives. Whether Modelog should declare a preferred `extensionKind` is open.

Scope to settle when the phase opens: whether Coder workspaces are expected to carry assistant logs at all, and if so whether the store should live in the workspace or in the user's persistent home.

---

## 8. Non-Functional Requirements

### 8.0 Invariants — the rules that must not break

Each of these is load-bearing for a promise the product makes. Several are enforced by tests or CI. They live here, not in `CLAUDE.md`, because they describe how Modelog must behave rather than how the repo is worked in.

1. **Never read `message.content`.** No prompts, no code enter the store. A test asserts it. Scoped per component — see the note below on the local-model boundary.
2. **Money is an integer in an explicit unit; modifiers are integer ratios.** Expanded in §8.2.
3. **An unknown model — or an unknown pricing modifier — costs `null`, never a default.** A visible gap beats a confidently wrong number.
4. **No literal colours in `src/webview/`.** Every colour is a VS Code theme variable; `scripts/check-theme.sh` fails the build otherwise.
5. **No cross-vendor cost comparison.** See §4.5. A hard product constraint, not a roadmap gap.
6. **The MCP server has no write tools.** Read-only, structurally (`MCP.md` §4.1).
7. **Thinking tokens are already inside `output_tokens`.** Never added again.

**The content boundary is per-component, not global.** The extension and any future backend never read content — that is invariant 1 in its strict form. The MCP/Ollama meta-inference engine *does* read content locally, because categorising work requires it. It never emits content to the extension, and never off the machine. Content leaves the local machine only through an explicitly opt-in tool (e.g. work-log export to a ticketing system), where the user directs the destination and owns that decision. No content is ever used by Adduco Digital GmbH or passed to third parties. The three claims are separable and must be stated separately: **never transmitted** (absolute), **never persisted to the store** (absolute), **never read** (component-scoped, opt-in where relaxed).

### 8.1 Privacy / local-first
Zero raw content leaves the device without an explicit sync action. Parts 1 and 2 make no network calls except to `localhost`.

### 8.2 Honest numbers

**Rate table.** Pricing lives in `data/pricing.json`, versioned and dated, never in code. It stores base input/output rates per model plus three cache multipliers applied to the base input rate — cache read 0.1x, 5-minute cache write 1.25x, 1-hour cache write 2.0x — so a rate change touches one number, not nine. An unrecognised model id yields "cost unavailable" for that turn; it must never fall back to a default rate.

**Money is an integer plus an explicit unit; modifiers are integer ratios.** (Restated 2026-09-27, resolving open question 20 — the original wording said "integer micro-dollars", which a measured value finer than a micro-dollar cannot satisfy.)

- A monetary quantity is `{ amount: integer, unit: Unit }` — never a float, never a bare number. `Unit` is a closed set, and each unit is chosen so that **every value its source publishes is an exact integer**. `usd_nano` holds every rate the Anthropic card publishes; `aiu_nano` holds Copilot's `total_nano_aiu` as reported.
- **Amounts in different units are never summed, averaged or compared.** Conversion is explicit, labelled, and happens at the presentation boundary — never on ingest — because a cross-unit rate is an *inference*, not a measurement. `1 AIU = 1¢` was derived by matching two rate cards; baking it into storage would be the same error class as a default rate for an unknown model. This also makes §4.5 structural rather than a policy note: `usd_nano` and `aiu_nano` cannot be added.
- **A measured amount is stored as reported.** Rounding a measurement is a worse failure than the float artefacts that motivated the original wording.
- **Pricing modifiers are integer ratios over a scale of 10,000**, composed as numerators and divided once — never chained float multiplications, which is exactly where `3.0 * 0.1 = 0.30000000000000004` came from.
- **Each unit documents and asserts its exact-integer ceiling** in IEEE-754 doubles: `usd_nano` ≈ $9.0M, `aiu_nano` ≈ $90k. Totals approaching a ceiling aggregate in SQL or `BigInt`.

*Current state:* micro-dollars remains exact for every published Anthropic rate and multiplier, so the Claude Code path needs no rescaling. The `{amount, unit}` tagging becomes load-bearing when a second unit exists — i.e. with the Copilot adapter — and is deliberately not built before then.

**Pricing modifiers reprice every token class, and are recorded per turn.** The card sets three: cache-read is **per-model** (0.1x standard, 0.05x Opus 5.5, 0.025x Fable 5.1/Mythos 5.1); `speed: "fast"` is **2x** on Opus 5.5/5/4.8; `inference_geo: "us"` is **1.1x**. They stack multiplicatively. Claude Code records `speed` and `inference_geo` in `message.usage`, so both are captured on `Turn` and priced. An unrecognised value for either yields `null` — a fast-mode turn priced at standard rates is a *known* model reported at half its true cost, which is the §8.2 failure reached through a different door than invariant 3's original wording guarded.

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
| 21 | ~~Does `pricing.json` miss a context-length pricing tier?~~ **Resolved 2026-09-27 against Anthropic's rate card: no such tier exists.** "Claude 4.6 and later models include the full 1M token context window at standard pricing." The assumption was correct; the concern came from importing Copilot's `long_context` tier, which was invalid reasoning. | Closed |
| 22 | ~~Three pricing modifiers exist that `pricing.json` cannot express.~~ **Fixed 2026-09-27.** `pricing.json` is schema 2: multipliers are integer ratios over 10,000, cache-read takes per-model overrides, and a `modifiers` table prices `speed` and `inference_geo`. `Turn` captures both fields; an unrecognised value yields `null` under a new `unknown_modifier_policy`. Verified against 939 real turns: 0 unpriced, every derived rate an exact integer. | Closed |
| 20 | ~~Does `money is integer micro-dollars` survive a source whose native unit is finer?~~ **Resolved 2026-09-27: the invariant was restated, not worked around** — see §8.2. Money is an integer plus an explicit unit; amounts in different units never mix; conversion is explicit and at presentation. Micro-dollars stays exact for the Claude Code path, so no rescaling was needed now. | Closed |
| 18 | **Should Claude Code pricing be captured per-session rather than pinned?** Copilot writes its rate card beside each session, giving rates-as-of-that-turn. `data/pricing.json` is one global snapshot and silently reprices history when it is updated. Affects every historical cost figure Modelog shows. **Promoted 2026-10-04 to a tracked improvement — [issue #3](https://github.com/m8a-io/modelog/issues/3) — with the direction settled: effective-dated rate intervals resolved per `turn.ts`, pinned at turn level rather than session level (a resumed session can straddle a price change). A network-fetched rate feed was considered and rejected there; it increases the frequency of silent repricing rather than fixing it, and §8.1 forbids it in Parts 1–2.** Current pinned behaviour is retained deliberately so Part 2 is not blocked, and `modelog_get_definitions` states the limitation outright rather than letting an agent assume rates-as-of-turn. | Part 1 → [#3](https://github.com/m8a-io/modelog/issues/3) |
| 19 | **Copilot's debug logs are retained per a user-settable limit, and the enabling setting is tagged `onExp`** — server-side experimentation can flip it. Measured Copilot data must therefore be treated as present-or-absent per session, never assumed. **Refined 2026-10-07:** the "50 retained sessions" figure is a *default*, not a cap — `…fileLogging.maxRetainedSessionLogs` is user-settable and reads 200 on the dev machine. The present-or-absent rule is already visible in local data: of three discovered session directories, two contain only a `session_start`. | Later adapter |
| 16 | **Does §4.5's tier 3 survive, now that units are commensurable?** The prohibition can no longer rest on incommensurable units; the real axis is metered vs. prepaid, which cuts across vendors. Reason 2 (comparative claims about a named third party) is untouched and still needs legal review. A product decision, not a technical one. | All |
| ~~17~~ | ~~**What does a real `llm_request` event actually contain?**~~ **Closed 2026-10-07 against two real captured sessions** (Copilot Chat 0.68.0). Full attr list in §7.1's Corrections block. A cache-write count is **not** present — but it is exactly recoverable per request by a closed-form solve against the session's own rate card, so the §8.2 four-class engine does run on Copilot data. The capture also corrected three other dossier claims; see Corrections 1–5. | Closed |
| ~~15~~ | ~~**Does Modelog ask users to enable `github.copilot.chat.agentDebugLog.fileLogging`?**~~ **Resolved 2026-10-07: explicit opt-in only, never a prompt.** A command (`Modelog: Enable Copilot Analysis`) states the trade-off plainly — that enabling it makes Copilot write full prompts and code to local unencrypted files that do not otherwise exist, which Modelog itself never reads but which other software could — and requires confirmation, mirroring the MCP config writer's confirm-then-write flow. Modelog **never** auto-prompts, never raises it during onboarding, and never nags to turn it off either: if the setting is already on, the data is read silently, with no notification in either direction. The permanent-gap option was rejected because it makes Copilot support largely nominal; the prompt-once-at-onboarding option was rejected as too close to the dark pattern §8.1 exists to prevent. (Note the key in this row is the *section*, not the boolean — see Correction 1 in §7.1.) | Closed |
| 23 | **How should subagent (`isSidechain`) turns be treated in turn counts and the model comparison table?** Deliberately deferred 2026-09-27: the field is captured and stored, no metric or display behaviour changed. Options considered — segment and exclude from the comparison table while still counting cost; count everywhere with a filter; a separate panel. Cost must include them either way (real calls, real money). Until this is decided, every surface that reports per-model turns is reporting a blended population, and the MCP `get_definitions` tool must say so. | Part 1 — product decision |
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
| 24 | **Should Modelog let the developer rate a stretch of work's effectiveness** (e.g. `/effectiveness 8`), so cost can eventually be read alongside a subjective quality signal? Raised 2026-10-08 — see §7.18. Needs: a write tool (breaks the §7.9 read-only invariant), a definition of "which turns" a rating covers, and a decision on number-only vs. a free-text note (the latter edges toward §8.1's content boundary). | Part 2 — product decision |

---

## 12. Naming & Positioning

**Name:** Modelog

**Domain:** `modelog.dev` (registered). The `.dev` TLD is HSTS-preloaded, so the Part 3 site is HTTPS-only by default.

**Positioning:** A personal instrument, not a cost-cutting mandate — and not an ROI justification tool. Modelog tells an individual developer what actually changed when they changed how they work.
