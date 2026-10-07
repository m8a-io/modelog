import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as vscode from "vscode";
import { DashboardPanel } from "./ui/panel.ts";
import { ModelogService } from "./service.ts";
import { LogWatcher } from "./ingest/watcher.ts";
import { ensureBundleDeployed } from "./mcp/deploy.ts";
import { mcpServerEnv } from "./mcp/registration.ts";
import {
  withModelogServer,
  withoutModelogServer,
  hasModelogServer,
  type McpServerEntry,
} from "./mcp/claudeConfig.ts";
import { readClaudeConfig, backupAndWriteClaudeConfig } from "./mcp/claudeConfigFile.ts";
import { isNodeOnPath } from "./mcp/nodeOnPath.ts";
import { findCopilotLogs } from "./ingest/copilot.ts";

let service: ModelogService | undefined;
let watcher: LogWatcher | undefined;

/**
 * Called once by VS Code on the "onStartupFinished" activation event declared
 * in package.json. Everything disposable goes on context.subscriptions.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const cfg = () => vscode.workspace.getConfiguration("modelog");

  service = new ModelogService({
    // VS Code hands every extension a private directory for its own data.
    storageDir: context.globalStorageUri.fsPath,
    extensionDir: context.extensionUri.fsPath,
    logPaths: cfg().get<string[]>("logPaths", ["~/.claude/projects"]),
    billingMode: cfg().get<string>("billingMode", "subscription"),
    copilotLogPaths: copilotLogPaths(context, cfg),
  });

  await service.init();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "modelog.openDashboard";
  status.tooltip = "Open the Modelog dashboard";

  const refreshAll = () => {
    if (!service) return;
    status.text = service.statusText();
    if (cfg().get<boolean>("statusBar.enabled", true)) status.show();
    else status.hide();
    DashboardPanel.refreshIfOpen();
  };

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand("modelog.openDashboard", () => {
      if (service) DashboardPanel.show(context, service);
    }),
    vscode.commands.registerCommand("modelog.rescan", () => {
      service?.rescan();
      refreshAll();
      void vscode.window.showInformationMessage("Modelog: rescan complete.");
    }),
    vscode.commands.registerCommand("modelog.exportData", async () => {
      if (!service) return;
      const uri = await vscode.window.showSaveDialog({
        filters: { JSON: ["json"] },
        saveLabel: "Export Modelog data",
      });
      if (!uri) return;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(service.exportJson(), "utf8"));
      void vscode.window.showInformationMessage(`Modelog: exported to ${uri.fsPath}`);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("modelog")) refreshAll();
    }),
    vscode.commands.registerCommand("modelog.enableMcpServer", () => enableMcpServer(context, cfg)),
    vscode.commands.registerCommand("modelog.disableMcpServer", () => disableMcpServer()),
    vscode.commands.registerCommand("modelog.copyMcpConfiguration", () => copyMcpConfiguration(context, cfg)),
    vscode.commands.registerCommand("modelog.mcpServerStatus", () => showMcpServerStatus(context)),
    vscode.commands.registerCommand("modelog.enableCopilotAnalysis", () => enableCopilotAnalysis()),
    vscode.commands.registerCommand("modelog.disableCopilotAnalysis", () => disableCopilotAnalysis()),
    vscode.commands.registerCommand("modelog.copilotStatus", () => showCopilotStatus(context, cfg)),
  );

  // Live updates: an active session appends to its log constantly, so the
  // watcher is debounced and only ever triggers an incremental read.
  watcher = new LogWatcher(() => {
    service?.rescan();
    refreshAll();
  });
  const failed = watcher.start(cfg().get<string[]>("logPaths", ["~/.claude/projects"]));
  if (failed.length) {
    void vscode.window.showWarningMessage(
      `Modelog: could not watch ${failed.join(", ")}. Use "Modelog: Rescan" to refresh manually.`,
    );
  }
  context.subscriptions.push({ dispose: () => watcher?.dispose() });

  // Ingest after activation returns, so we never sit on the startup path.
  setTimeout(() => {
    service?.rescan();
    refreshAll();
  }, 0);

  refreshAll();
  registerMcpProvider(context, cfg);
}

/**
 * Where Copilot's per-workspace debug logs live.
 *
 * **Derived, not guessed.** `globalStorageUri` is
 * `<...>/User/globalStorage/modelog.modelog`, and Copilot's logs are under
 * `<...>/User/workspaceStorage/`, so the root is two levels up from our own
 * storage directory. Because it comes from a path VS Code hands us, it is
 * correct on macOS, Windows, VSCodium, Remote-SSH and dev containers alike —
 * where a `homedir()` plus per-platform table would have to be maintained and
 * would be wrong on the ones nobody tested.
 *
 * The known gap: a user running two VS Code installs (desktop plus a remote)
 * has two `workspaceStorage` roots and this sees only the one its own
 * extension host lives in. `modelog.copilotLogPaths` covers that case
 * explicitly rather than by sniffing.
 */
