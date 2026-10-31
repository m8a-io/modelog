import { homedir, release } from "node:os";
import { join, resolve } from "node:path";
import * as vscode from "vscode";
import { DashboardPanel } from "./ui/panel.ts";
import { ModelogService } from "./service.ts";
import { ensureBundleDeployed } from "./mcp/deploy.ts";
import { mcpServerEnv } from "./mcp/registration.ts";
import {
  withModelogServer,
  withoutModelogServer,
  hasModelogServer,
  type McpServerEntry,
} from "./mcp/claudeConfig.ts";
import { readClaudeConfig, backupAndWriteClaudeConfig } from "./mcp/claudeConfigFile.ts";
import { isNodeOnPath, isOnPath } from "./mcp/nodeOnPath.ts";
import {
  codexClient,
  copilotCliClient,
  mcpAddArgs,
  mcpRemoveArgs,
  formatCommand,
  runCli,
  isRegisteredWithCli,
  backupFile,
  type CliClient,
} from "./mcp/cliRegistration.ts";
import { findCopilotLogs } from "./ingest/copilot.ts";
import { planCleanup, runCleanup } from "./cleanup/plan.ts";
import { footprintPath, recordCopilotLogging } from "./cleanup/footprint.ts";
import { findSettingsFileWith, listProfiles, settingsCandidates } from "./cleanup/settings.ts";
import {
  NEW_ISSUE_URL,
  buildIssueReport,
  issueUrl,
  summarizeFailure,
  type ActivationStatus,
  type FailureSummary,
  type ReportEnvironment,
} from "./diagnostics/report.ts";

let service: ModelogService | undefined;

/** Full errors, stacks included, stay here on the user's machine. A report carries only the allowlist in `diagnostics/report.ts`. */
let log: vscode.LogOutputChannel | undefined;
let activation: ActivationStatus = { state: "starting" };
/** The most recent failure this session, so "Modelog: Report Issue" can still describe it after its notification is gone. */
let lastFailure: FailureSummary | undefined;

/** Thrown by a command that needs the analytics service when it is not running. */
class ServiceUnavailableError extends Error {}

/**
 * Target A's refresh signal, hoisted to module scope so commands can fire it.
 *
 * Firing it makes VS Code re-ask the provider for its server definitions
 * (INSTALL-ux.md §2.1). That is the only lever Modelog has over the VS Code
 * MCP client after activation — there is no "connect" call and no config file
 * — so "Enable MCP Server (Copilot)" uses it to nudge the editor before
 * handing the user the steps only they can take.
 */
let didChangeMcpDefinitions: vscode.EventEmitter<void> | undefined;

