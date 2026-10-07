import { SCHEMA_VERSION } from "../store/store.ts";
import type { Turn } from "../ingest/types.ts";

/**
 * Read-only access to the store the extension writes (MCP.md §6).
 *
 * `readOnly: true` is enforced by SQLite itself, so constraint C1 is
 * structural rather than aspirational: a defective server cannot corrupt the
 * store. Verified on Node 24 — an attempted INSERT throws "attempt to write a
 * readonly database" — and because the extension sets `journal_mode = WAL`, a
 * concurrent write succeeds while a reader is open.
 *
 * Nothing here can migrate. A read-only connection cannot ALTER, so a schema
 * difference in *either* direction is reported rather than worked around.
 */

/** Envelope status values this module can produce (MCP.md §8.7). */
export type StoreStatus = "ok" | "no-data" | "schema-mismatch";

export interface StoreOpenResult {
  status: StoreStatus;
  /** Present only when status is "ok". */
  db: any | null;
  /**
   * Human-readable explanation, always present when status is not "ok".
   * Never imperative — it is returned as a data field, not as instruction
   * an agent could mistake for direction (MCP.md §4.2).
   */
  note: string | null;
  /** The schema version found on disk, when one could be read. */
  foundSchemaVersion: number | null;
  expectedSchemaVersion: number;
}

/** Resolved at runtime so its absence is catchable, as in the extension. */
async function loadSqlite(): Promise<any | null> {
  try {
    return await import("node:sqlite");
  } catch {
    return null;
  }
}

/**
 * Open the store named by `MODELOG_DB`.
 *
 * Every failure is a status, never a throw. An empty or absent store reports
 * "no-data" and must not be presented as zero usage — a gap and a zero are
 * different claims, and only one of them is true here.
 */
export async function openReadOnly(dbPath: string | undefined): Promise<StoreOpenResult> {
  const base = { db: null, foundSchemaVersion: null, expectedSchemaVersion: SCHEMA_VERSION };

  if (!dbPath) {
    return {
      ...base,
      status: "no-data",
      note:
        "No store path was provided. The MODELOG_DB environment variable names " +
        "the SQLite file the Modelog extension writes; it is set by the " +
        "registered client configuration.",
    };
  }

  const sqlite = await loadSqlite();
  if (!sqlite) {
    return {
      ...base,
      status: "no-data",
      note: "This Node build has no node:sqlite module, so the store cannot be read.",
    };
  }

  let db: any;
  try {
    // A read-only open of a non-existent file fails rather than creating one,
    // which is the behaviour we want: absence is reported, not manufactured.
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    return {
      ...base,
      status: "no-data",
      note:
        `No readable Modelog store at ${dbPath}. ` +
        "This is expected before the extension has run and ingested at least once. " +
        `(${e instanceof Error ? e.message : String(e)})`,
    };
  }

  let found: number | null = null;
  try {
    found = db.prepare("PRAGMA user_version").get().user_version as number;
  } catch {
    found = null;
  }

  // A store from a NEWER extension may hold columns and semantics this build
  // does not know. Refusing is correct; guessing is not.
  if (found !== null && found > SCHEMA_VERSION) {
    db.close();
    return {
      ...base,
      status: "schema-mismatch",
      foundSchemaVersion: found,
      note:
        `The store is at schema version ${found} but this MCP server was built ` +
        `for version ${SCHEMA_VERSION}. It was written by a newer Modelog than ` +
        "this server bundle, which may have changed what the columns mean.",
    };
  }

  // An OLDER store is missing columns this build reads, and a read-only
  // connection cannot add them. The extension migrates on its next open.
  if (found !== null && found < SCHEMA_VERSION) {
    db.close();
    return {
      ...base,
      status: "schema-mismatch",
      foundSchemaVersion: found,
      note:
        `The store is at schema version ${found} but this MCP server expects ` +
        `version ${SCHEMA_VERSION}. A read-only connection cannot migrate it. ` +
        "The extension upgrades the store when it next opens it.",
    };
  }

  return { ...base, status: "ok", db, note: null, foundSchemaVersion: found };
}

/** Every stored turn, oldest first. Mirrors the extension's `allTurns()`. */
export function readTurns(db: any): Turn[] {
  const rows = db.prepare("SELECT * FROM turns ORDER BY ts").all();
  return rows.map((r: any) => ({
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
    speed: r.speed ?? null,
    inferenceGeo: r.inference_geo ?? null,
    entrypoint: r.entrypoint ?? null,
    isSidechain: r.is_sidechain === 1,
    captureVersion: r.capture_version,
    source: r.source ?? "claude-code",
    costNanoAiu: r.cost_nano_aiu ?? null,
    tokenBreakdown: r.token_breakdown ?? null,
    cwd: r.cwd,
    gitBranch: r.git_branch,
    sourceFile: r.source_file,
  }));
}
