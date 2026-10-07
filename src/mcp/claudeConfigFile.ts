import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}