/**
 * Called once by VS Code on the "onStartupFinished" activation event declared
 * in package.json. Everything disposable goes on context.subscriptions.
 *
 * Commands are registered **before** the service starts. The palette lists
 * every command from the manifest whether or not activate() got that far, so
 * a failure before registration leaves the user with VS Code's bare
 * "command not found" (issue #25) and no way to report it. Registered first,
 * every command still runs — those that need the service explain why they
 * cannot, and offer the report.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const cfg = () => vscode.workspace.getConfiguration("modelog");
  activation = { state: "starting" };
  lastFailure = undefined;

  log = vscode.window.createOutputChannel("Modelog", { log: true });
  context.subscriptions.push(log);

  // The test hooks exist only in the Extension Development Host (F5) and in
  // extension tests, never in an installed VSIX.
  const diagnosticsTest = context.extensionMode !== vscode.ExtensionMode.Production;
  void vscode.commands.executeCommand("setContext", "modelog.diagnosticsTest", diagnosticsTest);

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

  const command = (id: string, run: () => unknown) =>
    vscode.commands.registerCommand(id, async () => {
      try {
        await run();
      } catch (e) {
        await handleCommandFailure(context, commandTitle(context, id), e);
      }
    });

  context.subscriptions.push(
    status,
    command("modelog.openDashboard", () => DashboardPanel.show(context, requireService())),
    command("modelog.rescan", () => {
      requireService().rescan();
      refreshAll();
      void vscode.window.showInformationMessage("Modelog: rescan complete.");
    }),
    command("modelog.exportData", async () => {
      const svc = requireService();
      const uri = await vscode.window.showSaveDialog({
        filters: { JSON: ["json"] },
        saveLabel: "Export Modelog data",
      });
      if (!uri) return;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(svc.exportJson(), "utf8"));
      void vscode.window.showInformationMessage(`Modelog: exported to ${uri.fsPath}`);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("modelog")) refreshAll();
    }),
    command("modelog.enableMcpServer", () => enableMcpServer(context, cfg)),
    command("modelog.disableMcpServer", () => disableMcpServer()),
    command("modelog.enableMcpServerCopilot", () => enableMcpServerCopilot(context, cfg)),
    command("modelog.disableMcpServerCopilot", () => disableMcpServerCopilot()),
    command("modelog.enableMcpServerCodex", () => enableMcpServerViaCli(context, cfg, codexClient(homedir()))),
    command("modelog.disableMcpServerCodex", () => disableMcpServerViaCli(codexClient(homedir()))),
    command("modelog.copyMcpConfiguration", () => copyMcpConfiguration(context, cfg)),
    command("modelog.mcpServerStatus", () => showMcpServerStatus(context)),
    command("modelog.enableCopilotAnalysis", () => enableCopilotAnalysis(context)),
    command("modelog.disableCopilotAnalysis", () => disableCopilotAnalysis()),
    command("modelog.copilotStatus", () => showCopilotStatus(context, cfg)),
    command("modelog.removeChanges", () => removeModelogChanges(context)),
    command("modelog.reportIssue", () => reportIssue(context, lastFailure)),
    command("modelog.showLog", () => log?.show()),
    command("modelog.triggerTestError", () => triggerTestError(diagnosticsTest)),
  );

  // Independent of the service, so a store or rate-table failure does not
  // also take the MCP bridge down with it.
  try {
    registerMcpProvider(context, cfg);
  } catch (e) {
    recordFailure("MCP server registration", e);
  }

  try {
    if (diagnosticsTest && process.env.MODELOG_TEST_ACTIVATION_FAILURE === "1") {
      throw testError("activation", "EMODELOGTESTACTIVATION");
    }

    const svc = new ModelogService({
      // VS Code hands every extension a private directory for its own data.
      storageDir: context.globalStorageUri.fsPath,
      extensionDir: context.extensionUri.fsPath,
      logPaths: cfg().get<string[]>("logPaths", ["~/.claude/projects"]),
      billingMode: cfg().get<string>("billingMode", "subscription"),
      copilotLogPaths: copilotLogPaths(context, cfg),
      copilotCliLogPaths: cfg().get<string[]>("copilotCliLogPaths", ["~/.copilot/session-state"]),
      codexLogPaths: cfg().get<string[]>("codexLogPaths", ["~/.codex/sessions"]),
    });
    try {
      await svc.init();
    } catch (e) {
      svc.dispose();
      throw e;
    }
    // Published only once initialised: a command arriving mid-init must see
    // "starting", not a service whose store is not open yet.
    service = svc;
  } catch (e) {
    const failure = recordFailure("Activation", e);
    activation = { state: "failed", failure };
    // Not awaited: activate() must not block on a notification nobody answers.
    void notifyFailure(context, `Modelog could not start: ${messageOf(e)}`, failure);
    return;
  }
  activation = { state: "ready" };

  // No background watcher (DESIGN.md §5): nobody keeps the dashboard open
  // while they work, so a live tail would mostly run unseen. The status bar
  // gets one scan at startup; the dashboard re-scans itself every time it is
  // actually brought in front of someone (DashboardPanel.rescanAndRefresh),
  // and "Modelog: Rescan" covers everything else.
  setTimeout(() => {
    try {
      service?.rescan();
      refreshAll();
    } catch (e) {
      const failure = recordFailure("Startup scan", e);
      void notifyFailure(context, `Modelog could not scan your session logs: ${messageOf(e)}`, failure);
    }
  }, 0);

  refreshAll();
}

// --- Failure handling and issue reporting ---------------------------------

function requireService(): ModelogService {
  if (!service) throw new ServiceUnavailableError("Modelog's analytics service is not running.");
  return service;
}

/** The palette title from the manifest, so a report names the command exactly as the user saw it. */
function commandTitle(context: vscode.ExtensionContext, id: string): string {
  const commands: Array<{ command: string; title: string }> =
    context.extension.packageJSON?.contributes?.commands ?? [];
  return commands.find((c) => c.command === id)?.title ?? id;
}

