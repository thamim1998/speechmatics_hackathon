#!/bin/bash
# Start all three services from the project root
# Usage: ./start.sh       — start all services
#        ./start.sh stop  — stop all running services

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── Stop mode ───────────────────────────────────────────
if [ "$1" = "stop" ]; then
  echo "Stopping services..."
  pkill -f "node.*index\.js" 2>/dev/null && echo "  Backend stopped" || echo "  Backend was not running"
  pkill -f "vite" 2>/dev/null && echo "  Frontend stopped" || echo "  Frontend was not running"
  pkill -f "livekit_agent\.py" 2>/dev/null && echo "  Agent stopped" || echo "  Agent was not running"
  echo "Done."
  exit 0
fi

# ─── Kill any existing instances first ───────────────────
pkill -f "node.*index\.js" 2>/dev/null
pkill -f "vite" 2>/dev/null
pkill -f "livekit_agent\.py" 2>/dev/null
sleep 1

# ─── Cleanup on exit ────────────────────────────────────
cleanup() {
  echo ""
  echo "Shutting down..."
  kill $BACKEND_PID $FRONTEND_PID $AGENT_PID 2>/dev/null
  wait $BACKEND_PID $FRONTEND_PID $AGENT_PID 2>/dev/null
  echo "Done."
}
trap cleanup EXIT INT TERM

echo "=== Starting Dementia Voice Agent ==="

# Python Agent
echo "[1/3] Starting Python agent (LiveKit)..."
(cd "$ROOT_DIR/demo" && PYTHONUNBUFFERED=1 uv run python -u livekit_agent.py dev) &
AGENT_PID=$!

sleep 3

# Backend
echo "[2/3] Starting backend (port 3000)..."
(cd "$ROOT_DIR/backend" && node index.js) &
BACKEND_PID=$!

sleep 2

# Frontend
echo "[3/3] Starting frontend (port 5173)..."
(cd "$ROOT_DIR/frontend" && npx vite) &
FRONTEND_PID=$!

sleep 2

echo ""
echo "=== All services running ==="
echo "  Agent:     Python LiveKit agent (listening for calls)"
echo "  Backend:   http://localhost:3000"
echo "  Frontend:  http://localhost:5173"
echo ""
echo "  To stop:   ./start.sh stop"
echo "  Or press Ctrl+C"
echo ""

wait
