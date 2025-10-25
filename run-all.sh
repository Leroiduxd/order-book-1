#!/usr/bin/env bash
set -euo pipefail

# charge .env si présent
if [ -f ".env" ]; then
  export $(grep -v '^#' .env | xargs)
fi

# lance les 4 listeners en parallèle
node src/opened.js &  PID1=$!
node src/executed.js & PID2=$!
node src/stopsUpdated.js & PID3=$!
node src/removed.js &   PID4=$!

echo "[RUNNER] started all listeners: $PID1 $PID2 $PID3 $PID4"
echo "[RUNNER] press Ctrl+C to exit."

# attend qu'un process sorte, puis termine les autres
wait -n
echo "[RUNNER] a listener exited — stopping all…"
kill $PID1 $PID2 $PID3 $PID4 2>/dev/null || true
wait || true