async function handleCommandFailure(
  context: vscode.ExtensionContext,
  operation: string,
  e: unknown,
): Promise<void> {
  if (e instanceof ServiceUnavailableError) {
    if (activation.state === "failed") {
      await notifyFailure(
        context,
        `Modelog could not start, so "${operation}" is unavailable.`,
        activation.failure,
      );
    } else {
      void vscode.window.showInformationMessage("Modelog is still starting. Try again in a moment.");
    }
    return;
  }

  const failure = recordFailure(operation, e);
  await notifyFailure(context, `${operation} failed: ${messageOf(e)}`, failure);
}

function recordFailure(operation: string, e: unknown): FailureSummary {
  log?.error(`${operation} failed`);
  log?.error(e instanceof Error ? e : String(e));
  lastFailure = summarizeFailure(operation, e);
  return lastFailure;
}

/** The full message is shown locally — it is the user's own machine. Only the report is allowlisted. */
async function notifyFailure(
  context: vscode.ExtensionContext,
  message: string,
  failure: FailureSummary,
): Promise<void> {
  const REPORT = "Report Issue";
  const SHOW_LOG = "Show Log";
  const choice = await vscode.window.showErrorMessage(message, REPORT, SHOW_LOG);
  if (choice === REPORT) await reportIssue(context, failure);
  else if (choice === SHOW_LOG) log?.show();
}

function messageOf(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * Shows the exact report before anything leaves the machine, then opens it as
 * a GitHub draft or copies it. Never submits: the user posts it, edits it, or
 * closes the tab.
 */
async function reportIssue(context: vscode.ExtensionContext, failure: FailureSummary | undefined): Promise<void> {
  const report = buildIssueReport(reportEnvironment(context), failure);

  const OPEN = "Open GitHub Draft";
  const COPY = "Copy Report";
  const choice = await vscode.window.showInformationMessage(
    "Modelog: report a problem on GitHub?",
    {
      modal: true,
      detail:
        "Opening GitHub sends exactly the text below to github.com as a pre-filled issue draft. " +
        "Nothing is posted until you submit it there, and you can edit it first.\n\n" +
        `Title: ${report.title}\n\n${report.body}`,
    },
    OPEN,
    COPY,
  );

  if (choice === OPEN) {
    // Deliberately a string, not vscode.Uri.parse(): a Uri is decoded and
    // re-encoded on its way to the browser, which turns an encoded "&" or "="
    // inside the body back into a query separator. VS Code opens an http(s)
    // string as-is (openerService: "open the url-string AS IS").
    await vscode.env.openExternal(issueUrl(report) as unknown as vscode.Uri);
  } else if (choice === COPY) {
    await vscode.env.clipboard.writeText(`${report.title}\n\n${report.body}`);
    const OPEN_BLANK = "Open GitHub";
    const next = await vscode.window.showInformationMessage(
      "Modelog: report copied. Paste it into a new GitHub issue.",
      OPEN_BLANK,
    );
    if (next === OPEN_BLANK) await vscode.env.openExternal(vscode.Uri.parse(NEW_ISSUE_URL));
  }
}

function reportEnvironment(context: vscode.ExtensionContext): ReportEnvironment {
  const copilotChat = vscode.extensions.getExtension("GitHub.copilot-chat");
  return {
    modelogVersion: String(context.extension.packageJSON?.version ?? "unknown"),
    editorName: vscode.env.appName,
    editorVersion: vscode.version,
    uiKind: vscode.env.uiKind === vscode.UIKind.Web ? "web" : "desktop",
    remoteName: vscode.env.remoteName ?? null,
    extensionKind: context.extension.extensionKind === vscode.ExtensionKind.Workspace ? "workspace" : "ui",
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    nodeVersion: process.versions.node,
    storage: service?.storageKind() ?? "not initialized",
    activation,
    copilotChatVersion: copilotChat ? String(copilotChat.packageJSON?.version ?? "unknown") : null,
  };
}

/**
 * The message deliberately embeds a home-directory path: it must appear in the
 * local notification and output channel, and must not appear in the report.
 * That makes the end-to-end check a privacy check as well.
 */
function testError(phase: string, code: string): Error {
  const path = join(homedir(), ".claude", "projects", "modelog-private-test-project");
  return Object.assign(new Error(`Simulated ${phase} failure while reading ${path}`), { code });
}

function triggerTestError(enabled: boolean): void {
  if (!enabled) {
    void vscode.window.showInformationMessage(
      "Modelog: the test error is available only in the Extension Development Host.",
    );
    return;
  }
  throw testError("command", "EMODELOGTEST");
}

/**
 * Where Copilot's debug logs live — two roots, not one.
 *
 * **Derived, not guessed.** `globalStorageUri` is
 * `<...>/User/globalStorage/modelog.modelog`, two levels below `<...>/User`.
 * Copilot writes a session under `User/workspaceStorage/<hash>/` when a
 * folder is open, but under `User/globalStorage/` directly when none is —
 * which is how a Copilot chat with no folder open behaves, the Extension
 * Development Host included. Missing that second root isn't a rare-platform
 * edge case; it's the default state of this very development loop. Because
 * both roots come from a path VS Code hands us, they are correct on macOS,
 * Windows, VSCodium, Remote-SSH and dev containers alike — where a
 * `homedir()` plus per-platform table would have to be maintained and would
 * be wrong on the ones nobody tested.
 *
 * The known gap: a user running two VS Code installs (desktop plus a remote)
 * has two such `User` directories and this sees only the one its own
 * extension host lives in. `modelog.copilotLogPaths` covers that case
 * explicitly rather than by sniffing — but it replaces this pair outright, so
 * an override needs to list both of the second install's roots too.
 */
function copilotLogPaths(
  context: vscode.ExtensionContext,
  cfg: () => vscode.WorkspaceConfiguration,
): string[] {
  if (cfg().get<string>("copilot.enabled", "auto") === "off") return [];

  const override = cfg().get<string[]>("copilotLogPaths", []);
  if (override.length > 0) return override;

  const user = resolve(context.globalStorageUri.fsPath, "..", "..");
  return [join(user, "workspaceStorage"), join(user, "globalStorage")];
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
  didChangeMcpDefinitions = didChangeDefinitions;
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
    "Modelog: MCP server configuration copied to the clipboard. Paste it into your client's MCP config. " +
      "Claude Code, Copilot and Codex each have their own Enable command, which does this for you.",
  );
}

