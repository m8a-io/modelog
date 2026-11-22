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

/** The server bundle imports `node:sqlite`; this matches `engines.node` in package.json. */
export const MIN_NODE_MAJOR = 24;

export type NodeCheck =
  | { status: "ok"; version: string }
  | { status: "missing" }
  | { status: "too-old"; version: string };

/**
 * Whether the `node` a client will spawn can actually run the server. Being
 * on PATH is not enough: an older system `node` passes {@link isNodeOnPath}
 * and then fails on `node:sqlite` at the next session start, out of sight.
 */
export function checkNode(env: NodeJS.ProcessEnv = process.env): NodeCheck {
  const result = spawnSync("node", ["--version"], { env, encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) return { status: "missing" };
  return classifyNodeVersion(result.stdout.trim());
}

/** Pure half of {@link checkNode}, for `v24.18.0`-style output. Unparseable output counts as too old: a visible refusal beats a silent failure. */
export function classifyNodeVersion(version: string): NodeCheck {
  const major = Number(/^v(\d+)\./.exec(version)?.[1]);
  return Number.isFinite(major) && major >= MIN_NODE_MAJOR
    ? { status: "ok", version }
    : { status: "too-old", version };
}

/**
 * The error to show when {@link checkNode} fails: what is wrong, why, and
 * the fix. The "why" is the part people miss: the extension host is not
 * started from a shell, so a PATH set in `~/.zshrc` or `~/.bashrc` (nvm, a
 * hand-installed Node) never reaches it, nor the client it starts the server
 * from (issue #39). Gives the extension host's own PATH, because that is the
 * list the fix has to target.
 */
export function nodeProblemMessage(
  check: Exclude<NodeCheck, { status: "ok" }>,
  clientLabel: string,
  pathValue: string = process.env.PATH ?? "",
): string {
  const problem =
    check.status === "missing"
      ? `"node" was not found on the PATH VS Code's extension host sees.`
      : `The "node" on the extension host's PATH is ${check.version}; the MCP server needs Node ${MIN_NODE_MAJOR} or later.`;
  return (
    `Modelog: ${problem} ${clientLabel} starts the MCP server by running "node" from this PATH. ` +
    "The extension host is not started from a shell, so PATH changes in ~/.zshrc or ~/.bashrc " +
    "(nvm, a hand-installed Node) do not reach it. Fix: link a Node " +
    `${MIN_NODE_MAJOR}+ binary into a directory on this PATH, for example ` +
    '`ln -s /path/to/node/bin/node ~/.local/bin/node`, then reload the window and retry. ' +
    `Extension host PATH: ${pathValue || "(empty)"}`
  );
}
