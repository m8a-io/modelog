/**
 * Pure merge logic over Claude Code's `~/.claude.json`.
 *
 * That file is not a dedicated MCP config: it also carries `oauthAccount`,
 * `primaryApiKey`, caches and more, alongside `projects` (PLAN-part2.md
 * Phase 3 preamble). Every function here touches only the `modelog` key it is
 * asked to touch and returns a full replacement object built by
 * shallow-spreading everything else untouched, so a bug here cannot silently
 * drop an unrelated key.
 *
 * **Modelog registers at user scope** (issue #39): the top-level `mcpServers`
 * map, which Claude Code reads for every project. This is what
 * `claude mcp add --scope user` writes. Verified in the bundled CLI of the
 * Claude Code VS Code extension 2.1.319: user-scope servers are read from the
 * global config's `mcpServers`.
 *
 * Earlier versions wrote `projects[<path>].mcpServers.modelog` instead. That
 * failed whenever Claude Code had no entry for the folder, and it creates
 * those entries lazily, only once a per-project setting changes, so a fresh
 * IDE-only install may have no `projects` key at all. It was also tied to one
 * folder, while Modelog belongs to the editor, not to a project.
 *
 * **Legacy per-project entries shadow the user-scope one.** Claude Code merges
 * scopes as `{...user, ...project, ...local, ...}` (same source), and
 * `projects[<path>]` is "local". So Enable removes them, and Disable and
 * cleanup remove them along with the user-scope entry.
 */

export interface ClaudeConfigProject {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ClaudeConfig {
  mcpServers?: Record<string, unknown>;
  projects?: Record<string, ClaudeConfigProject>;
  [key: string]: unknown;
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ModelogRemoval {
  config: ClaudeConfig;
  /** Whether the user-scope entry was present and removed. */
  removedUser: boolean;
  /** Projects whose legacy per-project entry was removed. */
  removedFrom: string[];
}

/** Whether the user-scope `modelog` entry is present. */
export function hasModelogServer(config: ClaudeConfig): boolean {
  return Boolean(config.mcpServers?.modelog);
}

/** Projects still carrying a legacy per-project `modelog` entry (written by Modelog 0.9.2 and earlier). */
export function projectsWithModelogServer(config: ClaudeConfig): string[] {
  return Object.entries(config.projects ?? {})
    .filter(([, project]) => Boolean(project?.mcpServers?.modelog))
    .map(([path]) => path);
}

/**
 * Adds or replaces the user-scope `modelog` entry, and removes every legacy
 * per-project entry, which would otherwise shadow it in that folder.
 *
 * Needs no project, so it works whether or not `projects` exists, and in any
 * folder or multi-root workspace.
 */
export function withModelogServer(
  config: ClaudeConfig,
  entry: McpServerEntry,
): { config: ClaudeConfig; migratedFrom: string[] } {
  const { config: withoutLegacy, removedFrom } = withoutLegacyEntries(config);
  return {
    config: {
      ...withoutLegacy,
      mcpServers: { ...withoutLegacy.mcpServers, modelog: entry },
    },
    migratedFrom: removedFrom,
  };
}

/**
 * Removes the user-scope `modelog` entry and every legacy per-project one,
 * leaving every sibling server and every other key untouched. Used by Disable
 * and by uninstall cleanup alike. A registration made at user scope is not
 * tied to a folder, so removing it can't be either.
 *
 * Returns the input unchanged (same reference) when there was nothing to
 * remove, so a caller can tell "already absent" from "removed" without a
 * second read.
 */
export function withoutModelogServer(config: ClaudeConfig): ModelogRemoval {
  const { config: withoutLegacy, removedFrom } = withoutLegacyEntries(config);
  const removedUser = hasModelogServer(withoutLegacy);
  if (!removedUser) return { config: withoutLegacy, removedUser, removedFrom };

  const { modelog: _removed, ...remainingServers } = withoutLegacy.mcpServers!;
  return {
    config: { ...withoutLegacy, mcpServers: remainingServers },
    removedUser,
    removedFrom,
  };
}

function withoutLegacyEntries(config: ClaudeConfig): { config: ClaudeConfig; removedFrom: string[] } {
  const removedFrom = projectsWithModelogServer(config);
  if (removedFrom.length === 0) return { config, removedFrom };

  const projects = { ...config.projects };
  for (const path of removedFrom) {
    const project = projects[path];
    const { modelog: _removed, ...remainingServers } = project.mcpServers!;
    projects[path] = { ...project, mcpServers: remainingServers };
  }
  return { config: { ...config, projects }, removedFrom };
}
