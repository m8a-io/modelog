# Next Session — the recommendation loop (PRD §7.23 / §7.24)

**Status:** specification written 2026-11-07; **step 1 complete 2026-11-07** (`RESEARCH-signals.md`). **Still no code.** Nothing in §7.23 or §7.24 is implemented, scoped, or estimated.

**Spec:** `PRD.md` §7.23 (the loop), §7.24 (shipping the commands), §7.22 (the closure record this builds on), §7.19 (the authorship rule). Where this document and the PRD disagree, **the PRD wins** — this is sequencing and session context, not requirements.

**Read before touching anything:** §7.22 and §7.23 in full. §7.23 exists partly to stop a plausible-sounding feature from being built, so skimming it defeats the point.

---

## Where the last session left off

A long design conversation on 2026-11-06/07 that produced **documentation only**. All changes are in `docs/PRD.md` and were **uncommitted** at the time of writing:

| Section | What |
| :--- | :--- |
| §4 | AI Insights now ships a Usage Health Score — observed 2026-11-07 from a local install. Records four things it does that Modelog's invariants forbid. Tagged as a commitment: **if §7.23 never ships, delete the block** rather than leave an unearned contrast standing |
| §7.23 | *"What could I do now?"* — the recommendation loop. **The main new specification** |
| §7.24 | Modelog ships `/handoff` and `/done`. The decision is settled; the mechanism is entirely open and `[untested]` |
| §11 rows 29–31 | Sufficiency algorithm; whether the agent's prose is stored; per-tool command installation |
| §12 | Why the name carries `log` — the remote-dev-environment argument |

~~**Also still open, never specified:** a small GitHub issue the maintainer wanted to file.~~ **Filed 2026-11-07 as [#28](https://github.com/m8a-io/modelog/issues/28)** — ingest warnings become one "inconsistencies noticed" notice with a privacy-safe report, reusing 0.7.0's flow.

**New prior art, 2026-11-07:** `microsoft/TokenEconomizer` (UC Berkeley / Microsoft Research, arXiv 2610.22732) — reviewed into PRD §4. It performs the interventions it then reports savings on, which is the shape §7.19 forbids Modelog from taking; it carries a published sufficiency-and-retraction rule relevant to step 2; and a developer who installs it is the cleanest available demonstration of §7.23's loop, since Modelog can anchor and score the change **without having shipped the intervention**.

---

## NEXT SESSION — build `/done` (and `/handoff`), shipped by the extension

**Priority set by the maintainer, 2026-11-07:** *"I really, really, really want `/done` badly."* The goal is both commands **built and deployable through the extension**. This reorders the plan below: §7.24's step 4 moves ahead of steps 2–3. That is legitimate, not a shortcut — `/done`'s first useful version needs neither the sufficiency rule (step 2) nor the range-scoped recommendation surface (step 3). The closure record is the product (§7.22); tips can arrive in a later release.

**Settled by the maintainer this session:** the commands are **deployed via the extension** (an opt-in installer, §7.15 rules). Still open: whether their source lives in this repo or its own (§7.24 Open) — default to **this repo** under a top-level directory unless that turns out to block anything; it is easy to split later and hard to merge.

### What must stay true (from the PRD — re-read §7.19, §7.22, §7.24)

- **The model never authors the record.** The agent drafts; the developer accepts or edits; only confirmed fields are written, each with its provenance (`user` / `generated` / `observed`).
- **The commands work with Modelog uninstalled** (§7.24 constraint 2). No MCP server, no extension → `/done` still runs the flow and **prints** the record as Markdown. It must never fail because Modelog is absent.
- **Invariant 6: the MCP server gets no write tools.** The write path is the **inbox file** the extension ingests (§7.22). Do not reopen this.
- **About 30 seconds, two interactions** (§7.22): blind gut rating first, then one review screen.
- **Modelog never runs either command automatically**, never nags toward one.

### Staged build — each stage verifiable on its own

| Stage | What | Done when |
| :-- | :--- | :--- |
| **0. Verify distribution** | For each target, install a trivial throwaway command and invoke it. Claude Code user scope (`~/.claude/commands/*.md` vs `~/.claude/skills/<name>/SKILL.md` — **neither directory exists here yet**); Copilot Chat prompt files (workspace `.github/prompts/*.prompt.md` and the user-profile location); Codex — **lead found 2026-11-07: `~/.codex/skills/` exists and holds `SKILL.md` files under `.system/`, the same shape as Claude Code skills**, so one artifact may serve both. `claude` is **not** on `PATH` (VS Code extension only), so Claude Code checks need the maintainer to type the command | Every §7.24 row is `[verified]` or `[fails]`, with the exact path and file format. **Nothing below is designed around an `[untested]` row** |
| **1. The command artifacts** | `/done` and `/handoff` prompt text, written once and rendered per target format. Covers both modes: Modelog present (call MCP, write inbox) and absent (print the record). Tag vocabulary pinned and versioned (§7.22 draft list) | Each command runs end-to-end in at least one tool **with Modelog uninstalled** |
| **2. Closure record + inbox + store** | The record's schema (§7.22 fields: id, session ref, gut + final rating, summary, result type, tags, time frame, per-field provenance, *when* it was attested — §7.19's recall caveat). The inbox location and file format. Ingest: idempotent by record id. Store: **a new table — today the store holds only `turns` and `cursors`**, so this is a `SCHEMA_VERSION` bump (currently 6). Widen `provenance` past the literal `"observed"` (`src/mcp/tools.ts`) | A hand-written inbox file is ingested once, re-ingested harmlessly, and visible via a read-only query |
| **3. The installer** | `Modelog: Install /done and /handoff` — reuse `MCP.md` §7.3/§7.4's flow unchanged: show exact file + content, confirm, back up, write, verify, clipboard fallback, never claim an unverified success | Installs into every stage-0-verified target; uninstall/cleanup covered (`src/cleanup/`) |
| **4. Minimal surface** | Closure records visible somewhere in the Dashboard (a list is enough) and exportable as Markdown/JSON (§7.22) | A developer can see and export what `/done` wrote |
| **5. `modelog_session_review`** *(may be a second release)* | The read-only MCP tool from §7.22, built on **`RESEARCH-signals.md`'s verified set**, not §7.22's original nine: S1 resume-rebuild cost, S2 context growth, S3 context at break, S5 unread writes (demoted), S7 delegation, S8 switches **with the tautology guard**, plus a `gaps` array. Mechanical-waste findings only until there is rating history | `/done` shows at most 2 tips + 1 praise, each with its baseline, and every gap |