// --- Registration for the other three clients ------------------------------

/**
 * "Copilot" is two products with two unrelated mechanisms, so the command
 * asks which rather than guessing:
 *
 * - **Copilot Chat in VS Code** consumes the editor's own MCP client, which
 *   Modelog already registers with at activation (Target A). There is no file
 *   to write, and no amount of config will help — what is actually missing is
 *   the user starting the server and enabling its tools in agent mode.
 * - **The Copilot CLI** is a separate product with its own config file and
 *   behaves like Claude Code and Codex.
 *
 * Collapsing them into one command would have to pick a mechanism, and would
 * then be silently useless for whichever product the user meant.
 */
async function enableMcpServerCopilot(
  context: vscode.ExtensionContext,
  cfg: () => vscode.WorkspaceConfiguration,
): Promise<void> {
  const target = await pickCopilotTarget("Where should Modelog's MCP server be enabled?");
  if (target === "vscode") await enableMcpServerForVsCode(context);
  else if (target === "cli")
    await enableMcpServerViaCli(context, cfg, copilotCliClient(homedir()));
}

async function disableMcpServerCopilot(): Promise<void> {
  const target = await pickCopilotTarget("Where should Modelog's MCP server be disabled?");
  if (target === "vscode") await explainVsCodeMcpIsNotConfigurable();
  else if (target === "cli") await disableMcpServerViaCli(copilotCliClient(homedir()));
}

async function pickCopilotTarget(title: string): Promise<"vscode" | "cli" | undefined> {
  const chatInstalled = copilotChatInstalled();
  const cliPresent = isOnPath("copilot");

  const items = [
    {
      label: "GitHub Copilot Chat (in VS Code)",
      description: chatInstalled ? "installed" : "not installed",
      detail:
        "Uses VS Code's own MCP client. No config file — Modelog registers itself at startup.",
      target: "vscode" as const,
    },
    {
      label: "GitHub Copilot CLI",
      description: cliPresent ? "found on PATH" : "not found on PATH",
      detail: `A separate product with its own config at ${copilotCliClient(homedir()).configPath}.`,
      target: "cli" as const,
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: "These are different products and are configured differently.",
    ignoreFocusOut: true,
  });
  return picked?.target;
}

