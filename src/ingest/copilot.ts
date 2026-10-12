import { readdirSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Turn, Diagnostic, ParseResult, TokenBreakdown } from "./types.ts";
import { CAPTURE_VERSION } from "./capture.ts";
import type { SourceAdapter } from "./adapter.ts";
import { loadCard, type CopilotCard, type CopilotPrices } from "./copilotCard.ts";

/**
 * GitHub Copilot source adapter.
 *
 * Reads `workspaceStorage/{hash}/GitHub.copilot-chat/debug-logs/{sessionId}/`
 * — OTel-shaped JSONL, one span per line. Verified against two real captured
 * sessions on Copilot Chat 0.66.0 and 0.68.0 (PRD §7.1 Corrections).
 *
 * Three things in here are not what PRD §7.1's original dossier described, and
 * each is load-bearing. See the Corrections block there for the measurements.
 *
 * Pure: takes text and a rate card, returns turns. The filesystem lives in the
 * adapter wrapper at the bottom, so the parsing itself stays testable.
 */

/** Only these two filenames are ever read. */
const MAIN_LOG = "main.jsonl";
const SUBAGENT_PREFIX = "executionSubagent-";

/**
 * Prompt and code content, which Modelog never reads (PRD §8.1, invariant 1).
 *
 * The same span that carries token counts also carries `userRequest` and
 * `inputMessages`, exactly as a Claude Code record carries `message.content`
 * beside `message.usage`. So attrs are read by name, one at a time, and the
 * attrs object is never copied or spread. The sibling `transcripts/` directory,
 * `system_prompt_*.json` and `tools_*.json` are pure content and are never
 * opened at all — which is why discovery below matches on path shape rather
 * than on the `.jsonl` extension.
 */

interface LlmRequest {
  parentSpanId: string;
  ts: number;
  model: string;
  debugName: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costNanoAiu: number | null;
  line: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Recover the cache-write token count for one request.
 *
 * Copilot bills cache writes but does not report them. Two equations, two
 * unknowns — the token identity and Copilot's own billing formula:
 *
 *     inputTokens = plain + cached + write
 *     cost        = plain·ip + write·wp + cached·rp + out·op
 *
 * which solves to:
 *
 *     write = [ cost − (in − cached)·ip − cached·rp − out·op ] / (wp − ip)
 *
 * All integer arithmetic in nano-AIU, with the division checked for
 * exactness: a naive floating-point form produces values like
 * `2.0000000000023306`, and a token count is a whole number or it is not
 * known.
 *
 * Returns null when the equation cannot determine the split — a degenerate
 * card where `wp == ip` (a model priced at zero throughout), a non-integral
 * result, or a negative one. Null means **unknown**, never zero: reporting a
 * zero cache-write would be a confident wrong number, which is the one thing
 * this product must not do.
 *
 * Verified against every request of two real sessions: where the alternative
 * successor-delta method is also defined, the two agree exactly, and this
 * additionally resolves the last request of each turn, which that method
 * cannot reach.
 */
export function solveCacheWrite(
  req: { inputTokens: number; outputTokens: number; cachedTokens: number; costNanoAiu: number | null },
  p: CopilotPrices,
): number | null {
  if (req.costNanoAiu === null) return null;

  const denominator = p.cacheWrite - p.input;
  if (denominator === 0) return null;

  const plainAtInputRate = (req.inputTokens - req.cachedTokens) * p.input;
  const numerator =
    req.costNanoAiu - plainAtInputRate - req.cachedTokens * p.cacheRead - req.outputTokens * p.output;

  if (numerator % denominator !== 0) return null;
  const write = numerator / denominator;
  if (write < 0) return null;
  if (req.inputTokens - req.cachedTokens - write < 0) return null;
  return write;
}

/**
 * What makes one turn: the user message a request hangs off, **plus the agent
 * surface that made it**.
 *
 * `parentSpanId` alone is not enough, and the correction matters. Measured on
 * a real 69-request session: Copilot's `backgroundTodoAgent` issues its own
 * requests under the *same* `user_message` span as the developer's
 * `panel/editAgent` work. Grouping on the parent span alone merges traffic the
 * developer initiated with traffic they did not, blends two models into one
 * turn, and gives that turn no single meaningful `entrypoint`. Splitting on
 * `debugName` keeps the developer's turn intact and makes background work its
 * own turn, which is exactly what `entrypoint` exists to distinguish.
 */
function groupKey(req: LlmRequest): string {
  return `${req.parentSpanId} ${req.debugName ?? ""}`;
}

function toRequest(rec: Record<string, unknown>, line: number): LlmRequest | null {
  const attrs = isObject(rec.attrs) ? rec.attrs : null;
  if (!attrs) return null;
  const model = attrs.model;
  const parentSpanId = rec.parentSpanId;
  if (typeof model !== "string" || typeof parentSpanId !== "string") return null;

  return {
    parentSpanId,
    ts: num(rec.ts),
    model,
    debugName: typeof attrs.debugName === "string" ? attrs.debugName : null,
    inputTokens: num(attrs.inputTokens),
    outputTokens: num(attrs.outputTokens),
    cachedTokens: num(attrs.cachedTokens),
    costNanoAiu:
      typeof attrs.copilotUsageNanoAiu === "number" ? attrs.copilotUsageNanoAiu : null,
    line,
  };
}

/**
 * Parse one Copilot session log.
 *
 * **A Copilot "turn" is not a Modelog turn.** `llm_request.parentSpanId` points
 * at the `user_message` span, and the `turn_start`/`turn_end` pair with its
 * per-message `turnId` counter marks one inference call. So requests sharing a
 * `parentSpanId` are one Modelog turn, and the size of that group is its
 * `iterations`. Reading it the other way round reports four times as many
 * turns at a quarter of the cost each, with nothing to signal the error —
 * measured: 2 user messages and 8 requests in one real session, 9 and 69 in
 * another.
 */
export function parseCopilotChunk(
  text: string,
  file: string,
  card: CopilotCard,
  startLine = 0,
): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const groups = new Map<string, LlmRequest[]>();
  let sessionId: string | null = null;

