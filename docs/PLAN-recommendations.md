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
- ~~**The commands work with Modelog uninstalled**~~ **Reversed 2026-11-09 (PRD §7.25):** without Modelog's MCP server, `/start`, `/handoff` and `/done` stop with one plain message that Modelog isn't running. Nothing is printed for pasting.
- **Invariant 6, rewritten:** append-only closures and markers; no update, no delete, no touch of measured data, no write outside the store.
- **Statistics come after saving**, so they cannot anchor the rating. **No number without a marker.**
- **Modelog's own context is budgeted, measured and shown** — tool definitions and server instructions are paid for in every session.
- **Modelog never runs either command automatically.** It may nudge only toward a change the developer marked, visibly and switchably (§7.24).

### Work sessions, and what was settled for 0.9.0 — 2026-11-09 (maintainer)

**Specified in `PRD.md` §7.25 (requirements W1–W10), with §6's definitions and dated corrections in §7.19, §7.22 and §7.24.** This block keeps only sequencing and the decisions that are about 0.9.0's build. In one line: a **chat session** is one conversation log; a **work session** is the developer's stretch of work, spanning chats joined by `/handoff` and closed by `/done`. `/handoff` takes no rating.

**Order, as the maintainer asked (2026-11-09): one requirement at a time.** PRD first (done 2026-11-09), then the record schema for W1–W4, then the rest. The Dashboard restructure (W10) and the open-work-session notice (W7) are required but not yet placed in a release.

**First live run, 2026-11-09 — `[verified]` in Claude Code 2.1.319 (VS Code, Remote-WSL).** A handoff was saved from a chat whose MCP server predated the tools (written by script through the real `saveWorkRecord` path, approved by the maintainer), then a new chat ran `/start` from `.claude/skills/`: the native question listed the waiting handoff plus *New work session*, the agent received the brief and open items, and the store holds a `continue` record with the new chat's id (observed from its server's environment), the same work session id, and `continues_from` set. No error. Claude Code's MCP `clientInfo` is **`claude-code` / `2.1.319`**, the same string as Modelog's `source`.

**Also settled, 2026-11-08/09:**

- **Chat identity (question 2):** the MCP server reads `CLAUDE_CODE_SESSION_ID` from its own environment (one server per chat in Claude Code, `[verified]` on four processes). The agent supplies no id. The link is resolved **when read**: the id counts only if that chat has a turn in the 10 minutes before the save; otherwise exactly one active chat in that folder; otherwise *chat not identified*. The candidate "timestamp + cwd" join was measured and rejected as the primary rule: Copilot has no `cwd` on 172 of 196 turns, and the store lagged so far that this very session had 0 turns in it.
- **Field caps:** summary ≤ 600 characters, ≤ 10 open items of ≤ 200, brief ≤ 1,500.
- **Time frame** is derived when displayed, not stored, because the store may not have the chat yet at save time.
- **The brief is returned as a typed field only**, never in notes or server instructions; a documented, narrow exception to `MCP.md` §4.2.
- **Installer:** `/start`, `/handoff` and `/done` are installed **together, as one bundle** (maintainer, 2026-11-09; this replaced a pick list). Work-session tracking is central to what Modelog measures, so a developer who doesn't want it doesn't want Modelog. **Installed by "Enable MCP Server"** (maintainer, 2026-11-09): its existing confirmation (`MCP.md` §7.3) shows the MCP entry and the three skill files together, then writes both. Enabling for Claude Code writes `~/.claude/skills/`; enabling for Copilot or Codex writes `~/.agents/skills/`. Disable and uninstall remove them. No separate install command. **Built 2026-11-09 (step 3), as `MCP.md` §7.3's addendum records:** a set-aside `SKILL.md` lives in `~/.modelog/backups/skills/<claude|agents>/<name>/`; Disable removes a root's skills only when no other registration uses that root (maintainer, 2026-11-09); the footprint gained `skills` and `copilotChatSkills`, and U2's fix (clearing one field no longer deletes the file) is done.
- **Uninstall removes Modelog's skills on every path**, silent hook included, edited or not; a `SKILL.md` that existed before install is restored from its backup. The "Uninstalling Modelog" section below (0.10.0) is revised to match.

### Staged build — agreed sequence, 2026-11-08

