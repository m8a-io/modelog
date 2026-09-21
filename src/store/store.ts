import type { Turn, FileCursor } from "../ingest/types.ts";

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
