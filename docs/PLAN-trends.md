# Plan — trends that teach (research)

**Status (2026-11-15): plan written, research not started. No code.** This is the current workstream. It replaces the rating-based direction of `PLAN-recommendations.md`, whose built parts (`/start`, `/handoff`, `/done`, markers, work sessions) stay in place.

Where this document and the PRD disagree, **the PRD wins**, until task R7 rewrites the PRD to match.

---

## Why the direction changed (maintainer, 2026-11-15)

After a week of using `/start`, `/handoff` and `/done` every day, the maintainer concluded:

- **A developer who doesn't know what to change can't rate a session usefully, and won't mark a change.** The loop in PRD §7.22–§7.24 depended on two human acts: rating, and noticing and marking a change. Most developers won't do either consistently, and the maintainer only did because he wants Modelog to work.
- **Ratings are removed** ([#35](https://github.com/m8a-io/modelog/issues/35)).
- **Modelog becomes a teaching tool, not only an analysis tool.** It notices trends in the developer's own data that point to good or bad AI habits, highlights them, and offers *Discuss with AI* ([#37](https://github.com/m8a-io/modelog/issues/37)). The agent explains the trend, gives tips, and asks whether the developer knows what they started doing differently. That answer can become a marker, so markers stay, but they are optional.
- **Modelog has one user, the maintainer, and won't be promoted until it gives him an "aha" moment.** So no backward compatibility, and the research is judged by that moment.

Related: [#34](https://github.com/m8a-io/modelog/issues/34) (adopting the skills as an observed change), [#36](https://github.com/m8a-io/modelog/issues/36) (triaging open items).

---

## The filter: the "aha" test

A candidate trend is worth building only if, **on the maintainer's own data**, it:

1. **tells him something about his own work that he didn't already know,** and
2. **is something he can act on.**

Being measurable is required but not enough. A trend that passes the test outranks a trend that is more rigorous but unsurprising. To apply the test, write **the actual sentence the Dashboard would show today**, with real numbers from this machine, and judge that sentence. If the sentence is boring, obvious or offers nothing to act on, the candidate fails, however well it measures.

## The classes: where "good" or "bad" comes from

PRD §7.23 says Modelog stores **no catalogue of good practice**. The reason is §7.20: "keep the cache warm" sounds right and costs more. A teaching tool that labels trends good or bad has to respect that, so every signal must say where its direction comes from:

| Class | Direction comes from | Dashboard may say |
| :--- | :--- | :--- |
| **Waste** | Arithmetic: money or tokens that bought nothing | "Getting worse", plainly |
| **Outcome-linked** | The developer's own data: the signal moves together with an objective outcome (git) | "In your history, this goes with worse outcomes", with the evidence |
| **Practice** | Nobody; it depends on the work | "This changed", and *Discuss with AI*, with no verdict |

Tips come from the agent, never from a list stored in Modelog. That division of labour is unchanged (§7.23).

---

## What already exists, so it isn't redone

- **`RESEARCH-signals.md`** specified S1–S10 and rejected four candidates with arithmetic: inference calls per turn (Claude Code), "expensive model, small output", keepalive, and time to first useful output. **Don't bring back a rejected signal** unless new data changes the arithmetic, and say so if it does.
- **S11 (peak context)** was added on 2026-11-08 (`src/markers/vocabulary.ts`).
- **Cost structure:** 85.5% of spend is cache traffic, so signals about context size and caching matter most (`RESEARCH-signals.md` §2).
- **Corpus hazards:** synthetic demo data is in the live store (exclude `/home/scott/modelog-demo/`), the store outlives its logs (whatever needs ingest can't be backfilled), and n is small.
- **`gitBranch` is already ingested** for Claude Code and Copilot CLI (`src/ingest/claudeCode.ts:179`). It is absent from Copilot Chat.
- **Work-session records** (`work_records`, schema 8) give work-session boundaries from 2026-11-08 onward.

---

## Tasks

Each task records its findings in `docs/RESEARCH-trends.md` (new), measured against this machine as `RESEARCH-signals.md` was. Mark claims `[verified]` / `[untested]`.

**Method (maintainer, 2026-11-15):** the candidate list starts from the **literature**: which
kinds of data the field has found worth watching. This machine's data then tests each one. The
local inventory (R1) adds what the logs offer beyond that. Recorded in `RESEARCH-trends.md` § L.

### R0 — Refresh the corpus

Count again: real sessions, turns, active days, and how many sessions now have work-session records. Exclude the demo data. State n for every figure that follows.

### R1 — Inventory candidate signals beyond S1–S11

For each one, give: the data source (store / needs ingest / git / `work_records`), whether it passes **invariant 1** (the store never reads `message.content`; check PRD §8.0's per-component list), and whether it can be backfilled. Starting list, to be extended from what the logs actually contain:

- **Interruptions and permission denials:** how often the developer stops the agent or refuses a tool call. Check whether a structural field exists, or whether this is only visible inside the content.
- **Tool-call failures:** whether the error flag is structural metadata or lives inside a content block.
- **Compactions:** automatic versus manual, and the context size when each happened.
- **Work-session shape:** chats per work session, handoffs, context at each handoff, and the share of chats that belong to a work session (#34).
- **S6, the agent's runs between prompts** (already specified, needs ingest).
- **Git outcomes** (see R4): commits per work session, code survival after N days, reverts, fix-up commits.
- **Model mix and switches over weeks**, not only within a session (S8 covers within).
- **When and how long:** time of day, length of breaks, active time per work session, *only* as inputs. They are not habits to teach.

### R2 — Assign each candidate a class

Waste, outcome-linked or practice, with one line of reasoning. If a candidate's class is unclear, say so; don't force it.

### R3 — Apply the "aha" test

For every candidate that survives R1, compute the trend over the available weeks and write the sentence the Dashboard would show. The maintainer judges the sentences. **This is the ranking.**

### R4 — Can git be linked, and do its outcomes vary enough to matter?

On this machine's repos: how well branches line up with chats and work sessions; whether commit timestamps fall inside work sessions; and whether code survival or revert rate varies enough across the last weeks to separate anything. If not, say so, because the outcome-linked class then has nothing to rest on locally. Commit messages are content: read them only to derive fields, never store them (`FACTORY.md` §6.4's pattern).

### R5 — Detecting a change in a trend

How Modelog decides that a trend has changed and isn't just noise. Options include rolling windows and change-point detection. This includes **minimum effect size** and sufficiency (PRD §11 row 29). Be honest about what n allows.

### R6 — Shortlist

Ranked by R3, with the class, the data source, what has to be built (ingest change, git reader, a new MCP tool for *Discuss with AI*) and what would be shown. The top entry is what gets built first.

### R7 — Rewrite the PRD to match

After R6, not before:

- Record the teaching-tool direction.
- Remove the rating from §7.22, §7.24 and §7.25 (with #35).
- Reconcile §7.23's no-catalogue rule using the three classes.
- Revisit §7.23's "the Dashboard may prod, nothing else may", given #37.
- Mark `PLAN-recommendations.md` as superseded where it is.

---

## Out of scope

- Code. This is research and documentation.
- Comparing costs across vendors (invariant 5), as always.
- Team or CI aggregation (`FACTORY.md`). Local first; git on this machine stands in for the forge.
