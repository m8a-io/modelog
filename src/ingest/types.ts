/**
 * The internal event model. Every source adapter normalizes into this shape,
 * so metrics, storage and UI never learn anything about Claude Code's (or any
 * other assistant's) on-disk format. Adding Copilot later means adding one
 * adapter, not touching anything downstream.
 */

export interface Turn {
  /** Source record uuid. Primary key — makes re-ingest idempotent. */
  uuid: string;
  sessionId: string;
  /** Epoch milliseconds. */
  ts: number;
  model: string;

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
