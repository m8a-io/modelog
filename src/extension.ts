import * as vscode from "vscode";
import { DashboardPanel } from "./ui/panel.ts";
import { ModelogService } from "./service.ts";
import { LogWatcher } from "./ingest/watcher.ts";

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
}

export function deactivate(): void {
  watcher?.dispose();
  watcher = undefined;
  service?.dispose();
  service = undefined;
}
