import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  readClaudeConfig,
  backupAndWriteClaudeConfig,
  writeFileAtomically,
} from "../mcp/claudeConfigFile.ts";
import { withoutModelogServerEverywhere } from "../mcp/claudeConfig.ts";
import {
  codexClient,
  copilotCliClient,
  isRegisteredInConfigFile,
  mcpRemoveArgs,
  runCli,
  type CliClient,
} from "../mcp/cliRegistration.ts";
import { footprintPath, readFootprint, removeFootprint } from "./footprint.ts";
import {
  findSettingsFileWith,
  isSettingEnabled,
  listProfiles,
  settingsCandidates,
  withSettingDisabled,
} from "./settings.ts";

/**
 * Undoing everything Modelog wrote outside its own storage.
 *
 * **One module, two callers, by design.** `Modelog: Remove Modelog's Changes`
 * runs it with a UI and consent; `dist/uninstall.js` runs it unattended from
 * VS Code's `vscode:uninstall` hook. If those two had separate implementations
 * they would drift, and the silent one is precisely the one nobody would
 * notice had drifted.
 *
 * **What is deliberately absent: Modelog's own data.** Verified in VS Code
 * 1.105's shipped `ExtensionsLifecycle.postUninstall` — it runs the hook and
 * then unconditionally removes `globalStorageHome/<extension id>`, which is
 * where `modelog.db` and the deployed `mcp-server.mjs` live. Cleaning that up
 * here would be duplicating the editor. It is offered by the command only, for
 * a user who wants the data gone without uninstalling.
 */

export type Outcome =
  | { status: "done"; note: string }
  | { status: "nothing"; note: string }
  | { status: "failed"; note: string };

export interface CleanupItem {
  id: string;
  label: string;
  /** What running it will do, in the user's terms. Shown in the picker. */
  detail: string;
  /**
   * Whether the unattended hook runs this, and whether the command ticks it by
   * default. Destructive-but-optional items (backup files, collected data) are
   * false: a silent uninstall should restore configuration, not delete things
   * the user might still want.
   */
  recommended: boolean;
  run(): Outcome;
}

export interface CleanupContext {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** VS Code's `User` directory when known. The hook has no way to learn it and passes nothing. */
  userDir?: string;
  /** Modelog's own storage directory, for the optional data item. Omitted by the hook. */
  storageDir?: string;
}

/**
 * Probes for what is actually present and returns only the items with
 * something to do. An empty list is the correct, common answer for a user who
 * never turned any of this on — and is why the command can say "nothing to
 * clean up" rather than showing five no-op checkboxes.
 */
export function planCleanup(ctx: CleanupContext): CleanupItem[] {
  return [
    copilotLoggingItem(ctx),
    claudeCodeMcpItem(ctx),
    cliMcpItem(ctx, copilotCliClient(ctx.home)),
    cliMcpItem(ctx, codexClient(ctx.home)),
    backupFilesItem(ctx),
    collectedDataItem(ctx),
  ].filter((item): item is CleanupItem => item !== undefined);
}

/** Runs a selection and reports per item, because a partial success is the likely outcome and a single boolean would hide it. */
export function runCleanup(items: CleanupItem[]): { item: CleanupItem; outcome: Outcome }[] {
  return items.map((item) => {
    try {
      return { item, outcome: item.run() };
    } catch (e) {
      return {
        item,
        outcome: { status: "failed" as const, note: e instanceof Error ? e.message : String(e) },
      };
    }
  });
}

// --- the items -------------------------------------------------------------

/**
 * Only offered when Modelog is on record as having switched the setting on
 * (see `footprint.ts`). A user who enabled Copilot's debug logging themselves
 * gets it left alone — Modelog restores what it changed, not what it found.
 */
function copilotLoggingItem(ctx: CleanupContext): CleanupItem | undefined {
  const record = readFootprint(footprintPath(ctx.home))?.copilotLogging;
  if (!record) return undefined;

  const settingsFile = record.settingsFile ?? locateSettingsFile(ctx, record.key);

  return {
    id: "copilot-logging",
    label: "Switch Copilot's debug logging back off",
    detail: settingsFile
      ? `Sets ${record.key} to false in ${settingsFile}. Copilot stops writing prompt-bearing debug files.`
      : `Could not find the settings file holding ${record.key} — it will be reported, not guessed at.`,
    recommended: true,
    run(): Outcome {
      if (!settingsFile) {
        return {
          status: "failed",
          note: `Could not locate the settings file. Set "${record.key}" to false by hand — Copilot is still writing debug logs until you do.`,
        };
      }

      const text = readFileSync(settingsFile, "utf8");
      if (!isSettingEnabled(text, record.key)) {
        removeFootprint(footprintPath(ctx.home));
        return { status: "nothing", note: "Already off." };
      }

      const next = withSettingDisabled(text, record.key);
      if (next === null) {
        return {
          status: "failed",
          note: `"${record.key}" appears more than once in ${settingsFile}. Left alone — change it by hand.`,
        };
      }

      writeFileAtomically(settingsFile, next);
      removeFootprint(footprintPath(ctx.home));
      return { status: "done", note: `Set to false in ${settingsFile}.` };
    },
  };
}

