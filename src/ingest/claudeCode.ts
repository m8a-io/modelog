import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Turn, Diagnostic, ParseResult } from "./types.ts";
import { CAPTURE_VERSION } from "./capture.ts";
import type { SourceAdapter } from "./adapter.ts";

/**
 * Claude Code source adapter.
 *
 * Reads `~/.claude/projects/<slug>/<session-uuid>.jsonl` — append-only JSONL,
 * one record per line. Schema verified against real session logs (PRD §7.1).
 *
 * Pure: takes text, returns turns. No filesystem, no VS Code, no clock. That
 * is what makes it testable and what keeps the trust guarantees checkable.
 */

/** Locally generated records that are not API calls. Must never be counted. */
const SYNTHETIC_MODEL = "<synthetic>";

/** Every `.jsonl` under `root`, recursively — Claude Code writes nothing else there. */
function findJsonl(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findJsonl(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

export const claudeCodeAdapter: SourceAdapter = {
  source: "claude-code",
  mode: "tail",
  findFiles: (root) => findJsonl(root),
  parse: (text, file, startLine) => parseChunk(text, file, startLine),
};

export function parseChunk(text: string, file: string, startLine = 0): ParseResult {
  const turns: Turn[] = [];
  const diagnostics: Diagnostic[] = [];

  const endsClean = text.endsWith("\n");
  const lines = text.split("\n");
  // If the chunk does not end in a newline the last element is a partial
  // record — a watch that fired mid-write. Hold it for the next read.
  const remainder = endsClean ? "" : (lines.pop() ?? "");
  if (endsClean) lines.pop(); // trailing empty string after the final newline

  lines.forEach((line, i) => {
    const lineNo = startLine + i + 1;
    if (line.trim() === "") return;

    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      diagnostics.push({
        kind: "parse-error",
        file,
        line: lineNo,
        detail: "line is not valid JSON; skipped",
      });
      return;
    }

    const turn = toTurn(rec, file, lineNo, diagnostics);
    if (turn) turns.push(turn);
  });

  return { turns, diagnostics, remainder };
}

function toTurn(
  rec: unknown,
  file: string,
  line: number,
  diagnostics: Diagnostic[],
): Turn | null {
  if (!isObject(rec) || rec.type !== "assistant") return null;

  const message = rec.message;
  if (!isObject(message)) return null;

  const model = message.model;
  if (typeof model !== "string" || model === SYNTHETIC_MODEL) return null;

  const usage = message.usage;
  if (!isObject(usage)) {
    diagnostics.push({
      kind: "unknown-shape",
      file,
      line,
      detail: `assistant record for "${model}" has no usage object; skipped`,
    });
    return null;
  }

  const uuid = typeof rec.uuid === "string" ? rec.uuid : null;
  const sessionId = typeof rec.sessionId === "string" ? rec.sessionId : null;
  const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
  if (!uuid || !sessionId || Number.isNaN(ts)) {
    diagnostics.push({
      kind: "unknown-shape",
      file,
      line,
      detail: "record missing uuid, sessionId or a parseable timestamp; skipped",
    });
    return null;
  }

  const created = num(usage.cache_creation_input_tokens);
  const split = isObject(usage.cache_creation) ? usage.cache_creation : null;
  let w1h = split ? num(split.ephemeral_1h_input_tokens) : 0;
  let w5m = split ? num(split.ephemeral_5m_input_tokens) : 0;

  // The split is authoritative when present. When it is absent but tokens were
  // written, we must attribute them somewhere: 5-minute is the default TTL, so
  // that is the documented assumption — and we say so rather than hide it.
  if (!split && created > 0) {
    w5m = created;
    diagnostics.push({
      kind: "assumed-cache-ttl",
      file,
      line,
      detail: `no cache_creation split; assumed ${created} tokens at 5m TTL`,
    });
  }

  // Guard against a split that disagrees with the total.
  if (split && w1h + w5m !== created) {
    diagnostics.push({
      kind: "unknown-shape",
      file,
      line,
      detail: `cache_creation split (${w1h}+${w5m}) != total (${created}); used the split`,
    });
  }

  const details = isObject(usage.output_tokens_details) ? usage.output_tokens_details : null;

  return {
    uuid,
    sessionId,
    ts,
    model,
    inputTokens: num(usage.input_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWrite5mTokens: w5m,
    cacheWrite1hTokens: w1h,
    outputTokens: num(usage.output_tokens),
    thinkingTokens: details ? num(details.thinking_tokens) : 0,
    iterations: Array.isArray(usage.iterations) ? usage.iterations.length : 1,
    speed: typeof usage.speed === "string" ? usage.speed : null,
    inferenceGeo: typeof usage.inference_geo === "string" ? usage.inference_geo : null,
    entrypoint: typeof rec.entrypoint === "string" ? rec.entrypoint : null,
    isSidechain: rec.isSidechain === true,
    captureVersion: CAPTURE_VERSION,
    source: "claude-code",
    // Claude Code reports every token class outright and reports no cost, so
    // cost is derived from tokens and rates downstream.
    costNanoAiu: null,
    tokenBreakdown: "reported",
    cwd: typeof rec.cwd === "string" ? rec.cwd : null,
    gitBranch: typeof rec.gitBranch === "string" ? rec.gitBranch : null,
    sourceFile: file,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
