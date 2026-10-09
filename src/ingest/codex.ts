import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Turn, Diagnostic, ParseResult } from "./types.ts";
import { CAPTURE_VERSION } from "./capture.ts";
import type { SourceAdapter } from "./adapter.ts";

/**
 * Codex source adapter.
 *
 * Reads `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl` —
 * one JSON record per line, `{timestamp, ordinal, type, payload}`. The CLI
 * and the official `openai.chatgpt` VS Code extension share this one
 * on-disk store, so one adapter covers both surfaces. Schema verified
 * against two real captured sessions — see `test/fixtures/codex/` and
 * `test/codexFixture.test.ts` for the exact shapes this was built against.
 *
 * Unlike Claude Code's log, a Codex rollout does not pre-aggregate a turn's
 * usage into one line: one logical turn (`turn_id`) is spread across many
 * `token_usage_record` lines, one per underlying model/tool round-trip. So
 * this adapter aggregates across lines the same way the Copilot adapter
 * does — whole-file, grouped by a turn-identifying key — rather than the
 * one-line-one-turn mapping Claude Code uses.
 *
 * Pure: takes text, returns turns. No filesystem, no VS Code, no clock.
 */

/** The four token classes Codex reports per request, already as plain counts. */
interface UsageTotals {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

interface UsageLine {
  line: number;
  ts: number;
  sessionId: string | null;
  rootTurnId: string | null;
  turnTokenUsage: UsageTotals;
}

interface TurnGroup {
  records: UsageLine[];
  /** The model in force (per `thread_settings_applied`) when this turn's first request arrived. */
  threadModelAtStart: string | null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function usageTotals(v: unknown): UsageTotals | null {
  if (!isObject(v)) return null;
  return {
    input_tokens: num(v.input_tokens),
    cached_input_tokens: num(v.cached_input_tokens),
    cache_write_input_tokens: num(v.cache_write_input_tokens),
    output_tokens: num(v.output_tokens),
    reasoning_output_tokens: num(v.reasoning_output_tokens),
  };
}

export function parseCodexChunk(text: string, file: string, startLine = 0): ParseResult {
  const diagnostics: Diagnostic[] = [];

  const endsClean = text.endsWith("\n");
  const lines = text.split("\n");
  // Whole-file adapters re-read from zero next pass, so an incomplete
  // trailing line is simply dropped rather than carried as a remainder.
  if (!endsClean) lines.pop();

  let fileSessionId: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let entrypoint: string | null = null;

  let threadModel: string | null = null;
  const turnModel = new Map<string, string>();
  const turnTrigger = new Map<string, string | null>();
  const groups = new Map<string, TurnGroup>();

  lines.forEach((line, i) => {
    const lineNo = startLine + i + 1;
    if (line.trim() === "") return;

    // Most of a real rollout is content this adapter never reads — the
    // system prompt, every message/reasoning/tool-call body, and compaction
    // summaries. Skip those lines by a cheap substring check before parsing.
    if (
      !line.includes('"session_meta"') &&
      !line.includes('"turn_context"') &&
      !line.includes('"token_usage_record"') &&
      !line.includes('"task_started"') &&
      !line.includes('"thread_settings_applied"')
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
    if (!isObject(rec) || !isObject(rec.payload)) return;

    const type = rec.type;
    const payload = rec.payload;

    if (type === "session_meta") {
      if (typeof payload.session_id === "string") fileSessionId = payload.session_id;
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      if (typeof payload.originator === "string") entrypoint = payload.originator;
      if (isObject(payload.git) && typeof payload.git.branch === "string") gitBranch = payload.git.branch;
      return;
    }

    if (type === "turn_context") {
      const turnId = payload.turn_id;
      const model = payload.model;
      if (typeof turnId !== "string" || typeof model !== "string") return;
      const prev = turnModel.get(turnId);
      if (prev !== undefined && prev !== model) {
        diagnostics.push({
          kind: "unknown-shape",
          file,
          line: lineNo,
          detail: `turn ${turnId} has conflicting turn_context models ("${prev}" then "${model}"); used the later one`,
        });
      }
      turnModel.set(turnId, model);
      return;
    }

    if (type === "event_msg") {
      const subtype = payload.type;

      if (subtype === "thread_settings_applied") {
        const settings = payload.thread_settings;
        if (isObject(settings) && typeof settings.model === "string") threadModel = settings.model;
        return;
      }

      if (subtype === "task_started") {
        const turnId = payload.turn_id;
        if (typeof turnId !== "string") return;
        const attribution = payload.turn_attribution;
        const trigger =
          isObject(attribution) && typeof attribution.turn_trigger === "string"
            ? attribution.turn_trigger
            : null;
        turnTrigger.set(turnId, trigger);
      }
      return;
    }

    if (type === "token_usage_record") {
      const turnId = payload.turn_id;
      if (typeof turnId !== "string") return;

      const totals = usageTotals(payload.turn_token_usage);
      if (!totals) {
        diagnostics.push({
          kind: "unknown-shape",
          file,
          line: lineNo,
          detail: "token_usage_record has no turn_token_usage object; skipped",
        });
        return;
      }

      const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
      if (Number.isNaN(ts)) {
        diagnostics.push({
          kind: "unknown-shape",
          file,
          line: lineNo,
          detail: "token_usage_record has no parseable timestamp; skipped",
        });
        return;
      }

      let group = groups.get(turnId);
      if (!group) {
        group = { records: [], threadModelAtStart: threadModel };
        groups.set(turnId, group);
      }
      group.records.push({
        line: lineNo,
        ts,
        sessionId: typeof payload.session_id === "string" ? payload.session_id : null,
        rootTurnId: typeof payload.root_turn_id === "string" ? payload.root_turn_id : null,
        turnTokenUsage: totals,
      });
    }
  });

  const turns: Turn[] = [];

  for (const [turnId, group] of groups) {
    const records = group.records;
    if (records.length === 0) continue;

    const model = turnModel.get(turnId) ?? group.threadModelAtStart;
    if (!model) {
      diagnostics.push({
        kind: "unknown-shape",
        file,
        line: records[0]!.line,
        detail: `turn ${turnId} has no resolvable model (no turn_context and no prior thread_settings_applied); skipped`,
      });
      continue;
    }

    const first = records[0]!;
    const last = records[records.length - 1]!;
    const sessionId = fileSessionId ?? first.sessionId;
    if (!sessionId) {
      diagnostics.push({
        kind: "unknown-shape",
        file,
        line: first.line,
        detail: `turn ${turnId} has no resolvable sessionId; skipped`,
      });
      continue;
    }

    const cumulative = last.turnTokenUsage;
    const cacheWrite = cumulative.cache_write_input_tokens;
    if (cacheWrite > 0) {
      diagnostics.push({
        kind: "assumed-cache-ttl",
        file,
        line: last.line,
        detail: "Codex does not state a cache-write TTL tier; assumed 5m",
      });
    }

    const trigger = turnTrigger.get(turnId);
    const isSidechain =
      (first.rootTurnId !== null && first.rootTurnId !== turnId) ||
      (typeof trigger === "string" && trigger !== "user");

    turns.push({
      uuid: turnId,
      sessionId,
      ts: first.ts,
      model,
      source: "codex",
      // Codex's input_tokens includes cached_input_tokens (OpenAI-shaped,
      // unlike Anthropic's already-exclusive count) — subtract, same reason
      // the Copilot adapter does the same subtraction.
      inputTokens: cumulative.input_tokens - cumulative.cached_input_tokens,
      cacheReadTokens: cumulative.cached_input_tokens,
      cacheWrite5mTokens: cacheWrite,
      cacheWrite1hTokens: 0,
      outputTokens: cumulative.output_tokens,
      // Already included in outputTokens (input + output == total on every
      // real request observed) — display-only, never re-added.
      thinkingTokens: cumulative.reasoning_output_tokens,
      iterations: records.length,
      // Anthropic-API pricing modifiers; do not apply to an OpenAI-brokered call.
      speed: null,
      inferenceGeo: null,
      entrypoint,
      isSidechain,
      captureVersion: CAPTURE_VERSION,
      // Codex reports token counts but no per-request dollar cost anywhere in
      // the log, so cost is derived from tokens and rates downstream, same as
      // Claude Code.
      costNanoAiu: null,
      tokenBreakdown: "reported",
      cwd,
      gitBranch,
      sourceFile: file,
    });
  }

  turns.sort((a, b) => a.ts - b.ts);
  return { turns, diagnostics, remainder: "" };
}

/** Every `rollout-*.jsonl` under `root`, recursively. */
function findRollouts(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findRollouts(p, out);
    else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

export const codexAdapter: SourceAdapter = {
  source: "codex",
  mode: "whole-file",
  findFiles: (root) => findRollouts(root),
  parse: (text, file, startLine) => parseCodexChunk(text, file, startLine),
};
