import { spawnSync } from "node:child_process";

/**
 * Whether `bin` resolves on `PATH` in the given environment (defaulting to
 * this process's own), probed by running it with `--version`.
 *
 * Checked at enable-time because MCP.md §7.2 requires failing clearly, rather
 * than writing a client config entry whose `command` silently never spawns.
 * The same question is asked of three different executables — `node`, which
 * every registered entry names, and `codex` / `copilot`, which Modelog shells
 * out to rather than writing their config files itself — and each can be
 * absent independently.
 *
 * Note that `spawnSync` here does **not** go through a shell, so this answers
 * "is it on the extension host's PATH", not "would it work in your terminal".
 * Those differ exactly where INSTALL-ux.md §5 says they do: a GUI-launched
 * editor inherits no shell profile, so no nvm and no Homebrew.
 */
export function isOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const result = spawnSync(bin, ["--version"], { env, stdio: "ignore" });
  return result.error === undefined && result.status === 0;
}

/** The original, narrower question: see {@link isOnPath}. */
export function isNodeOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOnPath("node", env);
}
