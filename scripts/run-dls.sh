#!/bin/bash
# Supervisor: keeps the Dust La Stella logger alive, keeps the Mac awake,
# and backs up DB + jsonl every 10 min. Stop: kill the PID in data/run-dls.pid
cd "$(dirname "$0")/.."
echo $$ > data/run-dls.pid
caffeinate -i -m -w $$ &
( while true; do
    sleep 600
    ts=$(date +%Y%m%d-%H%M)
    sqlite3 data/plugo.db ".backup data/backups/plugo-$ts-dls.db" 2>/dev/null
    cp data/backup-dustlastella.com.jsonl data/backups/backup-dustlastella-$ts.jsonl
    ls -t data/backups/*-dls.db 2>/dev/null | tail -n +7 | xargs rm -f   # keep last 6 auto DB backups
  done ) &
while true; do
  python3 -I scripts/plugo-logger.py dustlastella.com 10346 5
  echo "[run-dls] logger exited ($?), restarting in 3s" >&2
  sleep 3
done
