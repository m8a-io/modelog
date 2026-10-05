#!/usr/bin/env node
// A throwaway MCP server whose only purpose is to be observed.
//
// Registering it in .mcp.json answers questions about the *client* that
// Modelog's own server cannot, because Modelog's is already approved and
// already connected. Two things make it useful:
//
//   1. It appends to a spawn log the moment it starts, so "was it spawned?"
//      is answerable even if its tool is never called and nothing appears in
//      any UI. That is how task 2.0 established that Claude Code reads MCP
//      config at session start only.
//   2. It has exactly one tool and no dependencies, so it cannot fail for a
//      reason of its own.
//
// It is not part of the extension and nothing imports it. Register it, learn
// the answer, revert the registration.
//
//   "probe": { "command": "node", "args": ["<repo>/scripts/probe-server.mjs"] }

import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOG = process.env.PROBE_LOG ?? join(tmpdir(), "modelog-probe.log");

function log(event, detail = "") {
  // Never throw from the log: a probe that crashes answers nothing.
  try {
    appendFileSync(LOG, `${new Date().toISOString()} pid=${process.pid} ${event} ${detail}\n`);
  } catch {}
}

log("spawned", `ppid=${process.ppid} argv=${process.argv.slice(1).join(" ")}`);
log("env", `node=${process.execPath}`);

const TOOL = {
  name: "probe_heartbeat",
  description: "Returns a timestamp. Exists only to prove the probe was reachable.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handle(req) {
  const { id, method } = req;
  if (method === "initialize") {
    log("initialize", `client=${req.params?.clientInfo?.name ?? "?"}`);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "probe", version: "0.0.0" },
        instructions: "A probe. Call probe_heartbeat if you like; nothing depends on it.",
      },
    };
  }
  if (method === "tools/list") {
    log("tools/list");
    return { jsonrpc: "2.0", id, result: { tools: [TOOL] } };
  }
  if (method === "tools/call") {
    const name = req.params?.name;
    log("tools/call", name);
    if (name !== TOOL.name) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: `No such tool: ${name}` } };
    }
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: `probe alive at ${new Date().toISOString()}` }] },
    };
  }
  // Notifications carry no id and get no reply.
  if (id === undefined) {
    log("notification", method);
    return null;
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      log("unparseable", line.slice(0, 80));
      continue;
    }
    const reply = handle(req);
    if (reply) send(reply);
  }
});
process.stdin.on("end", () => log("stdin closed"));
process.on("SIGTERM", () => { log("SIGTERM"); process.exit(0); });

process.stderr.write(`[probe] ready on stdio, 1 tool, log: ${LOG}\n`);
