import type { Turn, FileCursor } from "../ingest/types.ts";

/**
 * Bumped whenever the persisted shape of a Turn changes. Both backends key
 * off this: SQLite ALTERs missing columns in, the file store discards a cache
 * written by an older version. Either way the source logs rebuild the data.
 */
export const SCHEMA_VERSION = 4;

/**
 * The storage contract. Deliberately narrow: nothing above this interface
 * knows whether SQLite or a flat file is underneath, so the backend can be
 * swapped without touching metrics or UI (DESIGN.md §7).
 */
export interface Store {
  readonly backend: "sqlite" | "file";
  upsertTurns(turns: readonly Turn[]): void;
  allTurns(): readonly Turn[];
  turnCount(): number;
  getCursor(path: string): FileCursor | undefined;
  setCursor(c: FileCursor): void;
  exportJson(): string;
  clear(): void;
  close(): void;
}
