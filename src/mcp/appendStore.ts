import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { SCHEMA_VERSION } from "../store/store.ts";
import { INSERT_MARKER_SQL, markerParams, rowToMarker } from "../store/markerRows.ts";
import { VOCABULARY_VERSION, signalDef, type DeclaredMarker, type MarkerInput } from "../markers/vocabulary.ts";
import { INSERT_WORK_RECORD_SQL, readOriginId, readWorkRecords, workRecordParams } from "../store/workRecordRows.ts";
import type { WorkRecord } from "../workSessions/records.ts";
import type { WorkRecordInput } from "../workSessions/validate.ts";
import { resolveAppend, type Observed } from "../workSessions/resolve.ts";

/**
 * The MCP server's ONLY write path (PRD invariant 6, MCP.md §4.1).
 *
 * Reads stay on `openReadOnly()`'s `readOnly: true` connection. This module
 * opens a second, separate connection for one statement, and narrows it at
 * the database rather than by convention:
 *
 * - **An SQLite authorizer** (`setAuthorizer`) allows INSERT into the
 *   append-only tables and nothing else that writes — no UPDATE, no DELETE,
 *   no DDL, no PRAGMA, no INSERT into `turns` or `cursors`. A defect or a
 *   persuaded caller that reaches this connection with any other statement
 *   gets "not authorized" from SQLite itself. Where the host Node lacks
 *   `setAuthorizer`, this refuses to write at all rather than write unguarded.
 * - **Schema-version refusal**, exactly as reads do: the version on disk must
 *   EQUAL the one this bundle was built for. Unlike reads, an append cannot
 *   tolerate an older store — the table it writes may not exist yet.
 * - **No create.** The file is opened only if it exists; the extension owns
 *   creating and migrating the store.
 *
 * Opened and closed per call, like reads, so it never holds the extension's
 * writer lock longer than one INSERT.
 */

/** The tables an append connection may INSERT into (invariant 6). */
export const APPEND_TABLES: readonly string[] = ["markers", "work_records"];

export type AppendStatus = "ok" | "no-data" | "schema-mismatch" | "unsupported";

export type AppendResult =
  | { status: "ok"; marker: DeclaredMarker; duplicateOf: null }
  | { status: "ok"; marker: DeclaredMarker; duplicateOf: string }
  | { status: Exclude<AppendStatus, "ok">; note: string };

/** An identical marker within this window is a retry, not a second declaration. */
export const DUPLICATE_WINDOW_MS = 10 * 60_000;

async function loadSqlite(): Promise<any | null> {
  try {
    return await import("node:sqlite");
  } catch {
    return null;
  }
}

/**
 * Open a guarded append connection. Exported for the tests that prove the
 * guard holds; production code goes through {@link appendMarker}.
 */
export async function openAppend(
  dbPath: string | undefined,
): Promise<{ status: "ok"; db: any } | { status: Exclude<AppendStatus, "ok">; note: string }> {
  if (!dbPath) {
    return { status: "no-data", note: "No store path was provided (MODELOG_DB is unset), so nothing can be saved." };
  }
  const sqlite = await loadSqlite();
  if (!sqlite) {
    return { status: "unsupported", note: "This Node build has no node:sqlite module, so nothing can be saved." };
  }
  if (typeof sqlite.DatabaseSync?.prototype?.setAuthorizer !== "function") {
    return {
      status: "unsupported",
      note:
        "This Node build cannot restrict a database connection to appends " +
        "(no setAuthorizer), and Modelog does not write without that guard. Nothing was saved.",
    };
  }

  let db: any;
  try {
    // A writable open creates a missing file, so absence is checked first:
    // the extension owns creating the store, never this server.
    if (!existsSync(dbPath)) throw new Error("absent");
    db = new sqlite.DatabaseSync(dbPath);
  } catch {
    return {
      status: "no-data",
      note:
        "No Modelog store exists yet at the configured path, so nothing can be saved. " +
        "The extension creates it on first run.",
    };
  }

  try {
    const found = db.prepare("PRAGMA user_version").get().user_version as number;
    if (found !== SCHEMA_VERSION) {
      db.close();
      return {
        status: "schema-mismatch",
        note:
          `The store is at schema version ${found} but this MCP server writes version ` +
          `${SCHEMA_VERSION}. Nothing was saved. ` +
          (found < SCHEMA_VERSION
            ? "The extension upgrades the store when it next opens it."
            : "It was written by a newer Modelog than this server bundle."),
      };
    }
    // The extension writes concurrently; WAL allows one writer at a time.
    db.exec("PRAGMA busy_timeout = 2000");
  } catch (e) {
    db.close();
    throw e;
  }

  const C = sqlite.constants;
  const appendable = new Set(APPEND_TABLES);
  db.setAuthorizer((action: number, arg1: string | null) => {
    switch (action) {
      case C.SQLITE_READ:
      case C.SQLITE_SELECT:
      case C.SQLITE_FUNCTION:
      case C.SQLITE_TRANSACTION:
        return C.SQLITE_OK;
      case C.SQLITE_INSERT:
        return arg1 !== null && appendable.has(arg1) ? C.SQLITE_OK : C.SQLITE_DENY;
      default:
        // UPDATE, DELETE, every CREATE/DROP/ALTER, PRAGMA, ATTACH, ...
        return C.SQLITE_DENY;
    }
  });

  return { status: "ok", db };
}

