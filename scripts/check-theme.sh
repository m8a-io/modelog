#!/usr/bin/env bash
# DESIGN.md §4: no literal colors in webview code. Enforced, not merely agreed.
#
# One narrow exception: src/webview/theme.ts is the single place that reads
# VS Code's CSS variables, and each read carries a fallback for the case where
# a variable is absent. Those literals are allowed ONLY as an argument to the
# v("--vscode-…", …) reader — any other literal in that file still fails.
set -uo pipefail
cd "$(dirname "$0")/.."

COLOR='#[0-9a-fA-F]{3,8}\b|\b(rgb|rgba|hsl|hsla)\s*\('
COMMENT='^\s*[^:]+:[0-9]+:\s*(\*|//|/\*)'

fail=0

# 1. Everything except theme.ts: no literal colors at all.
general=$(grep -rnE "$COLOR" src/webview/ --exclude=theme.ts 2>/dev/null | grep -vE "$COMMENT" || true)
if [ -n "$general" ]; then
  echo "Literal colors found — use var(--vscode-*) instead:"
  echo "$general"
  fail=1
fi

# 2. theme.ts: literals allowed only on a themed-variable fallback line.
themed=$(grep -nE "$COLOR" src/webview/theme.ts 2>/dev/null | grep -vE "$COMMENT" | grep -v 'v("--vscode-' || true)
if [ -n "$themed" ]; then
  echo "Literal colors in theme.ts outside a v(\"--vscode-…\") fallback:"
  echo "$themed"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "theme check: no literal colors outside theme.ts fallbacks"
fi
exit "$fail"
