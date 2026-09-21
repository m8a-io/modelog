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
