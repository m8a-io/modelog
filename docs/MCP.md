# Modelog — MCP Bridge Requirements

**Version:** 0.1
**Status:** Specification — no implementation yet
**Scope:** PRD §7.9, the first deliverable of Part 2
**Companion to:** `PRD.md` (what and why), `DESIGN.md` (Part 1 architecture)

---

## 1. Purpose

Expose Modelog's derived metrics over the Model Context Protocol so that an AI agent the developer **already uses** can reason over their own usage data.

The strategic point (PRD §7.6): Modelog does not need to ship an analysis model. The user has a capable model in their editor. Modelog's job is to hand it good, well-described data. This removes the hardest requirement in Part 2 rather than adding to it, and it delivers standalone value before any session labeling exists.

**The question it makes answerable:** *"What changed about how I work this month?"* — asked of the user's own agent, answered from their own local data.

---

## 2. Non-Goals

- **Not a write surface.** The server exposes no tool that mutates anything, in Modelog or anywhere else (§4.1).
- **Not a network service.** No listening socket, no port, no remote access (§5).
- **Not a content channel.** Prompts and code never pass through it (§4.3).
- **Not gated.** MCP is a local capability requiring no server, and is never placed behind registration, an account, or a paid tier.
- **Not a Copilot/other-vendor aggregator in v1.** It serves whatever Part 1 ingested; cross-vendor cost comparison remains forbidden (PRD §4.5) and the server must not return data shaped to invite it.

---

## 3. Design Constraints

| # | Constraint | Rationale |
| :-- | :--- | :--- |
| C1 | Read-only, structurally | Cannot corrupt the store even if defective (§6) |
| C2 | Opt-in, explicit | Registration writes to config files Modelog does not own (§7.3) |
| C3 | Derived data only | Preserves "never reads your code or prompts" (PRD §7.7) |
| C4 | Self-describing | An agent must be able to learn what a metric *means* (§8.1) |
| C5 | Honest gaps | Unknown or unavailable values are reported as such, never inferred (PRD §8.2) |

---

## 4. Trust Model

### 4.1 No write tools

Draft-then-approve (PRD §7.9) is satisfied **structurally**, not by policy. The agent drafts a timesheet or ticket entry; the user approves it inside Jira, Toggl, or wherever it belongs. Modelog holds no third-party credentials and writes nowhere. A server with no write tools cannot be talked into writing.

### 4.2 Untrusted strings

Git branch names, file paths, and repository names originate in the user's own environment but are still arbitrary strings flowing to an agent. They are returned **only as values of typed data fields** — never interpolated into prose, instructions, or anything an agent could mistake for direction. No tool response contains imperative text.

### 4.3 What is never exposed

Message content, prompts, code, file contents, credentials, API keys, account identifiers, and email addresses. The Part 1 store contains none of these by construction; the server must not introduce a path to any of them.

---

## 5. Architecture

**Transport: stdio.** The client spawns the server as a child process and communicates over stdin/stdout. No ports, no listening socket, no authentication, no network surface — which matches local-first positioning and avoids the failure modes of HTTP transport (port allocation, service discovery, DNS-rebinding protection, lifetime coupled to the editor being open). stdio is also the most broadly supported MCP transport.

**Language: TypeScript, in the Modelog repo.** The server is a thin adapter over code that already exists — `ModelogService`, the cost engine, and the aggregates are pure and carry no `vscode` import, so the server imports them directly. A divergent second implementation would be a correctness risk: metric definitions must not drift between the dashboard and the bridge.

**Dependency:** `@modelcontextprotocol/sdk` (MIT).

**Build:** a third esbuild target alongside the extension host and webview.

| Target | Entry | Platform | Format | Output |
| :--- | :--- | :--- | :--- | :--- |
| MCP server | `src/mcp/server.ts` | `node` | `esm` | `dist/mcp-server.mjs` |

ESM output, `.mjs` extension, to avoid CJS/ESM interop friction with the SDK. `node:*` builtins stay external.

**Process model:** one short-lived process per client session. No daemon, no shared state, no lifetime tied to VS Code. The server may run when VS Code is closed.

---

## 6. Storage Access

The server opens the **same SQLite file** the extension writes, in read-only mode:

```ts
new DatabaseSync(dbPath, { readOnly: true })
```

**Verified 2026-09-21** on Node 24: `readOnly` is genuinely enforced (an attempted `INSERT` throws `attempt to write a readonly database`), and with `journal_mode = WAL` — which the extension already sets — a concurrent write from the extension succeeds while a reader is open, with the reader seeing the new rows.

This makes C1 structural rather than aspirational.

**Store location:** the extension's `globalStorageUri`. The server receives it via the `MODELOG_DB` environment variable set in the registered client config, rather than re-deriving a platform-specific path.

**Missing store:** the server starts successfully and every tool returns an empty result with an explicit `status: "no-data"` and a human-readable note. It must not crash, and must not present emptiness as zero usage.

**Schema drift:** the server records the schema version it was built for. A store written by a *newer* extension causes tools to return `status: "schema-mismatch"` with the two versions named. Refusing is correct; guessing is not.

---

## 7. Deployment & Registration

### 7.1 The stable-path problem

VS Code installs extensions into a **version-stamped** directory, so any config referencing the extension's install path breaks at the next update.

**Solution:** `context.globalStorageUri` is keyed on extension ID, not version, and is therefore stable across updates. On activation the extension writes `mcp-server.mjs` into that directory when its content hash differs from what is already there. Registered client config references that stable path and never needs rewriting.

