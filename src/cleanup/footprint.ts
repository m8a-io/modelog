import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

export interface Footprint {
  version: 1;
  /** Present only while Modelog is the reason Copilot's debug logging is on. */
  copilotLogging?: CopilotLoggingRecord;
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

export function writeFootprint(path: string, footprint: Footprint): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(footprint, null, 2) + "\n");
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
  const current = readFootprint(path) ?? { version: 1 as const };
  const next: Footprint = { ...current, copilotLogging: record };
  if (record === undefined) delete next.copilotLogging;

  if (next.copilotLogging === undefined) removeFootprint(path);
  else writeFootprint(path, next);
}

/**
 * Removes the file, then the directory — but only if the directory is empty.
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