| Stage | What | Done when |
| :-- | :--- | :--- |
| **0. Verify distribution** — *done 2026-11-07* | Results in PRD §7.24: **one `SKILL.md`, written to `~/.agents/skills/<name>/` (Codex, Copilot CLI, Copilot Chat) and `~/.claude/skills/<name>/` (Claude Code)**. Copilot Chat confirmed by the maintainer 2026-11-08 | Every row `[verified]` or `[fails]` |
| **a. Marker write** — *shipped in 0.8.0, 2026-11-08; Claude Code verified, Dashboard not yet seen live* | Developer-declared markers ("from today I end sessions before 120k context"): a new append-only MCP tool and table, alongside today's derived model-switch markers. **The maintainer has never used markers — test the existing read path (`modelog_get_markers`) first.** Includes the invariant-6 plumbing every later write reuses: a separate narrow write connection (reads stay `readOnly: true`), schema-version refusal as reads do now, `provenance` widened past the literal `"observed"` (`src/mcp/tools.ts:669`), server instructions at `src/mcp/server.ts:95` reworded, and `test/tools.test.ts:534` ("no tool is a write tool") replaced by a test that pins the **exact** write surface: two append tools, nothing else | A marker set from an agent is stored once, visible via `modelog_get_markers` and the Dashboard, and no tool can update or delete it |
| **b. Closure write + `/done`** | Closure table (`SCHEMA_VERSION` bump, currently 6): id, rating, work-done summary, open items carried forward, time frame (derived), per-field provenance, attested-at. Append tool. `/done` `SKILL.md` with the four steps, both modes (saved / printed-not-saved). Installer per `MCP.md` §7.3/§7.4 into the two stage-0 directories, with cleanup in `src/cleanup/`. Dashboard list + Markdown/JSON export | `/done` saves a closure end-to-end in Claude Code; aborting saves nothing; with MCP absent it prints and says "not saved" |
| **b2. `/handoff`** — *target 0.9.0 together with b (maintainer, 2026-11-08)* | Same closure path, plus a successor brief that keeps context short. **The brief is stored**: one more field of the closure, written by the same append tool and read back by the same closure read tool that open items need (question 3, resolved). Without MCP it is printed and marked "not saved", exactly as `/done` behaves | Runs end-to-end in Claude Code, with and without Modelog |
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

Design constraint to carry into stage b: question tools are option lists (`AskUserQuestion` takes 2–4 options), and **a 1–10 rating does not fit four buttons**. Candidates: free-text entry via the tool's *Other* field, or two taps (band, then value). **Resolved 2026-11-09 by the maintainer: plain text.** `/done` asks *"Rate this work session from 1 (very poor) to 10 (very good)"* and the developer types the number; the question tool is used where the options fit (Save · Edit · Abort, `/start`'s list). Elicitation has a native `number` field with `minimum`/`maximum`, which is one more reason to want layer 2.

### Design questions still open

