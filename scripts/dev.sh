#!/usr/bin/env bash
# No-Docker path: install backend + build dashboard + pull the local model + serve on :8000.
#   scripts/dev.sh            # full setup then run
#   SKIP_SETUP=1 scripts/dev.sh   # just run
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY="${PYTHON:-python3}"
MODEL="${SITEMIND_LLM_MODEL:-qwen2.5:3b}"
export SITEMIND_DATA="${SITEMIND_DATA:-$ROOT/backend/.data}"
export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
export SITEMIND_LLM_MODEL="$MODEL"

if [ -z "${SKIP_SETUP:-}" ]; then
  echo "==> backend: pip install -e backend[dev]"
  "$PY" -m pip install -q -e "backend[dev]"

  echo "==> frontend: npm ci && npm run build"
  (cd frontend && npm ci --no-audit --no-fund && npm run build)

  if [ "${SITEMIND_LLM_PROVIDER:-ollama}" = "ollama" ]; then
    if ! command -v ollama >/dev/null; then
      echo "!! ollama not found - install from https://ollama.com (or set SITEMIND_LLM_PROVIDER=off)"; exit 1
    fi
    if ! curl -fsS "$OLLAMA_BASE_URL/api/tags" >/dev/null 2>&1; then
      echo "==> starting ollama serve"
      (ollama serve >"${TMPDIR:-/tmp}/ollama.log" 2>&1 &)
      for _ in $(seq 1 30); do curl -fsS "$OLLAMA_BASE_URL/api/tags" >/dev/null 2>&1 && break; sleep 1; done
    fi
    echo "==> ollama pull $MODEL"
    ollama pull "$MODEL"
  fi
fi

echo "==> SiteMind on http://localhost:${PORT:-8000}  (data: $SITEMIND_DATA)"
cd backend
exec "$PY" -m uvicorn sitemind.api:app --host "${HOST:-0.0.0.0}" --port "${PORT:-8000}"
