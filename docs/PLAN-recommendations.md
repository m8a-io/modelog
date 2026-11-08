# Next Session — the recommendation loop (PRD §7.23 / §7.24)

**Status:** specification written 2026-11-07; **step 1 complete 2026-11-07** (`RESEARCH-signals.md`); **stage 0 complete and design revised 2026-11-08** (see *Redesign* below). **Still no code.** Nothing in §7.23 or §7.24 is implemented, scoped, or estimated.

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

### Redesign, 2026-11-08 — read this before the stage table

The maintainer revised the design on 2026-11-08; the PRD carries it (§7.22's revision block, §7.24's nudge amendment, invariant 6 rewritten, `MCP.md` §4.1). In one paragraph: **Modelog now writes, through MCP, append-only, and only what the developer approved.** The inbox file decided on 2026-11-07 is dropped. `/done` is four steps — blind rating; work done with failures **and open items**; OK or abort; statistics after saving — and the score it shows is a **verdict against a change the developer marked**, never a free-standing number. Marked changes also feed small, budgeted MCP server instructions so the agent helps keep the change (§7.24).

### What must stay true

- **The model never authors the record.** The agent drafts; the developer accepts, edits or aborts; only approved fields are written, each with its provenance (`user` / `generated` / `observed`). The server cannot verify the approval — stated as a known gap, with MCP elicitation as the candidate fix (stage c).
- **The commands work with Modelog uninstalled** (§7.24 constraint 2). No MCP server → `/done` runs all four steps, **prints** the closure, and says it was not saved. It never fails because Modelog is absent.
- **Invariant 6, rewritten:** append-only closures and markers; no update, no delete, no touch of measured data, no write outside the store.
- **Statistics come after saving**, so they cannot anchor the rating. **No number without a marker.**
- **Modelog's own context is budgeted, measured and shown** — tool definitions and server instructions are paid for in every session.
- **Modelog never runs either command automatically.** It may nudge only toward a change the developer marked, visibly and switchably (§7.24).

### Staged build — agreed sequence, 2026-11-08

| Stage | What | Done when |
| :-- | :--- | :--- |
| **0. Verify distribution** — *done 2026-11-07* | Results in PRD §7.24: **one `SKILL.md`, written to `~/.agents/skills/<name>/` (Codex, Copilot CLI, Copilot Chat) and `~/.claude/skills/<name>/` (Claude Code)**. Copilot Chat confirmed by the maintainer 2026-11-08 | Every row `[verified]` or `[fails]` |
| **a. Marker write** — *shipped in 0.8.0, 2026-11-08; Claude Code verified, Dashboard not yet seen live* | Developer-declared markers ("from today I end sessions before 120k context"): a new append-only MCP tool and table, alongside today's derived model-switch markers. **The maintainer has never used markers — test the existing read path (`modelog_get_markers`) first.** Includes the invariant-6 plumbing every later write reuses: a separate narrow write connection (reads stay `readOnly: true`), schema-version refusal as reads do now, `provenance` widened past the literal `"observed"` (`src/mcp/tools.ts:669`), server instructions at `src/mcp/server.ts:95` reworded, and `test/tools.test.ts:534` ("no tool is a write tool") replaced by a test that pins the **exact** write surface: two append tools, nothing else | A marker set from an agent is stored once, visible via `modelog_get_markers` and the Dashboard, and no tool can update or delete it |
| **b. Closure write + `/done`** | Closure table (`SCHEMA_VERSION` bump, currently 6): id, rating, work-done summary, open items carried forward, time frame (derived), per-field provenance, attested-at. Append tool. `/done` `SKILL.md` with the four steps, both modes (saved / printed-not-saved). Installer per `MCP.md` §7.3/§7.4 into the two stage-0 directories, with cleanup in `src/cleanup/`. Dashboard list + Markdown/JSON export | `/done` saves a closure end-to-end in Claude Code; aborting saves nothing; with MCP absent it prints and says "not saved" |
| **b2. `/handoff`** | Same closure path, plus a successor brief that keeps context short. Not yet specified beyond §7.24 — whether the brief is stored is still open (question 3 below) | Runs end-to-end in Claude Code, with and without Modelog |
| **c. Elicitation probe** | Stage-0-style: does each client support MCP elicitation, so the server itself asks for the rating and the OK? Leads from the shipped bundles, 2026-11-08 — **string presence, not invocation**: `elicitation/create` appears in Claude Code 2.1.319's binary, codex-cli 0.162.0's binary and VS Code 1.144's bundle; the Copilot CLI binary is packed and showed nothing either way | Each client `[verified]` / `[fails]` |
| **d. Verdicts + sufficiency** | Step 4's score against marked changes; plan step 2's sufficiency rule; `RESEARCH-signals.md`'s verified signal set. Until then step 4 shows facts and *"nothing to score"* | A marked change gets a before/after, or a stated "not enough data yet" |
| **e. Marker-driven nudges** | Active markers rendered into server instructions; token budget set and measured; Dashboard shows the exact text with an off switch | Instructions stay inside budget, appear in the next session, and their cost is visible |

