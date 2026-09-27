#!/bin/bash
# Copilot on-disk recon — macOS. Answers PRD §11 open questions 2, 12, 13.
#
# SAFETY: emits schema, table/column names, counts and date ranges ONLY.
# It never SELECTs a row value, so no prompts and no source code leave the
# machine. Verify that yourself before running it on work hardware.
#
# Quit VS Code first — a read-only open can fail if the WAL needs recovery.
#
#   bash recon-copilot.sh            # writes ./copilot-recon.txt

OUT="${1:-./copilot-recon.txt}"
exec > >(tee "$OUT") 2>&1

echo "# Copilot recon — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# host: $(sw_vers -productVersion 2>/dev/null) / sqlite $(sqlite3 --version 2>/dev/null | cut -d' ' -f1)"

for APP in "Code" "Code - Insiders" "Cursor" "VSCodium"; do
  G="$HOME/Library/Application Support/$APP/User/globalStorage"
  [ -d "$G" ] || continue
  echo
  echo "================ $APP ================"
  ls -la "$G" | grep -i copilot || echo "(no copilot globalStorage dir)"

  find "$G" -iname "*copilot*" -type d -maxdepth 1 2>/dev/null | while read -r D; do
    echo "--- contents of $D ---"
    ls -la "$D"
  done

  find "$G" -ipath "*copilot*" \( -name "*.db" -o -name "*.sqlite" -o -name "*.sqlite3" \) 2>/dev/null | while read -r DB; do
    echo
    echo "--- DB: $DB  ($(du -h "$DB" | cut -f1)) ---"
    Q() { sqlite3 "file:$DB?mode=ro" "$1" 2>&1; }

    echo "[tables]";  Q ".tables"
    echo "[schema]";  Q ".schema"

    echo "[row counts]"
    Q "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';" | while read -r T; do
      [ -n "$T" ] && echo "  $T = $(Q "SELECT COUNT(*) FROM \"$T\";")"
    done

    # Q12: is per-turn cost on disk at all? column names only.
    echo "[columns matching cost/credit/premium/multiplier/quota/model/token]"
    Q "SELECT m.name FROM sqlite_master m WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%';" | while read -r T; do
      [ -z "$T" ] && continue
      Q "SELECT name FROM pragma_table_info('$T');" | grep -Ei 'cost|credit|premium|multipl|quota|model|token|usage|price' \
        | sed "s|^|  $T.|"
    done

    # Q13 / history depth: range of any timestamp-ish column. Aggregates only.
    echo "[timestamp-ish column ranges]"
    Q "SELECT m.name FROM sqlite_master m WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%';" | while read -r T; do
      [ -z "$T" ] && continue
      Q "SELECT name FROM pragma_table_info('$T');" | grep -Ei 'time|date|created|updated|ts$' | while read -r C; do
        echo "  $T.$C  min=$(Q "SELECT MIN(\"$C\") FROM \"$T\";")  max=$(Q "SELECT MAX(\"$C\") FROM \"$T\";")"
      done
    done
  done
done

echo
echo "================ extension versions ================"
ls ~/.vscode/extensions 2>/dev/null | grep -i copilot || echo "(none in ~/.vscode/extensions)"
ls ~/.vscode-insiders/extensions 2>/dev/null | grep -i copilot

echo
echo "================ other copilot state on disk ================"
find ~/Library/Application\ Support -iname "*copilot*" -maxdepth 6 2>/dev/null | head -40

echo
echo "# done -> $OUT"