1. ~~How does the agent find the inbox?~~ **Moot, 2026-11-08** — the inbox was dropped for an append-only MCP write. (It was decided as `~/.modelog/inbox/` on 2026-11-07; recorded so the reversal is visible.)
2. *Resolved 2026-11-09: server-observed id, linked when read — see "Work sessions" above.* **How does the agent identify its own session id?** (§7.22 Open.) Likely answer: it doesn't — the closure carries a timestamp and `cwd`, and the store joins to the most recent session active in that `cwd` at that time. Check against the real store. Needed by stage b.
3. ~~**Is `/handoff`'s successor brief stored?**~~ **Resolved 2026-11-08 by the maintainer: yes, by the same method as open items.** It is a field of the closure: appended through MCP, developer-approved, with its own provenance (`generated`, unless the developer rewrites it), and read by the next session through the closure read tool stage b needs anyway, so it needs no tool of its own. "Modelog-dependent" means Modelog is needed to **save** it, as with `/done`. Without MCP, `/handoff` still writes the brief, prints it for pasting, and says "not saved", which keeps §7.24 constraint 2. **Consequence:** it is the third content-adjacent field (after the summary and open items) and the first that is mostly generated. It gets the same terms: approved by the developer, local only, off the machine only through §7.11's sync toggle. PRD §7.24's open item on whether the brief is content needs updating to match.
4. **Timing:** the `/done` turn itself may not have reached the log when statistics run (§7.22 Open). Matters for stage d.
5. **The abandoned-session path** (§7.19 says required). Out of scope for v1 — the closure schema must not make it impossible later (a retroactive closure is distinguishable by its attestation time).
7. ~~**Retracting a marker**~~ **Resolved 2026-11-08, shipped in 0.8.0:** a Dashboard **Remove** that confirms in a native modal and then hard-deletes. **No agent delete tool**, after the arguments were weighed. Against: (1) the server cannot verify approval (`MCP.md` §4.1), and the cost of that gap is asymmetric, since a wrong append can be undone in the Dashboard but a wrong delete destroys data no log can rebuild; (2) a prompt-injected agent could erase markers, including the ones behind unflattering verdicts, which defeats §7.23's "it did nothing must be reportable"; (3) it would widen the authorizer to DELETE; (4) it would add another tool definition to every session's context. For: convenience, and stopping agents from offering raw SQL. The tool description now points agents to the Dashboard, which handles the second point without the tool. Still open: an append-only *retraction* record, if history ever needs to show that a change was abandoned rather than never made. The original finding: (found in the stage-a client test, 2026-11-08). Asked to delete a test marker, the agent correctly had no tool for it and offered to run a raw `DELETE` against the store instead. Invariant 6 puts deletion in the Dashboard, and no Dashboard delete exists yet. Candidates: a Dashboard delete (invariant 6 as written), and/or an append-only **retraction** record pointing at the original, which keeps the history honest. Needed before markers drive nudges (stage e), since a retracted change must stop being nudged.
8. **Copilot's auto model selection ("Fusion").** The maintainer ran Copilot with the router choosing the model, which explains the in-session `gpt-4o-mini` round-trips in the stage-a read. Turning the router on is a developer choice and could itself be an observed marker, with the router's per-turn picks excluded from switches the way subagent turns are. Whether Copilot's log records the selection mode is `[untested]`.
6. **The token budget's number.** Needs today's footprint measured first (five tool definitions plus instructions), then a ceiling. Stage e at the latest; measuring it is cheap and could happen in stage a.
   **Measured 2026-11-08, in characters** (stage a final, with the Dashboard-removal sentence: 7,532 + 427 = **7,959**) (`tools/list` JSON + `initialize` instructions, from the bundles over stdio): 0.7.0 = 5,434 + 363 = **5,797**; stage a = 7,474 + 427 = **7,901 (+36%)**. The append tool alone is 1,799 — as large as `list_sessions`. Tokens are **not** measured: no tokenizer was available, and how each client serialises tool definitions into context is unverified. At a typical 3–4 characters per token that is roughly 2,000–2,600 tokens — an estimate, labelled as one.
   **Re-measured 2026-11-09 for 0.9.0, same method (it reproduces 0.8.0's 7,959 exactly):** 9,628 + 460 = **10,088 (+2,129, +27%)**. `modelog_save_work_record` 1,612, `modelog_get_work_sessions` 482, instructions +33. The steps live in the three `SKILL.md` files (~8,000 characters together), which cost context only when a command is run.

### Uninstalling Modelog — decided 2026-11-08 — target 0.10.0, after 0.9.0

**Decided by the maintainer, 2026-11-08.** The options this replaced are kept at the end of this entry so the reasoning stays visible.

1. **Clicking Uninstall keeps the developer's records.** Markers and every work-session record (§7.25: start, handoff and closure, with their summaries, open items and briefs) survive. Measured data (turns) does not need to, because the logs rebuild it. *Why:* no log can rebuild the records, and invariant 6 makes deletion the developer's act; VS Code's `rm` of the storage directory is a deletion nobody chose. A clean uninstall stays available, as a choice, through `Remove Modelog's Changes` (stage U6).
2. **The silent hook removes Modelog's skills, edited or not.** *Revised 2026-11-09 by the maintainer; this replaced "only if unmodified, an edited copy is kept".* At install, Modelog records each skill file's path and SHA-256. The hook deletes every recorded file, then its directory only if empty; an edited one is deleted too, and the edit is logged. A `SKILL.md` that existed before install is restored from its install-time backup. *Why:* no Modelog skill should be left after an uninstall, and an edited copy still calls Modelog tools that no longer exist. The hash still matters, to log the edit and to restore a pre-existing file.
3. **The hook copies the records out**, as its first act, to `~/.modelog/records/`. A reinstall imports them. A prompted `Export My Records` command ships too, for a copy the developer directs and can see being made. **Option 3 (a separate `records.db` for good) is rejected for 0.10.0**, for the reasons below.
4. **No interim release.** 0.9.0 is being built in another session; the uninstall work follows it as 0.10.0 and is built against 0.9.0's actual code (stage U0). **Accepted exposure:** uninstalling 0.8.0 or 0.9.0 deletes records with no copy. VS Code runs the hook of the *version being removed*, so the protection starts only for developers who have run 0.10.0 before they uninstall. *Not decided, offered to the 0.9.0 session:* one README line saying that uninstalling deletes marked changes and closures costs nothing and covers the gap honestly.

**Verified before deciding, 2026-11-08**, against VS Code Server **1.144.0** (commit `2c33b50`, `out/server-main.js`) in this machine's Remote-WSL window. Details are in `INSTALL-ux.md` §1.1.

- **The deletion is unchanged since 1.105.** `postUninstall` runs the hook, then `rm(defaultProfile.globalStorageHome/<id>)` **in a separate `try`**. The `rm` happens even when the hook failed or was killed at 5 s, so those 5 s are the whole window for saving anything.
- **The hook runs at startup, not at the click.** The extension scanner's `cleanUp()` calls `deleteExtensionsMarkedForRemoval()`. It skips the hook if any other version of the extension is still installed, so **an update never runs it**.
- **In Remote-WSL, everything happens on the WSL side.** The hook, the `rm` and the store (`~/.vscode-server/data/User/globalStorage/modelog.modelog/`) all live in the server. `homedir()` in the hook is the WSL home, so `~/.modelog/`, `~/.claude/skills/` and `~/.agents/skills/` are on the same side as the store. "The restart after the uninstall" is the next start of the **WSL server**, which a window reload may not cause. That last point is read from the code, not observed.
- **The hook has never been observed running on this machine.** No server log since 2026-10-07 contains `Running post uninstall script`. Everything known about it comes from reading code.
- **One machine can hold two independent installs.** This one has Modelog 0.6.0/0.7.0 in Windows-side VS Code, with its own `modelog.db`, beside the WSL install. Each side uninstalls, exports and imports on its own.
- **The hook can read the store.** The server's Node is 24.22.1, and `node:sqlite` opens `modelog.db` read-only from it. Windows desktop, where the hook runs on Electron's Node, is `[untested]`.
- **The storage path is the default profile's.** Whether a store opened under a non-default profile lives elsewhere, and so survives or escapes the `rm`, is `[untested]`.

**Why not move the records out for good (option 3):**

- The MCP server finds the store only through `MODELOG_DB` in each client's registration (`src/mcp/registration.ts:18`). A second file means a second variable in every existing Claude Code, Copilot CLI and Codex entry. That is either a rewrite of foreign configs on upgrade, each a confirmed write under `MCP.md` §7.3, or a registration that silently cannot see records until the developer re-registers.
- Two schema versions to refuse independently, the append connection split across two files, and two files to keep consistent.
- It does not reach further than option 2. It still dies with a Coder workspace (§7.17: no location outlives it), and it is still per side on a machine with Windows and WSL installs. Both are §7.14 sync's job. Revisit only if sync lands and wants a store of its own.

**What this does not fix**, so it is not mistaken for solved:

- **Ephemeral workspaces.** Destroying a container never runs the hook (§7.14), and `~/.modelog/` dies with it. Sync remains the only answer.
- **A copy-out that fails or is killed.** The `rm` follows anyway, and with no UI nothing can tell the developer; it is logged only. The prompted export is the one copy the developer can see.
- **Cross-side.** Records exported on the WSL side are imported only by a reinstall on the WSL side.

#### Staged build — 0.10.0

| Stage | What | Done when |
| :-- | :--- | :--- |
| **U0. Read 0.9.0 as landed; observe the hook once** | Replace planned facts with actual ones: the skill install paths and file list, **where the installer keeps the backup of a pre-existing `SKILL.md`**, every record kind 0.9.0 stores (at least start, handoff and closure, §7.25 W1–W4, beside markers) with its table, id, cross-record references and identity fields (W9), `SCHEMA_VERSION`, whatever stage b put in `src/cleanup/` for skills, and any footprint changes. Then **watch the existing hook run end to end for the first time**: install a `.vsix` in WSL, uninstall, stop the WSL server (confirm whether a window reload is enough), and read `remoteagent.log` for `Running post uninstall script`, the `modelog:` lines, and the storage directory's absence | This table is corrected to the real paths, and `INSTALL-ux.md` §1.1's hook claims move from code reading to observed |
| **U1. Records export, as data** | A pure, `vscode`-free function from store to `{ format: "modelog-records", version: 1, schemaVersion, exportedAt, records: [{ kind, ... }] }`. **One kind-tagged list, not one array per kind:** 0.9.0 has at least four kinds (marker, start, handoff, closure; §7.25), and a later kind must not need a format bump. Every record keeps, **exactly as stored**: its id, the ids it references (a handoff names the handoff it continued from, a closure names its work session), its observed chat id (resolved when read, never at export), its workspace or install identity (W9), provenance per field, and its timestamps. Turns excluded. The reverse parses and validates. It refuses an unknown `format`, a newer `version` or an unknown `kind` with a stated reason, the way reads refuse a newer schema, and never drops a record silently. `Modelog: Export My Records` writes it through a save dialog, plus stage b's Markdown view | Round trip: export, then parse, gives identical records, references and identities included. A newer version and an unknown kind are each refused visibly. The `message.content` test (invariant 1) is extended to the exporter |
| **U2. Footprint v2** | `~/.modelog/uninstall.json` gains `stores: { "<extensions dir>": "<globalStorage dir>" }`, written on every activation, and `skills: [{ path, sha256, backup? }]`, written by the installer, where `backup` is the saved copy of a `SKILL.md` that existed before install (point 2). It is keyed by extensions directory because the hook knows only its own location (`dist/uninstall.js`, two levels up), and one home can hold several installs (VS Code, Insiders, a fork) sharing one `~/.modelog/`. **Fix on the way:** clearing Copilot logging currently deletes the whole file (`recordCopilotLogging` → `removeFootprint`, `src/cleanup/footprint.ts:80`), which would drop the store and skill entries. Removal must become "no field left". Write atomically (`writeFileAtomically`), because the hook may read while a window writes | Tests: two installs' entries coexist; clearing Copilot logging keeps the rest; an unknown version still reads as "nothing recorded" |
| **U3. Hook copy-out** | The first step of `src/uninstall.ts`, before `planCleanup` and any spawn, in its own `try`. It looks its store up in the footprint and **never guesses a path**. If the store is missing, it logs `store location unknown, records not copied`. Otherwise it opens `modelog.db` read-only with `node:sqlite`. With zero records it writes nothing. With records, it writes `~/.modelog/records/<UTC timestamp>.json` via a temp file and rename, mode `0600`, then drops its own `stores` entry | Timed inside the 5 s budget on a store with real records, with the time logged. A kill at any point leaves either the complete file or none (kill-injection test). An empty store leaves no file |
| **U4. Import on reinstall** | On activation, read `~/.modelog/records/*.json` and append every record whose id is not in the store, through the same validation as the MCP append tools. **Nothing is restamped**: ids, references, provenance, timestamps and the original workspace or install identity are kept. Restamping identity would make sync count the records twice (W9), and a new id would break every handoff chain. **One transaction per file, in dependency order** (start, then handoffs in chain order, then closure; markers anywhere). A reference is checked against the store and the file together, since the append tools' check ("the id exists") would otherwise reject a handoff imported before its predecessor. A chat whose log has since gone resolves to *chat not identified* when read (§7.25), which is a stated gap, not an import error. One notification, never a question (maintainer, 2026-11-08), counting each kind: *"Restored 3 marked changes and 5 work sessions (2 still open) from a previous install"*, with Show. **The files are never deleted** (invariant 6). Matching by id makes re-reading on every activation harmless. A refused file or record (newer format, unknown kind, dangling reference) is reported, never skipped silently | Uninstall then reinstall on the same side restores every record exactly once, and a work session chained by two handoffs reads back as one work session with its chats linked. A second activation restores nothing. A newer-format file produces a visible refusal |
| **U5. Skills in the hook and the command** | For each footprint entry: delete the file and `rmdir` its directory (never recursive, as `removeFootprint` already does); if the hash differs, log `edited since install, removed`; if a pre-install backup exists, restore it; if the file is missing, do nothing. All skills are `recommended: true`, so the hook and the command's default agree (revised 2026-11-09). Extends or replaces whatever 0.9.0 stage b put in `src/cleanup/` | Tests cover all four cases (unedited, edited, pre-existing restored, missing) in both directories. Other tools' entries in `~/.agents/skills/` stay untouched |
| **U6. The clean path in the command** | `Remove Modelog's Changes` makes the record choice explicit. (a) The existing `collected-data` item **has had wrong text since 0.8.0**: it says "usage history", but deleting `modelog.db` deletes the markers too, and from 0.9.0 every work-session record (`src/cleanup/plan.ts:268`). It must name the record kinds, say they cannot be rebuilt, and offer Export first. (b) A new item: *"Delete the record copies in `~/.modelog/records/`"*. Both stay unticked, and the hook never runs them. For a clean uninstall, the developer ticks both and then uninstalls. With no records left, the hook writes nothing | With both ticked, an uninstall leaves nothing of Modelog's in `$HOME` (checked by listing). Unticked, the records survive |
| **U7. Documentation and end to end** | A README "Uninstalling" section stating exactly what survives and where; CHANGELOG; `INSTALL-ux.md` §1.1 and §5; the header comment in `plan.ts`, which still cites 1.105 | Observed once in Remote-WSL: records plus one edited skill → uninstall → server restart → export present, all skills gone, the edited one included (revised 2026-11-09), storage gone, MCP entries gone → reinstall → records restored |

Order: U0 first. U1 and U2 are independent. U3 needs both, U4 and U6 need U1, and U5 needs U2. U7 comes last.

**Open, to settle during the build:**

- ~~**Should the import ask first, rather than notify?**~~ **Resolved 2026-11-08 by the maintainer: notify.** If there is something to import, it is there on purpose: the developer chose to keep their records and only wanted a fresh installation, plausibly to fix a problem. Asking would question a decision already made. U4 is built as written.
- **Restored open work sessions meet W7 at once.** A start with no closure is restored as an open work session. If the uninstall was more than 2 days ago, W7's notice fires on the first activation after the import, right beside the import's own notification. Candidates: let it fire (they are open, and W8's "lost" label applies), or fold the count into the import notification and suppress W7 for that one activation. Decide in U4, after W7 is built.
- **Export files accumulate**, one per uninstall, and nothing deletes them. That is fine at expected volumes. U6's item is the way to remove them.
- **Content-adjacent fields now exist in a plain file in `$HOME`.** The closure summary, open items and brief sit in `~/.modelog/records/`, readable by the same user who can already read the store, at mode `0600`. That is no different in kind from the store itself. But §7.11's sync must never use that directory as a source, and this is recorded there.

**The options as they stood before the decision (2026-11-08), for the record.** (1) A prompted export only: simple, but someone who just clicks Uninstall never sees it. (2) The hook copies the records out: works on the silent path, under a 5 s kill timer, and leaves files behind. (3) Move the records out of `globalStorage` for good: the most robust against uninstall, but a second database. The table that framed them: config entries are removed in every case (a dangling MCP entry breaks three assistants every session, as found in 0.6.0); skills were open; turns are rebuildable apart from sessions whose logs are gone (24%, `RESEARCH-signals.md`); records must survive.

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

Two constraints from §7.24 that shape the artifact itself: the commands must **work with Modelog uninstalled** *(reversed 2026-11-09, see PRD §7.25)*, and Modelog must never perform a handoff automatically.

---

## Realistic scope

Step 1 is a session on its own and produces no code. Steps 1 and 2 together are the honest definition of "ready to build".

~~**Do not start step 3 before step 1 has rejected at least one candidate signal.**~~ Satisfied: four rejected, with arithmetic.

**New constraint from step 1, for step 3.** The oversight signal (longest run of AI turns without human input) needs a `capture.ts` bump and **cannot be backfilled** — 24% of sessions already have no surviving source log, and that share only grows. If the MCP surface is designed before ingest records the prompt boundary, every session until that release permanently lacks the signal with the widest dispersion in the set.
