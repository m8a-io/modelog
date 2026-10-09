import { readdirSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Turn, Diagnostic, ParseResult } from "./types.ts";
import { CAPTURE_VERSION } from "./capture.ts";
import type { SourceAdapter } from "./adapter.ts";

/**
 * GitHub Copilot CLI source adapter.
 *
 * Reads `~/.copilot/session-state/<sessionId>/events.jsonl` — one JSON
 * record per line, `{type, data, id, timestamp, parentId}`. This is a
 * different product from the Copilot Chat VS Code extension (`copilot.ts`):
 * separate on-disk store, separate event shape, no shared code between the
 * two adapters. Both normalize to `source: "copilot"` (same billing pool,
 * same `aiu_nano` unit — issue #9), distinguished only by `entrypoint`.
 * Schema verified against two real captured sessions — see
 * `test/fixtures/copilot-cli/` and `test/copilotCli.test.ts`.
 *
 * Unlike the Chat extension, this log states cache-write tokens, cost, and
 * the cache TTL tier directly — nothing here is solved or assumed. What it
 * does not pre-aggregate is the turn: a developer's one request can span
 * several `assistant.turn_start`/`turn_end` brackets (one per tool-use
 * round-trip), all sharing one `interactionId`. Records sharing an
 * `interactionId` are one Modelog turn, same shape as the Copilot Chat and
 * Codex adapters' own grouping, just keyed on a field this source states
 * outright instead of one this adapter has to infer.
 *
 * Pure: takes text, returns turns. No filesystem, no VS Code, no clock.
 */

/** The token/cost fields read off one `session.usage_record`. */
interface UsageLine {
  line: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Nano-AIU, as this source itself measured it — never solved. */
  costNanoAiu: number | null;
  /** 300 or 3600 on every request observed; anything else is unrecognised. */
  cacheTtlSeconds: number | null;
}

interface InteractionGroup {
  ts: number;
  records: UsageLine[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function toUsageLine(data: unknown, line: number): UsageLine | null {
  if (!isObject(data) || !isObject(data.usage)) return null;
  const usage = data.usage;
  const model = usage.model;
  if (typeof model !== "string") return null;

  const copilotUsage = isObject(usage.copilotUsage) ? usage.copilotUsage : null;

  return {
    line,
    model,
    inputTokens: num(usage.inputTokens),
    outputTokens: num(usage.outputTokens),
    cacheReadTokens: num(usage.cacheReadTokens),
    cacheWriteTokens: num(usage.cacheWriteTokens),
    reasoningTokens: num(usage.reasoningTokens),
    costNanoAiu: copilotUsage && typeof copilotUsage.totalNanoAiu === "number" ? copilotUsage.totalNanoAiu : null,
    cacheTtlSeconds: typeof usage.cacheTtlSeconds === "number" ? usage.cacheTtlSeconds : null,
  };
}

/**
 * Parse one Copilot CLI session log.
 *
 * `assistant.turn_start` carries the `interactionId` an `assistant.turn_end`
 * does not repeat, so the current interaction is tracked as scanning state
 * and every `session.usage_record` seen before the next `turn_start` is
 * attributed to it — verified against real logs to always appear inside the
 * bracket it belongs to, never after `turn_end`.
 */
export function parseCopilotCliChunk(text: string, file: string, startLine = 0): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const groups = new Map<string, InteractionGroup>();

  let sessionId: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let entrypoint: string | null = null;
  let currentInteractionId: string | null = null;

  const endsClean = text.endsWith("\n");
  const lines = text.split("\n");
  // A log being written to can end mid-record. Whole-file adapters re-read
  // from zero next pass, so an incomplete trailing line is simply dropped
  // rather than carried as a remainder.
  if (!endsClean) lines.pop();

  lines.forEach((line, i) => {
    const lineNo = startLine + i + 1;
    if (line.trim() === "") return;

    // Most of a real log is content this adapter never reads: user/system/
    // assistant messages and tool call arguments/results. Skip those lines
    // by a cheap substring check before parsing.
    if (
      !line.includes('"session.start"') &&
      !line.includes('"assistant.turn_start"') &&
      !line.includes('"assistant.turn_end"') &&
      !line.includes('"session.usage_record"')
    ) {
      return;
    }

    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      diagnostics.push({ kind: "parse-error", file, line: lineNo, detail: "line is not valid JSON; skipped" });
      return;
    }
    if (!isObject(rec) || !isObject(rec.data)) return;

    const type = rec.type;
    const data = rec.data;

    if (type === "session.start") {
      if (typeof data.sessionId === "string") sessionId = data.sessionId;
      if (isObject(data.context)) {
        if (typeof data.context.cwd === "string") cwd = data.context.cwd;
        if (typeof data.context.branch === "string") gitBranch = data.context.branch;
      }
      if (typeof data.producer === "string") entrypoint = data.producer;
      return;
    }

    if (type === "assistant.turn_start") {
      currentInteractionId = typeof data.interactionId === "string" ? data.interactionId : null;
      return;
    }

    if (type === "assistant.turn_end") return;

    if (type === "session.usage_record") {
      if (currentInteractionId === null) {
        diagnostics.push({
          kind: "unknown-shape",
          file,
          line: lineNo,
          detail: "usage_record seen outside any turn_start/turn_end bracket; skipped",
        });
        return;
      }
      const usageLine = toUsageLine(data, lineNo);
      if (!usageLine) {
        diagnostics.push({
          kind: "unknown-shape",
          file,
          line: lineNo,
          detail: "usage_record without a usage object or model; skipped",
        });
        return;
      }

      const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
      if (Number.isNaN(ts)) {
        diagnostics.push({
          kind: "unknown-shape",
          file,
          line: lineNo,
          detail: "usage_record has no parseable timestamp; skipped",
        });
        return;
      }

      let group = groups.get(currentInteractionId);
      if (!group) {
        group = { ts, records: [] };
        groups.set(currentInteractionId, group);
      }
      group.records.push(usageLine);
    }
  });

