# Naming the signals — step 1 of `PLAN-recommendations.md`

**Status:** research complete 2026-11-07. **No code was written.** Everything below is measured
against this machine's own store and logs, or computed against `data/pricing.json`.

**What this answers.** `PLAN-recommendations.md` step 1 asks, for each candidate signal in
PRD §7.22 and §7.23: *is it derivable from what the store already holds*, and *does the cost
arithmetic survive* — the test §7.20 applied to cache keepalive, applied to every candidate
before anyone writes prose about it. The plan's acceptance bar is that each candidate is either
specified with its data source or **rejected with the arithmetic that killed it**. Four are
rejected, two on arithmetic and two on missing data.

Where this document and the PRD disagree on requirements, the PRD wins. Where it disagrees with
the PRD on a *measured fact*, the measurement wins and §9 below says which PRD claims move.

---

## 1. Method and corpus

Read-only, against `~/.vscode-server/data/User/globalStorage/modelog.modelog/modelog.db`
(4,581 turns) and the raw `~/.claude/projects/**/*.jsonl` (7,483 assistant records). Costs come
from `src/metrics/cost.ts` and `data/pricing.json` unchanged — the same engine the product ships,
so no figure here is a reimplementation that could drift from what a user sees.

### Three corpus hazards, all of which bite the analysis

| Hazard | Measured | Consequence |
| :--- | :--- | :--- |
| **Synthetic demo data in the live store** | 1,570 of 4,372 Claude Code turns (36%) come from `/home/scott/modelog-demo/logs/`, one fabricated 1,570-turn session | Excluded from everything below. Any future analysis that forgets to exclude it will report a 154-hour session as the developer's own behaviour |
| **The store outlives its logs** | **6 of 21 sessions (683 turns, 24%) have no surviving source `.jsonl`** | A signal that needs a raw-log field absent from the store **cannot be backfilled** for those sessions, and the share only grows. This is PRD §12's `log` argument showing up as an engineering constraint, not a positioning one |
| **n is small** | 21 real sessions over 48 calendar days, 23 active | Every per-session signal below has n=21. This is the single most important input to step 2 |

**The real corpus**, used for every figure from here on: **2,802 Claude Code turns, 21 sessions,
23 active days spanning 48, $370.07** at list rates.

---

## 2. The one fact that reorders the whole signal list

Cost decomposed by token class across the real corpus:

| Class | Cost | Share |
| :--- | ---: | ---: |
| Cache read | $177.41 | 47.9% |
| Cache **write** | $139.21 | 37.6% |
| Output | $53.42 | 14.4% |
| Fresh input | $0.02 | 0.0% |
| **Total** | **$370.06** | |

**85.5% of spend is cache traffic.** This is stronger than PRD §7.3's "roughly 95% of input-side
*tokens* were cache reads" — that was a token-volume claim, and this is the money claim it implies.

It has a blunt consequence for signal selection: **a signal about output addresses at most 14.4%
of spend, and a signal about fresh input addresses nothing at all.** The signals worth having are
the ones that move context size and cache behaviour. Three of §7.22's nine candidates are about
output or turn shape, and that is why two of them do not survive §5.

---

## 3. The cache-expiry cliff, measured

Every cache write on this machine is a 5-minute write. Binning the 2,781 inter-turn gaps by
length and asking how often the next turn rewrote more than half the prior context:

| Gap (s) | n | Rebuilds | Mean write (tokens) |
| ---: | ---: | ---: | ---: |
| 0–60 | 2,529 | 1% | 2,460 |
| 60–240 | 102 | 0% | ~2,200 |
| 240–290 | 13 | 0% | 5,000 |
| 290–310 | 3 | 0% | 467 |
| **310–330** | 2 | **50%** | 70,345 |
| **330–360** | 6 | **100%** | 177,818 |
| 360–600 | 40 | 97% | 168,000 |
| 600–3600 | 69 | 99% | 141,000 |
| >3600 | 17 | 94% | 168,000 |

The transition is complete between **300 and 330 seconds** and the mean write jumps **58×** across
it. This is the 5-minute TTL, observed rather than assumed, and it is the mechanism behind the
largest cost signal in the corpus.

