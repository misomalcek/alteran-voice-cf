#!/usr/bin/env bash
# Alteran Voice — local run.
cd "$(dirname "$0")"
[ -f .env ] || { echo "missing .env (GROQ_API_KEY, OPENROUTER_API_KEY)"; exit 1; }
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8787}"
if command -v uv >/dev/null 2>&1 && [ -x .venv/bin/python ]; then
  exec uv run uvicorn server:app --host "$HOST" --port "$PORT"
else
  exec python3 -m uvicorn server:app --host "$HOST" --port "$PORT"
fi