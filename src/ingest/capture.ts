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

export function isCaptured(turn: Pick<Turn, "captureVersion">, field: CapturedField): boolean {
  return turn.captureVersion >= CAPTURED_SINCE[field];
}

export function uncapturedFields(turn: Pick<Turn, "captureVersion">): CapturedField[] {
  return CAPTURED_FIELDS.filter((f) => !isCaptured(turn, f));
}
