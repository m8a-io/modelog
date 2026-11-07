# Next Session — the recommendation loop (PRD §7.23 / §7.24)

**Status:** specification written 2026-11-07. **No code.** Nothing in §7.23 or §7.24 is implemented, scoped, or estimated.

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

**Also still open, never specified:** a small GitHub issue the maintainer wanted to file. Ask.

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

### 2. The sufficiency rule — §11 row 29

Needs three things that do not exist yet: the minimum effect size worth claiming, the real dispersion of each signal across the author's own sessions, and a rate estimate stable enough to turn "40 more sessions" into "about 9 days".

The store holds ~1,800 real turns to measure dispersion against, so this is an **analysis task before it is an implementation one**. Getting it wrong is costly in both directions: too eager and Modelog calls noise a habit; too cautious and a new user is told "not yet" until she uninstalls.

### 3. The MCP surface

Only after 1 and 2.

§7.22 already specifies `modelog_session_review({ sessionId })` as read-only; §7.23 needs a range-scoped counterpart. **Neither may break invariant 6** — the server has no write tools, and `openReadOnly()` enforces that at the database rather than by convention.

So the write path for recommendation markers is **not** an MCP tool. §7.22 already settled the pattern: a local **inbox file** that the extension ingests. Reuse it; do not reopen it.

### 4. `/handoff` and `/done` — verify before designing

Every row in §7.24's distribution table except project-scoped Claude Code skills is `[untested]`. Specifically unconfirmed on this machine as of 2026-11-07: the user-scope `~/.claude/commands` format (directory does not exist), Copilot's `.github/prompts/*.prompt.md`, and whether Codex has a prompts directory at all (`~/.codex` exists, with no `prompts`). `codex` and `copilot` are on `PATH`; `claude` is not.

The precedent to copy is `MCP.md` §7.4: show the exact file and the exact content, confirm, back up, write, and never claim a success that was not verified.

Two constraints from §7.24 that shape the artifact itself: the commands must **work with Modelog uninstalled**, and Modelog must never perform a handoff automatically.

---

## Realistic scope

Step 1 is a session on its own and produces no code. Steps 1 and 2 together are the honest definition of "ready to build".

**Do not start step 3 before step 1 has rejected at least one candidate signal.** If nothing was rejected, the arithmetic was not actually run.