### How `/done` asks its questions — two layers (maintainer request, 2026-11-08)

The maintainer wants `/done`'s questions shown in the client's own structured question UI, as Claude Code's `AskUserQuestion` renders them — standard, quick, one click. Every target has such a facility; found 2026-11-08:

| Client | Native question tool | Evidence |
| :--- | :--- | :--- |
| Claude Code | `AskUserQuestion` | **`[verified]`** — used in this repository's own sessions |
| Copilot Chat (VS Code) | `vscode_askQuestions` | Name in VS Code 1.144's bundle — `[untested]` |
| Copilot CLI | `ask_user` | 59 calls recorded in `~/.copilot` session logs — used in practice, not yet by a skill |
| Codex | `request_user_input` | Name in codex-cli 0.162.0's binary — `[untested]` |

1. **Layer 1, stage b — the native tool.** The skill says: *ask each step with your structured question tool if you have one, otherwise in plain text*. No tool names are hard-coded, so one `SKILL.md` serves all four, and it works with Modelog uninstalled. The agent relays the answers, so the approval gap in `MCP.md` §4.1 remains.
2. **Layer 2, after stage c — MCP elicitation, where verified.** The server itself shows the form and receives the answer; the model never handles the rating or the OK, which closes that gap. Only in saving mode (MCP is present by definition), falling back to layer 1 per client.

Design constraint to carry into stage b: question tools are option lists (`AskUserQuestion` takes 2–4 options), and **a 1–10 rating does not fit four buttons**. Candidates: free-text entry via the tool's *Other* field, or two taps (band, then value). Elicitation has a native `number` field with `minimum`/`maximum`, which is one more reason to want layer 2.

### Design questions still open

1. ~~How does the agent find the inbox?~~ **Moot, 2026-11-08** — the inbox was dropped for an append-only MCP write. (It was decided as `~/.modelog/inbox/` on 2026-11-07; recorded so the reversal is visible.)
2. **How does the agent identify its own session id?** (§7.22 Open.) Likely answer: it doesn't — the closure carries a timestamp and `cwd`, and the store joins to the most recent session active in that `cwd` at that time. Check against the real store. Needed by stage b.
3. **Is `/handoff`'s successor brief stored?** Open items are now stored with the closure (maintainer, 2026-11-08); whether the fuller brief joins them, or is only printed for pasting, is undecided. Needed by stage b2.
4. **Timing:** the `/done` turn itself may not have reached the log when statistics run (§7.22 Open). Matters for stage d.
5. **The abandoned-session path** (§7.19 says required). Out of scope for v1 — the closure schema must not make it impossible later (a retroactive closure is distinguishable by its attestation time).
7. **Retracting a marker** (found in the stage-a client test, 2026-11-08). Asked to delete a test marker, the agent correctly had no tool for it and offered to run a raw `DELETE` against the store instead. Invariant 6 puts deletion in the Dashboard, and no Dashboard delete exists yet. Candidates: a Dashboard delete (invariant 6 as written), and/or an append-only **retraction** record pointing at the original, which keeps the history honest. Needed before markers drive nudges (stage e), since a retracted change must stop being nudged.
8. **Copilot's auto model selection ("Fusion").** The maintainer ran Copilot with the router choosing the model, which explains the in-session `gpt-4o-mini` round-trips in the stage-a read. Turning the router on is a developer choice and could itself be an observed marker, with the router's per-turn picks excluded from switches the way subagent turns are. Whether Copilot's log records the selection mode is `[untested]`.
6. **The token budget's number.** Needs today's footprint measured first (five tool definitions plus instructions), then a ceiling. Stage e at the latest; measuring it is cheap and could happen in stage a.
   **Measured 2026-11-08, in characters** (`tools/list` JSON + `initialize` instructions, from the bundles over stdio): 0.7.0 = 5,434 + 363 = **5,797**; stage a = 7,474 + 427 = **7,901 (+36%)**. The append tool alone is 1,799 — as large as `list_sessions`. Tokens are **not** measured: no tokenizer was available, and how each client serialises tool definitions into context is unverified. At a typical 3–4 characters per token that is roughly 2,000–2,600 tokens — an estimate, labelled as one.

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
