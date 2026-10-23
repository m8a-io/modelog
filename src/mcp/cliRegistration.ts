import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Registration with the two assistants that own a CLI of their own — Codex and
 * the GitHub Copilot CLI.
 *
 * **Modelog does not write these files.** It shells out to the assistant's own
 * `mcp add` / `mcp remove` subcommand and lets the vendor edit the vendor's
 * format. That is a deliberate departure from the Claude Code path
 * (`claudeConfig.ts`), which does write, and the reason is specific to each:
 *
 * - **Codex's config is TOML** (`~/.codex/config.toml`) and carries far more
 *   than MCP entries — the selected model, reasoning effort, and a
 *   `trust_level` per project. There is no TOML serialiser in this project's
 *   dependencies and no built-in one in Node 24, and a hand-rolled rewrite
 *   would not round-trip comments. Verified 2026-10-22 against codex-cli
 *   0.162.0: `codex mcp add` preserves comments and every unrelated section,
 *   replaces an existing entry in place, and `codex mcp remove` takes only
 *   that entry back out.
 * - **The Copilot CLI coordinates writes with a lock** — adding a server
 *   creates `.mcp-writer.lock` and `.mcp-writer.binding` beside
 *   `~/.copilot/mcp-config.json`. Writing the JSON directly would step around
 *   a mechanism that exists precisely to stop two writers colliding.
 *
 * The cost is that `codex` or `copilot` must be on the extension host's PATH,
 * which is the same fragility MCP.md §7.2 already accepts for `node`. Callers
 * check with {@link isOnPath} and fall back to Copy Configuration.
 *
 * MCP.md §7.3's guarantee survives the change in mechanism: the caller shows
 * the exact command and the exact file it will touch, takes a backup via
 * {@link backupFile}, and only then runs it.
 */

/** The entry name used in every client's config, so Disable can find what Enable wrote. */
export const MCP_SERVER_NAME = "modelog";

export interface CliClient {
  id: "codex" | "copilot";
  /** How the assistant is named in UI copy. */
  label: string;
  /** The executable Modelog shells out to. */
  bin: string;
  /** The file that executable owns and will modify — shown to the user before anything runs. */
  configPath: string;
  /**
   * Whether `mcp add` overwrites an existing entry or refuses.
   *
   * Verified 2026-10-22: `codex` replaces silently; `copilot` (CLI 1.0.94)
   * exits non-zero with *"Server already exists. To update it, remove it
   * first"*. Re-registering therefore needs a remove first on Copilot only,
   * and a caller that assumed otherwise would fail with a message naming the
   * wrong problem.
   */
  addReplaces: boolean;
}

export function codexClient(home: string): CliClient {
  return {
    id: "codex",
    label: "Codex",
    bin: "codex",
    configPath: join(home, ".codex", "config.toml"),
    addReplaces: true,
  };
}

export function copilotCliClient(home: string): CliClient {
  return {
    id: "copilot",
    label: "GitHub Copilot CLI",
    bin: "copilot",
    configPath: join(home, ".copilot", "mcp-config.json"),
    addReplaces: false,
  };
}

/**
 * Both CLIs take the same shape — `mcp add <name> [--env K=V ...] -- <command> [args]`
 * — so one builder serves both. Verified against codex-cli 0.162.0 and GitHub
 * Copilot CLI 1.0.94 on 2026-10-22.
 *
 * `node` rather than `process.execPath`: these clients spawn the server
 * themselves, long after and possibly without VS Code, so the editor's own
 * Node is not available to them. This is the Target B constraint
 * (INSTALL-ux.md §2.2) applying to two more clients.
 */
export function mcpAddArgs(bundlePath: string, env: Record<string, string>): string[] {
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  return ["mcp", "add", MCP_SERVER_NAME, ...envArgs, "--", "node", bundlePath];
}

export function mcpRemoveArgs(): string[] {
  return ["mcp", "remove", MCP_SERVER_NAME];
}

