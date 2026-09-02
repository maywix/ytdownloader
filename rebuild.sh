#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo ""
echo "  [1/3] Arrêt du container..."
docker compose down 2>/dev/null || true

echo "  [2/3] Rebuild de l'image (sans cache)..."
docker compose build --no-cache

echo "  [3/3] Démarrage..."
docker compose up -d

echo ""
echo "  ✓ YTDown relancé → http://localhost:8080"
echo ""
