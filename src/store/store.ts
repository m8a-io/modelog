import type { Turn, FileCursor } from "../ingest/types.ts";
import type { DeclaredMarker } from "../markers/vocabulary.ts";

/**
 * Bumped whenever the persisted shape of the store changes. Both backends key
 * off this: SQLite ALTERs missing columns in, the file store discards a cache
 * written by an older version. Either way the source logs rebuild the turns.
 *
 * 7 (2026-11-08): the `markers` table — developer-declared markers, appended
 * by the MCP server. Unlike turns, these are NOT rebuildable from any log.
 */
export const SCHEMA_VERSION = 7;

/**
 * The storage contract. Deliberately narrow: nothing above this interface
 * knows whether SQLite or a flat file is underneath, so the backend can be
 * swapped without touching metrics or UI (DESIGN.md §7).
 */
export interface Store {
  readonly backend: "sqlite" | "file";
  upsertTurns(turns: readonly Turn[]): void;
  allTurns(): readonly Turn[];
  /**
   * Developer-declared markers, oldest first. Written only by the MCP server's
   * append connection; the extension reads them. Always empty on the file
   * store, which the MCP server cannot reach.
   */
  allMarkers(): readonly DeclaredMarker[];
  turnCount(): number;
  getCursor(path: string): FileCursor | undefined;
  setCursor(c: FileCursor): void;
  exportJson(): string;
  /** Wipes the rebuildable cache (turns, cursors). Never touches markers. */
  clear(): void;
  close(): void;
}