> Worth noting against prior art: TokenEconomizer's README states that "after an idle hour that
> cache has expired anyway." On this machine the cache expires after **five minutes**, and the
> data above locates the boundary to within 30 seconds. Both can be true of different
> configurations — the point is that it is checkable, and was checked.

### What it costs

Classifying a turn as a **resume-rebuild** when it follows a gap over 5 minutes *and* writes
≥20k tokens:

- **131 events** across 21 sessions, costing **$106.33**
- **28.7% of all Claude Code spend in the corpus**
- Per event: p50 **$0.62**, p90 **$1.62**, max **$3.92**
- Per session it ranges from 0% to **57%** of that session's cost; median 25%

The marginal-cost table that explains it, at `claude-opus-5` rates:

| Context | A steady turn | The first turn after a >5 min break |
| ---: | ---: | ---: |
| 25k | $0.03 | $0.16 |
| 50k | $0.04 | $0.31 |
| 100k | $0.07 | $0.63 |
| 200k | $0.12 | **$1.25** |
| 400k | $0.22 | **$2.50** |

A five-minute interruption at 200k context costs **ten times** what the turn before it cost. That
is the single most actionable number this research produced, and **none of the nine §7.22 signals
names it.**

---

## 4. Signal verdicts

`Store` = computable today from `Turn` rows alone. `Ingest` = the data exists in the source log
but is not captured, so it needs a `capture.ts` version bump and is **not backfillable for the
24% of sessions whose logs are gone**.

| # | Signal | Source of truth | Verdict |
| :-- | :--- | :--- | :--- |
| S1 | **Resume-rebuild cost** — cache writes after a >5 min gap | **Store** | **Specify.** New. 28.7% of spend; see §3 |
| S2 | Context growth, first vs last quarter | **Store** | **Specify.** Dispersion p25 2.0× / p50 3.1× / p75 3.7×, n=20 |
| S3 | Context size at the moment of a break | **Store** | **Specify.** New. The multiplier on S1, and the only lever the developer actually controls |
| S4 | Cache hit rate | **Store** | **Specify, as a denominator — not as a tip.** p50 91.4%, p25 86.6%. See §5.3 |
| S5 | Cache written, never read | **Store** | **Specify, narrowed.** $11.35 (8.2% of write spend); mostly structural. See §5.3 |
| S6 | Longest run of AI turns without human input | **Ingest** | **Specify.** PRD §11 row 28 **resolved — yes.** See §6 |
| S7 | Sub-agent share of turns and of cost | **Store** | **Specify.** 6.3% of turns, 1.8% of cost; 14 of 21 sessions have zero |
| S8 | Mid-session model switches | **Store** | **Specify, with the tautology guard.** See §5.4 |
| S9 | Idle gaps / session shape | **Store** | **Specify as input to S1/S3**, not as a tip of its own |
| S10 | Context resets inside a session | **Store** | **Specify as an absence signal.** 3 resets in 21 sessions |
| — | Inference calls per turn | — | **Reject for Claude Code; keep for Copilot/Codex.** See §5.1 |
| — | Expensive-model turns with small output, no tool loop | — | **Reject.** See §5.2 |
| — | "Keep the session cached" (keepalive) | — | **Reject, confirmed on real data.** See §5.5 |
| — | Time to first useful output | — | **Reject for now.** Needs "useful", which needs content |

### The absence signals §7.23 names, tested

| §7.23's example | Measured here |
| :--- | :--- |
| *"Zero sub-agent turns across N sessions"* | **True of 14 of 21 sessions.** Real and common |
| *"No session under 40 turns in 90 days"* | **False here** — 6 of 21 sessions are under 40 turns. The absence form is right; this particular threshold is not this developer's |
| *"No context reset in any session that passed 100k tokens"* | **Nearly true: 11 sessions passed 100k, 3 resets in total, and 2 of those 3 were in one session.** The strongest absence signal in the set |

---

## 5. The rejections, with the arithmetic

### 5.1 Inference calls per turn — rejected for Claude Code, source-asymmetric

