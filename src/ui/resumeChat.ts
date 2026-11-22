import * as path from "node:path";
import * as vscode from "vscode";
import type { ResumeTarget } from "../workSessions/dashboard.ts";

/**
 * Opens a work session's still-open chat in Claude Code (PRD §7.25 W7).
 *
 * `claude-vscode.primaryEditor.open` is Claude Code's own command behind its
 * `vscode://anthropic.claude-code/open?session=<id>` link. With a chat id it
 * resumes that chat with its history `[verified]` 2026-11-22, extension
 * 2.1.319, but only in a window that has the chat's project folder open: in any
 * other window it silently opens a blank chat. So the folder is checked first,
 * and where it differs, or the command is missing (it is undocumented), the
 * developer gets the reason and the chat id instead of an empty chat.
 */
const OPEN_CHAT = "claude-vscode.primaryEditor.open";

export async function resumeChat(target: ResumeTarget | null): Promise<void> {
  if (!target) {
    void vscode.window.showInformationMessage(
      "Modelog: this work session has no open chat to resume. Reopen the Dashboard to refresh it.",
    );
    return;
  }

  if (target.cwd !== null && !folderIsOpen(target.cwd)) {
    const openFolder = "Open Folder in New Window";
    const copy = "Copy Chat Id";
    const choice = await vscode.window.showWarningMessage(
      `This chat ran in ${target.cwd}, which this window does not have open. ` +
        "Claude Code only resumes a chat from a window with its folder open; here it would start a blank chat.",
      openFolder,
      copy,
    );
    if (choice === openFolder) {
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(target.cwd), {
        forceNewWindow: true,
      });
    } else if (choice === copy) {
      await copyId(target.chatSessionId);
    }
    return;
  }

  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes(OPEN_CHAT)) {
    await copyId(target.chatSessionId);
    void vscode.window.showWarningMessage(
      "Modelog: Claude Code's command for opening a chat was not found (is the Claude Code extension " +
        "installed and enabled?). The chat id is on your clipboard.",
    );
    return;
  }

  await vscode.commands.executeCommand(OPEN_CHAT, target.chatSessionId);
}

function folderIsOpen(cwd: string): boolean {
  const want = path.resolve(cwd);
  return (vscode.workspace.workspaceFolders ?? []).some((f) => {
    const have = path.resolve(f.uri.fsPath);
    return want === have || want.startsWith(have + path.sep);
  });
}

async function copyId(id: string): Promise<void> {
  await vscode.env.clipboard.writeText(id);
  void vscode.window.showInformationMessage(`Modelog: copied chat id ${id}.`);
}
