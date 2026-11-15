# Research — trends that teach

**Status (2026-11-15): R0 done; literature pass (L) done; R1 started. No code.** Findings for the
tasks in `PLAN-trends.md`. The method is two-step, as the maintainer intended: **the literature
says which kinds of data are worth watching, and this machine's data tests each one** with the
"aha" sentence. Local claims are tagged `[verified]` (measured here, today) or `[untested]`.
Literature claims are tagged `[primary]` (read in the paper or the publisher's own post) or
`[secondary]` (seen only in coverage; check before quoting).

Where this document and the PRD disagree, the PRD wins until R7.

---

## R0 — The corpus, refreshed

### Method

Read-only, against a copy of the installed extension's store
(`~/.vscode-server/data/User/globalStorage/modelog.modelog/modelog.db`, with its WAL), plus a
direct read of the surviving `~/.claude/projects/**/*.jsonl`. Demo data is excluded everywhere
(`cwd LIKE '/home/scott/modelog-demo%'`, 1,570 turns, one session, unchanged since
`RESEARCH-signals.md`). `[verified]` The query scripts were throwaway and live outside the repo.

There is no other real store on this machine: every other `modelog.db` found is a test fixture
under `/tmp`. `[verified]`

### The store — the full history

| Source | Turns | Sessions | Active days | Span |
| :--- | ---: | ---: | ---: | :--- |
| Claude Code | **3,534** (3,358 main + 176 sub-agent) | **36** | **27** | 2026-09-20 → 2026-11-15 07:43 UTC |
| Copilot | 199 | 19 | 16 | 2026-09-27 → 2026-11-15 |
| Codex | 20 | 6 | 2 | 2026-10-09 → 2026-11-07 |

All sources together: **33 active days across 57 calendar days.** `[verified]` Claude Code is
29 sessions in `modelog`, 7 in `gitOps`. Since `RESEARCH-signals.md` (2026-11-07) that is
+15 sessions and +732 turns.

**Claude Code by week** (week starting Monday, local time), the resolution any trend has to live at:

| Week of | Turns | Sessions | Active days |
| :--- | ---: | ---: | ---: |
| 09-14 | 97 | 1 | 1 |
| 09-21 | 229 | 3 | 2 |
| 09-28 | 322 | 3 | 2 |
| 10-05 | 1,144 | 7 | 6 |
| 10-12 | 794 | 7 | 6 |
| 10-19 | 115 | 1 | 2 |
| 10-26 | 86 | 2 | 2 |
| 11-02 | 365 | 9 | 3 |
| 11-09 | 382 | 9 | 3 |

**Nine weeks, five of them with three sessions or fewer.** The shape of the work also changed:
October ran few, long sessions on many days, and November runs many shorter sessions on three
days a week. Any week-over-week trend is measured against that shift. `[verified]`

### The raw logs — the window for anything that needs new ingest

| | |
| :--- | ---: |
| Oldest surviving record | **2026-10-16** |
| Chats with a log (main files) | 25, of which 24 have assistant turns |
| Sub-agent logs | 1 |
| Assistant messages (deduplicated by `message.id`) | 1,160 |
| Active days | **13** |

**14 of the store's 36 Claude Code sessions (2,125 turns, 60%) no longer have a source log.**
On 2026-11-07 that was 24%. Logs go after roughly 30 days, which matches Claude Code's default
`cleanupPeriodDays`; there's no override in `~/.claude/settings*.json`. `[verified]` The
practical rule: **a signal that needs an ingest change can only ever look back about a month,
and only from the release that captures it.** Everything from the busy October weeks is
store-only already.

### Work-session records and markers — almost empty

| | |
| :--- | ---: |
| `work_records` rows | **4** (1 `done`, 1 `start`, 1 `handoff`, 1 `continue`) |
| Work sessions | 2 |
| Chats in a work session | 3 |
| Date of every record | 2026-11-15 |
| `markers` rows | **0** |

`[verified]` `PLAN-trends.md` assumes work-session boundaries "from 2026-11-08 onward", and the
handoff assumes a week of daily `/start`/`/handoff`/`/done`. **This store holds one morning of
it.** The skills ran (the raw logs attribute 38 assistant messages to `start`, 14 to `handoff`
and 2 to `done` from 2026-11-08 onward), so the earlier records were either written to another
machine's store (0.9.0 testing moved to the MacBook) or lost. Until that's resolved,
**work-session shape (R1) has n = 1 completed work session on this machine** and can't be
measured.

### The MCP surface only sees data as fresh as the last scan

At 10:22 UTC neither the store nor `modelog_list_sessions` had anything after **07:43 UTC**.
After the maintainer pressed Rescan, every chat appeared, this one included (re-queried at
10:45). `[verified]` **That's by design, not a regression:** there's no background watcher
(`DESIGN.md` §5, `src/extension.ts:197`). Scans run at startup, when the Dashboard is brought
to the front, and on *Modelog: Rescan*. **The MCP server never triggers one.**

That was acceptable while the Dashboard was the surface. It isn't for this direction: `/done`
and a future *Discuss with AI* ask the agent about the work just finished, and that work is
exactly what's missing until someone opens the Dashboard. **Requirement for the shortlist:** an
MCP read has to see the current chat. That could be a scan before each MCP read, or a narrower
tail of the caller's own log. Every R0 figure above is as of 07:43.

### n, for everything that follows

- **Store signals:** 36 Claude Code sessions over 9 weeks; per-week figures rest on 1–9 sessions.
- **Ingest-needed signals:** 24 chats over 13 active days, from 2026-10-16.
- **Work-session signals:** 1 completed work session.
- **Copilot / Codex:** too few and too short for session-level trends (Copilot median ~3 turns,
  as before).

---

## L — What the field says is worth watching (literature pass, 2026-11-15)

**Scope:** one round of web search plus a full read of two session-log papers. It's a first pass,
not a systematic review. **The most important finding is negative:** no study found here
correlates a *developer behaviour visible in session logs* with an *objective outcome*. The
large log studies report how common behaviours are and what they cost, not what predicts
success. `[primary]` for SWE-chat and the misalignment paper (read by a delegated fetch;
SWE-chat's last ~30% unread). So the outcome-linked class can't be borrowed from the
literature. It has to come from this developer's own git (R4), or stay empty.

### Findings that map onto data Modelog can see

| # | Finding | Source | What Modelog would watch | Visible to Modelog? |
| :-- | :--- | :--- | :--- | :--- |
| L1 | **Context rot:** every model tested degrades as input grows, sometimes as a cliff, not a slope | Chroma (18 models), Hong et al. 2025, via the self-compacting-agents paper `[secondary]` | Peak context per chat, context at which work continues instead of a fresh chat (S2, S3, S10, S11) | **Yes, store, backfillable** |
| L2 | **"Vibe" sessions cost ~3× per committed line** and carry ~3.8× the security findings of collaborative ones; only 59% of agent-written code reaches a commit | SWE-chat, ~18k sessions, 69% Claude Code `[primary]` | **Cost per line that lands**: store cost ÷ lines committed (git), or ÷ `cost-state.totalLinesAdded` (raw log, from 2026-11-07) | **Partly:** cost yes, lines need git or ingest |
| L3 | Developers **feel faster while being 19% slower**, before and after | METR RCT, 16 devs, 246 tasks `[secondary]` | Measured wall time per piece of work set beside the developer's sense of it; the product's thesis, not a signal | Needs a unit of work: work session or commit |
| L4 | **Context files** (`AGENTS.md`/`CLAUDE.md`): −28.6% runtime, −16.6% output tokens (Codex, 124 PRs). Auto-generated ones *lower* success and raise cost ~20% | Lulla et al. 2601.20404; ETH 2602.11988 `[secondary]` | **A change to an agent-instruction file is a datable event in git**, so Modelog could anchor a before/after *without the developer marking anything* | **Yes, git** |
| L5 | Learners who **delegate code generation** score <40% on comprehension; those who **ask conceptual questions** score ≥65% | Anthropic RCT, Shen & Tamkin, 2601.20245 `[primary: Anthropic post]` | Share of turns that end without a tool call (`message.stop_reason`, outside `content`) as a weak proxy for "explaining" vs "doing" | **Proxy only**; the real split needs content |
| L6 | **Planning** raises success for weaker models and lowers cost for stronger ones | Harness-design study 2609.20804 `[secondary]` | Plan-mode use (`permissionMode` / `mode` records) by model | Yes, raw log; **0 plan-mode prompts here** |
| L7 | Autonomous runs **doubled from ~10 to ~20 actions** in six months (Anthropic engineers, self-report) | Anthropic internal study `[secondary]` | S6, the longest run without a human prompt, as a trend | Needs ingest (`RESEARCH-signals.md` §6) |
| L8 | **Churn and duplication rose and moved code fell** as AI use grew | GitClear, 211M lines `[secondary]` | Code survival / rewrite within N days of a work session | **Yes, git (R4)** |
| L9 | Pushback in ~46% of turns; **a misaligned session is followed by another 52% of the time vs 34%** | SWE-chat; misalignment paper, 20,574 sessions `[primary]` | Correction rate | **No:** needs content. Only an MCP-side (content-reading, per-component) classifier could do it |
| L10 | AI **amplifies** what's there: only 2 of 7 team clusters gained throughput without more change failures | DORA 2025, ~5,000 respondents `[secondary]` | Reverts / fix-up commits after AI work | Yes, git (R4); team-level, so weakest fit for one developer |

### What this does to the plan

- **L4 is the most important mechanism, not a signal.** Today a change only gets measured if the
  developer marks it. Git dates changes to `CLAUDE.md`, skills and settings by itself. That gives
  `/start`-free, rating-free anchors, which is what `PLAN-trends.md` says ratings and markers
  failed to provide. The effort switch found in R1 is the same kind of event, read from the log
  instead of git.
- **L1 and L2 rank first for R3**, because the literature gives them a direction (so they can be
  *waste* or *outcome-linked*, not just *practice*) and Modelog can see them now.
- **L9 and L5 mark the content boundary.** The strongest behavioural findings need what invariant
  1 forbids the extension to read. If they're wanted, they belong to the agent during *Discuss
  with AI*, which reads the conversation it's in anyway, not to Modelog's store.
- **SWE-chat's own caveat applies here too:** abandoned work leaves no commit, so any
  git-linked outcome overstates success. Modelog's store keeps abandoned chats, which is an
  advantage over the published datasets.

### Sources

- SWE-chat: <https://arxiv.org/html/2604.20779>
- How Coding Agents Fail Their Users: <https://arxiv.org/html/2605.29442v1>
- METR RCT (coverage): <https://getdx.com/blog/metr-study-on-how-ai-affects-developer-productivity/>
- GitClear 2025 (coverage): <https://blog.robbowley.net/2025/02/17/gitclears-latest-report-indicates-genai-is-having-a-negative-impact-on-code-quality/>
- DORA 2025 (coverage): <https://blog.robbowley.net/2025/10/01/dora-2025-ai-assisted-dev-report-some-benefit-most-dont/>
- Context rot: <https://arxiv.org/pdf/2606.23525>, <https://morphllm.com/context-rot>
- AGENTS.md efficiency: <https://arxiv.org/html/2601.20404>; ETH evaluation: <https://arxiv.org/pdf/2602.11988>
- AI and skill formation: <https://www.anthropic.com/research/AI-assistance-coding-skills>
- Harness design / planning: <https://arxiv.org/pdf/2609.20804>
- Claude Code automation share (coverage): <https://www.convergence-now.com/artificial-intelligence/is-ai-taking-over-coding-79-of-chats-with-anthropics-assistant-focus-on-automation-119282>

---

## R1 — Candidate signals beyond S1–S11 (in progress)

### What the raw Claude Code log holds outside `message.content`

Every top-level record type and key was enumerated across the surviving logs. Values were read
only from structural fields. Two counts below come from **inside** `message.content` (tool-use
block names, `tool_result.is_error`). They were read here only to settle whether the data exists
anywhere, and they're flagged because the extension can't read them (invariant 1). `[verified]`

| Field / record | What it carries | Outside content? | Found |
| :--- | :--- | :--- | :--- |
| `assistant.effort` | `medium` / `high`, per message | **Yes** | 1,596 medium, 870 high |
| `assistant.requestedModel`, `advisorModel` | model asked for vs. advisor | Yes | from 2026-11-07 only |
| `user.permissionDecision` | accept/reject, source (`config` / `user_temporary`), reason (`classifier`, `mode`) | Yes | 706 accept, **2 reject** |
| `user.toolDenialKind` | `automode-blocked`, `user-rejected` | Yes | **3 total** |
| `user.toolUseResult.interrupted` | tool interrupted | **Borderline:** sits beside content and holds stdout | **0 true** |
| `queue-operation` | `enqueue`/`dequeue`, `remove/absorbed_mid_turn` | Yes | enqueue ≈ every prompt; **13 absorbed mid-turn** |
| `cost-state` | `totalLinesAdded`/`Removed`, API/tool durations, per session | Yes | 15 sessions, from 2026-11-07 |
| `pr-link` | PR number + repo, per session | Yes | 81 records, 11 sessions |
| `tools-used` | tool list per session | Yes (names, no arguments) | 85 records |
| `attributionSkill` / `attributionMcpTool` / `attributionAgent` | which skill/MCP tool/agent drove a message | Yes | `start` 38, `handoff` 14, `done` 2 |
| `user.promptSource` / `promptId` / `turnPosition` | human prompt boundary | Yes | as `RESEARCH-signals.md` §6 |
| `system` subtype `compact_boundary` | compaction | Yes | **0 found**: no compaction in the window |
| tool-use block `name` | tool used per call | **No: inside content** | Bash 873, Edit 85, Read 54, … |
| `tool_result.is_error` | tool failure | **No: inside content** | 40 of 1,139 (3.5%) |

### First verdicts from the inventory

- **Interruptions:** 0 *structural* interruptions (`toolUseResult.interrupted`) in 24 chats.
  SWE-chat finds them in ~4.5% of turns, so the zero more likely means Claude Code records an
  interrupt only as text inside `content` than that none happened. **Not visible without
  content**; treat it as unmeasurable, not as absent.
- **Permission denials:** 3 in 24 chats, under `permissionMode: auto` on 161 of 163 prompts.
  **Fails on n.** Auto mode removed the event this signal would count.
- **Tool-call failures:** the flag exists only inside `message.content`. **Fails invariant 1** for
  the extension. (3.5% failure rate, for the record; it doesn't get stored.) `cost-state` and
  `tools-used` don't carry it either.
- **Compactions:** none in the surviving window. **Can't be measured here**; it can be specified
  for later.
- **Mid-turn steering** (`absorbed_mid_turn`, a prompt typed while the agent was working): 13
  events, 11 of them in two October `gitOps` chats. Small n, but structural. Kept for R3.
- **Effort level: a new candidate, and the first one with a visible change.** Every Claude Code
  message in the window ran at `high` until **2026-11-07**. From 2026-11-07 onward every message
  runs at `medium` (a single chat mixes the two that day). **There's no marker for it.** It's a
  discrete practice change of the kind §7.23 wants anchored, it's structural, and it's exactly the
  question *Discuss with AI* would ask: "did you change this on purpose?" Its effect has to be
  separated from the model change of the same period (`claude-opus-5` → `claude-opus-5-5`) before
  R3 can write its sentence. `[verified]` for the switch; effect `[untested]`.
- **Lines added/removed and PR links per session:** structural, present from 2026-11-07. These
  are the cheapest outcome proxies available without a git reader, so they go to R4.

Still to do in R1: model mix over weeks, time-of-day / break inputs, work-session shape (blocked,
see R0), S6, and each candidate's backfillability.