  const endsClean = text.endsWith("\n");
  const lines = text.split("\n");
  // A log being written to can end mid-record. Whole-file adapters re-read
  // from zero next pass, so an incomplete trailing line is simply dropped
  // rather than carried as a remainder.
  if (!endsClean) lines.pop();

  lines.forEach((line, i) => {
    const lineNo = startLine + i + 1;
    if (line.trim() === "") return;

    // Most of a real log is content records this adapter never reads: on the
    // 13 MB session measured, this skips ~85% of lines before parsing them.
    if (!line.includes('"llm_request"') && !line.includes('"session_start"')) return;

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
    if (!isObject(rec)) return;

    if (typeof rec.sid === "string" && sessionId === null) sessionId = rec.sid;
    if (rec.type !== "llm_request") return;

    const req = toRequest(rec, lineNo);
    if (!req) {
      diagnostics.push({
        kind: "unknown-shape",
        file,
        line: lineNo,
        detail: "llm_request without a model or parentSpanId; skipped",
      });
      return;
    }
    const key = groupKey(req);
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(req);
  });

  const isSidechain = basename(file).startsWith(SUBAGENT_PREFIX);
  const turns: Turn[] = [];

  for (const [key, reqs] of groups) {
    const sid = sessionId ?? basename(dirname(file));

    // Once grouped by surface as well as user message, every group in the real
    // data is single-model: a model switch happens between user messages, not
    // inside one. A mixed group is therefore a shape this adapter does not
    // understand, and picking one model would misattribute every token in it
    // (format-drift rule, PRD §7.1). This currently never fires — it is here
    // so that a future Copilot change surfaces as a gap instead of as a wrong
    // attribution.
    const models = new Set(reqs.map((r) => r.model));
    if (models.size > 1) {
      diagnostics.push({
        kind: "unknown-shape",
        file,
        line: reqs[0]!.line,
        detail: `turn spans ${models.size} models on one surface; skipped`,
      });
      continue;
    }

    const model = reqs[0]!.model;
    const prices = card.get(model) ?? null;

    let plain = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let output = 0;
    let cost: number | null = null;
    let breakdown: TokenBreakdown = "solved";

    for (const r of reqs) {
      const write = prices ? solveCacheWrite(r, prices) : null;
      if (write === null) {
        breakdown = "unknown";
        // The split is not known, so the input side is reported as one
        // undivided figure rather than guessed apart. `tokenBreakdown` says
        // so, and cache statistics must exclude this turn.
        plain += r.inputTokens - r.cachedTokens;
      } else {
        plain += r.inputTokens - r.cachedTokens - write;
        cacheWrite += write;
      }
      cacheRead += r.cachedTokens;
      output += r.outputTokens;
      if (r.costNanoAiu !== null) cost = (cost ?? 0) + r.costNanoAiu;
    }

    if (breakdown === "unknown") {
      diagnostics.push({
        kind: "unknown-shape",
        file,
        line: reqs[0]!.line,
        detail: prices
          ? `cache-write split not solvable for ${model}; token classes reported as unknown`
          : `no rate card entry for ${model}; token classes reported as unknown`,
      });
    } else if (cacheWrite > 0) {
      // The card prices a 5-minute and a 1-hour cache write differently, and
      // the event says which was used nowhere. The solve reconciles against
      // the 5-minute price on every real request measured, so that is the
      // supported reading — stated, not assumed silently.
      diagnostics.push({
        kind: "assumed-cache-ttl",
        file,
        line: reqs[0]!.line,
        detail: "cache writes priced at the 5-minute rate; the source does not state the tier",
      });
    }

    turns.push({
      // Deterministic, so a whole-file re-read upserts over itself rather than
      // duplicating. Copilot's own `responseId` cannot serve here: two
      // requests in one real log share one.
      uuid: `${sid}:${key}`,
      // This adapter already aggregates all of a request's records into one
      // turn, so there is no per-block fan-out to collapse (issue #11).
      messageId: null,
      requestId: null,
      sessionId: sid,
      ts: reqs[0]!.ts,
      model,
      source: "copilot",
      inputTokens: plain,
      cacheReadTokens: cacheRead,
      cacheWrite5mTokens: cacheWrite,
      cacheWrite1hTokens: 0,
      outputTokens: output,
      // Not reported by this source. A gap, not a zero — but the field is a
      // display-only subset of outputTokens, so 0 cannot distort a cost.
      thinkingTokens: 0,
      iterations: reqs.length,
      // Anthropic-API pricing modifiers; they do not apply to a call brokered
      // by Copilot, even for an Anthropic model.
      speed: null,
      inferenceGeo: null,
      // Copilot's closest analogue of an entrypoint: which agent surface made
      // the call. `backgroundTodoAgent` is traffic the developer did not
      // initiate, which is a confound Claude Code has no equivalent of.
      entrypoint: reqs[0]!.debugName,
      isSidechain,
      captureVersion: CAPTURE_VERSION,
      costNanoAiu: cost,
      tokenBreakdown: breakdown,
      // Not present anywhere in this log. The workspace hash is not
      // reversible into a path, so guessing one would be a fabrication.
      cwd: null,
      gitBranch: null,
      sourceFile: file,
    });
  }

