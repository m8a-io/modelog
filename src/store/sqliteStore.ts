import type { Turn, FileCursor } from "../ingest/types.ts";
import { SCHEMA_VERSION, type Store } from "./store.ts";

/**
 * SQLite backed by Node's built-in `node:sqlite` — no native module, no
 * Electron ABI to match, nothing to rebuild when VS Code updates.
 *
 * Verified on VS Code 1.138's extension host (Node 24.18.1). Where the module
 * is missing (an older Electron), createStore() falls back to FileStore.
 *
 * Money and token counts are INTEGER columns throughout. Nothing is REAL.
 */

/**
 * Resolved at runtime so its absence is catchable. Dynamic import works in
 * both worlds: Node runs it natively when these files execute as ESM (tests),
 * and esbuild lowers it to a require() in the CJS extension bundle.
 */
export async function loadSqlite(): Promise<any | null> {
  try {
    return await import("node:sqlite");
  } catch {
    return null;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turns (
  uuid                  TEXT PRIMARY KEY,
  session_id            TEXT    NOT NULL,
  ts                    INTEGER NOT NULL,
  model                 TEXT    NOT NULL,
  input_tokens          INTEGER NOT NULL,
  cache_read_tokens     INTEGER NOT NULL,
  cache_write_5m_tokens INTEGER NOT NULL,
  cache_write_1h_tokens INTEGER NOT NULL,
  output_tokens         INTEGER NOT NULL,
  thinking_tokens       INTEGER NOT NULL,
  iterations            INTEGER NOT NULL,
  entrypoint            TEXT,
  is_sidechain          INTEGER NOT NULL DEFAULT 0,
  capture_version       INTEGER NOT NULL DEFAULT 1,
  speed                 TEXT,
  inference_geo         TEXT,
  cwd                   TEXT,
  git_branch            TEXT,
  source_file           TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_ts    ON turns(ts);
CREATE INDEX IF NOT EXISTS idx_turns_model ON turns(model);

CREATE TABLE IF NOT EXISTS cursors (
  path        TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  byte_offset INTEGER NOT NULL
);
`;

/**
 * Columns added after the first release. `CREATE TABLE IF NOT EXISTS` is a
 * no-op against an existing database, so the statement above will not add a
 * column to a store that already exists — it has to be ALTERed in.
 *
 * Append-only: never reorder or remove an entry, or an older database will
 * migrate to a different shape than a new one.
 */
const ADDED_COLUMNS: ReadonlyArray<{ column: string; ddl: string }> = [
  { column: "entrypoint", ddl: "ALTER TABLE turns ADD COLUMN entrypoint TEXT" },
  {
    column: "is_sidechain",
    ddl: "ALTER TABLE turns ADD COLUMN is_sidechain INTEGER NOT NULL DEFAULT 0",
  },
  { column: "speed", ddl: "ALTER TABLE turns ADD COLUMN speed TEXT" },
  { column: "inference_geo", ddl: "ALTER TABLE turns ADD COLUMN inference_geo TEXT" },
  // is_sidechain defaults to 0, so an uncaptured subagent turn reads as false.
  // Existing rows default to 1; a rescan re-stamps those whose file survives.
  {
    column: "capture_version",
    ddl: "ALTER TABLE turns ADD COLUMN capture_version INTEGER NOT NULL DEFAULT 1",
  },
];

/**
 * Bring an existing database up to SCHEMA_VERSION. Returns the columns it had
 * to add, which is empty for a database created fresh from SCHEMA.
 */
export function migrate(db: any): string[] {
  const present = new Set<string>(
    db.prepare("SELECT name FROM pragma_table_info('turns')").all().map((r: any) => r.name),
  );

  const added: string[] = [];
  for (const { column, ddl } of ADDED_COLUMNS) {
    if (present.has(column)) continue;
    db.exec(ddl);
    added.push(column);
  }

  // Rows that already existed carry the column default, not real data. The
  // scanner skips any file whose size and mtime are unchanged, so it would
  // never revisit them and the backfill would silently never happen. Dropping
  // the cursors forces one full re-read; upserts key on the record uuid, so
  // that is safe and cannot double-count.
  if (added.length > 0) db.exec("DELETE FROM cursors");

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return added;
}

export class SqliteStore implements Store {
  readonly backend = "sqlite" as const;
  /** Columns ALTERed in on open — non-empty only after an extension update. */
  readonly migratedColumns: readonly string[];
  private db: any;

  constructor(sqlite: any, dbPath: string) {
    const { DatabaseSync } = sqlite;
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.migratedColumns = migrate(this.db);
  }

  upsertTurns(turns: readonly Turn[]): void {
    if (turns.length === 0) return;
    // INSERT OR REPLACE on the source uuid is what makes a full rescan safe:
    // re-ingesting the same records can never double-count.
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO turns
        (uuid, session_id, ts, model, input_tokens, cache_read_tokens,
         cache_write_5m_tokens, cache_write_1h_tokens, output_tokens,
         thinking_tokens, iterations, entrypoint, is_sidechain, capture_version,
         speed, inference_geo, cwd, git_branch, source_file)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    this.db.exec("BEGIN");
    try {
      for (const t of turns) {
        stmt.run(
          t.uuid, t.sessionId, t.ts, t.model, t.inputTokens, t.cacheReadTokens,
          t.cacheWrite5mTokens, t.cacheWrite1hTokens, t.outputTokens,
          t.thinkingTokens, t.iterations, t.entrypoint, t.isSidechain ? 1 : 0,
          t.captureVersion, t.speed, t.inferenceGeo, t.cwd, t.gitBranch, t.sourceFile,
        );
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  allTurns(): readonly Turn[] {
    const rows = this.db.prepare("SELECT * FROM turns ORDER BY ts").all();
    return rows.map(rowToTurn);
  }

  turnCount(): number {
    return this.db.prepare("SELECT COUNT(*) AS c FROM turns").get().c as number;
  }

  getCursor(path: string): FileCursor | undefined {
    const r = this.db.prepare("SELECT * FROM cursors WHERE path = ?").get(path);
    if (!r) return undefined;
    return { path: r.path, size: r.size, mtimeMs: r.mtime_ms, byteOffset: r.byte_offset };
  }

  setCursor(c: FileCursor): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO cursors (path, size, mtime_ms, byte_offset) VALUES (?,?,?,?)",
      )
      .run(c.path, c.size, c.mtimeMs, c.byteOffset);
  }

  exportJson(): string {
    return JSON.stringify(this.allTurns(), null, 2);
  }

  clear(): void {
    this.db.exec("DELETE FROM turns; DELETE FROM cursors;");
  }

  close(): void {
    this.db.close();
  }
}

function rowToTurn(r: any): Turn {
  return {
    uuid: r.uuid,
    sessionId: r.session_id,
    ts: r.ts,
    model: r.model,
    inputTokens: r.input_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWrite5mTokens: r.cache_write_5m_tokens,
    cacheWrite1hTokens: r.cache_write_1h_tokens,
    outputTokens: r.output_tokens,
    thinkingTokens: r.thinking_tokens,
    iterations: r.iterations,
    entrypoint: r.entrypoint ?? null,
    isSidechain: r.is_sidechain === 1,
    captureVersion: r.capture_version,
    speed: r.speed ?? null,
    inferenceGeo: r.inference_geo ?? null,
    cwd: r.cwd,
    gitBranch: r.git_branch,
    sourceFile: r.source_file,
  };
}
