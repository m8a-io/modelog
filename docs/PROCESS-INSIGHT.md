# Modelog Process Insight

**Status:** Proposal for review; no implementation commitment. Supersedes `MODEL-SWITCHER.md`.

**Research date:** 2026-10-10.

Modelog should help a developer find the recurring, mechanical parts of their AI-assisted work and suggest cheaper ways to run them — including not running them through an LLM at all. The suggestions are produced by the agent the developer already uses, reasoning over findings Modelog mines from its own store and exposes over the MCP bridge. Modelog never sits in the request path and never enforces anything.

## 1. Why this supersedes the model switcher

`MODEL-SWITCHER.md` investigated switching a session's model per task. Its own research concluded against its central mechanism: swapping requires a pre-dispatch barrier most hosts do not expose, and it discards the prompt cache, so a swap for a short task can cost more than it saves. The one mechanism that survived review — delegating side work to cheaper sub-agents — needs no interception and is really a *behavioral suggestion*, not a control feature.

Process Insight keeps the goal (premeditated, cheaper model usage) and moves the entire intervention out-of-band:

> Observe what actually recurs → quantify what it costs → let the user's own agent suggest a cheaper shape for it → the user adopts or ignores → measure the before/after.

Nothing here needs a host control API, a submission barrier, or a presence in the request path. Every stage runs over data Modelog already ingests or is already specified to derive. That is why this proposal is architecturally cheaper than the switcher despite being more ambitious in effect.

Sub-agent delegation survives as **one suggestion category** (§6). The session model-swap mechanism is abandoned. `MODEL-SWITCHER.md` is retained as a research record for host control surfaces, should a host ever expose a real pre-dispatch barrier.

## 2. The savings hierarchy

For any recurring piece of work, the options rank by how much thinking they remove:

| Tier | Intervention | Example (this repo's own publish flow) | Saving |
| :-- | :--- | :--- | :--- |
| 1 | **Eliminate the LLM from the step** | `vsce publish` runs in CI on a tag push | Tokens go to zero |
| 2 | **Make the step deterministic** | A release skill/script the model invokes instead of re-deriving the steps | Near zero marginal reasoning |
| 3 | **Standardize the step** | One vetted release skill, identical on every machine and for every teammate | Variance collapses — same steps, same model, every time |
| 4 | **Delegate to a cheaper model** | Commit/push handled by a sub-agent on the user's cheap model | Lower rate, parent context preserved |
| 5 | **Keep the capable model** | The actual development work | None — and correctly so |

> **Revised 2026-10-10: tier 3 (standardize) added.** For a single developer it blurs into tier 2 — a personal skill both removes reasoning and fixes the steps. It earns its own tier because its saving is *variance*, not only rate, and variance only becomes measurable (and valuable) across machines and people — see `ENTERPRISE.md` §2, where this tier is the quality story.

Two properties of this table drive the design:

- **The biggest savings are above tier 4**, and tiers 1–3 are *advice*, not control — none of them needs a host control API. The switcher proposal only ever addressed tier 4.
- **The strongest suggestion needs no speculative arithmetic.** A tier-1 saving is simply the routine's current measured cost: "this recurring sequence cost you $14 last month; in CI it costs $0." Only tiers 3–4 — where an LLM still executes the work — may want a repriced estimate, and those are explicitly labeled as estimates (§5.3).

Modelog's contribution is to make the table *specific*: not "automate things" but "this exact sequence, which recurred 9 times, at this measured cost." Generic AI-usage tips (grades, session-length warnings) fail precisely because they attach to nothing the developer can act on.

## 3. Pipeline overview

Three stages, each with a different owner and a different privacy posture:

| Stage | What it does | Who runs it | Sees content? |
| :-- | :--- | :--- | :--- |
| 1. Segmentation | Labels contiguous runs of turns within a session with a task type | Heuristics in the extension; optionally the opt-in local SLM (PRD §7.8) | Heuristics: never. SLM: locally, opt-in, emits labels only |
| 2. Repetition mining | Finds label sequences that recur across sessions and attaches cost | Deterministic code in the extension | Never — operates on labels and existing metrics |
| 3. Suggestion | Turns a mined routine into a concrete proposal | The user's own agent, over MCP | N/A — Modelog exposes derived findings only; the agent's repo access is its own |

### 3.1 Stage 1 — Task segmentation (extends PRD §7.7)

PRD §7.7 assigns one label per session. This feature needs labels per *segment*: a contiguous run of turns doing one kind of work, so a session reads as a sequence such as `[dev, git, dev, git, publish]`.

- **Metadata first, measured.** Candidate signals per turn: tool names invoked, file paths and extensions touched, sidechain status and agent identity, turn rhythm, error/retry counts, branch name. Ship heuristics, hand-label real sessions, and measure accuracy before concluding metadata is insufficient — the PRD's "heuristics before models" rule applies unchanged.
- **Expect metadata to be weak at exactly the interesting boundary.** Distinguishing "git housekeeping" from "dev work" when both run through a `Bash` tool call likely requires seeing the command string, which is content. `[untested]` — this is the hypothesis the accuracy measurement exists to confirm or refute.
- **Where heuristics fail, the opt-in local SLM labels segments** under PRD §7.8's existing constraints: Ollama on localhost, condensed structured summary in, label out, nothing persisted but the label, nothing leaves the machine. The per-component content boundary (PRD §8.0 / §7.6 note) was designed for exactly this component. Classification into a small fixed vocabulary is what small local models are good at; no fine-tuning, same remedy order as PRD §7.8.
- **Small fixed vocabulary, pinned.** Roughly 8–10 segment types. The pinning argument from PRD §7.8 applies, and a coarse vocabulary is also load-bearing for stage 2 (§3.2).
- **Every label carries provenance** — `heuristic`, `local-model`, or `explicit` — and a confidence where meaningful, mirroring the marker provenance rule (PRD §6, MCP.md §8.5). An agent must be able to weight an inferred label differently from a declared one.
- **Delegation makes labels observable for free.** Once a user has adopted a named sub-agent (a "git" agent), the agent identity on sidechain turns is metadata that labels those segments with certainty. Adoption of tier-4 suggestions therefore *improves* the data that produces future suggestions.

Whether segment labels share the session-label vocabulary of PRD §7.7 or need a distinct one is a decision for review (§9). The switcher document's warning that analytics labels and routing labels may need distinct representations no longer applies in its original form — there is no routing — but the comparability-between-users argument for pinning still does.

### 3.2 Stage 2 — Repetition mining (deterministic — no model)

A **routine** is a label sequence that recurs across sessions above a frequency threshold: `[git, publish]` appearing nine times in thirty days is a routine; a one-off spike is not.

Once sessions are label sequences, mining is counting, not inference:

1. Reduce each session to its segment-label sequence.
2. Enumerate subsequences (n-grams over the label alphabet, small n).
3. Group identical sequences; count occurrences, sessions touched, and recency.
4. Attach cost per occurrence from the existing engine — per source, in that source's unit, never blended (PRD §4.5; the `partitionBySource()` discipline applies unchanged).
5. Rank by total attached cost.

This is the directly-follows / frequent-episode machinery of classic process mining, which ran on ERP event logs for decades before LLMs. **The fuzziness lives in the labeler, deliberately.** Two publish flows that differ in detail both compress to `[git, publish]` because the vocabulary is coarse, so exact matching behaves like fuzzy matching. If routines fail to collide in practice, the remedy is a coarser or better vocabulary in stage 1 — not a model in stage 2.

Per routine, the miner records: occurrence count and trend, total and per-occurrence cost (per source), models used, sidechain share, turn and duration statistics, tool-name distribution, and the session ids of recent occurrences. All of it is derived data; none of it is content.

### 3.3 Stage 3 — Suggestion generation (the user's agent, over MCP)

The suggestion step is deliberately **not** given to the local SLM, for three reasons:

- A good suggestion requires knowing the user's repo, CI configuration, installed skills, hooks, and host capabilities. The in-editor agent has all of that context natively; a local classifier has none of it.
- Open-ended "infer an automation opportunity" is frontier-model work. Small-model output here would be plausible-sounding and wrong — the exact failure mode the product exists to avoid.
- It makes the feature work **out of the box**: MCP bridge enabled plus any capable client is the entire requirement. No Ollama install is needed for suggestions (only, possibly, for label quality).

Modelog hands the agent a quantified, ranked finding; the agent maps it onto the user's actual environment and drafts the proposal; the user decides. This is PRD §7.6's Job B, upgraded from "answer questions about aggregates" to "reason over mined findings" — same trust model, same direction of data flow.

## 4. What the agent needs — design principles for the MCP additions

Four principles, derived from what makes a suggestion trustworthy and cheap to produce:

1. **Pre-mined and pre-ranked, never raw.** The agent gets the top routines by cost, not the material to mine them itself. Re-deriving patterns from `list_sessions` would be token-expensive, unreliable, and would make suggestion quality depend on agent diligence rather than on data.
2. **Modelog does all arithmetic; the agent does all judgment.** Every money figure in a suggestion must originate in the integer cost engine and arrive in the `{ amount, unit, formatted }` envelope. The agent never multiplies rates. Repriced what-ifs (§5.3) are computed server-side, same source only, labeled estimates.
3. **Tool responses stay declarative (MCP.md §4.2 unchanged).** No tool emits "you should." The framing that turns findings into advice lives in an MCP *prompt* the user explicitly invokes (§5.4).
4. **Honest gaps propagate.** Label provenance and confidence, uncaptured-field counts, unpriced turns, and the estimate/measurement distinction all surface in the response, so the agent can caveat exactly as the data deserves — the lesson of PLAN-part2.md Phase 4's range-clipping incident.

## 5. MCP additions

All additions preserve MCP.md's constraints C1–C5: read-only, opt-in, derived data only, self-describing, honest gaps. The envelope (§8.7), range semantics, and money shape are unchanged.

### 5.1 `modelog_get_routines` (new tool)

`{ days? | from?, to?, minOccurrences?, limit? }` → routines ranked by total attached cost, grouped by source with each group carrying its `unit` (the `compare_models` shape discipline, MCP.md §8.3).

Per routine:

- `sequence` — the ordered segment labels.
- `occurrences`, `sessionsTouched`, `firstSeen`, `lastSeen`, and a trend against the preceding equal-length window.
- `totalCost`, `costPerOccurrence` (median and spread, not only mean — occurrences will be skewed), `unpricedOccurrences` with causes.
- `modelsUsed` with per-model occurrence counts; `sidechainShare`.
- `turnStats` and `durationStats` per occurrence.
- `toolNames` distribution (names only — inputs are content).
- `labelProvenance` summary — how many underlying segments were labeled by heuristic vs. local model vs. explicitly, with aggregate confidence. A routine built on low-confidence labels must say so.
- `recentSessionIds` (small, capped) so the agent can drill into context via `list_sessions` without the routines payload carrying it.

Default `limit` small (order of 10): the tool answers "where does the money recur," and an agent that wants more pages for it. Clamps and truncation disclosed in `notes`, `matched` reports the pre-limit count — the §11 Q3 conventions.

Empty-store, no-labels-yet, and schema-mismatch states use the existing envelope statuses; a store with turns but no segment labels returns `no-data` with a note naming the missing prerequisite rather than an empty list that reads as "no routines exist."

### 5.2 `modelog_get_definitions` extension

New sections, same contract (declarative, measured-not-asserted):

- What a segment, a label, and a routine are; the vocabulary and its pinned version; what the mining thresholds were.
- Label provenance semantics and how confidence was produced.
- What a repriced estimate is and is not (§5.3), stated bluntly.
- That routine cost figures inherit every existing caveat: single rate-table snapshot, unpriced causes, billing mode.

### 5.3 Repriced estimates — rules

A tier-3 or tier-4 suggestion wants "this routine at a cheaper model's rates." That figure is an **estimate, not a measurement**, and the honest-numbers rules (PRD §8.2) bind it:

- Computed by the cost engine from the routine's recorded token counts at the alternative model's rates. Same source only — a reprice across sources or vendors is the comparison PRD §4.5 forbids, and no unit path exists for it anyway.
- Labeled `estimate: true` with the stated caveat that **token counts are not portable across models**: a different model produces different output lengths, different tool-call patterns, and different retry behavior. The reprice bounds the rate effect only.
- Offered only for models present in the rate table; an unknown model is a gap, not a default rate.
- Tier-1 suggestions ("eliminate the step") carry **no estimate** — the measured current cost of the routine is the complete figure, which is exactly why they are the strongest suggestions the product can support.

Whether repricing ships inside `get_routines`, as a separate `modelog_estimate_reprice` tool, or not at all in v1 (leaving the agent to say "cheaper, unquantified") is a decision for review (§9). Leaning: inside `get_routines` as an optional field, because principle 2 (§4) forbids the agent doing the arithmetic, and a separate tool invites exactly that when it isn't called.

### 5.4 The suggestion prompt — how framing stays out of tool responses

MCP.md §4.2 forbids imperative text in tool responses, and that rule is one of the bridge's trust assets. The savings hierarchy, the suggestion method, and the required caveats therefore ship as an **MCP prompt** (e.g. `suggest-process-improvements`) rather than as prose in any tool result:

- MCP prompts are **user-invoked by design** — the protocol defines them as user-initiated, and Claude Code surfaces server prompts as slash commands. `[untested]` across other clients; the prompt must be additive, with the tools fully usable without it.
- The prompt instructs the invoking agent to: call `get_definitions` first; fetch routines; inspect the user's actual environment (CI config, skills, agent definitions) itself; propose against the hierarchy top-down (eliminate before delegate); carry every Modelog caveat into the proposal; and present adoption as the user's decision with the measurement plan attached (§7).
- The prompt is versioned and its text user-visible. It is guidance the user chose to run, not hidden routing — the same line the switcher document drew against undisclosed optimization.

The server `instructions` field may carry one sentence pointing at the prompt. It must not carry the methodology itself, because instructions load into every session whether or not the user wants suggestions that day.

### 5.5 What this does not change

The bridge remains read-only (§5.6 of this document notwithstanding — see §7 on markers), stdio-only, derived-data-only. `modelog_get_work_log` (MCP.md §8.6) remains deferred; whether it merges with segment labeling's output is a decision for review.

## 6. Delegation, carried forward as a suggestion category

The surviving mechanism from `MODEL-SWITCHER.md`, restated as this feature's tier 4:

- A suggestion may propose a sub-agent definition on a cheaper model for a mined routine, plus a delegation rule in the host's instruction file. **If the user adopts it and asks their agent (or Modelog's preset flow) to install it**, the original consent requirements bind unchanged: explicit opt-in, preview of exact files, clean removal, drift detection between installed configuration and what Modelog believes is installed.
- Delegation remains **requested, not enforced**. It is reported as an observed rate, never a guarantee. The enforcement-strength ladder and the costs to measure (handoff cost, cheap-model quality on edge cases, cold start, compliance drift) transfer verbatim from `MODEL-SWITCHER.md` §"Costs and risks".
- The sub-agent log evidence table (capture status per source) and PRD §11 Q23 (how sidechain turns enter per-model comparisons) transfer as prerequisites for *measuring* adopted tier-4 suggestions. Q23 is only a prerequisite for that measurement — tiers 1–3 need none of it.
- Host integration research for live model control stays in `MODEL-SWITCHER.md` as a record. None of it is on this feature's path.

