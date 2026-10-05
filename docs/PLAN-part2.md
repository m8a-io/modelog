# Next Session — Part 2, Phase 3: Registration

**Goal:** Modelog registers its MCP server with both clients that can consume it — VS Code's own MCP client via the provider API, and Claude Code via a config file — without either path claiming a success it cannot verify.

**Spec:** `MCP.md` for the server, **`docs/INSTALL-ux.md` §2 for this phase**. Read INSTALL-ux first: registration is two targets with two different mechanisms, and only one of them writes a file. This document is sequencing and session context, not requirements — where it and the spec disagree, the spec wins.

**Phase 2 is complete and Phase 4 has run.** Everything below §2.0 is the record of how, kept because the findings constrain Phase 3. Skip to [Phase 3](#phase-3--registration) to start work.

---

## Before you start

### Do these two things *before* opening the session

**1. Open VS Code once, so the store migrates.** `SCHEMA_VERSION` is now 3 (`capture_version`, issue #7) and the real store on this machine was last written at 2. A read-only connection cannot migrate it, so until the extension host opens it, **every tool call returns `schema-mismatch` with `data: null`** — correct behaviour, alarming if unexpected. Opening VS Code with this repo as the workspace root is enough; `migrate()` runs on store open and then drops all cursors, forcing one full re-read.

While it re-ingests, there is a falsifiable prediction to check. Issue #7's fix says the store should report **146** turns with an uncaptured `entrypoint` — not 346, and not all of them:

```bash
node --input-type=module -e "
import { openReadOnly, readTurns } from './src/mcp/readOnlyStore.ts';
import { uncapturedFields } from './src/ingest/capture.ts';
const r = await openReadOnly(process.env.HOME + '/.vscode-server/data/User/globalStorage/modelog.modelog/modelog.db');
const t = readTurns(r.db);
console.log(r.status, t.length, t.filter((x) => uncapturedFields(x).includes('entrypoint')).length);
"   # expect: ok 1785+ 146
```

If that prints 346, the re-ingest has run but the value-aware predicate regressed. If it prints a number near the total, the re-ingest has not finished.

**2. Plant an unapproved server in `.mcp.json`, to settle known unknown #5 for free.** It needs one fresh session with an unapproved entry *present at launch*, and the next session is exactly that. Add a second entry beside `modelog` before you start:

```json
"probe": { "command": "node", "args": ["<repo>/scripts/probe-server.mjs"] }
```

Then note whether launching prompts for approval and what the prompt says, and revert it. This is task 3.0 and it is the only thing in this plan that cannot be done later.

### Then

```bash
nvm use 24 && npm install && npm run check    # expect: 164 tests, 0 failures
bash scripts/mcp-handshake.sh                 # expect: 5 tools, 3 ok envelopes, 1 deliberate error
```

The handshake script calls tools as well as listing them, including one
deliberately invalid call (`id=6`) that **must** come back as an error rather
than an empty envelope. If that one returns a `status`, argument validation
has regressed. It defaults to the real store, so it reports `schema-mismatch`
rather than `ok` until step 1 is done; pass a path to use a different store.

`npm run check` does **not** build; `pretest` does, so `npm test` is always testing a fresh bundle.

---

## Status — what is already done

| Item | State |
| :--- | :--- |
| Phase 0.2 — capture `entrypoint`, `isSidechain` | **Done** (`12a8538`) |
| Phase 0.2 — `entrypoint` segmentation in the dashboard | **Not done.** Deferred: all local data is `claude-vscode`, so there is nothing to segment until the CLI is used. It gets its first real surface as a tool *filter* in this phase instead. |
| Phase 0.1 — session history table | **Not done.** Pure Part 1 assembly, blocks nothing here. |
| Phase 1 — MCP skeleton, stdio, read-only store | **Done** (`962d2ce`) |
| Phase 2.1 — the envelope | **Done** (`dfb6b5d`) |
| Phase 2.2 — `get_definitions` | **Done** — see 2.2 below |
| Phase 2.3 — the query tools | **Done** — see 2.3 below |
| Phase 2.4 — wiring onto the `Server` | **Done** — see 2.4 below |
| Phase 4 — the actual test | **Done 2026-10-04** — see Phase 4 below. Known unknown #2 settled; four defects found |
| Issue [#4](https://github.com/m8a-io/modelog/issues/4) — range clipping reported as session fact | **Fixed** (`4a85d70`) |
| Issue [#7](https://github.com/m8a-io/modelog/issues/7) — uncaptured fields read as empty | **Fixed** (`508b0de`, `53a3fb9`) |
| Issues [#5](https://github.com/m8a-io/modelog/issues/5), [#6](https://github.com/m8a-io/modelog/issues/6) — token counts, dispersion | **Open.** Both are Phase 4 output, neither blocks Phase 3 |
| Phase 3 — registration | **Next.** Read `docs/INSTALL-ux.md` first — it is two targets, not one |

**What exists to build on:**

- `src/mcp/server.ts` — low-level `Server` (not `McpServer`), stdio, `tools/list` returning `[]`.
- `src/mcp/readOnlyStore.ts` — `openReadOnly(path)` returning `{status, db, note, foundSchemaVersion, expectedSchemaVersion}`, and `readTurns(db)` returning `Turn[]`. All three envelope statuses are already produced here.
- `src/metrics/cost.ts`, `src/metrics/aggregate.ts` — import these directly. Do **not** reuse `ModelogService` (it orchestrates ingest and owns a writable store) and do **not** restate the maths.
- `scripts/mcp-handshake.sh` — client-free stdio check.
- `.mcp.json` (gitignored) — project-scoped registration for testing against real Claude Code.

---

## What changed since the plan was written

Five findings from the 2026-09-27 session that Phase 2 has to absorb. All are recorded in `PRD.md`; they are repeated here because they change what the tools must say.

1. **`get_definitions` has more to explain than "what a turn is".** In this dataset **100% of Haiku traffic is subagent (`isSidechain`) calls and 100% of sidechain calls are Haiku.** An agent told only "these are the models you used" will conclude you chose Haiku for work. Sidechain turns are also still counted in turns and cost — a deliberate, deferred decision (PRD §11 open question 23), so the definitions tool has to state it plainly rather than paper over it.

2. **Money is an integer *plus a unit*, not micro-dollars.** PRD §8.2 was restated: `{ amount, unit }`, units never mixed, conversion explicit and at the presentation boundary. `MCP.md` §8.7 still says "integer micro-dollars and a formatted string" — **implement it as `{ amount, unit, formatted }`** so the envelope does not have to change when a second unit exists, and so an agent cannot add two units by accident. Flag the §8.7 wording as needing an update.

3. **Cost can be `null` for a second reason.** An unknown *modifier* now yields `null` as well as an unknown *model* (`54c8f43`). `unpricedTurns` therefore no longer means "unknown model"; the definitions text and the `notes` array must say which cause applies.

4. **Three billing realities, not two.** Claude Code on API credits is cash; on a subscription it is a shadow price; Copilot Pro is measured draw against a prepaid allowance. `detectBilling` returns a two-value mode and has no slot for the third. Not this phase's problem, but `get_definitions` must not claim a figure is a bill when it is not — locally `mode=api, rawType=prepaid`, i.e. real money.

5. **The store outlives the logs.** 146 of 1,141 stored turns come from a deleted project directory, and they carry permanent nulls because a migration can only backfill rows whose source file survives (DESIGN §6). `get_definitions` should state the store is a durable superset of the logs — it is a feature, and it explains nulls an agent would otherwise find odd.

---

## Phase 2 tasks

### 2.0 Answer known unknown #1 first — it is 2 minutes and it shapes Phase 3

Does Claude Code pick up a newly registered MCP server **without a restart**? The answer decides whether `Modelog: Enable MCP Server` (Phase 3) can report success immediately or has to tell the user to reload. Finding out now costs nothing; finding out while writing a config writer costs a rewrite.

Everything needed is already in place. `.mcp.json` sits in the repo root — **gitignored**, because it holds absolute home paths and this repo is public. If it is missing (fresh clone, or another machine), recreate it with the real store path:

```json
{
  "mcpServers": {
    "modelog": {
      "command": "node",
      "args": ["<repo>/dist/mcp-server.mjs"],
      "env": { "MODELOG_DB": "<globalStorage>/modelog.modelog/modelog.db" }
    }
  }
}
```

On this machine `<globalStorage>` is `~/.vscode-server/data/User/globalStorage` (Remote-WSL; a native install differs). Run `npm run build` first — the bundle must exist and be current.

**Steps.** Confirm `bash scripts/mcp-handshake.sh` still answers, then start a Claude Code session in this repo and run `/mcp`.

**Record four things**, because each feeds a Phase 3 decision:

1. **Did `modelog` appear without reloading the window?** The answer to the unknown.
2. **Was there an approval prompt, and what did it say?** `MCP.md` §7.3 requires Modelog to show the exact JSON and target file before writing. If Claude Code already prompts for a project-scoped `.mcp.json`, that is a precedent worth matching rather than inventing a different one.
3. **Does it report connected with 0 tools, or treat a toolless server as an error?** If zero tools is an error state, 2.2 has to land before any real client test is meaningful.
4. **Whether `node` resolved.** This is known unknown #4 answered for free — the client spawns `node` from its own environment, not the shell's.

**If it fails,** the likely causes in order: a stale or missing `dist/mcp-server.mjs`; a wrong `MODELOG_DB` path (the server still starts and reports `no-data` on stderr, so check stderr before assuming the transport broke); `node` not on the client's `PATH`.

**Done when:** all four answers are written into this document, replacing the known-unknowns rows they settle.

---

#### 2.0 — Answers (measured 2026-09-28, Claude Code extension `2.1.251`, Remote-WSL)

Method: rather than reading `/mcp` output, a throwaway probe MCP server (one tool, `probe_heartbeat`, dependency-free raw JSON-RPC) was registered in `.mcp.json` **while a session was already running**, and the process table plus a spawn log were watched. Reverted afterwards.

**1. Does a running session pick up a newly registered server? No.**

`.mcp.json` gained a second server at 05:56:41; the client (pid 1064) had been running since the previous 14:38:52. The probe was never spawned — no process, nothing in its spawn log, and its tool never entered the model's tool list. Config is read **at session start only**.

The complementary half is also confirmed: `modelog` itself was spawned at 14:38:52, the same second as the client, i.e. registration present at launch *is* honoured.

> **Phase 3 consequence.** `Modelog: Enable MCP Server` **cannot report success immediately.** After writing the config it must tell the user the server appears in their *next* session. Do not write a "connected" affirmation, and do not poll for the server to appear — it will not.

**2. Approval prompt — still open.** Not settled: because the config was never re-read, no prompt could fire. Answering it needs one fresh session with an unapproved server entry present at launch. Left for whenever that is convenient; it only affects whether `MCP.md` §7.3's confirmation UI matches an existing precedent or invents one.

**3. A toolless server reports connected, not an error.** The running `modelog` returns `{"tools": []}` and is a healthy connected server — its `instructions` string is delivered into the model's context. **2.2 does not have to land before client testing is meaningful.**

**4. `node` resolved — but the result argues *for* Phase 3's check, not against it.**

The client spawned `/home/scott/.nvm/versions/node/v24.21.0/bin/node`, resolved from the `PATH` inherited by `…/anthropic.claude-code-2.1.251-linux-x64/resources/native-binary/claude`, which contains `/home/scott/.nvm/versions/node/v24.21.0/bin`. `MODELOG_DB` passed through from the `env` block intact.

So the MCP server is spawned by **the extension's own binary with the extension's environment** — and here that environment has nvm on `PATH` only because this VS Code server was launched from a shell where nvm had initialised. A GUI-launched native install, or a later `nvm alias default`, resolves differently or not at all. Read this as *"it happened to work on one machine"*, not *"node is reliably on `PATH`"*; the Phase 3 `node` check stays load-bearing.

### 2.1 The envelope — do this first, once

Implement `MCP.md` §8.7 in one module and route **every** tool through it:

```ts
{ status: "ok" | "no-data" | "schema-mismatch",
  range: { from: string, to: string },
  data: <tool-specific>,
  notes: string[] }
```

- **Money is `{ amount: integer, unit: "usd_micro", formatted: string }`** — see finding 2. Never a bare number, never a float.
- **Range parsing is shared**: `{ days? }` or `{ from?, to? }`, omitted means last 30 days. One helper, one set of tests. Reject `days` together with `from`/`to` rather than silently preferring one.
- **`notes` is where honesty lives.** Populate for: unpriced turns present (and why), billing mode caveat, rate table older than 90 days, sidechain turns included in the figures, a store whose schema version differs.
- **Statuses come from `openReadOnly`**, which already produces all three. A tool must never turn `no-data` into zeros.

**Done when:** a single helper produces all three statuses and every tool returns the same shape, asserted by tests.

### 2.2 `modelog_get_definitions` — build this second, before any query tool

The plan's original reasoning still holds: building it first forces the semantics to be explicit before anything depends on them, and it is the tool that prevents confidently-wrong answers.

Must cover, at minimum:

- **A turn is not an inference call.** `usage.iterations[]` lists the underlying calls; state which the counts use.
- **`<synthetic>` records are excluded** — locally generated, all-zero usage.
- **Sidechain turns** — what they are, that they are *included* in current figures, and that in this dataset they are entirely one model. Finding 1.
- **Cost method** — four token classes, cache ratios on base input, cache-read being per-model, the rate table's `effective_date`.
- **Why a cost may be `null`** — unknown model *or* unknown modifier. Finding 3.
- **Billing mode and its caveat text** — from `detectBilling`/`billingCopy`. Finding 4.
- **Schema version**, and the store's first and last timestamps.
- **That the store is a durable superset of the logs.** Finding 5.

**Its description text matters as much as its output.** Budget real thought for the wording — it has to make an agent call this before reasoning. Test the *content*, not just the shape: assert the response mentions sidechain handling and the null-cost causes, so the explanation cannot silently regress.

#### 2.2 — Done 2026-10-04

`src/mcp/definitions.ts` + `src/mcp/rates.ts`, 32 tests in `test/definitions.test.ts` over a shared fixture store (`test/fixture.ts`, reused by 2.3). Suite: 98 tests, 0 failures.

Three things were settled on the way through, each recorded where it belongs rather than here:

1. **The server gets its rate table compiled in** — `MCP.md` §11 Q2, settled. The open question's leaning (a copy beside the DB) was rejected; reasoning in `src/mcp/rates.ts` and the Q2 row.
2. **`range` is nullable** — a no-argument tool reports the store's extent, and an empty store has none. `MCP.md` §8.7 updated.
3. **Pricing accuracy is now a tracked issue, not an open question** — PRD §11 Q18 → [issue #3](https://github.com/m8a-io/modelog/issues/3). Effective-dated rates resolved per `turn.ts` is the agreed direction; a network rate feed was considered and rejected. Current pinned behaviour stays, and `get_definitions` **discloses it outright** rather than letting an agent assume rates-as-of-turn. That disclosure is asserted by a test, so it cannot be dropped before the fix lands.

**Not done here, by design:** the tool is not yet callable — `tools/list` still returns `[]`. Wiring is 2.4. `DEFINITIONS_DESCRIPTION` is exported and ready for it.

### 2.3 The query tools

`modelog_get_summary` (§8.2), `modelog_compare_models` (§8.3), `modelog_list_sessions` (§8.4), `modelog_get_markers` (§8.5). Signatures are in `MCP.md`; do not invent arguments.

Two things to get right:

- **`entrypoint` becomes a filter argument** on `list_sessions` and `compare_models`. This is where Phase 0.2's segmentation lands first, with no webview work. Add `isSidechain` as a filter too — it is the same shape and it is the only way an agent can currently exclude subagent traffic.
- **Untrusted strings** (`MCP.md` §4.2): branch names, paths and repo names are returned only as values of typed fields. No tool response contains prose or anything an agent could read as instruction.

**Done when:** each handler has unit tests over a fixture store run under `node --test`, plus the three envelope states asserted for each.

#### 2.3 — Done 2026-10-04

`src/mcp/tools.ts` — all four handlers plus `get_definitions` behind one `callTool` dispatcher, with the `tools/list` surface (`TOOLS`) declared and asserted to match what the dispatcher accepts. 42 tests in `test/tools.test.ts`. Suite: 140 tests, 0 failures. Verified against the real store, not just the fixture.

Three findings, in order of how much they matter:

1. **Model-switch markers were a third noise — in the dashboard as well, now fixed.** Subagent dispatches were being counted as developer model switches, two per isolated subagent turn. The semantics moved into `developerModelSwitches()` in `aggregate.ts`, which both `get_markers` and `src/service.ts` (switch list *and* chart markers) now call, so the two surfaces cannot drift. The real store's all-time dashboard count fell from 6 to 4. `get_markers` additionally returns `sidechainTurnsExcluded` and a note. Only switch detection excludes subagent turns; the cost series still counts them.
2. **`inferenceCalls` equals `turns` on every real turn in the store (1285 = 1285).** `usage.iterations[]` is absent from this data, so the turn-is-not-a-call distinction is currently definitional with zero observed instances. Worth stating in `get_definitions` regardless — it costs nothing and stops an agent assuming the two are interchangeable if the field ever appears — but it is not presently load-bearing.
3. **Response sizes are small enough that known unknown #3 is mostly answered.** Measured: summary 736 B, compare 1.1 kB, sessions-at-50 2.6 kB, definitions 6.3 kB. See `MCP.md` §11 Q3.

Two deliberate scope decisions:

- **`get_summary` takes no filters**, per `MCP.md` §8.2, which specifies range only. The consequence is that an agent cannot currently get a subagent-excluded *total* — only per-model rows via `compare_models`, or a filtered `list_sessions`. Noted rather than fixed, because inventing arguments the spec does not list is how a tool surface drifts.
- **Filters aggregate over matching turns**, so a filtered session's figures describe part of a longer session. A note says so whenever any filter is active. The alternative — select sessions by match, then report their full stats — would report a turn count the filter contradicts.

### 2.4 Registering tools on the low-level `Server`

There is no `registerTool`. Tools are wired with two handlers:

```ts
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => { ... });
```

Tool input schemas are plain JSON Schema in the `tools/list` response — no zod. Return content as a single `text` block containing `JSON.stringify(envelope)`; that is what an agent parses.

#### 2.4 — Done 2026-10-04

`src/mcp/server.ts` wires both handlers; schemas come straight from `TOOLS` so they are never restated. 148 tests, 0 failures, including six new protocol tests over the built bundle and one that drives the whole stack — bundle, stdio, read-only store, handlers — against a fixture store and asserts the figures match the in-process ones.

Three decisions worth knowing:

- **The context is rebuilt per call, never cached.** The extension writes to the store concurrently, so a store can appear, gain rows or change schema between two calls in one session. A server that cached its first read would keep answering `no-data` after the extension's first ingest. Verified live: the startup diagnostic reported 1,671 turns and a call moments later saw 1,684.
- **Three failure classes stay distinct.** A bad argument or unknown tool is `isError` — "you asked wrongly" must not be readable as "there is no data". A missing store is a `no-data` envelope. A throw mid-call (locked or unreadable store, MCP.md §9) is `isError` with the reason, and the server keeps serving; a test asserts it survives a bad call and answers the next one.
- **`instructions` now points at `get_definitions`.** It is delivered into the model's context at connect time, which makes it the only place to influence tool choice before any call happens — the cheapest available lever on known unknown #2.

**Phase 2 is complete.** Phase 3 is registration, and `docs/INSTALL-ux.md` should be read first.

---

## Phase 3 — Registration

**Revised 2026-09-28 — read `INSTALL-ux.md` first.** The description below was written as one job. It is **two targets with two different mechanisms**, and only one of them writes a config file. Full detail in `docs/INSTALL-ux.md` §2; the short version:

- **Target A — VS Code's own MCP client.** `vscode.lm.registerMcpServerDefinitionProvider` plus a `contributes.mcpServerDefinitionProviders` manifest entry. **No config file writing, and no `node` on `PATH` required** — the server can run on the editor's Node via `process.execPath`. Requires raising `engines.vscode` from `^1.90.0`; the exact floor is not yet established.
- **Target B — Claude Code.** The config writing described below, still needed, because the provider API does not feed Claude Code.

**Target B's copy must not claim success.** Task 2.0 settled that Claude Code reads MCP config at session start only, so after writing, the command tells the user the server appears in their *next* session — and does not poll for it.

**One local fact for this phase:** there is no `claude` CLI on this machine, and `~/.claude.json` holds per-project `mcpServers` under `projects["<abs path>"]`. Testing has used a gitignored project-scoped `.mcp.json` instead, deliberately — a half-written writer that corrupts `~/.claude.json` remains the worst outcome available here.

**Not in this phase:** the first-run/walkthrough UX, cross-platform validation, and Coder/m8a support. Those are PRD §7.15, §7.16 and §7.17 respectively, scheduled after Part 2.

### Sequenced tasks

#### 3.0 Answer known unknown #5 — minutes, and only possible at launch

Covered in "Before you start". Record whether an unapproved `.mcp.json` entry prompts for approval at session start and what the prompt says, then revert the probe entry. If Claude Code already prompts, **match its wording and shape rather than inventing a different confirmation** — `MCP.md` §7.3 requires showing the exact JSON and target file, and an existing precedent is worth more than a nicer dialog. If it does not prompt, Modelog's own confirmation becomes the only gate and matters more.

#### 3.1 Establish the `engines.vscode` floor — do before writing Target A

Known unknown #6. `registerMcpServerDefinitionProvider` and `contributes.mcpServerDefinitionProviders` have an introduction version; the manifest's `^1.90.0` predates them. Find the real floor from the API docs or the `@types/vscode` changelog, then raise `engines.vscode` to it in the same commit as Target A — not before, or the extension declares a requirement it does not yet use.

Worth knowing what raising it costs: it is the minimum VS Code a user must run to install Modelog at all, including for Part 1's dashboard. If the floor turns out to be recent, say so in the PRD rather than absorbing it silently.

#### 3.2 Target A — the provider API

`vscode.lm.registerMcpServerDefinitionProvider` plus the manifest contribution. Two properties make this the easier target and both should be asserted somewhere:

- **No file is written.** Nothing to back up, nothing to corrupt, nothing to undo.
- **No `node` on `PATH` is required** — `process.execPath` is the editor's own Node, which is why known unknown #4 stops mattering for this target. It does *not* stop mattering for Target B.

This is also the first code in `src/` that imports `vscode` outside `extension.ts`. Keep the layering rule intact: the provider belongs with the VS Code wiring, not in `service.ts`.

#### 3.3 Ship the server bundle into `globalStorageUri`

Write `mcp-server.mjs` there on activation when the content hash differs. Both targets point at that path rather than at `dist/`, so a developer running from source and a user running from the marketplace get the same registration shape. Hash-compare rather than always writing, so an unchanged bundle is not rewritten on every activation.

#### 3.4 Target B — the Claude Code config writer

`Modelog: Enable MCP Server`: check `node` on `PATH` (still load-bearing — see 2.0 answer 4), show the exact JSON and the exact target file, confirm, back up, write. `Modelog: Disable` removes only the `modelog` entry and leaves every other server untouched. A Copy Configuration command covers every other client.

**The copy must not claim success.** Task 2.0 settled that Claude Code reads MCP config at session start only, so after writing, the command says the server appears in the user's *next* session. Do not write a "connected" affirmation and do not poll for it to appear — it will not.

Order within this task matters: write the backup-and-restore path and its test before the writer. The worst available outcome here is a half-written `~/.claude.json`.

#### 3.5 Make the two targets' disagreement visible

A user can end up with Target A registered and Target B not, or the reverse, and the two have different failure modes. Whatever UI reports state should report it **per target**, not as one boolean. This is small, and skipping it produces the one support question that cannot be answered from a screenshot.

## Phase 4 — The actual test

Ask, in a normal session: *"Is Opus actually costing me more per turn, or am I just using it more?"* and *"What did I work on this week?"*

Judge the answers and write down what the agent got wrong or had to guess. That list is the input to the following session.

**A specific thing to watch:** whether the agent notices Haiku's turns are subagent calls, and whether it calls `get_definitions` before reasoning. If it blends sidechain turns into a per-model comparison without remark, the definitions wording failed — that is the test, not a side effect.

#### Phase 4 — Done 2026-10-04

Method: the session that ran the test had already read this plan, so it was disqualified for the one question that matters. Two **cold** agents were used instead — no plan context, each given one of the two questions verbatim and nothing else. What they called was read afterwards from their own transcripts rather than self-reported, so that tool choice was never signposted as the thing being measured.

**Known unknown #2 is settled: yes.** Both agents called `modelog_get_definitions` **second** — immediately after discovering the tools, before any query tool — unprompted. One went further and re-ran `compare_models` twice with `isSidechain: false` to test whether subagent turns were distorting its comparison, then reported the delta as immaterial. That is the behaviour 2.2 was written to produce.

**Which lever fired is not isolated.** Neither transcript records a system prompt, so there is no evidence of whether the `instructions` string reached a subagent. What is certain is that both agents ran a tool search first, which returned the descriptions, and the call followed. So the earlier reading in 2.4 — that `instructions` is "the only place to influence tool choice" — is too strong in one direction and too weak in another:

- **Too weak:** `instructions` *is* delivered verbatim into a top-level session's context, under a `# MCP Server Instructions` heading, byte-identical to `src/mcp/server.ts`. Confirmed directly.
- **Too strong:** in a session where tools are *deferred* behind a search (names loaded, schemas not), `DEFINITIONS_DESCRIPTION` is not in context until the model searches for it. It is still reachable, and it still worked. But a description cannot be assumed present at the moment a tool is chosen.

**Four defects, all filed.** [#4](https://github.com/m8a-io/modelog/issues/4) and [#7](https://github.com/m8a-io/modelog/issues/7) are fixed; [#5](https://github.com/m8a-io/modelog/issues/5) and [#6](https://github.com/m8a-io/modelog/issues/6) are open.

#4 is the one worth remembering, because it shows what the product is for. Asked what the week's work had been, the agent reported a session as *"16 turns, 6 minutes, $11.23 … 5.5x your weekly average"* and then explained it: *"a large context loaded at session start and then abandoned almost immediately — you paid the cache writes and never amortised them."* The session actually ran **401 turns over 7h58m for $121.07**. Nothing was abandoned. The range had clipped it and no note said so. The agent had called `get_definitions`, read every note and caveated three other claims correctly — diligence does not help when the data is wrong and silent about it.

**The thing to watch was not exercised.** Haiku's turns all fall outside a 30-day window, so no agent had the chance to blend them into a per-model comparison. The sidechain wording is therefore still untested against a real agent, and the check is worth repeating once there is recent subagent traffic on a model the developer did not pick.

---

## Known unknowns

| # | Question | Find out by |
| :-- | :--- | :--- |
| ~~1~~ | ~~Does Claude Code pick up a newly registered server without a restart?~~ | **Settled 2026-09-28: no — config is read at session start only.** See 2.0 Answers. |
| ~~2~~ | ~~Will the agent call `get_definitions` before reasoning?~~ | **Settled 2026-10-04: yes.** Two cold agents, both called it second, before any query tool. Which lever caused it is not isolated — see the Phase 4 record. |
| ~~3~~ | ~~How much agent context does a `list_sessions` response consume?~~ | **Measured 2026-10-04: 2.6 kB at the 50-session default (~650 tokens).** Not a concern. `get_definitions` is the largest response at 6.3 kB, and it is called once. See `MCP.md` §11 Q3. |
| 4 | Is `node` reliably on `PATH` for VS Code-launched processes? | **Partly settled 2026-09-28: it resolved here, to nvm's node, via the extension binary's inherited `PATH` — but for a machine-specific reason. Not generalisable; keep the Phase 3 check.** See 2.0 Answers. |
| 5 | Does adding an unapproved server to `.mcp.json` prompt for approval, and what does the prompt say? | **Task 3.0 — do it first.** Needs one fresh session with an unapproved entry present at launch; see "Before you start". Affects `MCP.md` §7.3 only |
| 6 | What is the real `engines.vscode` floor for `registerMcpServerDefinitionProvider`? | Task 3.1. The manifest currently says `^1.90.0`, which is certainly too low. Blocks Target A |
| 7 | Are tool *descriptions* reliably in context when a client picks a tool? | Raised by Phase 4: in a deferred-tool session they are not until searched for. Decides how much weight `instructions` has to carry versus `DEFINITIONS_DESCRIPTION` |

## Explicitly not this session

Ollama, session labeling, work-log generation, the Copilot adapter, the `{amount, unit}` refactor beyond the envelope, anything in Part 3. Also not Phase 0.1's session history table.

Issues **#5** (token counts) and **#6** (dispersion) are Phase 4 output and both change the tool surface. They do not belong in a registration phase — finish Phase 3, then take them together, since #6 reads better once #5's counts exist.

Also explicitly **not** this session, now that they have phases of their own: install and first-run UX (PRD §7.15), cross-platform environment validation (§7.16), and m8a/Coder integration (§7.17).

## Realistic scope

3.0 and 3.1 are minutes each and both gate what follows, so do them first even though neither produces code. 3.2 plus 3.3 is a comfortable session. 3.4 is the one that deserves unhurried attention — it writes to a file in the user's home directory that other tools depend on, and it is the only task here that can damage something.

If time runs short, **stop after 3.3 with Target A working and Target B not started.** A single working registration path is a shippable state; a half-finished config writer is not. Do not start 3.4 without time to write its backup path and test.
