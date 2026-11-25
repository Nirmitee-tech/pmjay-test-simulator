#!/bin/bash
# Start the PMJAY Test Simulator, replacing whatever LISTENS on the port (LISTEN only, so a tunnel holding a
# client connection to the port is never killed).
PORT="${PMJAY_PORT:-9300}"
lsof -ti tcp:"$PORT" -sTCP:LISTEN | xargs kill 2>/dev/null
for i in $(seq 1 20); do lsof -ti tcp:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.2; done
cd "$(dirname "$0")"
mkdir -p data
PMJAY_PORT="$PORT" nohup node src/server/index.js > data/server.out 2>&1 &
for i in $(seq 1 30); do
  sleep 0.3
  if curl -s -o /dev/null "http://localhost:$PORT/mock/health"; then
    echo "PMJAY Test Simulator listening on http://localhost:$PORT"; exit 0
  fi
done
echo "PMJAY Test Simulator failed to start:"; tail -5 data/server.out; exit 1
