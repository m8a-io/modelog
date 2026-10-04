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
  printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"modelog_get_summary","arguments":{"days":30}}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"modelog_compare_models","arguments":{"days":30}}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"modelog_get_markers","arguments":{"days":30}}}'
  # Deliberately invalid: must come back isError, not as an empty envelope.
  printf '%s\n' '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"modelog_get_summary","arguments":{"days":7,"from":"2026-01-01"}}}'
  sleep 0.8
} | MODELOG_DB="$DB" node dist/mcp-server.mjs 2>&1 | python3 -c "
import sys, json

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    if not line.startswith('{'):
        print('  stderr |', line)
        continue

    m = json.loads(line)
    rid = m.get('id')
    res = m.get('result') or m.get('error') or {}

    # tools/list: names only, so the output stays readable.
    if 'tools' in res:
        print(f'  reply  | id={rid} tools/list:')
        for t in res['tools']:
            print(f\"           - {t['name']}\")
        continue

    # tools/call: unwrap the text block and show the envelope.
    if 'content' in res:
        text = res['content'][0]['text']
        if res.get('isError'):
            print(f'  reply  | id={rid} ERROR (expected for id=6): {text}')
            continue
        env = json.loads(text)
        notes = env.get('notes', [])
        print(f\"  reply  | id={rid} status={env['status']} range={env['range']['from']} .. {env['range']['to']}\")
        print(f\"           data: {json.dumps(env['data'])[:300]}\")
        for n in notes:
            print(f'           note: {n[:160]}')
        continue

    print(f'  reply  | id={rid}', json.dumps(res)[:300])
"
