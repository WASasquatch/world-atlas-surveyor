#!/usr/bin/env sh
# Serve World Atlas Surveyor locally.
# Browsers refuse to load ES modules from file:// URLs, so the app needs a
# local HTTP server. Uses Python 3 if available, falling back to Node (npx).
# Usage: ./serve.sh [port]   (if the port is taken, nearby ports are tried)
cd "$(dirname "$0")" || exit 1
REQ="${1:-5654}"

# Pick a server runtime.
if command -v python3 >/dev/null 2>&1; then SRV=python3
elif command -v python >/dev/null 2>&1; then SRV=python
elif command -v node >/dev/null 2>&1; then SRV=node
else
  echo "Error: no python3, python, or node found. Install Python 3 or Node.js." >&2
  exit 1
fi

# Find a port that actually binds -- the requested one may already be taken.
PORT=
for p in "$REQ" $((REQ + 1)) $((REQ + 2)) 8080 8888 9000; do
  if [ "$SRV" = node ]; then
    node -e "const s=require('net').createServer();s.on('error',()=>process.exit(1));s.listen($p,'127.0.0.1',()=>s.close(()=>process.exit(0)))" 2>/dev/null \
      && { PORT=$p; break; }
  else
    "$SRV" -c "import socket;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',$p));s.close()" 2>/dev/null \
      && { PORT=$p; break; }
  fi
done
if [ -z "$PORT" ]; then
  echo "Error: no free local port found (tried $REQ-$((REQ + 2)), 8080, 8888, 9000)." >&2
  exit 1
fi
[ "$PORT" = "$REQ" ] || echo "Port $REQ is unavailable, using $PORT instead."

echo "WAS - serving on http://localhost:$PORT/  (Ctrl+C to stop)"
if [ "$SRV" = node ]; then
  exec npx --yes serve --listen "tcp://127.0.0.1:$PORT" .
else
  exec "$SRV" -m http.server "$PORT" --bind 127.0.0.1
fi
