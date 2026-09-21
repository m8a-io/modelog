import { watch, existsSync, type FSWatcher } from "node:fs";
import { expandHome } from "./scanner.ts";

/**
 * Watches the log directories and fires a debounced callback when JSONL files
 * change.
 *
 * Node's own fs.watch is used rather than VS Code's file system watcher
 * because Modelog's sources live outside the workspace (~/.claude/projects) —
 * the VS Code watcher is oriented around workspace folders.
 *
 * Debounced per DESIGN.md §11: an active session appends constantly, and we
 * must never turn that into a busy loop.
 */
export class LogWatcher {
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly debounceMs: number;
  private readonly onChange: () => void;

  constructor(onChange: () => void, debounceMs = 500) {
    this.onChange = onChange;
    this.debounceMs = debounceMs;
  }

  start(logPaths: readonly string[]): string[] {
    this.stop();
    const failed: string[] = [];

    for (const raw of logPaths) {
      const dir = expandHome(raw);
      if (!existsSync(dir)) continue;
      try {
        const w = watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
          // Ignore SQLite sidecars and anything that is not a session log.
          if (filename && !String(filename).endsWith(".jsonl")) return;
          this.schedule();
        });
        w.on("error", () => {/* a vanished directory is not fatal */});
        this.watchers.push(w);
      } catch {
        failed.push(dir);
      }
    }
    return failed;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onChange();
    }, this.debounceMs);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const w of this.watchers) {
      try { w.close(); } catch { /* already closed */ }
    }
    this.watchers = [];
  }

  dispose(): void {
    this.stop();
  }
}
