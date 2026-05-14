#!/usr/bin/env bash
set -euo pipefail

cd /home/ubuntu/stremio-addon

PORT="${PORT:-6000}"
BASE="${BASE:-http://localhost:$PORT}"
TEST_ID="${TEST_ID:-tt0468569}"
TEST_TITLE="${TEST_TITLE:-The Dark Knight}"
BACKUP=".env.bak-stremthru-isolation-$(date +%F-%H%M%S)"

echo "Maximus StremThru isolation test"
echo "BASE=$BASE"
echo "TEST_ID=$TEST_ID"
echo "TEST_TITLE=$TEST_TITLE"

echo
echo "---- backup .env ----"
cp .env "$BACKUP"
echo "$BACKUP"

restore_env() {
  echo
  echo "---- restoring original .env ----"
  cp "$BACKUP" .env
  docker compose -f docker/docker-compose.yml up -d --build --force-recreate addon >/dev/null
  echo "✅ original .env restored and addon rebuilt"
}
trap restore_env EXIT

echo
echo "---- switch to StremThru-only external mode ----"
python3 <<'PY'
from pathlib import Path

p = Path(".env")
rows = p.read_text().splitlines()
out = []

for line in rows:
    if line.startswith("EXTERNAL_STREAM_ADDONS="):
        out.append("EXTERNAL_STREAM_ADDONS=")
    elif line.startswith("EXTERNAL_STREMIO_ADDONS="):
        out.append("EXTERNAL_STREMIO_ADDONS=")
    else:
        out.append(line)

p.write_text("\n".join(out) + "\n")
print("✅ Disabled EXTERNAL_STREAM_ADDONS and EXTERNAL_STREMIO_ADDONS for this test only")
PY

echo
echo "---- source counts ----"
python3 <<'PY'
from pathlib import Path

s = Path(".env").read_text()

for name in ["EXTERNAL_STREAM_ADDONS", "STREAMTHRU_MANIFEST_URLS", "EXTERNAL_STREMIO_ADDONS"]:
    for line in s.splitlines():
        if line.startswith(name + "="):
            val = line.split("=", 1)[1].strip().strip('"').strip("'")
            urls = [x.strip() for x in val.split(",") if x.strip()]
            print(f"{name}: count={len(urls)}")
            for i, u in enumerate(urls, 1):
                host = u.split("/")[2] if "://" in u else "unknown"
                print(f"  {i}. host={host}")
            break
PY

echo
echo "---- rebuild addon in StremThru-only mode ----"
docker compose -f docker/docker-compose.yml up -d --build --force-recreate addon
sleep 8

TOKEN="$(docker exec nuvio-addon sh -lc 'printf "%s" "$LOCAL_INDEX_ADMIN_TOKEN"')"

echo
echo "---- registry check ----"
curl -s "$BASE/debug/sources.json" > /tmp/maximus-stremthru-sources.json

python3 <<'PY'
import json

data = json.load(open("/tmp/maximus-stremthru-sources.json"))
sources = {s.get("id"): s for s in data.get("sources", [])}

for sid in ["streamthru", "external-stream-addons", "external-stremio"]:
    src = sources.get(sid, {})
    print(sid, "enabled=", src.get("enabled"), "configuredCount=", src.get("configuredCount", "n/a"))

st = sources.get("streamthru") or {}
if st.get("enabled") is not True or st.get("configuredCount") != 1:
    raise SystemExit("❌ StreamThru is not enabled/configured as expected")

if sources.get("external-stream-addons", {}).get("enabled") is not False:
    raise SystemExit("❌ EXTERNAL_STREAM_ADDONS was not disabled")

if sources.get("external-stremio", {}).get("enabled") is not False:
    raise SystemExit("❌ EXTERNAL_STREMIO_ADDONS was not disabled")

print("✅ registry isolation passed")
PY

echo
echo "---- clear test memory/cache ----"
curl -s -X DELETE "$BASE/debug/local-index/movie/$TEST_ID.json" \
  -H "x-local-index-token: $TOKEN" | python3 -m json.tool

docker exec stremio-redis redis-cli DEL "streams:$TEST_ID"

echo
echo "---- cold fetch with StremThru-only external source ----"
curl -m 90 -s "$BASE/debug/streams/movie/$TEST_ID.json?title=$(python3 - <<PY
import urllib.parse
print(urllib.parse.quote("$TEST_TITLE"))
PY
)" > /tmp/maximus-stremthru-streams.json

python3 -m json.tool /tmp/maximus-stremthru-streams.json \
  | grep -E '"count"|"name"|"bucket"|"sortScore"|"decision"|"matchSource"|"parseable"' \
  | head -220

echo
echo "---- provider assertions ----"
curl -s "$BASE/debug/engine" > /tmp/maximus-stremthru-engine.json

python3 <<'PY'
import json

data = json.load(open("/tmp/maximus-stremthru-engine.json"))
p = data.get("providerLast") or {}
q = p.get("quality") or {}
external = int(p.get("externalAddonCount") or 0)
final = int(p.get("finalStreamCount") or 0)

print("externalAddonCount:", external)
print("externalStremioCount:", p.get("externalStremioCount"))
print("finalStreamCount:", final)
print("externalContributed:", (q.get("signals") or {}).get("externalContributed"))
print("totalMs:", p.get("totalMs"))

if external <= 0:
    raise SystemExit("❌ StremThru returned no external addon streams")

if final <= 0:
    raise SystemExit("❌ final stream count was zero")

if (q.get("signals") or {}).get("externalContributed") is not True:
    raise SystemExit("❌ provider quality did not mark external contribution")

print("✅ provider assertions passed")
PY

echo
echo "---- memory URL safety assertions ----"
curl -s "$BASE/debug/local-index/movie/$TEST_ID.json" > /tmp/maximus-stremthru-memory.json

python3 <<'PY'
import json

data = json.load(open("/tmp/maximus-stremthru-memory.json"))
streams = data.get("streams", [])
bad = []
stremthru_names = 0

for s in streams:
    name = s.get("name", "")
    url = s.get("url", "")
    if "streamthru" in name.lower() or "stremthru" in name.lower():
        stremthru_names += 1
    if not url.startswith("https://maxstreams.opik.net/resolve?hash="):
        bad.append((name, url))

print("memoryCount:", data.get("count"))
print("stremthruNamedStreams:", stremthru_names)
print("badUrlCount:", len(bad))

if not streams:
    raise SystemExit("❌ no memory streams saved")

if stremthru_names <= 0:
    raise SystemExit("❌ no StreamThru-named streams were remembered")

if bad:
    for name, url in bad:
        print("BAD:", name, "=>", url)
    raise SystemExit("❌ found non-Maximus resolver URLs in memory")

print("✅ all remembered URLs are Maximus resolver URLs")
PY

echo
echo "✅ StremThru isolation test passed"
