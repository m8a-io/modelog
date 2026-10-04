import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SCHEMA_VERSION } from "../store/store.ts";
import { openReadOnly, readTurns } from "./readOnlyStore.ts";
import { PRICING, RATE_TABLE } from "./rates.ts";
import { callTool, TOOLS, type ToolContext } from "./tools.ts";
import { detectBilling, type BillingInfo } from "../ingest/billing.ts";
import type { Turn } from "../ingest/types.ts";

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

/**
 * The billing mode, and whether it was stated rather than detected.
 *
 * This process cannot read VS Code settings, so a user's `modelog.billingMode`
 * override is invisible here unless the registered client config passes it
 * through. `get_definitions` reports which of the two happened rather than
 * presenting a detected mode as a configured one.
 */
function resolveBilling(): { billing: BillingInfo; fromEnv: boolean } {
  const configured = process.env.MODELOG_BILLING_MODE;
  if (configured === "api" || configured === "subscription") {
    return { billing: { mode: configured, detected: false, rawType: null }, fromEnv: true };
  }
  return { billing: detectBilling(), fromEnv: false };
}

/**
 * Build a fresh context per call.
 *
 * Deliberately not cached. The extension writes to this store concurrently,
 * so a store can appear, gain rows or change schema between two calls in one
 * session — and a server that cached its first read would keep reporting a
 * stale answer, or keep reporting `no-data` after the extension's first
 * ingest. The connection is closed again immediately; holding a reader open
 * for the process lifetime buys nothing and blocks nothing usefully.
 */
export async function buildContext(now: number = Date.now()): Promise<ToolContext> {
  const opened = await openReadOnly(process.env.MODELOG_DB);
  const { billing, fromEnv } = resolveBilling();

  let turns: readonly Turn[] = [];
  if (opened.status === "ok") {
    try {
      turns = readTurns(opened.db);
    } finally {
      opened.db.close();
    }
  }

  return {
    status: opened.status,
    note: opened.note,
    turns,
    pricing: PRICING,
    table: RATE_TABLE,
    billing,
    billingFromEnv: fromEnv,
    schemaVersion: SCHEMA_VERSION,
    now,
  };
}

export function createServer(): Server {
  const server = new Server(
    { name: NAME, version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Modelog exposes read-only metrics derived from your own local AI " +
        "coding-assistant session logs. It holds no prompts or code. All " +
        "tools are read-only; there is no way to mutate anything through it. " +
        "Several metrics have semantics their names do not convey, so " +
        "modelog_get_definitions describes them and is worth reading before " +
        "interpreting the other tools' numbers.",
    },
  );

  // Plain JSON Schema straight from the tool declarations — no zod. The
  // schemas are part of the contract a client validates against, so they live
  // beside the handlers rather than being restated here.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ ...t, inputSchema: { ...t.inputSchema } })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    try {
      const ctx = await buildContext();
      const result = callTool(name, args, ctx);

      if (!result.ok) {
        // A bad argument or an unknown tool is the caller's error, and is
        // reported as a failed call rather than as an empty envelope — an
        // agent must not read "you asked wrongly" as "there is no data".
        return { isError: true, content: [{ type: "text", text: result.error }] };
      }

      // A single text block holding the serialised envelope: that is what an
      // agent parses (PLAN-part2.md 2.4).
      return { content: [{ type: "text", text: JSON.stringify(result.envelope) }] };
    } catch (e) {
      // MCP.md §9: a locked or unreadable store fails the individual call with
      // a clear error. It must never take the server down, because the next
      // call may well succeed.
      const detail = e instanceof Error ? e.message : String(e);
      return {
        isError: true,
        content: [{ type: "text", text: `Modelog could not read its store: ${detail}` }],
      };
    }
  });

  return server;
}

async function main(): Promise<void> {
  // Opened once at startup purely to surface a clear diagnostic on stderr.
  // Every call re-derives its own status; this is not a cached handle.
  const opened = await openReadOnly(process.env.MODELOG_DB);
  if (opened.status !== "ok") {
    // stderr only. stdout is the protocol channel and must carry nothing but
    // framed JSON-RPC, or the client's parser breaks.
    console.error(`[modelog] store unavailable (${opened.status}): ${opened.note}`);
  } else {
    const count = readTurns(opened.db).length;
    opened.db.close();
    console.error(
      `[modelog] store ok, schema ${SCHEMA_VERSION}, ${count} turns, ` +
        `rates effective ${PRICING.effective_date}`,
    );
  }

  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(
    `[modelog] mcp server ${VERSION} ready on stdio, ${TOOLS.length} tools`,
  );
}

main().catch((e) => {
  console.error("[modelog] fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
