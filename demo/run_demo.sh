#!/usr/bin/env bash
# One command: fresh backend (real local model) -> narration -> title cards -> recording -> render.
#   demo/run_demo.sh                    # starts its own backend on :8000
#   SITEMIND_URL=http://host:8000 NO_SERVER=1 demo/run_demo.sh   # use a running backend
# Env: SITEMIND_STEP_DELAY (pacing per agent step, default 3.0), SITEMIND_LLM_MODEL, PORT.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY="${PYTHON:-python3}"
PORT="${PORT:-8000}"
export SITEMIND_URL="${SITEMIND_URL:-http://localhost:$PORT}"
export SITEMIND_STEP_DELAY="${SITEMIND_STEP_DELAY:-3.0}"
export SITEMIND_LLM_PROVIDER="${SITEMIND_LLM_PROVIDER:-ollama}"
export SITEMIND_LLM_MODEL="${SITEMIND_LLM_MODEL:-qwen2.5:3b}"
export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
export SITEMIND_LLM_TIMEOUT="${SITEMIND_LLM_TIMEOUT:-120}"
BUILD="$ROOT/demo/build"
mkdir -p "$BUILD"

[ -s demo/voices/en_US-lessac-high.onnx ] || scripts/download_voices.sh

echo "==> [1/4] narration (Piper)"
"$PY" demo/tts.py
echo "==> [2/4] title cards"
node demo/titlecards.mjs

SERVER_PID=""
cleanup() { [ -n "${PINGER_PID:-}" ] && kill "$PINGER_PID" 2>/dev/null || true; [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; pkill -f "sitemind.runner" 2>/dev/null || true; }
trap cleanup EXIT

if [ -z "${NO_SERVER:-}" ]; then
  [ -f frontend/dist/index.html ] || (cd frontend && npm run build)
  if curl -fsS "$SITEMIND_URL/api/health" >/dev/null 2>&1; then
    echo "!! something already listens on $SITEMIND_URL - stop it or set NO_SERVER=1"; exit 1
  fi
  # make sure Ollama is up, then warm the model so the first plan call is not slowed by model load
  if [ "$SITEMIND_LLM_PROVIDER" = "ollama" ]; then
    if ! curl -fsS "$OLLAMA_BASE_URL/api/tags" >/dev/null 2>&1 && command -v ollama >/dev/null; then
      echo "==> starting ollama serve"
      (ollama serve >"$BUILD/ollama.log" 2>&1 &)
      for _ in $(seq 1 30); do curl -fsS "$OLLAMA_BASE_URL/api/tags" >/dev/null 2>&1 && break; sleep 1; done
    fi
    # warm through the same OpenAI-compatible endpoint the backend uses (a cold load can take >60 s),
    # then keep the model resident while recording (Ollama unloads idle models after 5 min)
    warm() { curl -fsS -m 240 "$OLLAMA_BASE_URL/v1/chat/completions" -H 'content-type: application/json' \
      -d "{\"model\":\"$SITEMIND_LLM_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"ok\"}],\"max_tokens\":1}" >/dev/null; }
    echo "==> warming $SITEMIND_LLM_MODEL"
    warm || echo "!! ollama warm-up failed (agent will use fallback templates)"
    ( while sleep 90; do warm || true; done ) &
    PINGER_PID=$!
  fi
  export SITEMIND_DATA="$BUILD/data"
  rm -rf "$SITEMIND_DATA"; mkdir -p "$SITEMIND_DATA"
  echo "==> starting backend on :$PORT (step delay ${SITEMIND_STEP_DELAY}s, data $SITEMIND_DATA)"
  (cd backend && exec "$PY" -m uvicorn sitemind.api:app --host 127.0.0.1 --port "$PORT" --log-level warning) \
    >"$BUILD/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 60); do curl -fsS "$SITEMIND_URL/api/health" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS "$SITEMIND_URL/api/health"; echo
fi

echo "==> [3/4] recording the dashboard"
node demo/record.mjs --base "$SITEMIND_URL" --out "$BUILD/rec"

echo "==> [4/4] render"
"$PY" demo/render.py --rec "$BUILD/rec" --out "$ROOT/submission/sitemind_demo.mp4"
ffprobe -v error -show_entries format=duration:stream=codec_name,width,height -of compact "$ROOT/submission/sitemind_demo.mp4"
echo "==> done: submission/sitemind_demo.mp4, frames in submission/frames/"
