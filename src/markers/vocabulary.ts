/**
 * Developer-declared markers (PRD §7.23) — the closed signal vocabulary and
 * the validation every write goes through.
 *
 * Pure: no `vscode`, no store. The MCP append tool and the tests both use it,
 * so what a marker may contain is decided in one place.
 *
 * **Why the list is closed.** A marker exists to be scored later (§7.23: "a
 * tip is an anchor, not output"). A change that names no measurable signal can
 * never get a verdict, so it is refused at write time rather than stored as an
 * anchor nothing can ever read. Ids are slugs, not the S-numbers of
 * `RESEARCH-signals.md`, because those are document-local.
 *
 * **Append-only, like the table.** Never rename or remove an id — stored
 * markers carry it. Add new ids and bump `VOCABULARY_VERSION`.
 */

export const VOCABULARY_VERSION = 1;

/** The unit a target is stated in. `null` means the signal takes no target. */
export type TargetUnit = "tokens" | "turns" | "percent";

export interface SignalDef {
  id: string;
  /** Plain label for the Dashboard and for the agent. */
  label: string;
  /** Where it was specified. */
  research: string;
  targetUnit: TargetUnit | null;
  /**
   * False when Modelog does not yet capture the data the signal needs, so a
   * marker can be set but no verdict is possible until ingest records it.
   */
  measurable: boolean;
}

/**
 * S4 (cache hit rate) and S9 (idle gaps) are absent on purpose: the research
 * specified them as a denominator and an input, not as things to change.
 */
export const SIGNALS: readonly SignalDef[] = [
  { id: "resume-rebuild-cost", label: "Cache rebuilds after a break", research: "S1", targetUnit: null, measurable: true },
  { id: "context-growth", label: "Context growth within a session", research: "S2", targetUnit: null, measurable: true },
  { id: "context-at-break", label: "Context size when taking a break", research: "S3", targetUnit: "tokens", measurable: true },
  { id: "cache-written-unread", label: "Cache written but never read", research: "S5", targetUnit: null, measurable: true },
  { id: "unsupervised-run", label: "Longest run of AI turns without developer input", research: "S6", targetUnit: "turns", measurable: false },
  { id: "subagent-share", label: "Share of work delegated to sub-agents", research: "S7", targetUnit: "percent", measurable: true },
  { id: "midsession-model-switches", label: "Model switches inside a session", research: "S8", targetUnit: null, measurable: true },
  { id: "context-resets", label: "Context resets inside a session", research: "S10", targetUnit: null, measurable: true },
  // Added 2026-11-08 for PRD §7.24's own example ("end sessions before 120k
  // context"), which none of S1–S10 expresses. Measured on the maintainer's
  // store: 23 real Claude Code sessions, p25 87k / p50 164k / p75 222k.
  { id: "peak-context", label: "Peak context size per session", research: "S11", targetUnit: "tokens", measurable: true },
];

export const SIGNAL_IDS = SIGNALS.map((s) => s.id);

export function signalDef(id: string): SignalDef | undefined {
  return SIGNALS.find((s) => s.id === id);
}

/** Who supplied a field: the developer, or the agent (approved by the developer). */
export type FieldProvenance = "user" | "generated";

/**
 * The wording is content-adjacent (it can say anything), so it is capped,
 * stored locally only, and never rendered into server instructions — nudges
 * are built from signal + target + date alone (maintainer, 2026-11-08).
 */
export const STATEMENT_MAX = 200;

/** What the append tool accepts, after validation. */
export interface MarkerInput {
  signal: string;
  target: number | null;
  statement: string | null;
  provenance: {
    signal: FieldProvenance;
    target: FieldProvenance | null;
    statement: FieldProvenance | null;
  };
}

/** A stored developer-declared marker, as both the extension and the MCP server read it. */
export interface DeclaredMarker extends MarkerInput {
  id: string;
  vocabularyVersion: number;
  targetUnit: TargetUnit | null;
  /** When the change takes effect. Equal to `attestedAt` in v1: no backdating. */
  effectiveAt: number;
  /** When the server stored it, by its own clock. */
  attestedAt: number;
  /** As the MCP client named itself at initialize — unverified, like all client claims. */
  clientName: string | null;
  clientVersion: string | null;
}

export type ValidateResult = { ok: true; value: MarkerInput } | { ok: false; error: string };

const PROVENANCE = new Set(["user", "generated"]);

/**
 * Validate raw tool arguments. Error strings name the offending argument but
 * never echo its value, so nothing the caller supplied is reflected back as
 * prose (MCP.md §4.2).
 */
export function validateMarkerInput(args: Record<string, unknown>): ValidateResult {
  const allowed = new Set(["signal", "target", "statement", "provenance", "developerApproved"]);
  for (const k of Object.keys(args)) {
    if (!allowed.has(k)) return { ok: false, error: "Unknown argument. Allowed: signal, target, statement, provenance, developerApproved." };
  }

  if (args.developerApproved !== true) {
    return {
      ok: false,
      error:
        "developerApproved must be true. Show the developer the exact marker first and " +
        "record it only after they confirm; nothing is stored otherwise.",
    };
  }

  const def = typeof args.signal === "string" ? signalDef(args.signal) : undefined;
  if (!def) return { ok: false, error: `signal must be one of: ${SIGNAL_IDS.join(", ")}.` };

  let target: number | null = null;
  if (args.target !== undefined && args.target !== null) {
    if (def.targetUnit === null) {
      return { ok: false, error: "This signal takes no target; omit it." };
    }
    if (typeof args.target !== "number" || !Number.isSafeInteger(args.target) || args.target < 0) {
      return { ok: false, error: `target must be a non-negative integer, in ${def.targetUnit}.` };
    }
    if (def.targetUnit === "percent" && args.target > 100) {
      return { ok: false, error: "target is a percentage and must be 0–100." };
    }
    target = args.target;
  }

  let statement: string | null = null;
  if (args.statement !== undefined && args.statement !== null) {
    if (typeof args.statement !== "string") return { ok: false, error: "statement must be a string." };
    const s = args.statement.trim();
    if (s.length > STATEMENT_MAX) {
      return { ok: false, error: `statement must be at most ${STATEMENT_MAX} characters.` };
    }
    statement = s.length > 0 ? s : null;
  }

  const p = args.provenance;
  if (p === null || typeof p !== "object" || Array.isArray(p)) {
    return { ok: false, error: "provenance is required: an object naming who supplied each field." };
  }
  const prov = p as Record<string, unknown>;
  for (const k of Object.keys(prov)) {
    if (!["signal", "target", "statement"].includes(k)) {
      return { ok: false, error: "provenance may only name signal, target and statement." };
    }
  }
  const pick = (field: "signal" | "target" | "statement", present: boolean): FieldProvenance | null | string => {
    const v = prov[field];
    if (!present) return v === undefined ? null : `provenance.${field} given for a field that is absent.`;
    if (typeof v !== "string" || !PROVENANCE.has(v)) return `provenance.${field} must be "user" or "generated".`;
    return v as FieldProvenance;
  };
  const ps = pick("signal", true);
  const pt = pick("target", target !== null);
  const pst = pick("statement", statement !== null);
  for (const v of [ps, pt, pst]) {
    if (typeof v === "string" && !PROVENANCE.has(v)) return { ok: false, error: v };
  }

  return {
    ok: true,
    value: {
      signal: def.id,
      target,
      statement,
      provenance: {
        signal: ps as FieldProvenance,
        target: pt as FieldProvenance | null,
        statement: pst as FieldProvenance | null,
      },
    },
  };
}
