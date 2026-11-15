import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { footprintPath, readFootprint, updateFootprint, type SkillTarget } from "../cleanup/footprint.ts";
import {
  bundleHash,
  describeRemovals,
  describeSkillInstall,
  hasInstalledSkills,
  installSkills,
  outdatedSkillTargets,
  planSkillInstall,
  readBundledSkills,
  removeSkills,
  skillsRoot,
  type SkillStep,
} from "../cleanup/skills.ts";

/**
 * The VS Code side of the skills installer: the two palette commands, the
 * confirmation and the messages. Every decision is made in
 * `cleanup/skills.ts`, which has no `vscode` import and is shared with the
 * uninstall hook.
 */

export interface PreparedSkills {
  target: SkillTarget;
  steps: SkillStep[];
  /** The body of the Install Skills confirmation. */
  detail: string;
  /** Nothing would be written. */
  unchanged: boolean;
}

/** Plans the install, or returns why it cannot happen. Writes nothing. */
export function prepareSkills(context: vscode.ExtensionContext, target: SkillTarget): PreparedSkills | string {
  const home = homedir();
  let steps: SkillStep[];
  try {
    steps = planSkillInstall(home, target, readBundledSkills(context.extensionUri.fsPath), readFootprint(footprintPath(home)));
  } catch (e) {
    return `could not read the bundled skills: ${e instanceof Error ? e.message : String(e)}`;
  }
  const blocked = steps.find((s) => s.action === "blocked");
  if (blocked) {
    return (
      `${blocked.path} is not Modelog's, and its backup path ${blocked.backup} is already taken. ` +
      "Move one of them aside, then install again."
    );
  }
  return {
    target,
    steps,
    detail: describeSkillInstall(home, target, steps),
    unchanged: steps.every((s) => s.action === "unchanged"),
  };
}

/**
 * The modal confirmation, with a second button that opens the three files.
 *
 * A modal blocks the editor, so the files cannot be read while it is up.
 * Choosing View closes it, opens them, and asks again in a notification with
 * the same verb, so installing still takes an explicit click.
 */
export async function confirmWithSkills(
  context: vscode.ExtensionContext,
  message: string,
  detail: string,
  verb: string,
): Promise<boolean> {
  const VIEW = "View Skill Files";
  const choice = await vscode.window.showInformationMessage(message, { modal: true, detail }, verb, VIEW);
  if (choice === verb) return true;
  if (choice !== VIEW) return false;

  for (const name of ["start", "handoff", "done"]) {
    const uri = vscode.Uri.file(join(context.extensionUri.fsPath, "skills", name, "SKILL.md"));
    await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: true });
  }
  return (await vscode.window.showInformationMessage(message, verb)) === verb;
}

/** Installs, returning a sentence for the success message, or throwing with the reason. */
export function installPrepared(prepared: PreparedSkills): string {
  installSkills(homedir(), prepared.target, prepared.steps);
  return prepared.unchanged
    ? `The skills in ${skillsRoot(homedir(), prepared.target)} were already current.`
    : `Installed /start, /handoff and /done in ${skillsRoot(homedir(), prepared.target)}.`;
}

const NOTIFIED_KEY = "modelog.skillsUpdateNotifiedFor";

/**
 * Once per release whose skills differ from the installed ones: say so, and
 * offer the same confirmation Install Skills shows. Installed skills are never
 * rewritten without it, because they live outside Modelog's storage
 * (MCP.md §7.3).
 *
 * Old copies must keep working until then, which is a rule on how the skills
 * and the MCP tools change (MCP.md §8.9): a skill edit may never depend on a
 * tool change that an earlier skill's calls would break.
 */