### 7.2 Node discovery

The registered command invokes `node`. If no `node` is on `PATH`, registration **fails at enable time with a clear message** naming the problem. Modelog must not silently reach for VS Code's internal Node binary, whose path changes with every VS Code release.

### 7.3 Registration flow (opt-in)

Command: **`Modelog: Enable MCP Server`**

1. Verify `node` is available; abort with a clear message if not.
2. Write the server bundle to `globalStorageUri`.
3. **Show the user the exact JSON to be written and the exact file path**, and require confirmation.
4. Back up the target config file before modifying it.
5. Write, then confirm success with the path.

Command: **`Modelog: Disable MCP Server`** removes only the `modelog` entry, leaving the rest of the file untouched.

### 7.4 Which clients

v1 keeps the blast radius small:

- **Claude Code** — offer automatic registration.
- **Everything else** — a **Copy Configuration** action placing the JSON on the clipboard, with the target file named in the UI.

Owning the config-file format of every MCP client is not a v1 commitment.

---

## 8. Tool Surface

All tools are read-only. Range arguments accept either `days` (integer, relative to now) or explicit ISO-8601 `from` / `to`; omitted means the last 30 days.

### 8.1 `modelog_get_definitions`

**No arguments.** Returns the metric definitions, so an agent reasons from stated semantics rather than from the names.

Includes: what a turn is (and that `<synthetic>` records are excluded, and that a turn is *not* an inference call), how cost is computed across the four token classes, cache-multiplier values, the rate table's effective date, the detected billing mode with its caveat text, the store's schema version, and the data's first and last timestamps.

**This tool exists to prevent confidently-wrong agent answers** and should be described so that agents call it first.

### 8.2 `modelog_get_summary`

`{ days? | from?, to? }` → totals over the range: turns, sessions, total cost in micro-dollars *and* formatted, unpriced turn count, cache hit rate, date bounds.

### 8.3 `modelog_compare_models`

`{ days? | from?, to? }` → one row per model: turns, sessions, cost per turn, relative multiple against the cheapest, turns per session, cache hit rate, total, unpriced count.

Costs appear only within a single vendor's data. If the store ever holds multiple vendors, rows are grouped by vendor and no cross-vendor ratio is emitted (PRD §4.5).

### 8.4 `modelog_list_sessions`

`{ days? | from?, to?, model?, branch?, limit? }` → sessions with id, start, end, duration, models used, turn count, cost, repo/branch. Default `limit` 50, hard cap 500.

### 8.5 `modelog_get_markers`

`{ days? | from?, to? }` → observed anchors, currently model switches: timestamp, from, to, and whether the switch was intra-session.

Every marker carries its `provenance` (PRD §6). v1 returns `observed` only; when inferred markers ship they are labelled as such so an agent can weight them differently.

### 8.6 `modelog_get_work_log` *(deferred)*

Ships with session labeling (PRD §7.7). Returns per-session categories for timesheet drafting. Specified here so the surface is designed for it, not implemented in v1.

### 8.7 Response shape

Every tool returns a common envelope:

```
{ status: "ok" | "no-data" | "schema-mismatch",
  range: { from, to },
  data: <tool-specific>,
  notes: string[] }
```

`notes` carries caveats the agent should surface — subscription-mode estimation, unpriced turns present, a stale rate table. Money is returned as **both** integer micro-dollars (for arithmetic) and a formatted string (for display), so an agent never has to parse currency text.

---

## 9. Failure Modes

| Condition | Behaviour |
| :--- | :--- |
| Store missing / extension never run | Start; all tools return `no-data` with an explanatory note |
| Store newer than server | `schema-mismatch`, both versions named, no data returned |
| Store locked or unreadable | Fail the individual call with a clear error; do not crash the server |
| `node` absent at registration | Refuse to register, name the problem |
| Rate table older than 90 days | `notes` carries a staleness warning on every cost-bearing response |
| Unknown model in range | Counted in `unpricedTurns`; never priced at a default rate |

---

## 10. Testing

- **Tool handlers** — pure functions over a fixture store; exact assertions, run under `node --test` like the Part 1 suite.
- **Read-only enforcement** — assert a write attempt through the server's connection throws.
- **Concurrency** — extension writes while the server reads; assert no corruption and that new rows become visible.
- **Protocol smoke test** — spawn the built `dist/mcp-server.mjs`, perform `initialize` and `tools/list`, assert the expected tool set and schemas.
- **Envelope invariants** — every tool returns a valid envelope in all three `status` states.
- **No-content guarantee** — assert no tool response contains any field sourced from `message.content`.

---

## 11. Open Questions

| # | Question | Leaning |
| :-- | :--- | :--- |
| 1 | Expose definitions as an MCP *resource* in addition to a tool? | Tool is universally supported; add the resource only if clients handle it well |
| 2 | Should the server read the rate table from `data/pricing.json` in the extension dir, or a copy in `globalStorageUri`? | Copy alongside the DB — keeps the server independent of the versioned extension path (§7.1) |
| 3 | Per-call result-size cap? | Yes — large `list_sessions` responses waste an agent's context; cap and paginate |
| 4 | Surface `entrypoint` (CLI vs IDE) as a filter dimension? | Yes, once Part 1 exposes it — it is nearly free and enables a genuinely commensurable comparison (PRD §4.5, tier 2) |
