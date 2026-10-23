import { homedir } from "node:os";
import { planCleanup, runCleanup } from "./cleanup/plan.ts";

/**
 * VS Code's `vscode:uninstall` hook — `scripts["vscode:uninstall"]` in
 * package.json, which the editor runs as a plain Node process.
 *
 * Everything about this entry point is dictated by how VS Code invokes it, as
 * read out of `ExtensionsLifecycle` in the shipped 1.105 bundle:
 *
 * - **It is forked, not activated.** There is no `vscode` module here, no
 *   window, and therefore **no way to ask the user anything**. That is why
 *   `Modelog: Remove Modelog's Changes` exists: consent is collected while the
 *   extension is still installed, and this is the fallback for someone who
 *   simply clicked Uninstall. It runs only `recommended` items, which is why
 *   backup files and collected data are excluded.
 * - **Five seconds, then SIGKILL.** `runLifecycleHook` sets a 5000 ms timer
 *   and calls `child.kill()`. The work measures around half a second
 *   (`copilot mcp remove` dominates at ~417 ms), but every step is
 *   independently guarded so a slow one cannot starve the rest.
 * - **It runs on the VS Code restart after the uninstall**, not at the click,
 *   and before the editor deletes Modelog's storage directory.
 * - **The manifest value must start with `node `.** `parseScript` rejects
 *   anything else and logs "should be a node script", silently doing nothing.
 *
 * Failure is never fatal: stdout and stderr are logged by VS Code under the
 * extension id, and a non-zero exit would only produce a scary log line about
 * an extension that is already gone.
 */
function main(): void {
  const home = homedir();
  const items = planCleanup({ home, platform: process.platform, env: process.env }).filter(
    (item) => item.recommended,
  );

  if (items.length === 0) {
    console.log("modelog: nothing to clean up.");
    return;
  }

  for (const { item, outcome } of runCleanup(items)) {
    console.log(`modelog: ${item.id}: ${outcome.status} — ${outcome.note}`);
  }
}

try {
  main();
} catch (e) {
  console.error("modelog: uninstall cleanup failed:", e instanceof Error ? e.message : String(e));
}