/**
 * The VS Code / Copilot Chat branch, which writes nothing.
 *
 * Modelog's leverage here ends at firing the definitions-changed event. The
 * remaining steps happen in VS Code's UI and in the chat tool picker, and
 * cannot be performed on the user's behalf by any API in 1.101+ — so they are
 * stated plainly instead of being implied by a success message. This is the
 * same honesty rule the Claude Code path follows for a different reason
 * (INSTALL-ux.md §2.2): never report "connected" when that is not knowable.
 */
async function enableMcpServerForVsCode(context: vscode.ExtensionContext): Promise<void> {
  if (!deployMcpBundle(context)) {
    void vscode.window.showErrorMessage(
      "Modelog: could not prepare the MCP server bundle, so VS Code has nothing to run. Check the Output panel.",
    );
    return;
  }

  didChangeMcpDefinitions?.fire();

  const OPEN = "Open MCP Servers";
  const choice = await vscode.window.showInformationMessage(
    "Modelog: already registered with VS Code's MCP client — there is no config file to write.",
    {
      modal: true,
      detail:
        "Copilot Chat reads MCP servers from VS Code itself, and Modelog registers one every time " +
        "the extension starts. Nothing else needs configuring.\n\n" +
        "Two steps remain that only you can take, in VS Code's own UI:\n\n" +
        '1. Start the "Modelog" server in the MCP servers list, and allow it if VS Code asks you to trust it.\n' +
        "2. In the Chat view, switch to Agent mode, open the tools picker and tick Modelog's tools. " +
        "Agent mode caps how many tools can be active at once, so a server can be running and still " +
        "have none of its tools selected.\n\n" +
        "That second step is the one most often missed — a running server with no tools ticked looks " +
        "exactly like a server that was never registered.",
    },
    OPEN,
  );
  if (choice !== OPEN) return;

  await openMcpServersView();
}

async function explainVsCodeMcpIsNotConfigurable(): Promise<void> {
  const OPEN = "Open MCP Servers";
  const choice = await vscode.window.showInformationMessage(
    "Modelog: there is nothing for Modelog to remove here.",
    {
      modal: true,
      detail:
        "The VS Code registration is part of the extension itself, not a config file Modelog wrote, " +
        "so it cannot be taken back out from this side.\n\n" +
        "Stop or disable the \"Modelog\" server in VS Code's MCP servers list, or untick its tools in " +
        "the Chat tool picker. Either stops Copilot Chat using it; neither affects the dashboard.",
    },
    OPEN,
  );
  if (choice === OPEN) await openMcpServersView();
}

/**
 * VS Code's MCP command ids are not part of the extension API, so they are
 * resolved against the running editor rather than hardcoded — the ids below
 * were read out of the 1.105 workbench bundle and could be renamed in any
 * release. When none is present the user is told which palette entry to run,
 * which is a visible gap rather than a silently dead button.
 */
async function openMcpServersView(): Promise<void> {
  const available = new Set(await vscode.commands.getCommands(true));
  const command = ["workbench.mcp.showInstalledServers", "workbench.mcp.listServer"].find((id) =>
    available.has(id),
  );

  if (!command) {
    void vscode.window.showInformationMessage(
      'Modelog: this VS Code version exposes no MCP view command Modelog recognises. Run "MCP: List Servers" from the Command Palette instead.',
    );
    return;
  }

  await vscode.commands.executeCommand(command);
}

/**
 * Registration for the clients that own a CLI — Codex and the Copilot CLI.
 *
 * Modelog runs their `mcp add` rather than editing their config (see
 * `cliRegistration.ts` for why), so MCP.md §7.3's four guarantees are met in
 * terms of commands rather than JSON: the exact command and the exact file are
 * shown, a backup is taken, and only then does anything run. A failure
 * surfaces the CLI's own stderr, because that text is the only accurate
 * account of what it refused to do.
 */
