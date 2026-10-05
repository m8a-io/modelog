import type { Turn } from "./types.ts";

/**
 * Which fields a row was ingested with.
 *
 * `is_sidechain INTEGER NOT NULL DEFAULT 0` cannot represent unknown: a turn
 * ingested before the column existed is stored as a literal `false`, and no
 * nullable-column scheme fixes that. `entrypoint` is merely ambiguous, since
 * NULL also means the source record carried none. A single per-row version
 * marks "Modelog did not look" without touching either column's type, and
 * extends to the next added field by adding one entry below.
 *
 * It says Modelog did not look, not that the log had a value. Pricing is
 * unaffected: an absent `speed` or `inference_geo` still means unmodified.
 */
export const CAPTURE_VERSION = 2;

export type CapturedField = "entrypoint" | "isSidechain" | "speed" | "inferenceGeo";

/** The capture version at which each field started being recorded. */
const CAPTURED_SINCE: Readonly<Record<CapturedField, number>> = {
  entrypoint: 2,
  isSidechain: 2,
  speed: 2,
  inferenceGeo: 2,
};

export const CAPTURED_FIELDS = Object.keys(CAPTURED_SINCE).sort() as CapturedField[];

/** Everything needed to decide capture: the version, plus the values it governs. */
export type CaptureProbe = Pick<Turn, "captureVersion" | CapturedField>;

/**
 * Whether `field` was captured for this row.
 *
 * The version is the primary answer, but it is not the only evidence. A row
 * whose source file has since been deleted can never be re-read, so it keeps
 * whatever version it had even when an earlier migration already backfilled
 * it — the version undercounts, in the safe direction, but it undercounts.
 * A stored value settles the question on its own: Modelog cannot invent an
 * `entrypoint`, so a row carrying one read it from the log whatever its
 * version says.
 *
 * Version alone would report 346 rows of this store's 1,785 as missing
 * `entrypoint` when 146 are, and exclude the other 200 — which hold a real
 * `claude-vscode` — from every filter on it.
 *
 * `isSidechain` resolves one way only. `true` could not have been invented,
 * but `false` is also the column default, so a pre-version row storing
 * `false` stays unknown. That is irreducible without the source file, and
 * unknown is the honest answer rather than a conservative one.
 */
export function isCaptured(turn: CaptureProbe, field: CapturedField): boolean {
  if (turn.captureVersion >= CAPTURED_SINCE[field]) return true;
  return field === "isSidechain" ? turn.isSidechain : turn[field] !== null;
}

export function uncapturedFields(turn: CaptureProbe): CapturedField[] {
  return CAPTURED_FIELDS.filter((f) => !isCaptured(turn, f));
}
