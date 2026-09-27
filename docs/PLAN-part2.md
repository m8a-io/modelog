# Next Session — Part 2, Phase 2: The Tool Surface

**Goal:** every MCP tool in `MCP.md` §8 implemented, routed through one envelope, unit-tested over a fixture store.

**Spec:** `MCP.md`. This document is sequencing and session context, not requirements — where the two disagree, `MCP.md` wins.

---

## Before you start (2 minutes)

```bash
nvm use 24 && npm install && npm run check    # expect: 48 tests, 0 failures
bash scripts/mcp-handshake.sh                 # expect: initialize reply + {"tools": []}
```

`npm run check` does **not** build; `pretest` does, so `npm test` is always testing a fresh bundle.

---

## Status — what is already done

| Item | State |
| :--- | :--- |
| Phase 0.2 — capture `entrypoint`, `isSidechain` | **Done** (`12a8538`) |
| Phase 0.2 — `entrypoint` segmentation in the dashboard | **Not done.** Deferred: all local data is `claude-vscode`, so there is nothing to segment until the CLI is used. It gets its first real surface as a tool *filter* in this phase instead. |
| Phase 0.1 — session history table | **Not done.** Pure Part 1 assembly, blocks nothing here. |
| Phase 1 — MCP skeleton, stdio, read-only store | **Done** (`962d2ce`) |
| Phase 2 — tools | **This session** |
| Phase 3 — registration | Unchanged, still after Phase 2 |

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

### 2.3 The query tools

`modelog_get_summary` (§8.2), `modelog_compare_models` (§8.3), `modelog_list_sessions` (§8.4), `modelog_get_markers` (§8.5). Signatures are in `MCP.md`; do not invent arguments.

Two things to get right:

- **`entrypoint` becomes a filter argument** on `list_sessions` and `compare_models`. This is where Phase 0.2's segmentation lands first, with no webview work. Add `isSidechain` as a filter too — it is the same shape and it is the only way an agent can currently exclude subagent traffic.
- **Untrusted strings** (`MCP.md` §4.2): branch names, paths and repo names are returned only as values of typed fields. No tool response contains prose or anything an agent could read as instruction.

**Done when:** each handler has unit tests over a fixture store run under `node --test`, plus the three envelope states asserted for each.

### 2.4 Registering tools on the low-level `Server`

There is no `registerTool`. Tools are wired with two handlers:

```ts
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => { ... });
```

Tool input schemas are plain JSON Schema in the `tools/list` response — no zod. Return content as a single `text` block containing `JSON.stringify(envelope)`; that is what an agent parses.

---

## Phase 3 — Registration (unchanged, still after Phase 2)

Write `mcp-server.mjs` into `globalStorageUri` on activation when the content hash differs; `Modelog: Enable MCP Server` checks `node` on `PATH`, shows the exact JSON and target file, confirms, backs up, writes; `Modelog: Disable` removes only the `modelog` entry; Copy Configuration for every other client.

**One local fact for this phase:** there is no `claude` CLI on this machine, and `~/.claude.json` holds per-project `mcpServers` under `projects["<abs path>"]`. Testing has used a gitignored project-scoped `.mcp.json` instead, deliberately — a half-written writer that corrupts `~/.claude.json` remains the worst outcome available here.

## Phase 4 — The actual test

Ask, in a normal session: *"Is Opus actually costing me more per turn, or am I just using it more?"* and *"What did I work on this week?"*

Judge the answers and write down what the agent got wrong or had to guess. That list is the input to the following session.

**A specific thing to watch:** whether the agent notices Haiku's turns are subagent calls, and whether it calls `get_definitions` before reasoning. If it blends sidechain turns into a per-model comparison without remark, the definitions wording failed — that is the test, not a side effect.

---

## Known unknowns

| # | Question | Find out by |
| :-- | :--- | :--- |
| 1 | Does Claude Code pick up a newly registered server without a restart? | Reload with `.mcp.json` present and run `/mcp`. Testable now, before Phase 3 is built. |
| 2 | Will the agent call `get_definitions` before reasoning? | Phase 4; if not, the description needs rewriting |
| 3 | How much agent context does a `list_sessions` response consume? | Phase 4 — may force `MCP.md` §11 Q3's cap sooner |
| 4 | Is `node` reliably on `PATH` for VS Code-launched processes? | Phase 3 |

## Explicitly not this session

Ollama, session labeling, work-log generation, the Copilot adapter, the `{amount, unit}` refactor beyond the envelope, anything in Part 3. Also not Phase 0.1's session history table unless Phase 2 finishes early.

## Realistic scope

2.1 plus 2.2 is a solid session on its own; 2.2's wording is the part that deserves unhurried attention. If time runs short, stop after 2.2 and test with the MCP Inspector (`npx @modelcontextprotocol/inspector node dist/mcp-server.mjs`) rather than starting 2.3 badly.
