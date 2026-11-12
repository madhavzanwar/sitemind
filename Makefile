# SiteMind — common tasks.  `make help`
SHELL := /bin/bash
PY ?= python3
export SITEMIND_LLM_MODEL ?= qwen2.5:3b

.PHONY: help setup backend frontend model dev run test lint docker-up docker-down voices demo demo-dry clean

help:
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  %-12s %s\n", $$1, $$2}'

setup: backend frontend model ## install backend, build dashboard, pull local model

backend: ## pip install -e backend[dev]
	$(PY) -m pip install -e "backend[dev]"

frontend: ## npm ci && npm run build (-> frontend/dist)
	cd frontend && npm ci --no-audit --no-fund && npm run build

model: ## ollama pull $(SITEMIND_LLM_MODEL)
	ollama pull $(SITEMIND_LLM_MODEL)

dev: ## full no-Docker setup + serve on :8000
	scripts/dev.sh

run: ## serve on :8000 without setup
	SKIP_SETUP=1 scripts/dev.sh

test: ## backend unit tests (deterministic, no LLM)
	cd backend && SITEMIND_LLM_PROVIDER=off $(PY) -m pytest

lint:
	cd backend && ruff check . && ruff format --check . && $(PY) -m mypy sitemind

docker-up: ## docker compose up --build (ollama + app on :8000)
	docker compose up --build -d && docker compose ps

docker-down:
	docker compose down

voices: ## download Piper voice for the demo narration
	scripts/download_voices.sh

demo: ## record + narrate + render submission/sitemind_demo.mp4 (needs Chromium, ffmpeg, piper)
	demo/run_demo.sh

demo-dry: ## test the video pipeline with a test-pattern recording (no app needed)
	$(PY) demo/tts.py && node demo/titlecards.mjs && $(PY) demo/make_dummy_recording.py && \
	$(PY) demo/render.py --rec demo/build/rec_dummy --out demo/build/dummy/sitemind_demo.mp4

clean:
	rm -rf demo/build backend/.data frontend/dist
