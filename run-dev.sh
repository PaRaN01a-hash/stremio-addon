#!/usr/bin/env bash
set -euo pipefail

AIO_URL=$(grep '^EXTERNAL_STREMIO_ADDONS=' .env | cut -d= -f2- | tr -d '"' || true)
HDHUB_URL=$(grep '^EXTERNAL_STREAM_ADDONS=' .env | cut -d= -f2- | tr -d '"' || true)
JACKETT_URL=$(grep '^JACKETT_URL=' .env | cut -d= -f2- | tr -d '"' || true)

REDIS_IP=""
if docker ps --format '{{.Names}}' | grep -qx 'stremio-redis'; then
  REDIS_IP=$(docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' stremio-redis)
fi

echo "Starting Maximus local dev on PORT=6001"
echo "External Stremio addons: $( [ -n "$AIO_URL" ] && echo enabled || echo disabled )"
echo "External stream addons: $( [ -n "$HDHUB_URL" ] && echo enabled || echo disabled )"
echo "Redis: $( [ -n "$REDIS_IP" ] && echo enabled || echo disabled )"

if [ -n "$REDIS_IP" ]; then
  REDIS_URL="redis://$REDIS_IP:6379" \
  PORT=6001 \
  ZILEAN_URL="${ZILEAN_URL:-http://localhost:8181}" \
  JACKETT_URL="$JACKETT_URL" \
  EXTERNAL_STREMIO_ADDONS="$AIO_URL" \
  EXTERNAL_STREAM_ADDONS="$HDHUB_URL" \
  MAX_FINAL_STREAMS="${MAX_FINAL_STREAMS:-40}" \
  MAX_PER_PROVIDER_QUALITY="${MAX_PER_PROVIDER_QUALITY:-2}" \
  npm run dev
else
  REDIS_DISABLED=true \
  PORT=6001 \
  ZILEAN_URL="${ZILEAN_URL:-http://localhost:8181}" \
  JACKETT_URL="$JACKETT_URL" \
  EXTERNAL_STREMIO_ADDONS="$AIO_URL" \
  EXTERNAL_STREAM_ADDONS="$HDHUB_URL" \
  MAX_FINAL_STREAMS="${MAX_FINAL_STREAMS:-40}" \
  MAX_PER_PROVIDER_QUALITY="${MAX_PER_PROVIDER_QUALITY:-2}" \
  npm run dev
fi