  const turns: Turn[] = [];
  const sid = sessionId ?? basename(dirname(file));

  for (const [interactionId, group] of groups) {
    const records = group.records;
    if (records.length === 0) continue;

    // Every real session measured keeps one model per interaction — a model
    // switch happens between interactions, not inside one doing tool
    // round-trips. A mixed group is a shape this adapter does not
    // understand, and picking one model would misattribute every token in
    // it (same format-drift rule the Copilot Chat adapter applies).
    const models = new Set(records.map((r) => r.model));
    if (models.size > 1) {
      diagnostics.push({
        kind: "unknown-shape",
        file,
        line: records[0]!.line,
        detail: `interaction spans ${models.size} models; skipped`,
      });
      continue;
    }

    let plain = 0;
    let cacheRead = 0;
    let cacheWrite5m = 0;
    let cacheWrite1h = 0;
    let output = 0;
    let thinking = 0;
    let cost: number | null = null;

    for (const r of records) {
      plain += r.inputTokens - r.cacheReadTokens - r.cacheWriteTokens;
      cacheRead += r.cacheReadTokens;
      output += r.outputTokens;
      // The underlying call is Anthropic's Messages API (apiEndpoint
      // "/v1/messages" on every record observed), whose own accounting
      // already folds thinking into outputTokens — same convention Claude
      // Code's own log uses. Not verified for a non-Anthropic model routed
      // through Copilot CLI.
      thinking += r.reasoningTokens;
      if (r.costNanoAiu !== null) cost = (cost ?? 0) + r.costNanoAiu;

      if (r.cacheWriteTokens > 0) {
        if (r.cacheTtlSeconds === 3600) cacheWrite1h += r.cacheWriteTokens;
        else {
          if (r.cacheTtlSeconds !== 300 && r.cacheTtlSeconds !== null) {
            diagnostics.push({
              kind: "unknown-shape",
              file,
              line: r.line,
              detail: `cache write with unrecognised cacheTtlSeconds ${r.cacheTtlSeconds}; priced at the 5-minute rate`,
            });
          }
          cacheWrite5m += r.cacheWriteTokens;
        }
      }
    }

    turns.push({
      // Deterministic, so a whole-file re-read upserts over itself rather
      // than duplicating.
      uuid: `${sid}:${interactionId}`,
      sessionId: sid,
      ts: group.ts,
      model: records[0]!.model,
      source: "copilot",
      inputTokens: plain,
      cacheReadTokens: cacheRead,
      cacheWrite5mTokens: cacheWrite5m,
      cacheWrite1hTokens: cacheWrite1h,
      outputTokens: output,
      thinkingTokens: thinking,
      iterations: records.length,
      // Anthropic/OpenAI-API pricing modifiers; they do not apply to a call
      // brokered by Copilot.
      speed: null,
      inferenceGeo: null,
      entrypoint,
      // Copilot CLI has a `--fleet` parallel-subagent mode this adapter has
      // not captured a session from — a known gap, not a measured `false`.
      isSidechain: false,
      captureVersion: CAPTURE_VERSION,
      costNanoAiu: cost,
      tokenBreakdown: "reported",
      cwd,
      gitBranch,
      sourceFile: file,
    });
  }

  turns.sort((a, b) => a.ts - b.ts);
  return { turns, diagnostics, remainder: "" };
}

/** Every `<sessionId>/events.jsonl` directly under `root`. */
export function findCopilotCliLogs(root: string): string[] {
  let sessions: string[];
  try {
    sessions = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const sid of sessions) {
    const f = join(root, sid, "events.jsonl");
    if (existsSync(f)) out.push(f);
  }
  return out.sort();
}

export const copilotCliAdapter: SourceAdapter = {
  source: "copilot",
  mode: "whole-file",
  findFiles: findCopilotCliLogs,
  parse: (text, file, startLine) => parseCopilotCliChunk(text, file, startLine),
};