## 7. Closing the loop — adoption markers and before/after

The differentiator over static-grade tools is that the cycle closes: observe → suggest → adopt → **measure** → refine.

- **Adoption is recorded as a marker** (PRD §7.4) with `provenance: "declared"` — the user states "I adopted suggestion X on date Y," they do not prove it. Candidate mechanism: an extension command (`Modelog: Mark a Change`), keeping the MCP bridge read-only. The alternative — a first, narrowly-scoped MCP write tool that appends only to Modelog's own store — would breach constraint C1's *structural* guarantee for a convenience, and the leaning is against it (§9).
- **Before/after uses existing tools with ranges** around the marker: did the routine's occurrences fall or vanish (`get_routines`), did sidechain cost share rise, did parent input-tokens-per-turn and cache-read ratio move (`get_summary`, `compare_models`). The suggestion prompt (§5.4) tells the agent to attach this measurement plan to every proposal, so adoption comes with its own follow-up built in.
- **All comparisons are observational** and must be presented as such: prompt shapes, work mix, and model versions all move between the two windows. Modelog shows what changed; it does not prove the suggestion caused it. One rate-table snapshot pricing both windows (MCP.md §8.1) is a standing caveat on any cost delta.

## 8. Privacy posture

Nothing here opens new ground; every boundary already exists in the PRD:

