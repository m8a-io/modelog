import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { readClaudeConfig, writeFileAtomically } from "../mcp/claudeConfigFile.ts";
import { hasModelogServer } from "../mcp/claudeConfig.ts";
import { codexClient, copilotCliClient, isRegisteredInConfigFile } from "../mcp/cliRegistration.ts";
import {
  footprintDir,
  footprintPath,
  readFootprint,
  updateFootprint,
  type Footprint,
  type SkillRecord,
  type SkillTarget,
} from "./footprint.ts";

/**
 * Installing and removing Modelog's `/start`, `/handoff` and `/done` skills
 * (PRD §7.25; the installer decisions are in PLAN-recommendations.md,
 * "Work sessions").
 *
 * **One bundle, two roots.** The same three `SKILL.md` files go to
 * `~/.claude/skills/<name>/` for Claude Code and to `~/.agents/skills/<name>/`
 * for Codex, the Copilot CLI and Copilot Chat (PRD §7.24's verified table).
 * They are installed by "Enable MCP Server", never by a command of their own.
 *
 * **Removed on every path, edited or not.** An edited copy still calls Modelog
 * tools that are gone after an uninstall, so the hash recorded at install only
 * decides whether the removal *mentions* an edit. A `SKILL.md` that was at the
 * path before Modelog's is set aside under `~/.modelog/backups/` and put back.
 *
 * **Shared roots.** Each root serves several registrations (every Claude Code
 * project; three agents for `~/.agents`). Disable removes a root's skills
 * only when {@link skillUsers} finds no registration left that uses them.
 *
 * Pure Node, no `vscode`: the uninstall hook runs this too.
 */

export const SKILL_NAMES = ["start", "handoff", "done"] as const;

export interface BundledSkill {
  name: string;
  content: string;
}

/** The files shipped in the extension's own `skills/` directory, which the .vsix includes. */
export function readBundledSkills(extensionDir: string): BundledSkill[] {
  return SKILL_NAMES.map((name) => ({
    name,
    content: readFileSync(join(extensionDir, "skills", name, "SKILL.md"), "utf8"),
  }));
}

export function skillsRoot(home: string, target: SkillTarget): string {
  return target === "claude" ? join(home, ".claude", "skills") : join(home, ".agents", "skills");
}

export function skillPath(home: string, target: SkillTarget, name: string): string {
  return join(skillsRoot(home, target), name, "SKILL.md");
}

