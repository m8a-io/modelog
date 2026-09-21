# Modelog — Product Requirements Document

**Version:** 1.0
**Status:** In implementation — Part 1
**Data-source verification:** 2026-09-20, 507 assistant records across 5 local Claude Code sessions

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

**Verified schema (2026-09-20).** Across 507 assistant records in 5 local sessions, `message.model` and `message.usage` were present and populated on **507 of 507** — coverage is total, not partial. The `usage` object is uniform in shape:

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

**Cost model (cache-aware) — required, not an optimization.** In the verified sample, **95% of all input-side tokens were cache reads**: 56,460,502 cache-read tokens against 1,179 fresh input tokens and 2,509,912 cache-creation tokens. A naive `input_tokens x input_price` calculation would report a cost near zero and be wrong by orders of magnitude.

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
| 2 | Does `session-store.db` expose per-turn model and token data for a future Copilot adapter? | Later adapter |
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
