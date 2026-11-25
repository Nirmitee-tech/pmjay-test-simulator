#!/bin/bash
# Example: run several simulator instances side by side, one per HIMS test copy, so parallel test
# runs never share cases. Lane N listens on BASE_PORT+N, keeps its data in data/lanes/wN and sends
# callbacks to HIMS_HOST on port HIMS_BASE_PORT+N. Adjust the three settings below to your setup.
#
#   examples/lanes.sh start | stop | status      (LANES="1 3" to act on some lanes only)
#
# stop kills only the process that LISTENS on each lane port, so a client connection is never killed.
cd "$(dirname "$0")/.."
LANES="${LANES:-1 2}"
BASE_PORT="${BASE_PORT:-9300}"          # lane N listens on BASE_PORT+N
HIMS_HOST="${HIMS_HOST:-localhost}"     # where the HIMS copies run
HIMS_BASE_PORT="${HIMS_BASE_PORT:-8081}" # lane N calls back to HIMS_BASE_PORT+N

lane_port() { echo $((BASE_PORT + $1)); }
lane_pid() { lsof -ti tcp:"$(lane_port "$1")" -sTCP:LISTEN 2>/dev/null | head -1; }

start() {
  local n=$1 port dir
  port=$(lane_port "$n"); dir="data/lanes/w$n"
  if [ -n "$(lane_pid "$n")" ]; then echo "w$n: already listening on $port"; return 0; fi
  mkdir -p "$dir"
  # Share the main instance's payer key pair, so every lane answers with a certificate the HIMS already knows.
  for f in payer-1518.key payer-1518.crt; do [ -f "$dir/$f" ] || { [ -f "data/$f" ] && cp -p "data/$f" "$dir/$f"; }; done
  PMJAY_PORT="$port" PMJAY_DATA_DIR="$PWD/$dir" PMJAY_CALLBACK_BASE="http://$HIMS_HOST:$((HIMS_BASE_PORT + n))" \
    nohup node src/server/index.js > "$dir/server.out" 2>&1 &
  for i in $(seq 1 30); do
    sleep 0.3
    if curl -s -o /dev/null "http://localhost:$port/mock/health"; then echo "w$n: listening on $port"; return 0; fi
  done
  echo "w$n: failed to start:"; tail -5 "$dir/server.out"; return 1
}

stop() {
  local n=$1 pid
  pid=$(lane_pid "$n")
  if [ -z "$pid" ]; then echo "w$n: not running"; return 0; fi
  kill "$pid"
  for i in $(seq 1 20); do [ -z "$(lane_pid "$n")" ] && break; sleep 0.2; done
  [ -z "$(lane_pid "$n")" ] && echo "w$n: stopped" || echo "w$n: pid $pid still listening"
}

status() {
  local n=$1 port pid
  port=$(lane_port "$n"); pid=$(lane_pid "$n")
  if [ -z "$pid" ]; then echo "w$n: port $port down"; return 1; fi
  echo "w$n: port $port pid $pid health: $(curl -s -m 3 "http://localhost:$port/mock/health" | head -c 200)"
}

case "${1:-}" in
  start|stop|status) rc=0; for n in $LANES; do "$1" "$n" || rc=1; done; exit $rc ;;
  *) echo "usage: $0 start|stop|status"; exit 2 ;;
esac
