import { readdirSync, statSync, openSync, readSync, closeSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseChunk } from "./claudeCode.ts";
import type { Diagnostic, FileCursor } from "./types.ts";
import type { Store } from "../store/index.ts";

export interface ScanResult {
  filesScanned: number;
  turnsIngested: number;
  diagnostics: Diagnostic[];
  missingPaths: string[];
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : resolve(p);
}

/**
 * Walk the configured log directories and ingest anything new.
 *
 * Incremental by byte offset: JSONL files are append-only, so we read only
 * from where we stopped. A file whose size DECREASED was rotated or rewritten,
 * so we re-read it whole. Upserts key on the record uuid, which makes a full
 * rescan safe at any time.
 */
export function scan(store: Store, logPaths: readonly string[]): ScanResult {
  const result: ScanResult = {
    filesScanned: 0,
    turnsIngested: 0,
    diagnostics: [],
    missingPaths: [],
  };

  for (const raw of logPaths) {
    const root = expandHome(raw);
    if (!existsSync(root)) {
      result.missingPaths.push(root);
      continue;
    }
    for (const file of findJsonl(root)) {
      ingestFile(store, file, result);
    }
  }

  return result;
}

function findJsonl(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findJsonl(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function ingestFile(store: Store, path: string, result: ScanResult): void {
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }

  const prev = store.getCursor(path);
  // Unchanged since last read.
  if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return;

  // Shrunk => rotated or rewritten => start over.
  const from = prev && st.size >= prev.size ? prev.byteOffset : 0;
  if (from >= st.size) return;

  const text = readFrom(path, from, st.size - from);
  if (text === null) return;

  const { turns, diagnostics, remainder } = parseChunk(text, path);
  store.upsertTurns(turns);

  // Rewind past a partial trailing line so the next read picks it up whole.
  const consumed = st.size - Buffer.byteLength(remainder, "utf8");
  const cursor: FileCursor = {
    path,
    size: st.size,
    mtimeMs: st.mtimeMs,
    byteOffset: consumed,
  };
  store.setCursor(cursor);

  result.filesScanned++;
  result.turnsIngested += turns.length;
  result.diagnostics.push(...diagnostics);
}

function readFrom(path: string, offset: number, length: number): string | null {
  if (length <= 0) return null;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
