import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Store } from "./store.ts";
import { SqliteStore, loadSqlite } from "./sqliteStore.ts";
import { FileStore } from "./fileStore.ts";

export type { Store } from "./store.ts";

export interface StoreResult {
  store: Store;
  /** Set when we had to fall back — surfaced as an ingest-health notice. */
  warning?: string;
}

/**
 * Feature-detect at activation (DESIGN.md §7). `node:sqlite` needed a flag on
 * Node 22 and is unflagged only from 23.4, so an older Electron host will not
 * have it.
 */
export async function createStore(storageDir: string): Promise<StoreResult> {
  mkdirSync(storageDir, { recursive: true });

  const sqlite = await loadSqlite();
  if (sqlite) {
    return { store: new SqliteStore(sqlite, join(storageDir, "modelog.db")) };
  }
  return {
    store: new FileStore(join(storageDir, "modelog.json")),
    warning:
      "node:sqlite is unavailable in this VS Code build; using the file store. " +
      "Metrics are unaffected, but large histories will load more slowly.",
  };
}
