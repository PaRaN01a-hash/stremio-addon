#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-6000}"
BASE="http://localhost:${PORT}"
WARM_MAX_MS="${WARM_MAX_MS:-1000}"
FAILURES=0

fail() {
  echo "❌ $1"
  FAILURES=$((FAILURES + 1))
}

pass() {
  echo "✅ $1"
}

TOKEN="${LOCAL_INDEX_ADMIN_TOKEN:-}"
if [ -z "$TOKEN" ] && docker ps --format '{{.Names}}' | grep -qx 'nuvio-addon'; then
  TOKEN="$(docker exec nuvio-addon sh -lc 'printf "%s" "$LOCAL_INDEX_ADMIN_TOKEN"' 2>/dev/null || true)"
fi

redis_del() {
  local key="$1"

  if docker ps --format '{{.Names}}' | grep -qx 'stremio-redis'; then
    docker exec stremio-redis redis-cli DEL "$key" >/dev/null || true
  elif docker ps --format '{{.Names}}' | grep -qx 'redis-local-dev'; then
    docker exec redis-local-dev redis-cli DEL "$key" >/dev/null || true
  fi
}

urlencode() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1"
}

provider_summary() {
  local json
  json="$(curl -s "$BASE/debug/engine")"

  ENGINE_JSON="$json" python3 -c '
import json
import os

data = json.loads(os.environ["ENGINE_JSON"])
p = data.get("providerLast") or {}
q = p.get("quality") or {}
jd = p.get("jackettDecision") or {}

print(json.dumps({
  "coreSort": p.get("coreSort"),
  "zileanCount": p.get("zileanCount"),
  "jackettUsed": jd.get("used"),
  "jackettReason": jd.get("reason"),
  "jackettThreshold": jd.get("threshold"),
  "torboxCached": p.get("torboxCached"),
  "internalStreamCount": p.get("internalStreamCount"),
  "finalStreamCount": p.get("finalStreamCount"),
  "totalMs": p.get("totalMs"),
  "speedGrade": q.get("speedGrade"),
  "overallScore": q.get("overallScore"),
}, indent=2))
'
}

memory_summary_json() {
  local memory_json="$1"
  local engine_json="$2"

  MEMORY_JSON="$memory_json" ENGINE_JSON="$engine_json" python3 -c '
import json
import os

memory = json.loads(os.environ["MEMORY_JSON"])
engine = json.loads(os.environ["ENGINE_JSON"])

streams = memory.get("streams") or []
provider = engine.get("providerLast") or {}

external_urls = [
  s.get("url", "")
  for s in streams
  if any(x in str(s.get("url", "")).lower() for x in ["torrentio.strem.fun", "hdhub", "aiostreams"])
]

bad_decisions = [
  s.get("matchDecision")
  for s in streams
  if s.get("matchDecision") != "accept"
]

not_maximus_resolver = [
  s.get("url", "")
  for s in streams
  if "maxstreams.opik.net/resolve?hash=" not in str(s.get("url", ""))
]

print(json.dumps({
  "memoryCount": memory.get("count", 0),
  "coreSort": provider.get("coreSort"),
  "externalUrlCount": len(external_urls),
  "badDecisionCount": len(bad_decisions),
  "notMaximusResolverCount": len(not_maximus_resolver),
}, separators=(",", ":")))
'
}

stream_count_from_json() {
  python3 -c 'import json,sys; print(json.load(sys.stdin).get("count", 0))'
}