`iterations` takes exactly **one distinct value across all 2,802 Claude Code turns: 1.** The field
is populated, the column is real, and it carries no information whatsoever for this source.

It is not dead everywhere: **Copilot ranges 1–8, Codex 1–11.** So this is the same shape of
problem as §7.21's latency asymmetry and takes the same answer — a per-source signal, stated as
unavailable on Claude Code rather than reported as a flat 1.0, which would read as "you never run
long loops" when it means "this source does not say."

This also disposes of the *"and no tool loop"* half of §7.22's model-fit signal: on Claude Code
there is nothing to detect a tool loop with.

### 5.2 "Expensive model, small output" — rejected on arithmetic

Repricing `claude-opus-5` turns onto `claude-sonnet-5` at three output cut-offs:

| Cut-off | Turns | Actual | On Sonnet | Saving | As % of Opus spend |
| :--- | ---: | ---: | ---: | ---: | ---: |
| output < 50 | 1 / 1,070 | $0.10 | $0.04 | $0.06 | 0.0% |
| output < 200 | 165 / 1,070 | $24.14 | $9.66 | $14.49 | 7.1% |
| output < 1,000 | 705 / 1,070 | $100.08 | $40.03 | $60.05 | 29.5% |

The tight cut-off that would make the tip defensible finds **one turn**. The cut-off that finds
real money captures **66% of all Opus turns**, which is not a signal, it is a decision to stop
using Opus. There is no threshold in between that is both discriminating and material.

The reason is §2: cost is dominated by reading the context, not by producing output, so output
size does not identify turns that are cheap to move. **Small output is an intuitive proxy that the
rate card does not support** — the same failure mode §7.20 caught, reached from a different
direction.

What survives is not a per-turn signal at all: *which model handled which stretch of work, and
what that stretch cost*. That is S8, and §7.22's existing model-switch anchor already carries it.

### 5.3 Cache hit rate and cache-write-unread — demoted, not rejected

**Cache hit rate** has a per-session range of 62.0% – 97.2%, p50 91.4%. It is a fine denominator
and a fine diagnostic. It is a poor tip: there is no action "raise your cache hit rate," because
the rate is an artefact of how long sessions run and when they are interrupted. S1 and S3 are the
same information expressed as something a developer can act on.

**Cache written, never read** is real but small and mostly unavoidable: **$11.35, 8.2% of write
spend**, median session 1.7% and p90 16.6%. Most of it is the last write before a session ends,
which no behaviour change prevents. Keep it as a mechanical-waste finding; do not lead with it. On
the evidence here it is worth about a tenth of S1.

### 5.4 Model switches — specify, but guard the tautology

All 15 developer model switches in the corpus produce a clean before/after on cost per turn, e.g.
`opus-5 → sonnet-5` moving $0.16 → $0.03 per turn, and `sonnet-5 → opus-5` moving $0.08 → $0.44.

**The direction of every one of those deltas is fixed by the rate card before any behaviour
happens.** Reporting "switching to Sonnet cut your cost per turn 80%" as a verdict on advice would
be reporting the price list back to the user as a discovery. §7.23's verdict machinery must
therefore not score a model-switch recommendation on cost per turn. What it *can* honestly score
is what the rate card does not determine: turns to finish the work, session length, rebuild count,
whether the developer switched back.

### 5.5 Keepalive — §7.20's rejection confirmed on real data

§7.20 computed the keepalive from rate ratios alone and flagged that it was unmeasured. Replaying
it against the actual gap profile — a ping every 4.5 minutes across each gap that preceded a
rebuild, each ping re-reading the cached prefix at that session's real context size:

| | |
| :--- | ---: |
| Pings required | 2,398 |
| Cost of those pings | $150.69 |
| Rebuild cost avoided | −$97.83 |
| **Net** | **+$52.86 — 14.3% *dearer*** |

**§7.20's conclusion holds and is now measured rather than computed.** The worked example the
whole "Modelog stores no catalogue of good practice" rule rests on is real.

### 5.6 The 1-hour TTL — §7.20's ranking holds, and the size of it is new

§7.20's table put the 1-hour TTL cheapest of the three (+0.75×P). Against real data:

| | |
| :--- | ---: |
| Surcharge on incremental writes (1.25× → 2.0×) | +$18.37 |
| Surcharge on rebuilds after >1h, which happen anyway | +$9.29 |
| Rebuilds in the 5–60 min band, avoided entirely | −$85.67 |
| **Net** | **−$58.01 — 15.7% *cheaper*** |

> **A correction to my own first pass, recorded because it is the exact error this document
> exists to catch.** My first counterfactual applied the 1-hour surcharge to *every* write token,
> including the 17.4M tokens of rebuild writes that under a 1-hour TTL would never be written. It
> returned −$2.21, a wash. The corrected model returns −$58.01. A plausible-looking arithmetic
> slip moved the answer by a factor of 26 and would have killed a real saving.

**This is not yet a recommendation**, and under `PLAN-recommendations.md` rule 1 it must not
become one that Modelog stores. Two things are unverified: whether Claude Code exposes the TTL
choice to a developer at all, and whether this developer's break profile — 119 gaps in the 5–60
minute band out of 2,781 — generalises to anyone else. It is exactly the shape of thing the agent
should propose and Modelog should then measure.

---

## 6. PRD §11 row 28 — resolved for Claude Code

> *"Can a human-message count be captured without reading content?"*

**Yes.** `type: "user"` records in Claude Code's JSONL carry a `promptId`, and the records that
begin a genuine human prompt additionally carry `promptSource`, `origin` and `permissionMode`.
Counting distinct `promptId` values, or counting records on which `promptSource` is present, are
both **key-presence tests** — they never touch `message.content`, so invariant 1 holds strictly.
The two agree closely (34 vs 32 on the largest session; exact on the rest).

This matters because it separates real prompts from tool results, which the record `type` alone
does not: on the largest session, 676 `user` records are only **32 human prompts** and 627 tool
results.

The oversight signal S6 is therefore real, and it has the widest dispersion of anything measured
here — longest run of assistant records with no human prompt, per session:

| | min | median | max |
| :--- | ---: | ---: | ---: |
| Longest unsupervised run | 17 | 58 | **312** |

**Cost of acquiring it:** a `capture.ts` version bump, because the store holds assistant turns
only and has no prompt-boundary column. Per §1, it is **not backfillable for the 24% of sessions
whose source logs are gone**, which argues for capturing it sooner rather than later. Copilot and
Codex are unverified.

---

## 7. What survives, by source

Every signal is per source, and the asymmetries do not line up the way the Claude-Code-first
view suggests.

| Signal | Claude Code | Copilot | Codex |
| :--- | :--- | :--- | :--- |
| S1 resume-rebuild | **Yes** | Partly — cache writes are `solved` on 159/193 turns, `unknown` on 13 | **No — zero cache-write tokens reported at all** |
| S2/S3 context size and growth | Yes | Yes | Yes |
| S6 unsupervised run | Needs ingest; verified available | Unverified | Unverified |
| S7 delegation | `isSidechain` | **Not `isSidechain` (1 turn).** `entrypoint` distinguishes `executionSubagentTool` / `backgroundTodoAgent` | No sub-agents observed |
| Inference calls per turn | **No — constant 1** | Yes, 1–8 | Yes, 1–11 |

Copilot's sessions are also far too short for session-level signals here — median 3 turns, and
only one session of the fifteen exceeds 24 turns.

---

## 8. Prior art — TokenEconomizer (`microsoft/TokenEconomizer`), reviewed 2026-11-07

UC Berkeley and Microsoft Research, arXiv 2610.22732. A plugin for Claude Code, Codex, the Copilot
CLI and Pi that reads the same local session logs Modelog reads and acts on them: micro-skills
(repo facts learned from repeated failures), tool pruning (drop tools unused over *p* prompts
across *m* sessions), and a failure-loop judge that injects a redirect. Reported **18.4–30.9%
lower mean cost** on 277 SWE-Bench tasks across five agent–model combinations.

It is a sharper comparison than AI Insights, in three directions at once.

