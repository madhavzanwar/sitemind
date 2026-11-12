#!/usr/bin/env bash
# Download Piper TTS voices (rhasspy/piper-voices on Hugging Face) into demo/voices/ (gitignored).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/demo/voices"
mkdir -p "$DIR"
BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main"
VOICES="${VOICES:-en/en_US/lessac/high/en_US-lessac-high}"
for v in $VOICES; do
  name="$(basename "$v")"
  for ext in onnx onnx.json; do
    if [ ! -s "$DIR/$name.$ext" ]; then
      echo "downloading $name.$ext"
      curl -sSLf -o "$DIR/$name.$ext" "$BASE/$v.$ext"
    fi
  done
done
ls -la "$DIR"
