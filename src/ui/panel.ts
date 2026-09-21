import * as vscode from "vscode";
import type { HostMessage, WebviewMessage } from "./protocol.ts";
import type { ModelogService } from "../service.ts";

/**
 * Owns the dashboard webview panel: one at a time, revealed if already open.
 */
export class DashboardPanel {
  private static current: DashboardPanel | undefined;

  static show(context: vscode.ExtensionContext, service: ModelogService): void {
    const column = vscode.window.activeTextEditor?.viewColumn;
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "modelog.dashboard",
      "Modelog",
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // Restrict what the webview may load from disk to our bundle output.
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
      },
    );
    DashboardPanel.current = new DashboardPanel(panel, context, service);
  }

  static refreshIfOpen(): void {
    DashboardPanel.current?.refresh();
  }

  private readonly disposables: vscode.Disposable[] = [];

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly service: ModelogService;
  private rangeDays: number | null = 30;

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    service: ModelogService,
  ) {
    this.panel = panel;
    this.context = context;
    this.service = service;
    this.panel.webview.html = this.html();

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this.onMessage(msg),
      undefined,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  private onMessage(msg: WebviewMessage): void {
    switch (msg.type) {
      case "ready":
        this.refresh();
        return;
      case "setRange":
        this.rangeDays = msg.days;
        this.refresh();
        return;
      case "rescan":
        this.service.rescan();
        this.refresh();
        return;
    }
  }

  refresh(): void {
    this.post({ type: "state", state: this.service.viewState(this.rangeDays) });
  }

  private post(msg: HostMessage): void {
    void this.panel.webview.postMessage(msg);
  }

  /**
   * The webview is locked down by a content security policy: nothing loads
   * unless we allow it. `asWebviewUri` rewrites an on-disk path into the
   * special scheme the webview is permitted to fetch from, and the nonce lets
   * exactly one inline-free script tag run.
   */
  private html(): string {
    const w = this.panel.webview;
    const uri = (f: string) =>
      w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", f));
    const nonce = nonceString();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}'; img-src ${w.cspSource} data:;">
<link href="${uri("webview.css")}" rel="stylesheet">
<title>Modelog</title>
</head>
<body>
<main id="app"></main>
<script nonce="${nonce}" type="module" src="${uri("webview.js")}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    DashboardPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

function nonceString(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
