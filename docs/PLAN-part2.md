# Next Session — Part 2, Session 1

**Goal:** a working MCP server that Claude Code can query about your own usage.

**Spec:** `MCP.md`. This document is sequencing, not requirements — where the two disagree, `MCP.md` wins.

---

## Before you start (5 minutes)

- [ ] `nvm alias default 24 && nvm use 24` — the shell was still defaulting to Node 20, which is end-of-life. Build tooling only, but it will bite.
- [ ] `npm install && npm run check` — confirm the tree is still green after a week.
- [ ] Use Claude Code normally for a bit beforehand. The trend chart and any MCP answers are only as interesting as the history behind them, and right now there are 1–2 active days per model.

---

## Phase 0 — Close out Part 1 first

Two small items. Doing them now avoids leaving Part 1 permanently 90% done, and the second is a prerequisite for the MCP work anyway.

### 0.1 Session history table — `DESIGN.md` §10.4

The last v1 surface. Sortable, filterable table: start, duration, repo/branch, models used, turns, cost. Row click expands to per-turn detail. CSV export.

Mostly assembly — `service.ts` already has the data; this is a new view model plus a table in the webview.

**Done when:** the table renders real sessions, sorts by every column, and exports CSV that opens cleanly in a spreadsheet.

### 0.2 Surface `entrypoint` — `MCP.md` §11 Q4

Every record carries `entrypoint` (all currently `claude-vscode`; the CLI writes something different). Add it to `Turn`, the SQLite schema, and the filter set.

This is the cheapest genuinely valuable feature left: it makes **CLI vs IDE** comparable, which is tier-2 commensurable under `PRD.md` §4.5 — same tool, same billing, same units. A real comparison, unlike the cross-vendor case.

**Note:** schema change. Bump the store schema version and confirm re-ingest repopulates it (upserts key on `uuid`, so a rescan is safe).

**Done when:** `entrypoint` is stored, and the comparison table can segment by it.

---

## Phase 1 — MCP server skeleton

### 1.1 Build target
Add `@modelcontextprotocol/sdk`. Third esbuild target: `src/mcp/server.ts` → `dist/mcp-server.mjs`, platform `node`, format `esm`, `node:*` external.

### 1.2 Read-only store access
Open the same SQLite file with `{ readOnly: true }`; path from the `MODELOG_DB` environment variable. Verified working alongside the extension's writes under WAL.

Reuse `ModelogService` and the metrics modules directly — a second implementation of the cost maths is a correctness risk, not a convenience.

### 1.3 stdio transport
Wire `initialize` and `tools/list`. No tools yet.

**Done when:** spawning the built `.mjs` and speaking MCP over stdio returns a valid initialize response.

---

## Phase 2 — Tools

### 2.1 Envelope
Implement the `{ status, range, data, notes }` shape from `MCP.md` §8.7 once, and route every tool through it. Money always returned as both integer micro-dollars and a formatted string.

### 2.2 `modelog_get_definitions` — build this first
It is the tool that prevents confidently-wrong agent answers, and building it first forces the semantics to be explicit before anything depends on them.

Its **description text matters as much as its output** — it has to read in a way that makes an agent call it before reasoning. Budget real thought for the wording, not just the schema.

### 2.3 The query tools
`modelog_get_summary`, `modelog_compare_models`, `modelog_list_sessions`, `modelog_get_markers`. Signatures in `MCP.md` §8.

**Done when:** each handler has unit tests over a fixture store, run under `node --test` like the Part 1 suite, plus the three envelope states asserted.

---

## Phase 3 — Registration

### 3.1 Stable path
On activation, write `mcp-server.mjs` into `globalStorageUri` when its content hash differs. That path is keyed on extension ID, not version, so registered config survives extension updates.

### 3.2 `Modelog: Enable MCP Server`
Check `node` is on `PATH` (fail clearly if not) → show the **exact JSON and the exact target file** → confirm → back up → write.

### 3.3 `Modelog: Disable MCP Server`
Remove only the `modelog` entry.

### 3.4 Copy Configuration
Clipboard action for every non-Claude-Code client. v1 does not own other clients' config formats.

**Done when:** enable, restart Claude Code, and `modelog` appears in its MCP server list.

---

## Phase 4 — The actual test

Ask Claude Code, in a normal session:

1. *"Is Opus actually costing me more per turn, or am I just using it more?"*
2. *"What did I work on this week?"*

Judge the answers. This is the first real evidence on the **usage → data → inference** question — whether the data is sliced well enough to support good reasoning. Expect to learn that some tool needs to return a field it currently doesn't.

Write down what the agent got wrong or had to guess. That list is the input to the next session.

---

## Known unknowns

| # | Question | Find out by |
| :-- | :--- | :--- |
| 1 | Does Claude Code pick up a newly registered server without a restart? | Trying it in Phase 3 |
| 2 | Will the agent actually call `get_definitions` before reasoning? | Phase 4; if not, the description needs rewriting |
| 3 | How much agent context does a `list_sessions` response consume? | Phase 4 — may force the cap in `MCP.md` §11 Q3 sooner |
| 4 | Is `node` reliably on `PATH` for VS Code-launched processes? | Phase 3 |

## Explicitly not this session

Session labeling, Ollama, work-log generation, anything in Part 3. The bridge is valuable on its own and ships before any labeling exists — that is the point of the reordering.

## Realistic scope

Phase 0 plus Phases 1–2 is a solid session. Phase 3 is fiddly — config-file handling always is. **If time runs short, stop after Phase 2 and test the server with the MCP Inspector rather than rushing registration.** A half-written config writer that corrupts someone's `~/.claude.json` is the worst outcome available here.
