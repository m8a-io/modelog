/**
 * The internal event model. Every source adapter normalizes into this shape,
 * so metrics, storage and UI never learn anything about Claude Code's (or any
 * other assistant's) on-disk format. Adding Copilot later means adding one
 * adapter, not touching anything downstream.
 */

import type { TurnSource } from "./adapter.ts";

export type { TurnSource };

/**
 * How a turn's token classes were determined.
 *
 * - `reported` — the source stated every class outright (Claude Code).
 * - `solved` — the cache-write count was not reported and was recovered by
 *   solving the source's own billing equation (Copilot; PRD §7.1 Correction 4).
 * - `unknown` — the solve was degenerate or inexact, so the split between
 *   plain input and cache writes is **not known**. Such a turn is excluded
 *   from cache statistics but keeps its cost, which is measured independently.
 */
export type TokenBreakdown = "reported" | "solved" | "unknown";

export interface Turn {
  /** Source record uuid. Primary key — makes re-ingest idempotent. */
  uuid: string;
  sessionId: string;
  /** Epoch milliseconds. */
  ts: number;
  model: string;

  /**
   * Which assistant produced this turn. Load-bearing: the two sources do not
   * share a cost unit, so anything that sums or compares money must partition
   * on this first (PRD §4.5, §8.2).
   */
  source: TurnSource;

  /** Token counts, kept as four separately-priced classes (DESIGN.md §9). */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;

  /** Already included in outputTokens. Display only — never re-added. */
  thinkingTokens: number;

  /** Underlying inference calls in this turn. A turn is not a call. */
  iterations: number;

  /**
   * Request-level pricing modifiers, recorded by the source per turn. Both
   * reprice **every** token class, so a turn cannot be costed without them:
   * `speed: "fast"` doubles Opus rates, `inferenceGeo: "us"` applies 1.1x.
   * Null where the source record does not carry the field. An unrecognised
   * value must yield a null cost, never a neutral ratio (PRD §8.2).
   */
  speed: string | null;
  inferenceGeo: string | null;

  /**
   * Which surface of the tool produced the turn — `claude-vscode` for the VS
   * Code extension, a different value for the CLI. Same tool, same billing,
   * same units, so segmenting on it is tier-2 comparable (PRD §4.5). Null
   * where the source record does not carry the field.
   */
  entrypoint: string | null;

  /**
   * True when the turn belongs to a spawned subagent rather than the user's
   * own conversation. A real API call costing real money, but not a turn the
   * user chose — so it is a confound for any per-turn behavioural comparison.
   * Captured only; how it affects displayed metrics is not yet decided.
   */
  isSidechain: boolean;

  /** Which fields this row was ingested with; see `capture.ts`. */
  captureVersion: number;

  /**
   * Cost as the source itself measured it, in nano-AIU (Copilot's own unit —
   * `copilotUsageNanoAiu`). Null for a source that does not report a cost, in
   * which case cost is derived from tokens and rates instead.
   *
   * Deliberately NOT converted to micro-dollars on ingest: 1 AIU = 1 cent is a
   * derived equivalence, not a measurement, and baking a derivation into
   * stored data is the same error class as pricing an unknown model at a
   * default rate (PRD §8.2).
   */
  costNanoAiu: number | null;

  /**
   * How this row's token classes were established. Null on rows ingested
   * before the field existed.
   *
   * Not folded into `capture.ts`: that mechanism is version-indexed — "did
   * this build of Modelog look at this field" — whereas this varies per row
   * with the data itself, so a "captured since version N" answer would be
   * meaningless here.
   */
  tokenBreakdown: TokenBreakdown | null;

  cwd: string | null;
  gitBranch: string | null;
  sourceFile: string;
}

export interface FileCursor {
  path: string;
  size: number;
  mtimeMs: number;
  byteOffset: number;
}

/** Non-fatal things worth telling the user about (DESIGN.md §12). */
export interface Diagnostic {
  kind: "parse-error" | "unknown-shape" | "assumed-cache-ttl";
  file: string;
  line: number;
  detail: string;
}

export interface ParseResult {
  turns: Turn[];
  diagnostics: Diagnostic[];
  /** Trailing bytes that did not end in a newline — a write caught mid-flight. */
  remainder: string;
}
