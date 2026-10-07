/**
 * Pure merge logic over Claude Code's `~/.claude.json`.
 *
 * That file is not a dedicated MCP config — on this machine it also carries
 * `oauthAccount`, `primaryApiKey`, caches, and more, alongside `projects`
 * (PLAN-part2.md Phase 3 preamble). Every function here touches only the one
 * path it is asked to touch and returns a full replacement object built by
 * shallow-spreading everything else untouched, so a bug here cannot silently
 * drop an unrelated key.
 */

export interface ClaudeConfigProject {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ClaudeConfig {
  projects?: Record<string, ClaudeConfigProject>;
  [key: string]: unknown;
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Adds or replaces the `modelog` entry under `projects[projectPath].mcpServers`.
 *
 * Returns `null` when `projectPath` is not already a known project — Claude
 * Code's own project objects carry fields Modelog does not know how to set
 * correctly (`hasTrustDialogAccepted`, `allowedTools`, ...), so inventing a
 * project entry from scratch risks writing one Claude Code did not create.
 * The caller should ask the user to open the folder in Claude Code first.
 */
export function withModelogServer(
  config: ClaudeConfig,
  projectPath: string,
  entry: McpServerEntry,
): ClaudeConfig | null {
  const project = config.projects?.[projectPath];
  if (!project) return null;

  return {
    ...config,
    projects: {
      ...config.projects,
      [projectPath]: {
        ...project,
        mcpServers: { ...project.mcpServers, modelog: entry },
      },
    },
  };
}

/**
 * Removes only the `modelog` entry from `projects[projectPath].mcpServers`,
 * leaving every sibling server and every other key untouched. Returns the
 * input unchanged (same reference) when there was nothing to remove, so a
 * caller can tell "already absent" from "removed" without a second read.
 */
export function withoutModelogServer(config: ClaudeConfig, projectPath: string): ClaudeConfig {
  const project = config.projects?.[projectPath];
  if (!project?.mcpServers || !("modelog" in project.mcpServers)) return config;

  const { modelog: _removed, ...remainingServers } = project.mcpServers;

  return {
    ...config,
    projects: {
      ...config.projects,
      [projectPath]: { ...project, mcpServers: remainingServers },
    },
  };
}

/** Whether `projectPath` already carries a `modelog` entry — used to decide which confirmation copy to show (adding vs. replacing). */
export function hasModelogServer(config: ClaudeConfig, projectPath: string): boolean {
  return Boolean(config.projects?.[projectPath]?.mcpServers?.modelog);
}
