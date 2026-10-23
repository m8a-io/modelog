import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The one setting Modelog ever writes outside its own namespace. */
export const COPILOT_LOGGING_SETTING = "github.copilot.chat.agentDebugLog.fileLogging.enabled";

/**
 * Where VS Code's user settings might be.
 *
 * **Candidates, deliberately — not a derivation.** `copilotLogPaths` in
 * `extension.ts` derives Copilot's log roots from `globalStorageUri` and is
 * right to; the same trick does *not* work here. Measured on the development
 * machine (Remote-WSL): `~/.vscode-server/data/User/` contains
 * `globalStorage`, `History`, `profiles` and `workspaceStorage` — and **no
 * `settings.json` at all**, because in a remote window the user settings file
 * is on the client. A derivation would have been confidently wrong in the
 * exact environment this was written in.
 *
 * So the list is broad and the answer is confirmed by reading the file
 * (`findSettingsFileWith`) rather than by trusting the path. A candidate that
 * does not exist, or does not contain the key, costs nothing.
 */
export function settingsCandidates(opts: {
  home: string;
  /** VS Code's `User` directory, when it is known — two levels above `globalStorageUri`. */
  userDir?: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Profile directory names found under `<userDir>/profiles`; VS Code gives each profile its own settings file. */
  profiles?: string[];
}): string[] {
  const { home, userDir, platform, env, profiles = [] } = opts;
  const candidates: string[] = [];

  if (userDir) {
    candidates.push(join(userDir, "settings.json"));
    for (const profile of profiles) candidates.push(join(userDir, "profiles", profile, "settings.json"));
  }

  // Remote machine settings — a separate scope from user settings, on the
  // remote filesystem. Present on this development machine and carrying this
  // very key, so it is not hypothetical.
  candidates.push(join(home, ".vscode-server", "data", "Machine", "settings.json"));

  const appNames = ["Code", "Code - Insiders", "VSCodium"];
  for (const app of appNames) {
    if (platform === "darwin") {
      candidates.push(join(home, "Library", "Application Support", app, "User", "settings.json"));
    } else if (platform === "win32") {
      const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
      candidates.push(join(appData, app, "User", "settings.json"));
    } else {
      candidates.push(join(env.XDG_CONFIG_HOME ?? join(home, ".config"), app, "User", "settings.json"));
    }
  }

  return [...new Set(candidates)];
}

/** Profile directory names, read off disk. Absent or unreadable means "no profiles", which is the common case. */
export function listProfiles(userDir: string): string[] {
  try {
    return readdirSync(join(userDir, "profiles"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * The first candidate that actually has the key switched on. Confirmation by
 * content, so a wrong guess in {@link settingsCandidates} cannot cause a
 * wrong edit — it simply does not match.
 */
export function findSettingsFileWith(candidates: string[], key: string): string | null {
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      if (isSettingEnabled(readFileSync(path, "utf8"), key)) return path;
    } catch {
      continue;
    }
  }
  return null;
}

function keyPattern(key: string): RegExp {
  // The key contains dots, which are regex metacharacters.
  return new RegExp(`("${key.replaceAll(".", "\\.")}"\\s*:\\s*)true\\b`, "g");
}

export function isSettingEnabled(text: string, key: string): boolean {
  return keyPattern(key).test(text);
}

/**
 * Switches one key from `true` to `false`, leaving every other byte of the
 * file exactly as it was.
 *
 * **A surgical text edit rather than a parse-and-reserialise**, because
 * `settings.json` is JSONC: comments and trailing commas are legal there and
 * common in practice, so `JSON.parse` would throw on a perfectly normal file
 * — and a reserialise would strip a user's comments even when it succeeded.
 *
 * Returns `null` unless there is **exactly one** match. Zero means someone
 * already turned it off; more than one means the file is shaped in a way this
 * does not understand. Either way the honest move is to change nothing and
 * let the caller report it, rather than edit the wrong occurrence.
 *
 * Set to `false` rather than deleted, which is what `Modelog: Disable Copilot
 * Analysis` does too: removing a line risks leaving an invalid comma, and the
 * effect on Copilot is identical.
 */
export function withSettingDisabled(text: string, key: string): string | null {
  const matches = text.match(keyPattern(key));
  if (matches?.length !== 1) return null;
  return text.replace(keyPattern(key), "$1false");
}
