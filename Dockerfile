# syntax=docker/dockerfile:1
# SiteMind — single image: React dashboard (built with Node) served by the FastAPI backend.

# ---------- stage 1: build the dashboard ----------
FROM node:22-bookworm-slim AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- stage 2: python runtime ----------
FROM python:3.12-slim-bookworm AS app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    SITEMIND_DATA=/data \
    SITEMIND_FRONTEND_DIST=/app/frontend/dist \
    SITEMIND_LLM_PROVIDER=ollama \
    SITEMIND_LLM_MODEL=qwen2.5:3b \
    OLLAMA_BASE_URL=http://ollama:11434
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl tini \
    && rm -rf /var/lib/apt/lists/*
COPY backend/ /app/backend/
RUN pip install /app/backend
COPY --from=web /src/frontend/dist /app/frontend/dist
RUN useradd --create-home --uid 10001 sitemind && mkdir -p /data && chown sitemind /data
USER sitemind
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://localhost:8000/api/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["uvicorn", "sitemind.api:app", "--host", "0.0.0.0", "--port", "8000"]
