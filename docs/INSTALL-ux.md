# Install, Activation & First-Run UX

How Modelog actually reaches a user's editor, and what it may do once there.

**Status:** findings verified on one machine (Remote-WSL, VS Code 1.138.0 stable, `@types/vscode` 1.138.0) on 2026-09-28. Claims are tagged **[verified]** where measured locally and **[untested]** where they depend on a platform not available here. Do not promote an `[untested]` row to a design commitment without running §5.

---

## 1. There is no installation-time hook

**[verified]** VS Code never executes extension code at install time. There is no `preinstall`/`postinstall`, no `onInstall` activation event, and nothing equivalent anywhere in the 1.138 API surface.

The only entry point an extension has is `activate()`, fired by its `activationEvents`. Modelog declares `onStartupFinished`.

**Consequence.** "Do X during installation" is not expressible. Every such intent must be rewritten as **"on first activation"** — the first time VS Code starts up with the extension present — and made idempotent by recording a flag in `context.globalState`, which is the only durable per-extension key-value store VS Code offers for this.

This is not a limitation to work around. It is the model, and it is why first-run behaviour is a *product* decision rather than a packaging one.

---

## 2. The MCP server: two targets, two mechanisms

The single biggest correction to the original Phase 3 plan. "Register the MCP server" means two unrelated things depending on which client is meant, and only one of them involves writing a config file.

| | **Target A — VS Code's own MCP client** | **Target B — Claude Code** |
| :--- | :--- | :--- |
| Mechanism | `vscode.lm.registerMcpServerDefinitionProvider` | Write `.mcp.json` / `~/.claude.json` |
| Config files touched | **None** | The client's, outside Modelog's storage |
| Lifecycle owner | VS Code | Claude Code |
| Takes effect | On provider registration | **The user's next session** (see `PLAN-part2.md` 2.0) |
| Needs `node` on `PATH` | **No** — see §2.1 | Yes, and it is fragile |

### 2.1 Target A — the native provider API

**[verified]** Present in 1.138. Requires a manifest contribution declared *before* the call:

```json
"contributes": {
  "mcpServerDefinitionProviders": [
    { "id": "modelog.mcp-servers", "label": "Modelog" }
  ]
}
```

then `lm.registerMcpServerDefinitionProvider("modelog.mcp-servers", provider)` during activation. The provider returns `McpStdioServerDefinition` objects:

```ts
new McpStdioServerDefinition(label, command, args?, env?, version?)
```

Three properties of this path matter:

- **The `node` problem disappears.** The API documentation states it directly: *"Node.js-based servers may use `process.execPath` to use the editor's version of Node.js to run the script."* Combined with what `CLAUDE.md` already records — the extension host runs Node 24.18 with built-in `node:sqlite` — the server can run on the editor's own Node with no external dependency at all.
- **No shell.** The server "will be spawned as a child process of the extension host and by default will **not** run in a shell environment." This is the same fact measured from the other direction in `PLAN-part2.md` 2.0, where a `PATH`-resolved `node` worked only because that VS Code server happened to inherit an nvm-initialised environment.
- **`version` is the refresh signal.** Changing it makes the editor report that tools changed and offer to re-fetch them. That is the supported way to ship a tool-surface change, rather than asking the user to reload.

**Cost:** `engines.vscode` is currently `^1.90.0`. This API is not in 1.90. The floor must rise, and **the exact version at which it became stable has not been verified** — establish it before picking a number.

### 2.2 Target B — Claude Code

Unchanged from the original Phase 3 plan, and still required, because VS Code's provider API does not feed Claude Code. It reads its own configuration, at session start only. Therefore:

- After writing config, Modelog **must not** report that the server is connected, and must not poll for it to appear. The correct message names the user's *next* session.
- The `node`-on-`PATH` check stays load-bearing here, since this path cannot use `process.execPath`.
- `MCP.md` §7.3's requirement — show the exact JSON and target file, confirm, back up, write — applies to this target only.

---

## 3. Ollama detection

**[verified]** `GET http://127.0.0.1:11434/api/tags` returns `{"models":[...]}`. Detection is a plain localhost HTTP probe with a short timeout; no Ollama client library is needed.

There are **three** states, not two:

| State | Signal | Correct behaviour |
| :--- | :--- | :--- |
| Absent | connection refused | Feature cleanly off, per §8 *Every optional dependency defaults cleanly to off* |
| Reachable, no models | `{"models":[]}` | Daemon is up but nothing is pulled. Cannot classify. Must **not** be reported as "Ollama not found" — the remedy is pulling a model, which is a different instruction |
| Reachable with models | populated array | Configure from the returned list |

The middle state is the machine this was measured on (`/usr/local/bin/ollama` present, daemon answering, zero models). Collapsing it into "absent" would misreport the project's own development environment.

**Detection is not enablement.** PRD §7.8 already sanctions auto-detection on `localhost:11434`, and a localhost probe crosses no boundary. *Using* Ollama does — PRD §7.6/§8 place the labeling job inside the content boundary — so enabling it requires explicit opt-in. Keep the two decisions separate: detect silently, ask before using.

**Remote caveat:** see §4. `localhost` is not the user's laptop when the extension host is remote.

---

## 4. Remote extension hosts change what "local" means

**[verified]** In WSL, the extension host runs inside Linux (`~/.vscode-server` is present, and `localhost` resolves to the WSL host, not Windows). The same holds for Remote-SSH, Dev Containers and Coder.

Two consequences:

- **Ollama probing hits the remote machine.** A user running Ollama on their laptop while editing in a remote workspace will get a correct-but-useless "not found". Modelog should detect the situation and say something true about it.
- **Log paths are the remote filesystem's.** `~/.claude/projects` on the extension host is not the laptop's.

**[verified]** The detection primitives exist: `vscode.env.remoteName` (`string | undefined`) and `Extension.extensionKind` (`ExtensionKind.UI` vs `ExtensionKind.Workspace`). Whether Modelog should declare a preferred `extensionKind` is an open design question, not yet decided.

---

## 5. Environment matrix — what is actually unknown

Everything above was measured on one configuration. The following are **[untested]** and each has a specific failure mode worth targeting rather than exploring:

| Environment | The specific question |
| :--- | :--- |
| **macOS, GUI-launched** | GUI processes inherit no shell `PATH` — no nvm, no Homebrew. Highest-probability break for any `PATH`-based `node` lookup. Does Target B's check degrade correctly? |
| **Windows, no WSL** | `process.execPath` is `Code.exe`, not a node binary. Does the §2.1 `execPath` technique hold at all? Path separators and `globalStorageUri` location also differ |
| **Remote-SSH / Dev Container** | §4's assumptions, on a non-WSL remote |
| **Coder (m8a)** | §4 plus whatever the platform imposes — see PRD §7.16 |
| **Remote-WSL** | **[verified]** — the baseline everything here was measured against |

The `process.execPath` question on Windows is the one that could invalidate §2.1's main advantage. Test it before relying on it.

---

## 6. First-run UX: the available mechanisms

**[verified]** Three, none of them at install time:

1. **`contributes.walkthroughs`** — the sanctioned onboarding surface. Renders in the Welcome page, persists as discoverable documentation, and supports `completionEvents` such as `onCommand:...` so steps tick themselves off when the user performs the action. Local precedent: the Claude Code extension ships `claude-code-walkthrough` with markdown-media steps wired to exactly that.
2. **`window.showInformationMessage`** with action buttons — the one-shot consent prompt, gated on `globalState`.
3. **A webview wizard** — most control, most work. `ui/panel.ts` already provides the infrastructure.

### Recommendation

**A walkthrough for discovery, plus at most one first-activation prompt for the opt-ins. Not a modal wizard.**

Reasons, in order of weight:

- Both MCP registration and Ollama use **default off** (PRD §8), so nothing is broken by a user who dismisses or never sees the prompt. A blocking wizard would be asking permission for features that are already correctly inert.
- Startup modals are among the most-resented extension behaviours, and Modelog's positioning is a quiet local tool.
- The walkthrough is *durable*. A dismissed toast is gone; a walkthrough step remains findable when the user later wonders how to turn MCP on. Config-only discovery has the opposite property — it requires already knowing the feature exists.

Because MCP registration writes outside Modelog's own storage (Target B), its opt-in must remain an explicit, confirmed action per `MCP.md` §7.3 — never a side effect of clicking through onboarding.