function copilotLogPaths(
  context: vscode.ExtensionContext,
  cfg: () => vscode.WorkspaceConfiguration,
): string[] {
  if (cfg().get<string>("copilot.enabled", "auto") === "off") return [];

  const override = cfg().get<string[]>("copilotLogPaths", []);
  if (override.length > 0) return override;

  return [resolve(context.globalStorageUri.fsPath, "..", "..", "workspaceStorage")];
}

/**
 * Both registration targets point at the same copy of the bundle in
 * `globalStorageUri` (MCP.md §7.1), so a developer running from source and a
 * user running from the Marketplace register the same shape. The bundle
 * should always exist in a built extension; if it does not, that is a
 * packaging defect, so callers get `undefined` and log, rather than
 * crashing activation or a command.
 */
function deployMcpBundle(context: vscode.ExtensionContext): { path: string; hash: string } | undefined {
  try {
    return ensureBundleDeployed(
      join(context.extensionUri.fsPath, "dist", "mcp-server.mjs"),
      context.globalStorageUri.fsPath,
    );
  } catch (e) {
    console.error("[modelog] could not deploy mcp-server.mjs:", e);
    return undefined;
  }
}

/**
 * Target A (PLAN-part2.md §3.2): VS Code's own MCP client. Registering here,
 * unconditionally, is safe in a way Target B is not — nothing is written
 * outside Modelog's own `globalStorageUri`, so there is no foreign config
 * file to confirm, back up, or risk corrupting (MCP.md §7.3 applies only to
 * Target B). The server also runs on `process.execPath`, the editor's own
 * Node, so unlike Target B it needs no `node` on `PATH`.
 */
function registerMcpProvider(
  context: vscode.ExtensionContext,
  cfg: () => vscode.WorkspaceConfiguration,
): void {
  const deployed = deployMcpBundle(context);
  if (!deployed) return;

  const didChangeDefinitions = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    didChangeDefinitions,
    vscode.lm.registerMcpServerDefinitionProvider("modelog.mcp", {
      onDidChangeMcpServerDefinitions: didChangeDefinitions.event,
      provideMcpServerDefinitions: async () => {
        const billingMode = cfg().get<string>("billingMode", "auto");
        return [
          new vscode.McpStdioServerDefinition(
            "Modelog",
            process.execPath,
            [deployed.path],
            mcpServerEnv(context.globalStorageUri.fsPath, billingMode),
            deployed.hash,
          ),
        ];
      },
    }),
  );
}

function claudeConfigPath(): string {
  return join(homedir(), ".claude.json");
}

function claudeMcpEntry(
  bundlePath: string,
  storageDir: string,
  billingMode: string,
): McpServerEntry {
  return { command: "node", args: [bundlePath], env: mcpServerEnv(storageDir, billingMode) };
}

/**
 * Target B (PLAN-part2.md §3.4): Claude Code's own config file.
 *
 * This is the one path in the whole extension that writes outside its own
 * storage, into a file (`~/.claude.json`) that also carries Claude Code's
 * auth state (verified directly on the dev machine: `oauthAccount`,
 * `primaryApiKey` live at the same top level as `projects`). Every step that
 * can fail does so with a specific, named reason and writes nothing; the
 * actual write is preceded by a backup and an explicit confirmation showing
 * the exact JSON and the exact file (MCP.md §7.3).
 *
 * The success message must not claim the server is connected — task 2.0
 * established Claude Code reads this file at session start only, so it
 * takes effect in the *next* session in this folder, never this one.
 */