/**
 * Append one developer-declared marker. The server's clock stamps both times:
 * a marker cannot be backdated to place a before/after window retroactively
 * (maintainer, 2026-11-08).
 */
export async function appendMarker(
  dbPath: string | undefined,
  input: MarkerInput,
  client: { name: string | null; version: string | null },
  now: number = Date.now(),
): Promise<AppendResult> {
  const opened = await openAppend(dbPath);
  if (opened.status !== "ok") return opened;
  const db = opened.db;
  try {
    // An agent that times out and retries must not declare the change twice.
    const dup = db
      .prepare(
        "SELECT * FROM markers WHERE signal = ? AND target_value IS ? AND statement IS ? " +
          "AND attested_at >= ? ORDER BY attested_at DESC LIMIT 1",
      )
      .get(input.signal, input.target, input.statement, now - DUPLICATE_WINDOW_MS);
    if (dup) return { status: "ok", marker: rowToMarker(dup), duplicateOf: dup.id };

    const marker: DeclaredMarker = {
      ...input,
      id: randomUUID(),
      vocabularyVersion: VOCABULARY_VERSION,
      targetUnit: input.target === null ? null : (signalDef(input.signal)?.targetUnit ?? null),
      effectiveAt: now,
      attestedAt: now,
      clientName: client.name,
      clientVersion: client.version,
    };
    db.prepare(INSERT_MARKER_SQL).run(...markerParams(marker));
    return { status: "ok", marker, duplicateOf: null };
  } finally {
    db.close();
  }
}

export type AppendWorkResult =
  | { status: "ok"; record: WorkRecord; duplicate: boolean; records: readonly WorkRecord[] }
  | { status: "refused"; note: string }
  | { status: Exclude<AppendStatus, "ok">; note: string };

/**
 * Append one work-session record (PRD §7.25). The decision of which work
 * session it joins is `resolveAppend`'s, made inside one write transaction
 * over the records as they stand, so two chats racing for one handoff are
 * serialised here, and the unique index on `continues_from` refuses whichever
 * loses if they are not. The server's clock stamps the record.
 */
export async function appendWorkRecord(
  dbPath: string | undefined,
  input: WorkRecordInput,
  observed: Observed,
  client: { name: string | null; version: string | null },
  now: number = Date.now(),
): Promise<AppendWorkResult> {
  const opened = await openAppend(dbPath);
  if (opened.status !== "ok") return opened;
  const db = opened.db;
  try {
    // IMMEDIATE takes the write lock before reading, so the records the
    // decision is based on cannot change before the INSERT.
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = readWorkRecords(db);
      const res = resolveAppend(existing, input, observed, {
        id: randomUUID(),
        originId: readOriginId(db),
        clientName: client.name,
        clientVersion: client.version,
        now,
      });
      if (res.kind === "refuse") {
        db.exec("ROLLBACK");
        return { status: "refused", note: res.reason };
      }
      if (res.kind === "duplicate") {
        db.exec("ROLLBACK");
        return { status: "ok", record: res.record, duplicate: true, records: existing };
      }
      db.prepare(INSERT_WORK_RECORD_SQL).run(...workRecordParams(res.record));
      db.exec("COMMIT");
      return { status: "ok", record: res.record, duplicate: false, records: [...existing, res.record] };
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      if (e instanceof Error && /UNIQUE constraint failed: work_records\.continues_from/.test(e.message)) {
        return { status: "refused", note: "Another chat has already continued that handoff." };
      }
      throw e;
    }
  } finally {
    db.close();
  }
}
