#!/bin/bash
# Generic supervisor: keeps the Plugo logger alive for one shop, keeps the Mac
# awake, and backs up DB + jsonl every 10 min.
# Usage: scripts/run-logger.sh <domain> <shopId> [intervalSec]
# Stop:  kill $(cat data/run-<domain>.pid)
DOMAIN=$1; SHOP=$2; INT=${3:-5}
[ -z "$DOMAIN" ] || [ -z "$SHOP" ] && { echo "usage: $0 <domain> <shopId> [intervalSec]"; exit 1; }
cd "$(dirname "$0")/.."
mkdir -p data/backups
echo $$ > "data/run-$DOMAIN.pid"
caffeinate -i -m -w $$ &
( while true; do
    sleep 600
    ts=$(date +%Y%m%d-%H%M)
    sqlite3 data/plugo.db ".backup data/backups/plugo-$ts-$DOMAIN.db" 2>/dev/null
    cp "data/backup-$DOMAIN.jsonl" "data/backups/backup-$DOMAIN-$ts.jsonl" 2>/dev/null
    ls -t data/backups/plugo-*-"$DOMAIN".db 2>/dev/null | tail -n +7 | xargs rm -f   # keep last 6 auto DB backups
  done ) &
while true; do
  python3 -I scripts/plugo-logger.py "$DOMAIN" "$SHOP" "$INT"
  echo "[run-logger] logger exited ($?), restarting in 3s" >&2
  sleep 3
done
