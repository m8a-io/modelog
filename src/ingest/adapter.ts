import type { ParseResult } from "./types.ts";

/**
 * Which assistant a turn was captured from.
 *
 * Stored on every turn and used to keep sources apart wherever mixing them
 * would produce a meaningless figure — most importantly cost, where the two
 * sources do not even share a unit (PRD §4.5, §8.2).
 */
export type TurnSource = "claude-code" | "copilot";

/**
 * A per-source ingest adapter (PRD §7.1).
 *
 * Deliberately four members. Each one exists because the two real sources
 * differ on it; nothing here is reserved for a source that does not exist yet.
 */
export interface SourceAdapter {
  readonly source: TurnSource;

  /**
   * `tail` reads only the bytes appended since the last pass — correct for an
   * append-only log whose records are independently parseable.
   *
   * `whole-file` re-reads from zero every pass. Copilot needs it: a turn is
   * assembled from every request sharing a `parentSpanId`, and the cache-write
   * solve needs the whole group, so an arbitrary byte-range suffix cannot be
   * parsed correctly in isolation. The size+mtime check still skips unchanged
   * files, and re-ingest is harmless because upserts key on the turn uuid.
   */
  readonly mode: "tail" | "whole-file";

  /** Log files under `root` that belong to this source. Empty if none do. */
  findFiles(root: string): string[];

  parse(text: string, file: string, startLine?: number): ParseResult;
}
