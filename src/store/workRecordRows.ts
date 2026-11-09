import { randomUUID } from "node:crypto";
import type { FieldProvenance } from "../markers/vocabulary.ts";
import type { TurnSource } from "../ingest/adapter.ts";
import type { WorkRecord, WorkRecordKind } from "../workSessions/records.ts";

/**
 * The `work_records` table (PRD §7.25): start, continue, handoff and done
 * records, appended by the MCP server and never updated or deleted by it
 * (invariant 6). Like `markers`, nothing in any log can rebuild these, so
 * nothing that clears the cache may touch them.
 *
 * The CHECK constraints restate the per-kind field rules at the database, so a
 * defect in the handler cannot store a rated handoff or an unrated closure.
 * The partial unique index on `continues_from` makes "a handoff is continued
 * once" a database fact: a second claim fails the INSERT.
 *
 * Shared by the extension's store (which creates the table) and both MCP
 * connections (which read and append), so the column list exists once.
 */
export const WORK_RECORDS_DDL = `
CREATE TABLE IF NOT EXISTS work_records (
  id                      TEXT    PRIMARY KEY,
  kind                    TEXT    NOT NULL CHECK (kind IN ('start', 'continue', 'handoff', 'done')),
  work_session_id         TEXT    NOT NULL,
  continues_from          TEXT,
  started_implicitly      INTEGER NOT NULL DEFAULT 0 CHECK (started_implicitly IN (0, 1)),
  rating                  INTEGER CHECK (rating BETWEEN 1 AND 10),
  summary                 TEXT,
  open_items              TEXT,
  brief                   TEXT,
  provenance              TEXT    NOT NULL,
  chat_session_id         TEXT,
  chat_session_id_source  TEXT,
  cwd                     TEXT,
  source                  TEXT,
  origin_id               TEXT,
  attested_at             INTEGER NOT NULL,
  client_name             TEXT,
  client_version          TEXT,
  CHECK ((kind = 'done') = (rating IS NOT NULL)),
  CHECK (summary IS NULL OR kind = 'done'),
  CHECK (brief IS NULL OR kind = 'handoff'),
  CHECK (open_items IS NULL OR kind IN ('handoff', 'done')),
  CHECK (continues_from IS NULL OR kind <> 'start'),
  CHECK (kind <> 'continue' OR continues_from IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_work_records_session  ON work_records(work_session_id);
CREATE INDEX IF NOT EXISTS idx_work_records_chat     ON work_records(chat_session_id);
CREATE INDEX IF NOT EXISTS idx_work_records_attested ON work_records(attested_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_records_continues
  ON work_records(continues_from) WHERE continues_from IS NOT NULL;
`;

/**
 * Store-level facts. Holds `origin_id`: a random id for this install, made
 * once by the extension when it creates or migrates the store, and stamped by
 * the MCP server on every record it appends (W9). Records will move between
 * stores (reinstall import, central sync), so where one was written has to
 * travel with it. Never read from the machine: it identifies the install, not
 * the person or the hardware.
 */
export const META_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Creates the origin id if this store has none. Extension side only. */
export function ensureOriginId(db: any): void {
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('origin_id', ?)").run(randomUUID());
}

/** Null when the store predates schema 8 or the row is missing. */
export function readOriginId(db: any): string | null {
  try {
    const r = db.prepare("SELECT value FROM meta WHERE key = 'origin_id'").get();
    return r?.value ?? null;
  } catch {
    return null;
  }
}

export const INSERT_WORK_RECORD_SQL =
  "INSERT INTO work_records (id, kind, work_session_id, continues_from, started_implicitly, " +
  "rating, summary, open_items, brief, provenance, chat_session_id, chat_session_id_source, " +
  "cwd, source, origin_id, attested_at, client_name, client_version) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

export function workRecordParams(r: WorkRecord): unknown[] {
  return [
    r.id, r.kind, r.workSessionId, r.continuesFrom, r.startedImplicitly ? 1 : 0,
    r.rating, r.summary, r.openItems === null ? null : JSON.stringify(r.openItems), r.brief,
    JSON.stringify(r.provenance), r.chatSessionId, r.chatSessionIdSource,
    r.cwd, r.source, r.originId, r.attestedAt, r.clientName, r.clientVersion,
  ];
}

export function rowToWorkRecord(r: any): WorkRecord {
  let prov: Record<string, unknown> = {};
  try {
    prov = JSON.parse(r.provenance);
  } catch {
    // Unparseable provenance reads as "generated" — the weaker claim — as markers do.
  }
  const p = (present: boolean, v: unknown): FieldProvenance | null =>
    present ? (v === "user" ? "user" : "generated") : null;
  let openItems: string[] | null = null;
  if (r.open_items != null) {
    try {
      const parsed = JSON.parse(r.open_items);
      openItems = Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
    } catch {
      openItems = [];
    }
  }
  return {
    id: r.id,
    kind: r.kind as WorkRecordKind,
    workSessionId: r.work_session_id,
    continuesFrom: r.continues_from ?? null,
    startedImplicitly: r.started_implicitly === 1,
    rating: r.rating ?? null,
    summary: r.summary ?? null,
    openItems,
    brief: r.brief ?? null,
    provenance: {
      summary: p(r.summary != null, prov.summary),
      openItems: p(r.open_items != null, prov.openItems),
      brief: p(r.brief != null, prov.brief),
    },
    chatSessionId: r.chat_session_id ?? null,
    chatSessionIdSource: r.chat_session_id_source === "client-env" ? "client-env" : null,
    cwd: r.cwd ?? null,
    source: (r.source ?? null) as TurnSource | null,
    originId: r.origin_id ?? null,
    attestedAt: r.attested_at,
    clientName: r.client_name ?? null,
    clientVersion: r.client_version ?? null,
  };
}

/** Every work record, oldest first. Callers hold whichever connection they have. */
export function readWorkRecords(db: any): WorkRecord[] {
  return db
    .prepare("SELECT * FROM work_records ORDER BY attested_at, rowid")
    .all()
    .map(rowToWorkRecord);
}