export async function notifyOutdatedSkills(context: vscode.ExtensionContext): Promise<void> {
  const home = homedir();
  const bundled = readBundledSkills(context.extensionUri.fsPath);
  const targets = outdatedSkillTargets(bundled, readFootprint(footprintPath(home)));
  const hash = bundleHash(bundled);
  if (targets.length === 0 || context.globalState.get<string>(NOTIFIED_KEY) === hash) return;
  await context.globalState.update(NOTIFIED_KEY, hash);

  const UPDATE = "Update Skills";
  const roots = targets.map((t) => skillsRoot(home, t)).join(" and ");
  const choice = await vscode.window.showInformationMessage(
    `Modelog: this version changes the /start, /handoff and /done skills. The copies in ${roots} are from an earlier version; they still work.`,
    UPDATE,
  );
  if (choice !== UPDATE) return;

  const notes: string[] = [];
  for (const target of targets) {
    const prepared = prepareSkills(context, target);
    if (typeof prepared === "string") {
      notes.push(`${skillsRoot(home, target)}: not updated, because ${prepared}`);
      continue;
    }
    const confirmed = await confirmWithSkills(
      context,
      `Modelog: update the skills in ${skillsRoot(home, target)}?`,
      prepared.detail,
      "Update",
    );
    if (!confirmed) continue;
    try {
      notes.push(installPrepared(prepared));
    } catch (e) {
      notes.push(`${skillsRoot(home, target)}: update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (notes.length > 0) void vscode.window.showInformationMessage(`Modelog: ${notes.join(" ")}`);
}

// --- the palette commands ---------------------------------------------------

const ROOT_LABELS: Record<SkillTarget, string> = {
  claude: "Claude Code",
  agents: "Codex, GitHub Copilot CLI and Copilot Chat",
};

function pickRoots(placeHolder: string, targets: SkillTarget[], preselect: (t: SkillTarget) => boolean) {
  const home = homedir();
  return vscode.window.showQuickPick(
    targets.map((target) => ({
      label: ROOT_LABELS[target],
      description: skillsRoot(home, target),
      picked: preselect(target),
      target,
    })),
    { canPickMany: true, placeHolder },
  );
}

/**
 * `Modelog: Install Skills`, the only way the skills get installed. It touches
 * no MCP registration: the two were tied together until 0.9.0 and that proved
 * unreliable. The confirmation says the skills need the server enabled.
 */
export async function installSkillsCommand(context: vscode.ExtensionContext): Promise<void> {
  const home = homedir();
  const picked = await pickRoots(
    "Install the /start, /handoff and /done skills for which tools?",
    ["claude", "agents"],
    (t) => t === "claude",
  );
  if (!picked || picked.length === 0) return;

  const notes: string[] = [];
  for (const { target } of picked) {
    const prepared = prepareSkills(context, target);
    if (typeof prepared === "string") {
      notes.push(`${skillsRoot(home, target)}: not installed, because ${prepared}`);
      continue;
    }
    if (!prepared.unchanged) {
      const confirmed = await confirmWithSkills(
        context,
        `Modelog: install the work-session skills in ${skillsRoot(home, target)}?`,
        prepared.detail,
        "Install",
      );
      if (!confirmed) continue;
    }
    try {
      notes.push(installPrepared(prepared));
    } catch (e) {
      notes.push(`${skillsRoot(home, target)}: install failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (notes.length > 0)
    void vscode.window.showInformationMessage(
      `Modelog: ${notes.join(" ")} They take effect in your next session, and need the Modelog MCP server enabled to record anything.`,
    );
}

/** `Modelog: Uninstall Skills`: removes the chosen roots' skills, edited or not, and says which were edited. */
export async function uninstallSkillsCommand(): Promise<void> {
  const home = homedir();
  const present = (["claude", "agents"] as const).filter((t) => hasInstalledSkills(home, t));
  if (present.length === 0) {
    void vscode.window.showInformationMessage("Modelog: no skills are installed.");
    return;
  }
  const picked = await pickRoots("Remove the Modelog skills from which tools?", present, () => true);
  if (!picked || picked.length === 0) return;

  let detail: string;
  try {
    detail = describeRemovals(removeSkills(home, picked.map((p) => p.target)));
  } catch (e) {
    void vscode.window.showErrorMessage(`Modelog: removing the skills failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  // 0.9.0 recorded Copilot Chat's use of the agents root here; nothing reads it now.
  if (picked.some((p) => p.target === "agents"))
    updateFootprint(footprintPath(home), (current) => ({ ...current, copilotChatSkills: undefined }));
  void vscode.window.showInformationMessage("Modelog: skills uninstalled.", { modal: true, detail });
}
