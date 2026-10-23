import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { ClaudeConfig } from "./claudeConfig.ts";

export type ReadConfigResult =
  | { status: "ok"; config: ClaudeConfig }
  | { status: "missing" }
  | { status: "invalid-json" };

/**
 * Three outcomes, not two: a missing file and an unparsable one both mean
 * "do not write," but for different reasons a caller needs to say correctly
 * (never used Claude Code here, vs. something is wrong with its config).
 */
export function readClaudeConfig(path: string): ReadConfigResult {
  if (!existsSync(path)) return { status: "missing" };
  try {
    const config = JSON.parse(readFileSync(path, "utf8"));
    return { status: "ok", config };
  } catch {
    return { status: "invalid-json" };
  }
}

/**
 * Copies the current file to `<path>.bak` (overwriting any previous backup)
 * before writing the replacement. Only ever called after a successful
 * `readClaudeConfig`, so there is always something at `path` to copy.
 */
export function backupAndWriteClaudeConfig(path: string, config: ClaudeConfig): void {
  copyFileSync(path, `${path}.bak`);
  writeFileAtomically(path, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Write via a sibling temp file and a rename, so the target is either the old
 * content or the new one and never a half-written file.
 *
 * This matters beyond ordinary tidiness because the same code runs inside VS
 * Code's `vscode:uninstall` hook, which the editor **SIGKILLs after five
 * seconds**. A kill landing inside a plain `writeFileSync` could leave a user
 * with a truncated `~/.claude.json` — which holds their Claude Code auth state
 * — or a truncated `settings.json`. `renameSync` within the same directory is
 * atomic, so no window exists for that.
 */
export function writeFileAtomically(path: string, contents: string): void {
  const temp = `${path}.modelog-tmp`;
  writeFileSync(temp, contents);
  renameSync(temp, path);
}