function locateSettingsFile(ctx: CleanupContext, key: string): string | null {
  return findSettingsFileWith(
    settingsCandidates({
      home: ctx.home,
      userDir: ctx.userDir,
      platform: ctx.platform,
      env: ctx.env,
      profiles: ctx.userDir ? listProfiles(ctx.userDir) : [],
    }),
    key,
  );
}

function claudeConfigPath(home: string): string {
  return join(home, ".claude.json");
}

function claudeCodeMcpItem(ctx: CleanupContext): CleanupItem | undefined {
  const path = claudeConfigPath(ctx.home);
  const read = readClaudeConfig(path);
  if (read.status !== "ok") return undefined;

  const { removedFrom } = withoutModelogServerEverywhere(read.config);
  if (removedFrom.length === 0) return undefined;

  return {
    id: "claude-code-mcp",
    label: "Remove the MCP entry from Claude Code",
    detail: `Removes "modelog" from ${removedFrom.length} project${removedFrom.length === 1 ? "" : "s"} in ${path}. Every other server stays.`,
    recommended: true,
    run(): Outcome {
      // Re-read rather than reuse the probe's parse: the command shows a
      // confirmation first, and the file can change while it is on screen.
      const current = readClaudeConfig(path);
      if (current.status !== "ok") return { status: "failed", note: `${path} is no longer readable.` };

      const next = withoutModelogServerEverywhere(current.config);
      if (next.removedFrom.length === 0) return { status: "nothing", note: "Already removed." };

      backupAndWriteClaudeConfig(path, next.config);
      return { status: "done", note: `Removed from ${next.removedFrom.length} project(s) in ${path}.` };
    },
  };
}

/**
 * Codex and the Copilot CLI are unregistered the same way they were
 * registered — by running their own `mcp remove`, so neither config format
 * ever becomes Modelog's to write.
 *
 * The *probe* deliberately does not spawn anything (see
 * `isRegisteredInConfigFile`): VS Code kills the uninstall hook after five
 * seconds, and `copilot` costs ~417 ms per invocation. One spawn per client,
 * only when there is actually something to remove.
 */
function cliMcpItem(ctx: CleanupContext, client: CliClient): CleanupItem | undefined {
  if (!isRegisteredInConfigFile(client)) return undefined;

  return {
    id: `${client.id}-mcp`,
    label: `Remove the MCP entry from ${client.label}`,
    detail: `Runs "${client.bin} mcp remove modelog", which takes it out of ${client.configPath}. Every other server stays.`,
    recommended: true,
    run(): Outcome {
      const result = runCli(client.bin, mcpRemoveArgs(), { cwd: ctx.home, env: ctx.env });
      if (result.status === "ok") return { status: "done", note: `Removed from ${client.configPath}.` };
      return {
        status: "failed",
        note: result.status === "not-found" ? `"${client.bin}" could not be run.` : result.output,
      };
    },
  };
}

/**
 * The `.bak` copies Modelog takes before touching a foreign config.
 *
 * Not recommended, and never run by the hook. Modelog overwrites any existing
 * `<file>.bak`, so these are plausibly Modelog's own — but "plausibly" is not
 * grounds for an unattended delete of a file whose whole purpose is to be the
 * copy someone falls back on.
 */
function backupFilesItem(ctx: CleanupContext): CleanupItem | undefined {
  const paths = [
    `${claudeConfigPath(ctx.home)}.bak`,
    `${copilotCliClient(ctx.home).configPath}.bak`,
    `${codexClient(ctx.home).configPath}.bak`,
  ].filter((p) => existsSync(p));
  if (paths.length === 0) return undefined;

  return {
    id: "backups",
    label: `Delete the ${paths.length} backup file${paths.length === 1 ? "" : "s"} Modelog made`,
    detail: `${paths.join(", ")}. Modelog overwrites any earlier .bak at these paths, so check them first if you kept one.`,
    recommended: false,
    run(): Outcome {
      for (const path of paths) rmSync(path, { force: true });
      return { status: "done", note: `Deleted ${paths.length} file(s).` };
    },
  };
}

/**
 * Offered only by the command, and only unticked. Uninstalling removes this
 * anyway — VS Code deletes the whole storage directory — so the single reason
 * to run it is wanting the history gone while keeping the extension.
 */
function collectedDataItem(ctx: CleanupContext): CleanupItem | undefined {
  if (!ctx.storageDir) return undefined;
  const db = join(ctx.storageDir, "modelog.db");
  if (!existsSync(db)) return undefined;

  return {
    id: "collected-data",
    label: "Delete Modelog's collected usage history",
    detail: `${db}. Uninstalling deletes this on its own, so you only need this to start over. It cannot be undone, and history whose source logs have since been deleted cannot be rebuilt.`,
    recommended: false,
    run(): Outcome {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${db}${suffix}`, { force: true });
      return { status: "done", note: `Deleted ${db}.` };
    },
  };
}