- The extension and store never read content — segment labels from heuristics use metadata only, and the invariant asserted by `test/parser.test.ts` is untouched.
- The opt-in local SLM reads content locally under PRD §7.8's constraints and emits only labels. Absent Ollama, heuristic labels still feed the miner; the feature degrades to lower label confidence, not to off.
- The MCP bridge continues to expose derived data only. Routines, labels, provenance, and costs contain no prompts, no code, no command strings; tool *names* and file paths are already sanctioned fields (MCP.md §4.2–4.3).
- The suggesting agent sees the user's repo because the user already gave *it* that access. Modelog adds no content channel.

## 9. Decisions for review

1. **Naming.** "Routine" vs. "process" vs. "sequence" for the mined unit, in tool names and UI. ("Process" collides with OS processes; this draft uses routine.)
2. **Vocabulary.** Do segment labels share the PRD §7.7 session-label vocabulary or need their own? Who may extend it, given pinning exists for cross-user comparability?
3. **Reprice placement.** Inside `get_routines`, a separate tool, or omitted in v1? (Leaning: inside, optional field — §5.3.)
4. **Prompt vs. instructions.** Is an MCP prompt the sole carrier of suggestion methodology, with client support gaps accepted, or is a documented copy-paste prompt also shipped for clients without prompt support?
5. **Adoption recording.** Extension command only (bridge stays read-only), or is a store-scoped MCP write tool acceptable? (Leaning: command only — §7.)
6. **Mining thresholds.** Are `minOccurrences`, n-gram length, and the trend window user-configurable, fixed, or fixed-with-override?
7. **Work log overlap.** Does `modelog_get_work_log` (MCP.md §8.6) become a view over segment labels, or stay a separate session-level product?
8. **Sequencing.** Proposed order: heuristic segment labeling with measured accuracy → miner → `get_routines` + definitions extension → suggestion prompt → optional Ollama labeler where accuracy demands it. Does anything justify pulling the SLM earlier?

The central goal is unchanged from the switcher proposal — make developer-defined behavior changes repeatable and measurable — but the route no longer depends on any host capability that does not exist. Modelog finds and prices what recurs; the user's own agent proposes the cheaper shape; the user decides; Modelog measures what actually changed.
