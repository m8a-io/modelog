import type { DeclaredMarker, FieldProvenance, TargetUnit } from "../markers/vocabulary.ts";

/**
 * The `markers` table: developer-declared markers (PRD §7.23), appended by the
 * MCP server and never updated or deleted by it (invariant 6).
 *
 * **The first table in the store that cannot be rebuilt.** Everything in
 * `turns` and `cursors` is a cache of the source logs and may be wiped and
 * re-read — `clear()` and the message_id migration both do exactly that. A
 * marker exists only here. So nothing that clears the cache may touch this
 * table, and a test holds that.
 *
 * Model-switch markers are NOT stored: they are derived from `turns` on every
 * read, and storing them would duplicate measured data.
 *
 * Shared by the extension's store (which creates the table) and both MCP
 * connections (which read and append), so the column list exists once.
 */
export const MARKERS_DDL = `
CREATE TABLE IF NOT EXISTS markers (
  id                  TEXT    PRIMARY KEY,
  type                TEXT    NOT NULL CHECK (type = 'declared-change'),
  signal              TEXT    NOT NULL,
  vocabulary_version  INTEGER NOT NULL,
  target_value        INTEGER,
  target_unit         TEXT,
  statement           TEXT,
  provenance          TEXT    NOT NULL,
  effective_at        INTEGER NOT NULL,
  attested_at         INTEGER NOT NULL,
  client_name         TEXT,
  client_version      TEXT
);
CREATE INDEX IF NOT EXISTS idx_markers_effective ON markers(effective_at);
`;

export const INSERT_MARKER_SQL =
  "INSERT INTO markers (id, type, signal, vocabulary_version, target_value, target_unit, " +
  "statement, provenance, effective_at, attested_at, client_name, client_version) " +
  "VALUES (?, 'declared-change', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

export function markerParams(m: DeclaredMarker): unknown[] {
  return [
    m.id, m.signal, m.vocabularyVersion, m.target, m.targetUnit, m.statement,
    JSON.stringify(m.provenance), m.effectiveAt, m.attestedAt, m.clientName, m.clientVersion,
  ];
}

export function rowToMarker(r: any): DeclaredMarker {
  let prov: Record<string, unknown> = {};
  try {
    prov = JSON.parse(r.provenance);
  } catch {
    // A row whose provenance cannot be parsed is shown with every field
    // generated — the weaker claim — rather than dropped or guessed upward.
  }
  const p = (v: unknown): FieldProvenance => (v === "user" ? "user" : "generated");
  return {
    id: r.id,
    signal: r.signal,
    vocabularyVersion: r.vocabulary_version,
    target: r.target_value ?? null,
    targetUnit: (r.target_unit ?? null) as TargetUnit | null,
    statement: r.statement ?? null,
    provenance: {
      signal: p(prov.signal),
      target: r.target_value == null ? null : p(prov.target),
      statement: r.statement == null ? null : p(prov.statement),
    },
    effectiveAt: r.effective_at,
    attestedAt: r.attested_at,
    clientName: r.client_name ?? null,
    clientVersion: r.client_version ?? null,
  };
}

/** Every declared marker, oldest first. Callers hold whichever connection they have. */
export function readMarkers(db: any): DeclaredMarker[] {
  return db.prepare("SELECT * FROM markers ORDER BY effective_at, attested_at").all().map(rowToMarker);
}
