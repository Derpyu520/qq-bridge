#!/usr/bin/env bash
# Launch the docs-site live-reload dev server (pure-stdlib HTTP + SSE).
#   ./run_dev.sh            # port 8002
#   ./run_dev.sh 9000       # custom port
#   HOST=127.0.0.1 ./run_dev.sh
# The server re-bakes pages on every change; without it, run python3 _lib/_wrap_handwritten.py.
# See README.md.
set -e
cd "$(dirname "$0")"
PORT=${1:-8002}; INTERVAL=${INTERVAL:-0.5}; HOST=${HOST:-0.0.0.0}
PYTHON=${PYTHON:-python3}
echo "Doc-Site live-reload: http://${HOST}:${PORT}/"
"$PYTHON" _lib/_serve.py --host "$HOST" --port "$PORT" --interval "$INTERVAL"
