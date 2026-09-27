import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Turn, FileCursor } from "../ingest/types.ts";
import { SCHEMA_VERSION, type Store } from "./store.ts";

/**
 * Fallback for hosts without `node:sqlite` (an older Electron). Because the
 * source logs are append-only, the store is only ever a rebuildable cache —
 * this degrades performance, never correctness.
 *
 * Delete this file once every supported host ships Node 24+.
 */
export class FileStore implements Store {
  readonly backend = "file" as const;
  private turns = new Map<string, Turn>();
  private cursors = new Map<string, FileCursor>();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, "utf8"));
        // A cache written before the current Turn shape is missing fields that
        // downstream code now expects. Discarding it costs one rescan; keeping
        // it would hand out turns with undefined where a value should be.
        if (data.version === SCHEMA_VERSION) {
          for (const t of data.turns ?? []) this.turns.set(t.uuid, t);
          for (const c of data.cursors ?? []) this.cursors.set(c.path, c);
        }
      } catch {
        // A corrupt cache is discarded, not repaired — the logs rebuild it.
      }
    }
  }

  upsertTurns(turns: readonly Turn[]): void {
    for (const t of turns) this.turns.set(t.uuid, t);
    this.flush();
  }

  allTurns(): readonly Turn[] {
    return [...this.turns.values()].sort((a, b) => a.ts - b.ts);
  }

  turnCount(): number {
    return this.turns.size;
  }

  getCursor(path: string): FileCursor | undefined {
    return this.cursors.get(path);
  }

  setCursor(c: FileCursor): void {
    this.cursors.set(c.path, c);
    this.flush();
  }

  exportJson(): string {
    return JSON.stringify(this.allTurns(), null, 2);
  }

  clear(): void {
    this.turns.clear();
    this.cursors.clear();
    this.flush();
  }

  close(): void {
    this.flush();
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(
      this.path,
      JSON.stringify({
        version: SCHEMA_VERSION,
        turns: [...this.turns.values()],
        cursors: [...this.cursors.values()],
      }),
    );
  }
}