**Recommended release split:** stages 0–4 are a shippable `/done` — a rating, a summary and a result type, recorded durably. That alone answers §12's `log` argument, and it starts accumulating the **rated** sessions that stage 5's *personal-best* tips need anyway. Shipping 0–4 first is the fastest route to the tips, not a detour from them.

### Design questions the next session must answer (or ask the maintainer)

1. **How does the agent find the inbox?** The extension's `globalStorageUri` differs per editor and per remote, and the agent cannot guess it. Candidates: a fixed user-level path (e.g. `~/.modelog/inbox/`), or a **read-only** MCP tool that *returns* the path (keeps invariant 6; fails cleanly when Modelog is absent, which constraint 2 needs anyway). Decide before stage 2.
2. **How does the agent identify its own session id?** (§7.22 Open.) Likely answer: it doesn't — the record carries a timestamp and `cwd`, and ingest joins to the most recent session active in that `cwd` at that time. Check against the real store.
3. **Timing:** the `/done` turn itself may not have reached the log when the review runs (§7.22 Open). Matters for stage 5, not 0–4.
4. **Is `/handoff`'s successor brief content?** (§7.24 Open.) Simplest safe answer for v1: the brief is printed for the developer to paste and **never stored**; only the closure record is.
5. **The abandoned-session path** (§7.19 says required). Out of scope for v1 — but the record schema must not make it impossible later (e.g. a retroactive record must be distinguishable by its attestation time).

---

## The five rules this workstream must not break

Each came out of the design conversation, and each has a reason that is easy to lose once implementation starts.

1. **Modelog stores no catalogue of good practice.** The agent supplies *"this practice exists, and here is why it helps"* from its own live knowledge. Modelog supplies the signal, the anchor and the verdict. The worked example for why: §7.20 computes that *"keep the session cached"* — which sounds obviously right — **costs more** than letting the cache lapse, for any break past roughly fifty minutes. Stored as a tip, it would have cost users money on a plausible guess.
2. **A tip is an anchor, not output.** A recommendation is written to the store as a §6 `Marker`. Without that, no verdict on it is possible later and the loop is decoration.
3. **Adoption is measured, never self-reported** — read from the triggering signal moving in the window after the anchor. *Modelog measures the behaviour, never the brand*: a developer who achieves the same change by hand is indistinguishable in the data, deliberately.
4. **"It did nothing" must be reportable.** A loop that can only produce good news is marketing (§4.5).
5. **Sufficiency is per signal, and is sessions-and-spread, not days** — though it is *expressed* to the user in days, because "about 9 days" is actionable and "40 more sessions" is not.

---

## Sequenced work

### 1. Name the signals — research, no code

This is the narrowed research task, and it is deliberately **not** "what is current best practice". That ages, and it is the agent's job to know it. The durable question is **which measurable signals are worth exposing at all.**