async function enableMcpServerViaCli(
  context: vscode.ExtensionContext,
  cfg: () => vscode.WorkspaceConfiguration,
  client: CliClient,
): Promise<void> {
  if (!isOnPath(client.bin)) {
    await offerCopyConfiguration(
      context,
      cfg,
      `Modelog: "${client.bin}" was not found on PATH, so ${client.label} cannot be configured from here.`,
    );
    return;
  }

  if (!isNodeOnPath()) {
    void vscode.window.showErrorMessage(
      `Modelog: "node" was not found on PATH. ${client.label} spawns the MCP server by running "node", ` +
        "so it must be reachable here for registration to work.",
    );
    return;
  }

  const deployed = deployMcpBundle(context);
  if (!deployed) {
    void vscode.window.showErrorMessage("Modelog: could not prepare the MCP server bundle.");
    return;
  }

  const home = homedir();
  const env = mcpServerEnv(context.globalStorageUri.fsPath, cfg().get<string>("billingMode", "auto"));
  const addArgs = mcpAddArgs(deployed.path, env);

  // Codex's `mcp add` replaces in place; Copilot's refuses and tells you to
  // remove first. Doing the remove here keeps "Replace" meaning the same thing
  // in both dialogs instead of leaking a vendor quirk into the user's lap.
  const alreadyRegistered = isRegisteredWithCli(client, home) === true;
  const steps =
    alreadyRegistered && !client.addReplaces ? [mcpRemoveArgs(), addArgs] : [addArgs];

  const verb = alreadyRegistered ? "Replace" : "Register";
  const choice = await vscode.window.showInformationMessage(
    `Modelog: ${verb.toLowerCase()} the "modelog" MCP server in ${client.label}?`,
    {
      modal: true,
      detail:
        `Modelog will run ${steps.length === 1 ? "this command" : "these commands"}:\n\n` +
        steps.map((args) => formatCommand(client.bin, args)).join("\n") +
        `\n\n${client.label} edits ${client.configPath} itself — Modelog does not write that file, ` +
        `so nothing else in it is touched. A backup is saved to ${client.configPath}.bak first.\n\n` +
        `${client.label} reads this at session start, so the server appears in your next session — not a running one.`,
    },
    verb,
  );
  if (choice !== verb) return;

  backupFile(client.configPath);

  for (const args of steps) {
    const result = runCli(client.bin, args, { cwd: home });
    if (result.status === "ok") continue;
    void vscode.window.showErrorMessage(
      `Modelog: ${formatCommand(client.bin, args)} failed.` +
        (result.status === "not-found"
          ? ` "${client.bin}" could not be run.`
          : result.output
            ? ` ${result.output}`
            : ""),
    );
    return;
  }

  void vscode.window.showInformationMessage(
    `Modelog: registered with ${client.label} in ${client.configPath}. It appears next time you start a ${client.label} session.`,
  );
}

async function disableMcpServerViaCli(client: CliClient): Promise<void> {
  if (!isOnPath(client.bin)) {
    void vscode.window.showErrorMessage(
      `Modelog: "${client.bin}" was not found on PATH, so ${client.label} cannot be configured from here.`,
    );
    return;
  }

  const home = homedir();
  if (isRegisteredWithCli(client, home) !== true) {
    void vscode.window.showInformationMessage(
      `Modelog: not registered with ${client.label} — nothing to do.`,
    );
    return;
  }

  const args = mcpRemoveArgs();
  const CONFIRM = "Remove";
  const choice = await vscode.window.showInformationMessage(
    `Modelog: remove the "modelog" MCP server from ${client.label}?`,
    {
      modal: true,
      detail:
        `Modelog will run:\n\n${formatCommand(client.bin, args)}\n\n` +
        `This removes only the "modelog" entry from ${client.configPath}; every other server stays. ` +
        `A backup is saved to ${client.configPath}.bak first.`,
    },
    CONFIRM,
  );
  if (choice !== CONFIRM) return;

  backupFile(client.configPath);

  const result = runCli(client.bin, args, { cwd: home });
  if (result.status !== "ok") {
    void vscode.window.showErrorMessage(
      `Modelog: ${formatCommand(client.bin, args)} failed.` +
        (result.status === "not-found" ? ` "${client.bin}" could not be run.` : ` ${result.output}`),
    );
    return;
  }

  void vscode.window.showInformationMessage(`Modelog: removed from ${client.configPath}.`);
}