/** `mcp get <name>` exits 0 when the entry exists and non-zero when it does not, on both CLIs (verified 2026-10-22). */
export function mcpGetArgs(): string[] {
  return ["mcp", "get", MCP_SERVER_NAME];
}

/**
 * Renders an argv as the command line a user could paste into a terminal, for
 * the confirmation dialog. Quoting is display-only — the real invocation never
 * goes through a shell — but it must not *look* copy-pasteable while being
 * wrong, so anything with whitespace or a shell metacharacter is quoted.
 */
export function formatCommand(bin: string, args: string[]): string {
  return [bin, ...args].map(quoteForDisplay).join(" ");
}

function quoteForDisplay(token: string): string {
  if (token.length > 0 && !/[\s"'$`\\&|;<>()*?]/.test(token)) return token;
  return `'${token.replaceAll("'", `'\\''`)}'`;
}

export type CliResult =
  | { status: "ok"; output: string }
  | { status: "failed"; output: string }
  | { status: "not-found" };

/**
 * Runs an assistant's CLI and collapses the three outcomes a caller must tell
 * apart: it ran and succeeded, it ran and refused (whose stderr is the only
 * accurate explanation available, so it is surfaced verbatim), or it was not
 * there at all.
 *
 * `cwd` is pinned to the home directory because both CLIs also honour a
 * *workspace* MCP config when one is in scope, and these commands are meant to
 * write the user-level one. Running from an arbitrary extension-host cwd would
 * make which file gets touched depend on something the user cannot see.
 */
export function runCli(
  bin: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv } = { cwd: process.cwd() },
): CliResult {
  const result = spawnSync(bin, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
  });

  if (result.error !== undefined) return { status: "not-found" };

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return result.status === 0 ? { status: "ok", output } : { status: "failed", output };
}

/**
 * Whether the client already carries a `modelog` entry — asked of the CLI
 * rather than by reading its config, so Codex's TOML never needs parsing here
 * and neither client's file format becomes Modelog's problem.
 *
 * Returns `undefined` when the CLI is absent, which is distinct from "not
 * registered": the status command must not report an absent assistant as one
 * that merely has not been set up.
 */
export function isRegisteredWithCli(client: CliClient, cwd: string): boolean | undefined {
  const result = runCli(client.bin, mcpGetArgs(), { cwd });
  return result.status === "not-found" ? undefined : result.status === "ok";
}

/**
 * Copies a config file to `<path>.bak` before a CLI is let near it, mirroring
 * what `backupAndWriteClaudeConfig` does for the one file Modelog writes
 * itself. A missing file is not an error — Codex and Copilot both create their
 * config on first `mcp add`, and there is nothing to preserve.
 */
export function backupFile(path: string): void {
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
}

/**
 * Whether the client's config file names a `modelog` entry, answered by
 * reading the file rather than by running the CLI.
 *
 * {@link isRegisteredWithCli} is the authoritative check and is what the
 * status command uses — it is the vendor's own parser. This exists because
 * **the uninstall hook is killed after five seconds** and each probe is a
 * process spawn (`copilot` alone measures ~417 ms). Planning the cleanup with
 * spawns cost 2.4 s of that budget on a warm machine; reading two files costs
 * nothing.
 *
 * It only ever gates an action whose authoritative step is still the vendor's
 * `mcp remove`, so being wrong is cheap in both directions: a false positive
 * attempts a removal that is a no-op, and a false negative leaves an entry for
 * the user to see in `MCP Server Status`. That is why a regular expression
 * over Codex's TOML is acceptable here and would not be for a write.
 */
export function isRegisteredInConfigFile(client: CliClient): boolean {
  let text: string;
  try {
    text = readFileSync(client.configPath, "utf8");
  } catch {
    return false;
  }

  if (client.id === "codex") return /^\s*\[mcp_servers\.modelog\]/m.test(text);

  try {
    const config = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
    return config.mcpServers?.[MCP_SERVER_NAME] !== undefined;
  } catch {
    return false;
  }
}
