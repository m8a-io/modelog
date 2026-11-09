import type { Turn, FileCursor } from "../ingest/types.ts";
import type { DeclaredMarker } from "../markers/vocabulary.ts";
import type { WorkRecord } from "../workSessions/records.ts";

/**
 * Bumped whenever the persisted shape of the store changes. Both backends key
 * off this: SQLite ALTERs missing columns in, the file store discards a cache
 * written by an older version. Either way the source logs rebuild the turns.
 *
 * 7 (2026-11-08): the `markers` table — developer-declared markers, appended
 * by the MCP server. Unlike turns, these are NOT rebuildable from any log.
 *
 * 8 (2026-11-09): the `work_records` table (PRD §7.25: start, continue,
 * handoff, done) and a `meta` table holding this install's origin id. Also
 * not rebuildable.
 */
export const SCHEMA_VERSION = 8;

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
  /**
   * Work-session records (PRD §7.25), oldest first. Appended only by the MCP
   * server; always empty on the file store, for the same reason as markers.
   */
  allWorkRecords(): readonly WorkRecord[];
  turnCount(): number;
  getCursor(path: string): FileCursor | undefined;
  setCursor(c: FileCursor): void;
  exportJson(): string;
  /**
   * Delete one developer-declared marker. The Dashboard's Remove button, after
   * the developer confirms, is the only caller: invariant 6 puts deletion in
   * the developer's hands and nowhere else. Returns false if no such marker.
   */
  removeMarker(id: string): boolean;
  /** Wipes the rebuildable cache (turns, cursors). Never touches markers or work records. */
  clear(): void;
  close(): void;
}
