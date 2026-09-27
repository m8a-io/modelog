import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SCHEMA_VERSION } from "../store/store.ts";
import { openReadOnly } from "./readOnlyStore.ts";

/**
 * Modelog MCP server (MCP.md).
 *
 * A thin, read-only adapter over the Part 1 store and metrics modules. It
 * imports the cost engine and aggregates directly rather than restating them,
 * because a second implementation of the maths would let the bridge and the
 * dashboard drift apart — a correctness risk, not a convenience (MCP.md §5).
 *
 * Transport is stdio: no port, no listening socket, no network surface. The
 * client spawns it as a child process, so it can run with VS Code closed.
 *
 * Built by the third esbuild target to `dist/mcp-server.mjs` — ESM, `node:*`
 * external. Runs on real Node, not inside Electron.
 *
 * The low-level `Server` is deliberate rather than `McpServer`: every response
 * goes through the §8.7 envelope, so the convenience of `registerTool`'s
 * schema wiring buys little, and `McpServer` only installs a `tools/list`
 * handler once a tool is registered.
 */

const NAME = "modelog";
const VERSION = "0.1.0";

/** Phase 1 registers no tools. `tools/list` still answers, with an empty list. */
export function createServer(): Server {
  const server = new Server(
    { name: NAME, version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Modelog exposes read-only metrics derived from your own local AI " +
        "coding-assistant session logs. It holds no prompts or code. All " +
        "tools are read-only; there is no way to mutate anything through it.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));

  return server;
}

async function main(): Promise<void> {
  // Opened once at startup purely to surface a clear diagnostic on stderr.
  // Tools will each re-derive status per call; a store can appear or change
  // between calls because the extension writes to it concurrently.
  const opened = await openReadOnly(process.env.MODELOG_DB);
  if (opened.status !== "ok") {
    // stderr only. stdout is the protocol channel and must carry nothing but
    // framed JSON-RPC, or the client's parser breaks.
    console.error(`[modelog] store unavailable (${opened.status}): ${opened.note}`);
  } else {
    opened.db.close();
    console.error(`[modelog] store ok, schema ${SCHEMA_VERSION}`);
  }

  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`[modelog] mcp server ${VERSION} ready on stdio`);
}

main().catch((e) => {
  console.error("[modelog] fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