Start from §7.22's signal table (nine candidates, each with a `Captured` / `Unknown` column) and add the absence-signals §7.23 introduces — zero sub-agent turns, no session under N turns, no context reset above N tokens.

For each candidate, answer two questions:

- **Is it derivable from what the store already holds?** `metrics/aggregate.ts` and the four token classes cover more than they look like they do.
- **Does the arithmetic survive?** Do for each candidate tip what §7.20 did for cache keepalive: compute the actual cost consequence against `data/pricing.json` *before* anyone writes prose about it. §7.20 is the model to copy, including its honesty that its numbers are computed and not yet measured.

**Done when** each candidate is either specified with its data source, or rejected with the arithmetic that killed it.

> **Done 2026-11-07 — `RESEARCH-signals.md`.** Ten signals specified with their data source, **four rejected** (two on arithmetic, two on missing data), two demoted to denominators. Headlines: cost is **85.5% cache traffic**, and **cache rebuilds after a break are 28.7% of all spend** — a signal §7.22's table does not contain. `iterations` is constant 1 on Claude Code and so carries no information there. The small-output model-fit tip dies on the arithmetic. §7.20's keepalive rejection is **confirmed on real data** (+14.3% dearer), and the 1-hour TTL it ranked cheapest is worth **−15.7%** here. §11 row 28 is **resolved yes** for Claude Code. Three corpus hazards were found and must be carried forward: 36% of the live store is synthetic demo data, **24% of sessions have no surviving source log**, and n is 21 sessions from one developer.
>
> **The rejections rule 1 predicted did happen**, and one of them was mine: a first-pass 1-hour-TTL counterfactual double-charged the surcharge onto writes that would never occur, and returned a wash where the corrected model returns a $58 saving — a factor of 26, from a plausible-looking slip. Recorded in `RESEARCH-signals.md` §5.6 rather than quietly fixed.

### 2. The sufficiency rule — §11 row 29

Needs three things that do not exist yet: the minimum effect size worth claiming, the real dispersion of each signal across the author's own sessions, and a rate estimate stable enough to turn "40 more sessions" into "about 9 days".

The store holds **2,802 real Claude Code turns across 21 sessions** to measure dispersion against (not ~1,800 — and 36% of the raw store is synthetic demo data that must be excluded first), so this is an **analysis task before it is an implementation one**. Step 1 has already measured the dispersion of six signals and the session rate; what is left is the minimum effect size, and the choice between the two rate denominators — 21 sessions / 48 calendar days versus 0.91 per active day over 23 active days — which differ by a factor of two and therefore change "ask again in about 9 days" into something twice as long. Getting it wrong is costly in both directions: too eager and Modelog calls noise a habit; too cautious and a new user is told "not yet" until she uninstalls.

### 3. The MCP surface

Only after 1 and 2.

§7.22 already specifies `modelog_session_review({ sessionId })` as read-only; §7.23 needs a range-scoped counterpart. **Neither may break invariant 6** — the server has no write tools, and `openReadOnly()` enforces that at the database rather than by convention.

So the write path for recommendation markers is **not** an MCP tool. §7.22 already settled the pattern: a local **inbox file** that the extension ingests. Reuse it; do not reopen it.

### 4. `/handoff` and `/done` — verify before designing  *(promoted to NEXT SESSION above, 2026-11-07)*

Every row in §7.24's distribution table except project-scoped Claude Code skills is `[untested]`. Specifically unconfirmed on this machine as of 2026-11-07: the user-scope `~/.claude/commands` format (directory does not exist), Copilot's `.github/prompts/*.prompt.md`, and whether Codex has a prompts directory at all (`~/.codex` exists, with no `prompts`). `codex` and `copilot` are on `PATH`; `claude` is not.

The precedent to copy is `MCP.md` §7.4: show the exact file and the exact content, confirm, back up, write, and never claim a success that was not verified.

Two constraints from §7.24 that shape the artifact itself: the commands must **work with Modelog uninstalled**, and Modelog must never perform a handoff automatically.

---

## Realistic scope

Step 1 is a session on its own and produces no code. Steps 1 and 2 together are the honest definition of "ready to build".

~~**Do not start step 3 before step 1 has rejected at least one candidate signal.**~~ Satisfied: four rejected, with arithmetic.

**New constraint from step 1, for step 3.** The oversight signal (longest run of AI turns without human input) needs a `capture.ts` bump and **cannot be backfilled** — 24% of sessions already have no surviving source log, and that share only grows. If the MCP surface is designed before ingest records the prompt boundary, every session until that release permanently lacks the signal with the widest dispersion in the set.