  turns.sort((a, b) => a.ts - b.ts);
  return { turns, diagnostics, remainder: "" };
}

/**
 * Session log files under one storage root, in either of Copilot's two
 * on-disk shapes.
 *
 * Matched by **path shape, not file extension**. The sibling
 * `transcripts/{sessionId}.jsonl` is conversation content and also ends in
 * `.jsonl`, so an extension-based walk of this tree would ingest prompts —
 * the opposite of what §8.1 promises.
 *
 * **Two shapes, because Copilot has two.** A session started with a folder
 * open is workspace-bound: `<workspaceStorage>/<hash>/GitHub.copilot-chat/debug-logs/<sessionId>/`.
 * A session started with no folder open — which is how the Extension
 * Development Host itself launches, so this is not a rare case — has no
 * workspace to be bound to, and lands instead at
 * `<globalStorage>/github.copilot-chat/debug-logs/<sessionId>/`: lowercase,
 * and one level shallower, with no hash directory at all. Verified directly
 * against a real no-folder session already on disk; a hash-only walk finds
 * zero of these, silently, which is exactly the gap that let one go missing.
 * A root only ever matches one shape, so trying both unconditionally is safe
 * — the other check simply finds nothing at that root.
 */
export function findCopilotLogs(root: string): string[] {
  return [...sessionsUnder(join(root, "github.copilot-chat", "debug-logs")), ...workspaceBoundLogs(root)].sort();
}

function workspaceBoundLogs(root: string): string[] {
  let workspaces: string[];
  try {
    workspaces = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const ws of workspaces) {
    out.push(...sessionsUnder(join(root, ws, "GitHub.copilot-chat", "debug-logs")));
  }
  return out;
}

function sessionsUnder(debugLogs: string): string[] {
  if (!existsSync(debugLogs)) return [];

  let sessions: string[];
  try {
    sessions = readdirSync(debugLogs, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const session of sessions) {
    const dir = join(debugLogs, session);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === MAIN_LOG || (name.startsWith(SUBAGENT_PREFIX) && name.endsWith(".jsonl"))) {
        out.push(join(dir, name));
      }
    }
  }
  return out;
}

export const copilotAdapter: SourceAdapter = {
  source: "copilot",
  mode: "whole-file",
  findFiles: findCopilotLogs,
  // The card read lives here rather than in the parser, so the parsing stays
  // a pure function of text plus rates and can be tested without a filesystem.
  parse: (text, file, startLine) => parseCopilotChunk(text, file, loadCard(dirname(file)), startLine),
};
