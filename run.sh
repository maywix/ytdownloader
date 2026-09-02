#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

pip3 install -q --break-system-packages -r requirements.txt 2>/dev/null || \
pip3 install -q --user -r requirements.txt 2>/dev/null || true

if ! command -v ffmpeg &>/dev/null; then
  echo "⚠  ffmpeg manquant → sudo apt install ffmpeg"
fi

python3 app.py