1. **It is the thing §7.19's independence rule forbids Modelog from being.** It performs the
   intervention and reports the saving the intervention produced. It does this creditably — its
   own model calls are counted into the cost it reports, and every action is reversible — but it
   is structurally the measurer scoring its own advice. Modelog's answer to §4's "the gap is the
   verb" is unchanged by it.
2. **Its evidence base is a benchmark; Modelog's is the developer's own history.** "23.6% lower on
   SWE-Bench with Sonnet 5" is a strong claim about a task distribution, and says nothing about
   whether it helps *this* developer in *this* repository. That is §7.22's "who defines optimal"
   distinction, now with a concrete other answer to point at.
3. **It is a published precedent for §11 row 29, which is step 2's whole problem.** It carries a
   sufficiency rule and a retraction rule: a fact is stated *"once three sessions have confirmed
   it, and dropped when later sessions contradict it."* n=3 with retraction. Step 2 should start
   from that rather than from nothing — and should note that it is sufficiency over a *repository*,
   not over a developer, which is a different and easier denominator.

**It also sharpens rule 1 rather than contradicting it.** TokenEconomizer does keep a catalogue,
in `~/.tokeneconomizer` — but a *learned, repository-specific, retractable* one, not a shipped
static one. Rule 1 is about advice frozen into a release having no correction mechanism. A
catalogue derived from the user's own data and dropped when contradicted has one. The rule should
be read as scoping to shipped advice, which is how §7.23 already words it.

**The product consequence is immediate and good.** A developer who installs TokenEconomizer has
made exactly the kind of deliberate change §7.23 exists to evaluate, and Modelog can anchor on it
and report the before/after **without breaching the independence rule, because Modelog did not
ship the intervention.** That is the cleanest possible demonstration of the loop, available
without building the recommendation half first.

Two of its three mechanisms are measurable by Modelog only in their effects, never directly: tool
names are not captured for Claude Code (§11 row 14), and "repeated failures" requires reading
content (invariant 1). The third, context re-reading, is S1 — the signal this research found
independently, and the one both tools agree dominates.

---

## 9. Corrections this research forces on existing documents

| Where | Claim | Status |
| :--- | :--- | :--- |
| PRD §7.3 | *"observed split: 2,144,830 vs 365,082 tokens, so both are live in practice"* for `ephemeral_1h` vs `ephemeral_5m` | **Not reproducible.** Across 7,483 raw records on this machine: `ephemeral_1h` is present on every record and **non-zero on none**; `ephemeral_5m` is non-zero on 7,481, totalling 83.6M tokens. The four-class engine should stay — pricing a class that may appear is right — but the "both are live" evidence does not currently exist |
| PRD §7.20 | Keepalive arithmetic, flagged as computed and unmeasured | **Confirmed on real data**, §5.5. The 1-hour TTL's ranking also holds, and is worth 15.7% here, §5.6 |
| PRD §11 row 28 | Human-message count without reading content — unverified | **Resolved yes for Claude Code**, §6. Copilot and Codex still unverified |
| PRD §7.22 signal table | Nine candidates | Two rejected (§5.1, §5.2), two demoted to denominators (§5.3), and **the largest signal in the corpus is missing from it entirely** (S1/S3) |
| PRD §4 | Prior art is AI Insights | TokenEconomizer belongs beside it, §8 |

---

## 10. What step 2 inherits

`PLAN-recommendations.md` step 2 needs three things. Two of them now have numbers.

- **Dispersion per signal** — measured above for S1, S2, S4, S5, S7, S10 and the gap profile. All
  of it is n=21 sessions from **one developer**, so it sets no thresholds; it sets the shape of
  the distributions a threshold has to survive.
- **Rate, for turning sessions into days** — this developer ran **21 sessions in 48 days, 0.91 per
  active day across 23 active days.** The two denominators disagree by a factor of two, and
  which one is used decides whether "40 more sessions" reads as 44 days or 91. That choice is
  step 2's, and it must be stated to the user, not buried.
- **Minimum effect size** — still open, and still the hardest of the three.

One structural finding for step 3: **S6 needs an ingest change and cannot be backfilled.** If the
MCP surface is designed before `capture.ts` records the prompt boundary, every session until that
release is permanently missing the signal with the widest dispersion in the set.