async function enableMcpServer(
  context: vscode.ExtensionContext,
  cfg: () => vscode.WorkspaceConfiguration,
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage("Modelog: open a folder to register the MCP server for it.");
    return;
  }

  if (!isNodeOnPath()) {
    void vscode.window.showErrorMessage(
      'Modelog: "node" was not found on PATH. Claude Code spawns the MCP server by running "node", ' +
        "so it must be reachable here for registration to work.",
    );
    return;
  }

  const deployed = deployMcpBundle(context);
  if (!deployed) {
    void vscode.window.showErrorMessage("Modelog: could not prepare the MCP server bundle.");
    return;
  }

  const configPath = claudeConfigPath();
  const read = readClaudeConfig(configPath);
  if (read.status === "missing") {
    void vscode.window.showErrorMessage(
      `Modelog: ${configPath} does not exist yet. Run Claude Code at least once before enabling this.`,
    );
    return;
  }
  if (read.status === "invalid-json") {
    void vscode.window.showErrorMessage(
      `Modelog: ${configPath} is not valid JSON. Refusing to modify it.`,
    );
    return;
  }

  const projectPath = folder.uri.fsPath;
  const entry = claudeMcpEntry(deployed.path, context.globalStorageUri.fsPath, cfg().get<string>("billingMode", "auto"));
  const next = withModelogServer(read.config, projectPath, entry);
  if (!next) {
    void vscode.window.showErrorMessage(
      `Modelog: "${projectPath}" is not yet a project Claude Code knows about. ` +
        "Open a Claude Code session in this folder once, then retry.",
    );
    return;
  }

  const verb = hasModelogServer(read.config, projectPath) ? "Replace" : "Write";
  const choice = await vscode.window.showInformationMessage(
    `Modelog: ${verb.toLowerCase()} the "modelog" MCP server entry in ${configPath}?`,
    {
      modal: true,
      detail:
        `This will be written under projects["${projectPath}"].mcpServers.modelog:\n\n` +
        JSON.stringify(entry, null, 2) +
        `\n\nA backup of the current file is saved to ${configPath}.bak first. Claude Code reads ` +
        "this file at session start only, so the server appears in your next session here — not this one.",
    },
    verb,
  );
  if (choice !== verb) return;

  try {
    backupAndWriteClaudeConfig(configPath, next);
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Modelog: failed to write ${configPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  void vscode.window.showInformationMessage(
    `Modelog: wrote the MCP server entry to ${configPath}. It appears next time you start a Claude Code session in this folder.`,
  );
}

async function disableMcpServer(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage("Modelog: open a folder to disable the MCP server for it.");
    return;
  }

  const configPath = claudeConfigPath();
  const read = readClaudeConfig(configPath);
  if (read.status === "missing") {
    void vscode.window.showInformationMessage(`Modelog: ${configPath} does not exist — nothing to remove.`);
    return;
  }
  if (read.status === "invalid-json") {
    void vscode.window.showErrorMessage(`Modelog: ${configPath} is not valid JSON. Refusing to modify it.`);
    return;
  }

  const projectPath = folder.uri.fsPath;
  if (!hasModelogServer(read.config, projectPath)) {
    void vscode.window.showInformationMessage("Modelog: not registered for this project — nothing to do.");
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `Modelog: remove the "modelog" MCP server entry from ${configPath}?`,
    { modal: true, detail: `A backup of the current file is saved to ${configPath}.bak first.` },
    "Remove",
  );
  if (choice !== "Remove") return;

  try {
    backupAndWriteClaudeConfig(configPath, withoutModelogServer(read.config, projectPath));
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Modelog: failed to write ${configPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  void vscode.window.showInformationMessage(`Modelog: removed from ${configPath}.`);
}

/** The "every other client" path (MCP.md §7.4): no target file is owned, so Modelog writes nothing — it hands the user the JSON and lets them place it. */
async function copyMcpConfiguration(
  context: vscode.ExtensionContext,
  cfg: () => vscode.WorkspaceConfiguration,
): Promise<void> {
  const deployed = deployMcpBundle(context);
  if (!deployed) {
    void vscode.window.showErrorMessage("Modelog: could not prepare the MCP server bundle.");
    return;
  }

  const entry = claudeMcpEntry(deployed.path, context.globalStorageUri.fsPath, cfg().get<string>("billingMode", "auto"));
  const json = JSON.stringify({ mcpServers: { modelog: entry } }, null, 2);
  await vscode.env.clipboard.writeText(json);
  void vscode.window.showInformationMessage(
    'Modelog: MCP server configuration copied to the clipboard. Paste it into your client\'s MCP config ' +
      '(for Claude Code specifically, use "Modelog: Enable MCP Server" instead).',
  );
}

// --- Copilot analysis opt-in (PRD §7.1, open question 15) -------------------

/** Copilot's own setting. Note the `.enabled` suffix: the shorter path is the section, and reads as undefined. */
const COPILOT_LOGGING_SECTION = "github.copilot.chat";
const COPILOT_LOGGING_KEY = "agentDebugLog.fileLogging.enabled";

function copilotLoggingEnabled(): boolean {
  return (
    vscode.workspace.getConfiguration(COPILOT_LOGGING_SECTION).get<boolean>(COPILOT_LOGGING_KEY) ===
    true
  );
}

function copilotChatInstalled(): boolean {
  return vscode.extensions.getExtension("GitHub.copilot-chat") !== undefined;
}

/**
 * The only route to per-turn Copilot data is a Copilot setting that is off by
 * default and, when on, makes Copilot write **full prompts and code context**
 * to local unencrypted files that do not otherwise exist.
 *
 * That is in direct tension with Modelog's central claim (PRD §8.1), so the
 * decision (open question 15, resolved) is: **explicit opt-in, never a
 * prompt.** Modelog does not raise this at activation, in onboarding, or on
 * seeing that Copilot is installed. A user who wants it runs this command and
 * is told plainly what it does first. A user who already has it on is read
 * silently, with no notification in either direction — and is never nagged to
 * turn it off either.
 *
 * Modelog itself never reads the prompt content in those files; the point of
 * the warning is that the files will exist on disk for anything else to read.
 */
async function enableCopilotAnalysis(): Promise<void> {
  if (!copilotChatInstalled()) {
    void vscode.window.showErrorMessage(
      "Modelog: GitHub Copilot Chat is not installed, so there is nothing to enable.",
    );
    return;
  }

  if (copilotLoggingEnabled()) {
    void vscode.window.showInformationMessage(
      "Modelog: Copilot's debug logging is already on, and Modelog is already reading what it writes. Nothing to change.",
    );
    return;
  }

  const CONFIRM = "Enable logging";
  const choice = await vscode.window.showWarningMessage(
    "Modelog: turn on Copilot's debug logging?",
    {
      modal: true,
      detail:
        `This sets ${COPILOT_LOGGING_SECTION}.${COPILOT_LOGGING_KEY} to true in your user settings.\n\n` +
        "What that does: Copilot Chat will write your full prompts and code context to " +
        "local, unencrypted debug-log files that do not otherwise exist. Modelog reads " +
        "only the token counts and costs in those files and never the prompt content — " +
        "but the files will exist on disk, and anything else on this machine can read them.\n\n" +
        "It is also not retroactive: only Copilot sessions started after this takes effect " +
        "produce data. Sessions you have already had cannot be measured.\n\n" +
        "Without this, Modelog can show Claude Code figures but not Copilot ones.",
    },
    CONFIRM,
  );
  if (choice !== CONFIRM) return;

  try {
    await vscode.workspace
      .getConfiguration(COPILOT_LOGGING_SECTION)
      .update(COPILOT_LOGGING_KEY, true, vscode.ConfigurationTarget.Global);
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Modelog: could not update the setting: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  void vscode.window.showInformationMessage(
    "Modelog: Copilot debug logging is on. Start a new Copilot Chat session to produce data — existing sessions are not logged retroactively.",
  );
}

async function disableCopilotAnalysis(): Promise<void> {
  if (!copilotLoggingEnabled()) {
    void vscode.window.showInformationMessage("Modelog: Copilot's debug logging is already off.");
    return;
  }

  const CONFIRM = "Disable logging";
  const choice = await vscode.window.showWarningMessage(
    "Modelog: turn off Copilot's debug logging?",
    {
      modal: true,
      detail:
        `This sets ${COPILOT_LOGGING_SECTION}.${COPILOT_LOGGING_KEY} to false.\n\n` +
        "Copilot will stop writing new debug logs, so Modelog will have no Copilot data " +
        "for sessions after this point.\n\n" +
        "It does NOT delete logs already written. Those files stay on disk until you " +
        'remove them yourself — use "Modelog: Copilot Status" to see where they are.',
    },
    CONFIRM,
  );
  if (choice !== CONFIRM) return;

  await vscode.workspace
    .getConfiguration(COPILOT_LOGGING_SECTION)
    .update(COPILOT_LOGGING_KEY, false, vscode.ConfigurationTarget.Global);

  void vscode.window.showInformationMessage(
    "Modelog: Copilot debug logging is off. Previously written logs were not deleted.",
  );
}

/** Reports each condition separately, because they fail independently and a single "Copilot: off" cannot say which. */
function showCopilotStatus(
  context: vscode.ExtensionContext,
  cfg: () => vscode.WorkspaceConfiguration,
): void {
  const installed = copilotChatInstalled();
  const logging = copilotLoggingEnabled();
  const roots = copilotLogPaths(context, cfg);
  const files = roots.flatMap((r) => findCopilotLogs(r));
  const stored = service?.sourceCounts()["copilot"] ?? 0;

  const lines = [
    `Copilot Chat installed: ${installed ? "yes" : "no"}`,
    `Copilot debug logging: ${logging ? "on" : "off"}` +
      (logging ? "" : ' — run "Modelog: Enable Copilot Analysis" to turn it on'),
    `Session logs found: ${files.length}`,
    `Copilot turns stored: ${stored}`,
    "",
    roots.length > 0 ? `Scanning: ${roots.join(", ")}` : "Copilot ingest is disabled in settings.",
  ];

  void vscode.window.showInformationMessage("Modelog: Copilot status", {
    modal: true,
    detail: lines.join("\n"),
  });
}

/**
 * PLAN-part2.md §3.5: the two targets fail independently and a boolean
 * "MCP: on/off" cannot say which. Reported per target, not merged into one.
 * Target A has no "is connected" API to query — a provider registration
 * either threw (logged, deployMcpBundle already returned `undefined`) or it
 * did not — so "registered with VS Code" means exactly that, not "connected".
 */
async function showMcpServerStatus(context: vscode.ExtensionContext): Promise<void> {
  const targetA = deployMcpBundle(context)
    ? "Registered with VS Code's MCP client."
    : "Not registered — the server bundle could not be deployed. Check the Output panel.";

  const folder = vscode.workspace.workspaceFolders?.[0];
  let targetB: string;
  if (!folder) {
    targetB = "Unknown — no folder is open, so there is no project to check.";
  } else {
    const read = readClaudeConfig(claudeConfigPath());
    if (read.status === "missing") targetB = `Not registered — ${claudeConfigPath()} does not exist.`;
    else if (read.status === "invalid-json") targetB = `Unknown — ${claudeConfigPath()} is not valid JSON.`;
    else if (hasModelogServer(read.config, folder.uri.fsPath))
      targetB = `Registered for this project in ${claudeConfigPath()}.`;
    else targetB = `Not registered for this project. Run "Modelog: Enable MCP Server" to add it.`;
  }

  void vscode.window.showInformationMessage("Modelog: MCP server status", {
    modal: true,
    detail: `VS Code (built-in MCP client):\n${targetA}\n\nClaude Code:\n${targetB}`,
  });
}

export function deactivate(): void {
  watcher?.dispose();
  watcher = undefined;
  service?.dispose();
  service = undefined;
}