run_case() {
  local label="$1"
  local type="$2"
  local id="$3"
  local title="$4"
  local encoded_title
  local cold_json
  local warm_json
  local memory_json
  local engine_json
  local summary
  local memory_count
  local core_sort
  local external_count
  local bad_decision_count
  local not_resolver_count
  local warm_count
  local warm_ms

  encoded_title="$(urlencode "$title")"

  echo
  echo "============================================================"
  echo "CASE: $label"
  echo "TYPE: $type"
  echo "ID:   $id"
  echo "============================================================"

  if [ -n "$TOKEN" ]; then
    curl -s -X DELETE "$BASE/debug/local-index/$type/$id.json" \
      -H "x-local-index-token: $TOKEN" >/dev/null || true
  fi

  redis_del "streams:${id}"

  echo
  echo "---- cold streams ----"
  cold_json="$(curl -m 90 -s "$BASE/debug/streams/$type/$id.json?title=$encoded_title")"

  echo "$cold_json" \
    | python3 -m json.tool \
    | grep -E '"count"|"name"|"bucket"|"sortScore"|"decision"|"matchSource"|"parseable"' \
    | head -160 || true

  echo
  echo "---- provider summary ----"
  provider_summary

  echo
  echo "---- local index memory ----"
  memory_json="$(curl -s "$BASE/debug/local-index/$type/$id.json")"
  engine_json="$(curl -s "$BASE/debug/engine")"

  echo "$memory_json" \
    | python3 -m json.tool \
    | grep -E '"count"|"name"|"url"|"bucket"|"matchDecision"|"sortScore"' \
    | head -140 || true

  echo
  echo "---- cold assertions ----"
  summary="$(memory_summary_json "$memory_json" "$engine_json")"
  echo "$summary" | python3 -m json.tool

  memory_count="$(echo "$summary" | python3 -c 'import json,sys; print(json.load(sys.stdin)["memoryCount"])')"
  core_sort="$(echo "$summary" | python3 -c 'import json,sys; print(json.load(sys.stdin)["coreSort"])')"
  external_count="$(echo "$summary" | python3 -c 'import json,sys; print(json.load(sys.stdin)["externalUrlCount"])')"
  bad_decision_count="$(echo "$summary" | python3 -c 'import json,sys; print(json.load(sys.stdin)["badDecisionCount"])')"
  not_resolver_count="$(echo "$summary" | python3 -c 'import json,sys; print(json.load(sys.stdin)["notMaximusResolverCount"])')"

  if [ "$memory_count" -gt 0 ]; then pass "$label remembered streams"; else fail "$label remembered zero streams"; fi
  if [ "$core_sort" = "True" ] || [ "$core_sort" = "true" ]; then pass "$label coreSort true"; else fail "$label coreSort not true"; fi
  if [ "$external_count" -eq 0 ]; then pass "$label has no direct external resolver URLs in memory"; else fail "$label remembered direct external resolver URLs"; fi
  if [ "$bad_decision_count" -eq 0 ]; then pass "$label memory contains accepted streams only"; else fail "$label memory contains non-accepted streams"; fi
  if [ "$not_resolver_count" -eq 0 ]; then pass "$label memory URLs are Maximus resolver URLs"; else fail "$label has non-Maximus resolver memory URLs"; fi

  echo
  echo "---- warm-hit proof ----"
  redis_del "streams:${id}"

  warm_json="$(
    curl -m 90 -s \
      -w $'\n__MAXIMUS_TIME_MS__:%{time_total}\n' \
      "$BASE/debug/streams/$type/$id.json?title=$encoded_title"
  )"

  warm_ms="$(
    echo "$warm_json" \
      | awk -F: '/__MAXIMUS_TIME_MS__/{printf "%.0f", $2 * 1000}'
  )"

  warm_json="$(
    echo "$warm_json" \
      | sed '/__MAXIMUS_TIME_MS__/d'
  )"

  warm_count="$(echo "$warm_json" | stream_count_from_json)"

  echo "warmCount=$warm_count"
  echo "warmMs=$warm_ms"
  echo "warmMaxMs=$WARM_MAX_MS"

  if [ "$warm_count" -gt 0 ]; then pass "$label warm request returned streams"; else fail "$label warm request returned zero streams"; fi
  if [ "$warm_ms" -le "$WARM_MAX_MS" ]; then pass "$label warm request under ${WARM_MAX_MS}ms"; else fail "$label warm request too slow: ${warm_ms}ms"; fi

  memory_json="$(curl -s "$BASE/debug/local-index/$type/$id.json")"
  memory_count_after="$(MEMORY_JSON="$memory_json" python3 -c 'import json,os; print(json.loads(os.environ["MEMORY_JSON"]).get("count", 0))')"

  echo "memoryCountAfterWarm=$memory_count_after"

  if [ "$memory_count_after" -ge "$memory_count" ]; then
    pass "$label memory preserved after warm hit"
  else
    fail "$label memory count dropped after warm hit"
  fi
}

echo "Maximus Core Engine smoke test"
echo "BASE=$BASE"
echo "WARM_MAX_MS=$WARM_MAX_MS"

echo
echo "---- engine flags ----"
curl -s "$BASE/debug/engine" \
  | python3 -m json.tool \
  | grep -E '"status"|"localIndexFirst"|"coreSortStreams"|"externalAddonsOnColdLoad"'

run_case "Friends S01E01" "series" "tt0108778:1:1" "Friends"
run_case "From S01E01" "series" "tt9813792:1:1" "From"
run_case "The Dark Knight" "movie" "tt0468569" "The Dark Knight"

echo
echo "---- local index cockpit ----"
curl -s "$BASE/debug/local-index/stats.json" \
  | python3 -c '
import json, sys
s=json.load(sys.stdin)
print("rememberedItems:", s.get("rememberedItems"))
print("totalStreams:", s.get("totalStreams"))
print("movieItems:", s.get("movieItems"))
print("seriesItems:", s.get("seriesItems"))
print("resolverUrlCount:", s.get("resolverUrlCount"))
print("externalUrlCount:", s.get("externalUrlCount"))
print("acceptedCount:", s.get("acceptedCount"))
print("nonAcceptedCount:", s.get("nonAcceptedCount"))
print("buckets:", s.get("buckets"))
print("newestIndexedAt:", s.get("newestIndexedAt"))
'

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "✅ Smoke test complete: all checks passed"
  exit 0
else
  echo "❌ Smoke test failed with $FAILURES failure(s)"
  exit 1
fi