/** Outside the skill folder, so the assistant scanning it sees only one file. */
export function skillBackupPath(home: string, target: SkillTarget, name: string): string {
  return join(footprintDir(home), "backups", "skills", target, name, "SKILL.md");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// --- install ----------------------------------------------------------------

export type SkillAction =
  /** Nothing at the path. */
  | "create"
  /** Modelog's current version is already there. Recorded again, not rewritten. */
  | "unchanged"
  /** Modelog's earlier version, unedited. */
  | "update"
  /** Modelog's copy, edited by the developer since install. The edit is overwritten. */
  | "replace-edited"
  /** Someone else's `SKILL.md`. Set aside, then restored when Modelog's is removed. */
  | "back-up"
  /** Someone else's `SKILL.md`, and the backup path is already taken. Nothing is written. */
  | "blocked";

export interface SkillStep {
  name: string;
  path: string;
  action: SkillAction;
  content: string;
  sha256: string;
  backup?: string;
}

/**
 * Decides, per file, what installing would do. Reads only; the confirmation
 * shows the result before anything is written (MCP.md §7.3).
 */
export function planSkillInstall(
  home: string,
  target: SkillTarget,
  bundled: BundledSkill[],
  footprint: Footprint | null,
): SkillStep[] {
  const recorded = footprint?.skills ?? [];

  return bundled.map(({ name, content }): SkillStep => {
    const path = skillPath(home, target, name);
    const hash = sha256(content);
    const record = recorded.find((r) => r.path === path);
    const base = { name, path, content, sha256: hash, backup: record?.backup };

    if (!existsSync(path)) return { ...base, action: "create" };

    const current = sha256(readFileSync(path, "utf8"));
    if (current === hash) return { ...base, action: "unchanged" };
    if (record) return { ...base, action: current === record.sha256 ? "update" : "replace-edited" };

    // A backup with no record behind it belongs to an install whose footprint
    // was lost. Overwriting it could destroy the developer's only copy.
    const backup = skillBackupPath(home, target, name);
    return { ...base, backup, action: existsSync(backup) ? "blocked" : "back-up" };
  });
}

/**
 * Writes the planned files: backup first, then the file, then a read-back
 * against the hash. Each file is recorded in the footprint as soon as it is
 * written, so a failure part-way leaves nothing the uninstall cannot find.
 *
 * Refuses the whole bundle when any file is blocked: the three skills only
 * work together.
 */
export function installSkills(home: string, target: SkillTarget, steps: SkillStep[]): void {
  const blocked = steps.find((s) => s.action === "blocked");
  if (blocked) {
    throw new Error(
      `${blocked.path} is not Modelog's, and ${blocked.backup} already holds a backup Modelog has no record of. ` +
        "Nothing was installed. Move one of them aside, then enable again.",
    );
  }

  const fp = footprintPath(home);
  for (const step of steps) {
    if (step.action === "back-up" && step.backup) {
      mkdirSync(dirname(step.backup), { recursive: true });
      copyFileSync(step.path, step.backup);
    }
    if (step.action !== "unchanged") {
      mkdirSync(dirname(step.path), { recursive: true });
      writeFileAtomically(step.path, step.content);
    }
    if (sha256(readFileSync(step.path, "utf8")) !== step.sha256) {
      throw new Error(`${step.path} did not read back as written.`);
    }

    const record: SkillRecord = { target, name: step.name, path: step.path, sha256: step.sha256 };
    if (step.backup) record.backup = step.backup;
    updateFootprint(fp, (current) => ({
      ...current,
      skills: [...(current.skills ?? []).filter((r) => r.path !== step.path), record],
    }));
  }
}

const ACTION_TEXT: Record<SkillAction, string> = {
  create: "new",
  unchanged: "already installed, unchanged",
  update: "replaces Modelog's earlier version",
  "replace-edited": "replaces Modelog's copy, which was edited since install — the edit is lost",
  "back-up": "a SKILL.md that isn't Modelog's is here; it is moved to the backup below and put back when Modelog's is removed",
  blocked: "a SKILL.md that isn't Modelog's is here, and its backup path is taken — nothing will be installed",
};

/** The skills half of an Enable confirmation. */
export function describeSkillInstall(home: string, target: SkillTarget, steps: SkillStep[]): string {
  const lines = steps.map((s) => {
    const backup = s.action === "back-up" || s.action === "blocked" ? `\n      backup: ${s.backup}` : "";
    return `  /${s.name}  ${s.path}\n      ${ACTION_TEXT[s.action]}${backup}`;
  });
  return (
    `Installs the /start, /handoff and /done skills into ${skillsRoot(home, target)}:\n\n` +
    lines.join("\n") +
    "\n\nThey record your work sessions through this MCP server, and stop with a message when it isn't connected. " +
    "Disable and uninstall remove them."
  );
}

// --- who still uses a root --------------------------------------------------

export interface SkillUsersExcept {
  /** The Claude Code project being disabled. */
  claudeProject?: string;
  /** The agent being disabled. */
  client?: "codex" | "copilot-cli" | "copilot-chat";
}

/**
 * Which registrations still use a root, read from where each one lives: the
 * `modelog` entries in `~/.claude.json`, the Codex and Copilot CLI configs,
 * and the footprint flag for Copilot Chat, which has no config of its own.
 *
 * `except` lets a Disable dialog say beforehand what will happen; the caller
 * asks again after its own removal and acts on that answer.
 */
export function skillUsers(home: string, target: SkillTarget, except: SkillUsersExcept = {}): string[] {
  if (target === "claude") {
    const read = readClaudeConfig(join(home, ".claude.json"));
    if (read.status !== "ok") return [];
    return Object.keys(read.config.projects ?? {})
      .filter((p) => p !== except.claudeProject && hasModelogServer(read.config, p))
      .map((p) => `Claude Code in ${p}`);
  }

  const users: string[] = [];
  if (except.client !== "codex" && isRegisteredInConfigFile(codexClient(home))) users.push("Codex");
  if (except.client !== "copilot-cli" && isRegisteredInConfigFile(copilotCliClient(home)))
    users.push("GitHub Copilot CLI");
  if (except.client !== "copilot-chat" && readFootprint(footprintPath(home))?.copilotChatSkills)
    users.push("GitHub Copilot Chat");
  return users;
}

/**
 * The roots whose installed skills come from an older release: what Modelog
 * wrote there (the recorded hash) is not what this version ships. A developer's
 * own edit does not count, since the record is what Modelog wrote, not what
 * the file holds now. A skill missing from the record counts as outdated.
 */
export function outdatedSkillTargets(bundled: BundledSkill[], footprint: Footprint | null): SkillTarget[] {
  const records = footprint?.skills ?? [];
  const targets = [...new Set(records.map((r) => r.target))];
  return targets.filter((target) =>
    bundled.some(
      ({ name, content }) =>
        records.find((r) => r.target === target && r.name === name)?.sha256 !== sha256(content),
    ),
  );
}

/** One hash for the whole shipped bundle, so "notified for this release" is one stored string. */
export function bundleHash(bundled: BundledSkill[]): string {
  return sha256(bundled.map((s) => `${s.name}\0${s.content}`).join("\0"));
}

export function hasInstalledSkills(home: string, target: SkillTarget): boolean {
  return (readFootprint(footprintPath(home))?.skills ?? []).some((r) => r.target === target);
}

// --- remove -----------------------------------------------------------------

export type SkillRemovalResult = "removed" | "removed-edited" | "already-gone";

export interface SkillRemoval {
  path: string;
  result: SkillRemovalResult;
  /** Where the developer's own `SKILL.md` was put back from, when there was one. */
  restoredFrom?: string;
}

/**
 * Removes every recorded skill in the given roots, edited or not, and puts a
 * set-aside `SKILL.md` back. Directories are removed only when empty and never
 * recursively: anything else in them is not Modelog's.
 *
 * Safe to interrupt: a file is forgotten only after it is handled, and a
 * second run finds a missing file plus its backup and restores it.
 */
export function removeSkills(home: string, targets: SkillTarget[]): SkillRemoval[] {
  const fp = footprintPath(home);
  const records = (readFootprint(fp)?.skills ?? []).filter((r) => targets.includes(r.target));

  return records.map((record) => {
    let result: SkillRemovalResult = "already-gone";
    if (existsSync(record.path)) {
      result = sha256(readFileSync(record.path, "utf8")) === record.sha256 ? "removed" : "removed-edited";
    }

    let restoredFrom: string | undefined;
    if (record.backup && existsSync(record.backup)) {
      writeFileAtomically(record.path, readFileSync(record.backup, "utf8"));
      rmSync(record.backup);
      removeEmptyDirs(dirname(record.backup), footprintDir(home));
      restoredFrom = record.backup;
    } else {
      rmSync(record.path, { force: true });
      removeEmptyDirs(dirname(record.path), dirname(skillsRoot(home, record.target)));
    }

    updateFootprint(fp, (current) => ({
      ...current,
      skills: current.skills?.filter((r) => r.path !== record.path),
    }));

    const removal: SkillRemoval = { path: record.path, result };
    if (restoredFrom) removal.restoredFrom = restoredFrom;
    return removal;
  });
}

/** One line per file, for a notification or the uninstall hook's log. */
export function describeRemovals(removals: SkillRemoval[]): string {
  if (removals.length === 0) return "No Modelog skills were installed.";
  return removals
    .map((r) => {
      const what =
        r.result === "removed-edited"
          ? "edited since install, removed"
          : r.result === "already-gone"
            ? "already gone"
            : "removed";
      return `${r.path}: ${what}${r.restoredFrom ? `; your own SKILL.md was put back from ${r.restoredFrom}` : ""}.`;
    })
    .join("\n");
}

/** `rmdir` from `dir` upward, stopping before `stop` or at the first directory that isn't empty. */
function removeEmptyDirs(dir: string, stop: string): void {
  let current = dir;
  while (relative(stop, current) !== "" && !relative(stop, current).startsWith("..")) {
    try {
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}
