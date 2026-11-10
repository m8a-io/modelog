import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { footprintPath, readFootprint, type SkillTarget } from "../cleanup/footprint.ts";
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
  skillUsers,
  type SkillStep,
  type SkillUsersExcept,
} from "../cleanup/skills.ts";

/**
 * The VS Code side of the skills installer: confirmation, and the messages.
 * Every decision is made in `cleanup/skills.ts`, which has no `vscode` import
 * and is shared with the uninstall hook.
 */

export interface PreparedSkills {
  target: SkillTarget;
  steps: SkillStep[];
  /** The skills half of the Enable confirmation. */
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
      "Move one of them aside, then enable again."
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

/** The skills half of a Disable confirmation: what will happen to them, and why. */
export function describeSkillsOnDisable(target: SkillTarget, except: SkillUsersExcept): string {
  const home = homedir();
  if (!hasInstalledSkills(home, target)) return "";
  const users = skillUsers(home, target, except);
  return users.length === 0
    ? `\n\nAlso removes the /start, /handoff and /done skills from ${skillsRoot(home, target)}, edited or not. Nothing else uses them.`
    : `\n\nThe /start, /handoff and /done skills stay in ${skillsRoot(home, target)}: still used by ${users.join(", ")}.`;
}

/**
 * Called after the registration is gone. Asks again rather than trusting the
 * dialog's answer, since a config can change while a modal is up.
 */
export function removeSkillsIfUnused(target: SkillTarget): string {
  const home = homedir();
  if (!hasInstalledSkills(home, target) || skillUsers(home, target).length > 0) return "";
  try {
    return `\n${describeRemovals(removeSkills(home, [target]))}`;
  } catch (e) {
    return `\nCould not remove the skills in ${skillsRoot(home, target)}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

const NOTIFIED_KEY = "modelog.skillsUpdateNotifiedFor";

/**
 * Once per release whose skills differ from the installed ones: say so, and
 * offer the same confirmation Enable shows. Installed skills are never
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