/** The §7.4 fallback, reached when a client's own CLI is not available to do the work. */
async function offerCopyConfiguration(
  context: vscode.ExtensionContext,
  cfg: () => vscode.WorkspaceConfiguration,
  message: string,
): Promise<void> {
  const COPY = "Copy Configuration";
  const choice = await vscode.window.showErrorMessage(`${message} You can configure it by hand instead.`, COPY);
  if (choice === COPY) await copyMcpConfiguration(context, cfg);
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
async function enableCopilotAnalysis(context: vscode.ExtensionContext): Promise<void> {
  if (!copilotChatInstalled()) {
    void vscode.window.showErrorMessage(
      "Modelog: GitHub Copilot Chat is not installed, so there is nothing to enable.",
    );
    return;
  }

  if (copilotLoggingEnabled()) {
    void vscode.window.showInformationMessage(
      activation.state === "failed"
        ? "Modelog: Copilot's debug logging is already on. Modelog could not start, so it is not reading those logs yet — run \"Modelog: Show Log\" for the error."
        : "Modelog: Copilot's debug logging is already on, and Modelog is already reading what it writes. Nothing to change.",
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

  rememberWeTurnedCopilotLoggingOn(context);

  void vscode.window.showInformationMessage(
    "Modelog: Copilot debug logging is on. Start a new Copilot Chat session to produce data — existing sessions are not logged retroactively.",
  );
}

/**
 * Records that *Modelog* is the reason the setting is on, and where it landed,
 * so uninstall cleanup can undo exactly this and nothing else.
 *
 * The file is located by reading it back rather than by computing a path: VS
 * Code offers no API for where `ConfigurationTarget.Global` actually wrote,
 * and the obvious derivation is wrong in a remote window (see
 * `cleanup/settings.ts`). A `null` here is recorded as a null — the cleanup
 * then names the key for the user instead of editing a guess.
 */
function rememberWeTurnedCopilotLoggingOn(context: vscode.ExtensionContext): void {
  const userDir = resolve(context.globalStorageUri.fsPath, "..", "..");
  const key = `${COPILOT_LOGGING_SECTION}.${COPILOT_LOGGING_KEY}`;

  const settingsFile = findSettingsFileWith(
    settingsCandidates({
      home: homedir(),
      userDir,
      platform: process.platform,
      env: process.env,
      profiles: listProfiles(userDir),
    }),
    key,
  );

  try {
    recordCopilotLogging(footprintPath(homedir()), { key, settingsFile });
  } catch (e) {
    console.error("[modelog] could not record the uninstall footprint:", e);
  }
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

  // Nothing left for cleanup to undo, and a stale record would later switch
  // off a setting the user had turned back on themselves.
  try {
    recordCopilotLogging(footprintPath(homedir()), undefined);
  } catch (e) {
    console.error("[modelog] could not clear the uninstall footprint:", e);
  }

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

// --- Uninstall cleanup (the consented half) --------------------------------

/**
 * `Modelog: Remove Modelog's Changes` — the only place the user can be *asked*
 * about any of this.
 *
 * VS Code's `vscode:uninstall` hook runs the same plan (`cleanup/plan.ts`),
 * but it is a bare Node process with no window: it cannot show a checkbox, so
 * it quietly does only what is unambiguously a restoration. Anything
 * destructive — the `.bak` files, the collected history — exists only here,
 * unticked, where someone can read what it means first.
 *
 * Modelog's own storage is absent from both, because VS Code deletes it
 * itself immediately after the hook (verified in 1.105's `postUninstall`).
 */
async function removeModelogChanges(context: vscode.ExtensionContext): Promise<void> {
  const items = planCleanup({
    home: homedir(),
    platform: process.platform,
    env: process.env,
    userDir: resolve(context.globalStorageUri.fsPath, "..", ".."),
    storageDir: context.globalStorageUri.fsPath,
  });

  if (items.length === 0) {
    void vscode.window.showInformationMessage("Modelog: nothing to clean up.", {
      modal: true,
      detail:
        "Modelog has not written anything outside its own storage on this machine — no Copilot " +
        "setting, no MCP entries in another assistant's config.\n\n" +
        "Its own data needs no cleanup either: VS Code deletes an extension's storage directory " +
        "when the extension is uninstalled.",
    });
    return;
  }

  const picked = await vscode.window.showQuickPick(
    items.map((item) => ({
      label: item.label,
      detail: item.detail,
      picked: item.recommended,
      item,
    })),
    {
      title: "Modelog: remove the changes Modelog made",
      placeHolder: "Ticked items are run. Untick anything you want to keep.",
      canPickMany: true,
      ignoreFocusOut: true,
    },
  );
  if (!picked || picked.length === 0) return;

  const chosen = picked.map((p) => p.item);
  const CONFIRM = "Remove";
  const choice = await vscode.window.showWarningMessage(
    `Modelog: run ${chosen.length} cleanup ${chosen.length === 1 ? "action" : "actions"}?`,
    {
      modal: true,
      detail:
        chosen.map((item) => `• ${item.label}\n  ${item.detail}`).join("\n\n") +
        "\n\nConfig files are backed up to <file>.bak before being changed. Deletions are not reversible.",
    },
    CONFIRM,
  );
  if (choice !== CONFIRM) return;

  const results = runCleanup(chosen);
  const failed = results.filter((r) => r.outcome.status === "failed");

  // Reported per item rather than as a count: the one that matters most —
  // Copilot's logging, which keeps writing prompt-bearing files until it is
  // off — is exactly the one whose failure carries a manual instruction.
  const detail = results.map(({ item, outcome }) => `• ${item.label}\n  ${outcome.note}`).join("\n\n");

  if (failed.length === 0) {
    void vscode.window.showInformationMessage("Modelog: cleanup complete.", { modal: true, detail });
    return;
  }

  void vscode.window.showWarningMessage(
    `Modelog: cleanup finished with ${failed.length} ${failed.length === 1 ? "problem" : "problems"}.`,
    { modal: true, detail },
  );
}

/**
 * PLAN-part2.md §3.5: the targets fail independently and a boolean
 * "MCP: on/off" cannot say which. Reported per target, not merged into one.
 *
 * There are four now, not two, and they fail for four unrelated reasons — a
 * bundle that would not deploy, a project Claude Code has never seen, a CLI
 * that is not on PATH, and an entry that was never written. Each line names
 * the one that applies, because "MCP: not working" sends a user looking in the
 * wrong place three times out of four.
 *
 * Target A has no "is connected" API to query — a provider registration either
 * threw (logged, `deployMcpBundle` already returned `undefined`) or it did not
 * — so "registered with VS Code" means exactly that, not "connected", and
 * certainly not "its tools are selected in agent mode".
 */
async function showMcpServerStatus(context: vscode.ExtensionContext): Promise<void> {
  const targetA = deployMcpBundle(context)
    ? "Registered with VS Code's MCP client. Start it, and tick its tools in the Chat tool picker, to reach it from Copilot Chat."
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
    else targetB = `Not registered for this project. Run "Modelog: Enable MCP Server (Claude Code)" to add it.`;
  }

  const home = homedir();
  const detail = [
    `VS Code's MCP client — used by Copilot Chat:\n${targetA}`,
    `Claude Code:\n${targetB}`,
    `GitHub Copilot CLI:\n${cliStatusLine(copilotCliClient(home), home, "Copilot")}`,
    `Codex:\n${cliStatusLine(codexClient(home), home, "Codex")}`,
  ].join("\n\n");

  void vscode.window.showInformationMessage("Modelog: MCP server status", { modal: true, detail });
}

/**
 * "Not installed" and "installed but not set up" are different answers with
 * different remedies, so an absent CLI is never reported as an unregistered
 * one — the same three-state rule INSTALL-ux.md §3 applies to Ollama.
 */
function cliStatusLine(client: CliClient, home: string, commandSuffix: string): string {
  if (!isOnPath(client.bin)) return `Not detected — "${client.bin}" is not on PATH here.`;

  const registered = isRegisteredWithCli(client, home);
  if (registered === undefined) return `Unknown — "${client.bin}" is on PATH but could not be run.`;

  return registered
    ? `Registered in ${client.configPath}.`
    : `Not registered. Run "Modelog: Enable MCP Server (${commandSuffix})" to add it.`;
}

export function deactivate(): void {
  service?.dispose();
  service = undefined;
}
