import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomically } from "../mcp/claudeConfigFile.ts";

/**
 * The one piece of state the uninstall hook cannot work out for itself.
 *
 * Everything else Modelog writes lives at a fixed, home-relative path the hook
 * can derive (`~/.claude.json`, `~/.codex/config.toml`,
 * `~/.copilot/mcp-config.json`). Copilot's debug-logging setting does not: it
 * lives in VS Code's user settings, whose location varies by platform, by
 * profile, and by whether the extension host is remote — and in a Remote-WSL
 * window it is not even on the same machine as the extension host.
 *
 * More importantly, the hook must know *whether Modelog turned it on*.
 * `enableCopilotAnalysis` only ever flips the setting false → true and returns
 * early when it was already on, so a user who enabled Copilot's logging
 * themselves must get it back untouched. Without this record the hook could
 * only see "the setting is on", which does not distinguish the two.
 *
 * Why a file in `$HOME` rather than `globalState`: the hook is a bare Node
 * process with no `vscode` module, and `globalState` lives in a SQLite
 * database whose path has exactly the same discovery problem. The directory is
 * deleted by the cleanup itself, so it does not outlive what it describes.
 */

export interface CopilotLoggingRecord {
  /** The setting Modelog set, recorded rather than restated, so the hook cannot drift from the extension. */
  key: string;
  /**
   * The settings file confirmed to contain that key, or `null` when none could
   * be confirmed. Null is a real outcome, not a failure to try: the cleanup
   * reports it and names the key for the user instead of editing a file it
   * guessed at.
   */
  settingsFile: string | null;
}

/** Which of the two skill roots a skill file was installed into (`skills.ts`). */
export type SkillTarget = "claude" | "agents";

/**
 * One `SKILL.md` Modelog wrote, recorded so the uninstall hook can remove it
 * without the extension (PRD §7.15). The hash is what Modelog wrote: a file
 * that no longer matches was edited, which is logged and then removed anyway.
 */
export interface SkillRecord {
  target: SkillTarget;
  name: string;
  path: string;
  sha256: string;
  /** The developer's own `SKILL.md` that was at `path` before install, saved here and restored on removal. */
  backup?: string;
}

export interface Footprint {
  version: 1;
  /** Present only while Modelog is the reason Copilot's debug logging is on. */
  copilotLogging?: CopilotLoggingRecord;
  /** Modelog's installed `/start`, `/handoff` and `/done` skills, in both roots. */
  skills?: SkillRecord[];
  /**
   * Copilot Chat's claim on `~/.agents/skills`. Codex and the Copilot CLI have
   * a config entry that says they are enabled; Copilot Chat has none (MCP.md
   * §7.4), so without this flag disabling Codex could not tell that Copilot
   * Chat still uses the skills.
   */
  copilotChatSkills?: true;
}

export function footprintDir(home: string): string {
  return join(home, ".modelog");
}

export function footprintPath(home: string): string {
  return join(footprintDir(home), "uninstall.json");
}

/** A missing or unreadable footprint is "nothing recorded", never an error — the cleanup simply has less to go on. */
export function readFootprint(path: string): Footprint | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Footprint;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Atomic, because the uninstall hook may read this file while a window is
 * writing it, and a half-written footprint reads as "nothing recorded".
 */
export function writeFootprint(path: string, footprint: Footprint): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileAtomically(path, JSON.stringify(footprint, null, 2) + "\n");
}

/**
 * Read, change, write — and remove the file once no field is left.
 *
 * Every field is cleared through here, so clearing one can never drop
 * another. (Until 0.9.0 clearing Copilot logging deleted the whole file,
 * which was harmless only while that was the file's one field.)
 */
export function updateFootprint(path: string, change: (current: Footprint) => Footprint): void {
  const next = change(readFootprint(path) ?? { version: 1 });
  if (next.skills?.length === 0) delete next.skills;
  for (const key of Object.keys(next) as (keyof Footprint)[]) {
    if (next[key] === undefined) delete next[key];
  }

  if (Object.keys(next).every((key) => key === "version")) removeFootprint(path);
  else writeFootprint(path, next);
}

/**
 * Records, or forgets, that Modelog is the reason Copilot's logging is on.
 * Forgetting is what `Modelog: Disable Copilot Analysis` does — once the user
 * has turned it off again there is nothing left to undo, and a stale record
 * would make a later cleanup switch off a setting the user had re-enabled
 * themselves in the meantime.
 */
export function recordCopilotLogging(
  path: string,
  record: CopilotLoggingRecord | undefined,
): void {
  updateFootprint(path, (current) => ({ ...current, copilotLogging: record }));
}

/**
 * Removes the file, then the directory, but only if the directory is empty
 * (it also holds `backups/` while a developer's own skill is set aside).
 *
 * `rmdirSync` rather than `rmSync({ recursive: true })` deliberately: it
 * throws `ENOTEMPTY` instead of deleting whatever else is in there. `~/.modelog`
 * is a path a user could reasonably put something of their own into, and the
 * cleanup's whole premise is removing only what Modelog put there.
 */
export function removeFootprint(path: string): void {
  rmSync(path, { force: true });
  try {
    rmdirSync(join(path, ".."));
  } catch {
    // Non-empty or already gone. Either way there is nothing safe to do here.
  }
}
