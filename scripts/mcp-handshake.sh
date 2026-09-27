#!/bin/bash
# Speak MCP to the built server over stdio, with no client involved.
# Usage: bash scripts/mcp-handshake.sh [path-to-store.db]
DB="${1:-$HOME/.vscode-server/data/User/globalStorage/modelog.modelog/modelog.db}"
[ -f dist/mcp-server.mjs ] || { echo "run: npm run build"; exit 1; }
echo "store: $DB"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"handshake","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 0.6
} | MODELOG_DB="$DB" node dist/mcp-server.mjs 2>&1 | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    if not line.startswith('{'):
        print('  stderr |', line); continue
    m = json.loads(line)
    print(f\"  reply  | id={m.get('id')}\", json.dumps(m.get('result') or m.get('error')))
"
