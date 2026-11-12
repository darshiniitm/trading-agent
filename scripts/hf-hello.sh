#!/usr/bin/env bash
# Dry run: one "hello world" call to Gemma 4 31B via Hugging Face Inference Providers.
# Usage (from the repo root):  bash scripts/hf-hello.sh [provider]   # provider default: deepinfra
set -euo pipefail
cd "$(dirname "$0")/.."
PROVIDER="${1:-deepinfra}"
# Read HF_TOKEN from .env (tolerates spaces around '=' and quotes); never printed.
TOK="${HF_TOKEN:-$(grep -E '^[[:space:]]*HF_TOKEN[[:space:]]*=' .env | head -1 | sed -E 's/^[^=]*=[[:space:]]*//; s/^["'\'']//; s/["'\''][[:space:]]*$//; s/[[:space:]]+$//')}"
[ -n "$TOK" ] || { echo "HF_TOKEN not found in .env"; exit 1; }
echo "Calling google/gemma-4-31B-it via $PROVIDER (token ${TOK:0:3}…, ${#TOK} chars)"
curl -sS -m 90 https://router.huggingface.co/v1/chat/completions \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -w '\n\nHTTP %{http_code} in %{time_total}s\n' \
  -d "{\"model\":\"google/gemma-4-31B-it:$PROVIDER\",\"temperature\":0,\"max_tokens\":60,
       \"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: Hello, world!\"}]}"
