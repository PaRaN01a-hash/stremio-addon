#!/usr/bin/env bash
set -euo pipefail

cd /home/ubuntu/stremio-addon

PORT="${PORT:-6000}"
BASE="${BASE:-http://localhost:$PORT}"
DATE="${DATE:-$(date +%F)}"
RCLONE_CONFIG_PATH="${RCLONE_CONFIG_PATH:-/home/ubuntu/.config/rclone/rclone.conf}"
CLOUD_BACKUP="${CLOUD_BACKUP:-/tmp/maximus-local-index-memory-from-gdrive-$DATE.json}"

TOKEN="$(docker exec nuvio-addon sh -lc 'printf "%s" "$LOCAL_INDEX_ADMIN_TOKEN"')"

echo "Maximus Core Engine cloud restore drill"
echo "BASE=$BASE"
echo "DATE=$DATE"
echo "CLOUD_BACKUP=$CLOUD_BACKUP"

echo
echo "---- download memory backup from Google Drive current ----"
sudo RCLONE_CONFIG="$RCLONE_CONFIG_PATH" \
  rclone copyto \
  "gdrive:server-backups/current/maximus-local-index-memory-$DATE.json" \
  "$CLOUD_BACKUP"

echo
echo "---- downloaded backup summary ----"
python3 - <<PY
import json
p="$CLOUD_BACKUP"
data=json.load(open(p))
print("file:", p)
print("format:", data.get("format"))
print("count:", data.get("count"))
print("keys:", [r.get("key") for r in data.get("records", [])[:10]])
PY

echo
echo "---- delete Friends memory key ----"
curl -s -X DELETE "$BASE/debug/local-index/series/tt0108778:1:1.json" \
  -H "x-local-index-token: $TOKEN" | python3 -m json.tool

echo
echo "---- confirm Friends memory deleted ----"
curl -s "$BASE/debug/local-index/series/tt0108778:1:1.json" \
  | python3 -m json.tool \
  | grep -E '"count"|"name"|"url"' \
  | head -40 || true

echo
echo "---- restore memory from Google Drive backup ----"
./scripts/local-index-memory.py restore \
  --container stremio-redis \
  --file "$CLOUD_BACKUP"

echo
echo "---- confirm Friends memory restored ----"
curl -s "$BASE/debug/local-index/series/tt0108778:1:1.json" \
  | python3 -m json.tool \
  | grep -E '"count"|"name"|"url"|"bucket"|"matchDecision"|"sortScore"' \
  | head -120

echo
echo "---- delete normal stream cache only ----"
docker exec stremio-redis redis-cli DEL "streams:tt0108778:1:1"

echo
echo "---- warm hit after cloud restore ----"
time curl -s "$BASE/debug/streams/series/tt0108778:1:1.json?title=Friends" \
  | python3 -m json.tool \
  | grep -E '"count"|"name"|"bucket"|"sortScore"|"decision"' \
  | head -80

echo
echo "✅ cloud restore drill complete"
