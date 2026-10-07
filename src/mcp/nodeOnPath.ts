import { spawnSync } from "node:child_process";

/**
 * Whether `node` resolves on `PATH` in the given environment (defaulting to
 * this process's own). Checked at enable-time because MCP.md §7.2 requires
 * failing clearly, rather than writing a Claude Code config entry whose
 * `command: "node"` silently never spawns.
 */
export function isNodeOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  const result = spawnSync("node", ["--version"], { env, stdio: "ignore" });
  return result.error === undefined && result.status === 0;
}
