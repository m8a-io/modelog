import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const prod = process.argv.includes("--production");

const common = {
  bundle: true,
  minify: prod,
  sourcemap: !prod,
  logLevel: "info",
  // Keep upstream licence headers (ECharts is Apache-2.0) in the bundle.
  legalComments: "eof",
};

/**
 * Three targets, because the parts run in different places.
 *
 *  - The extension host is a Node process inside VS Code. `vscode` is injected
 *    there at runtime, so it must be marked external or esbuild will try to
 *    resolve a module that does not exist on disk.
 *  - The webview is a browser context (an iframe). No Node APIs, ESM output.
 */
const targets = [
  {
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
  },
  {
    ...common,
    entryPoints: ["src/webview/main.ts"],
    outfile: "dist/webview.js",
    platform: "browser",
    format: "esm",
    target: "es2022",
  },
  {
    ...common,
    entryPoints: ["src/webview/style.css"],
    outfile: "dist/webview.css",
  },
  {
    ...common,
    // The MCP server is spawned by a client as its own Node process, not by
    // VS Code, so it targets real Node and never imports `vscode`. ESM with a
    // .mjs extension avoids CJS interop friction with the MCP SDK; `node:*`
    // builtins stay external so `node:sqlite` resolves at runtime rather than
    // being bundled. See MCP.md §5.
    entryPoints: ["src/mcp/server.ts"],
    outfile: "dist/mcp-server.mjs",
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["node:*"],
  },
];

if (watch) {
  const ctxs = await Promise.all(targets.map((t) => esbuild.context(t)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("[modelog] watching...");
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
}
