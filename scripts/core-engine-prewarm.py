#!/usr/bin/env python3
import argparse
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path


def fetch_json(url: str, timeout: int = 90):
    with urllib.request.urlopen(url, timeout=timeout) as res:
        raw = res.read().decode("utf-8", errors="replace")
    return json.loads(raw)


def main():
    parser = argparse.ArgumentParser(description="Prewarm Maximus local-index memory using a seed list")
    parser.add_argument("--base", default="http://localhost:6000")
    parser.add_argument("--seeds", default="data/core-engine-prewarm-seeds.json")
    parser.add_argument("--timeout", type=int, default=90)
    parser.add_argument("--sleep", type=float, default=0.5)
    args = parser.parse_args()

    base = args.base.rstrip("/")
    seeds = json.loads(Path(args.seeds).read_text())

    print("Maximus Core Engine prewarm")
    print(f"BASE={base}")
    print(f"SEEDS={args.seeds}")
    print(f"COUNT={len(seeds)}")

    results = []

    for index, seed in enumerate(seeds, start=1):
        label = seed["label"]
        stream_type = seed["type"]
        item_id = seed["id"]
        title = seed["title"]

        encoded_title = urllib.parse.quote(title)
        stream_url = f"{base}/debug/streams/{stream_type}/{item_id}.json?title={encoded_title}"
        memory_url = f"{base}/debug/local-index/{stream_type}/{item_id}.json"

        print()
        print("=" * 60)
        print(f"{index}/{len(seeds)} {label}")
        print(f"{stream_type} {item_id}")

        started = time.time()

        try:
            stream_data = fetch_json(stream_url, timeout=args.timeout)
            memory_data = fetch_json(memory_url, timeout=args.timeout)

            took_ms = int((time.time() - started) * 1000)
            stream_count = int(stream_data.get("count") or 0)
            memory_count = int(memory_data.get("count") or 0)

            status = "ok" if memory_count > 0 else "no_memory"

            print(f"streams={stream_count}")
            print(f"memory={memory_count}")
            print(f"tookMs={took_ms}")
            print(f"status={status}")

            results.append({
                "label": label,
                "type": stream_type,
                "id": item_id,
                "streamCount": stream_count,
                "memoryCount": memory_count,
                "tookMs": took_ms,
                "status": status,
            })

        except Exception as err:
            print(f"status=error")
            print(f"error={err}")
            results.append({
                "label": label,
                "type": stream_type,
                "id": item_id,
                "streamCount": 0,
                "memoryCount": 0,
                "tookMs": int((time.time() - started) * 1000),
                "status": "error",
                "error": str(err),
            })

        time.sleep(args.sleep)

    print()
    print("=" * 60)
    print("Prewarm summary")

    ok = sum(1 for r in results if r["status"] == "ok")
    no_memory = sum(1 for r in results if r["status"] == "no_memory")
    errors = sum(1 for r in results if r["status"] == "error")

    print(json.dumps({
        "seedCount": len(results),
        "ok": ok,
        "noMemory": no_memory,
        "errors": errors,
        "results": results,
    }, indent=2))

    print()
    print("Memory cockpit")
    try:
        stats = fetch_json(f"{base}/debug/local-index/stats.json", timeout=args.timeout)
        print(json.dumps({
            "rememberedItems": stats.get("rememberedItems"),
            "totalStreams": stats.get("totalStreams"),
            "movieItems": stats.get("movieItems"),
            "seriesItems": stats.get("seriesItems"),
            "resolverUrlCount": stats.get("resolverUrlCount"),
            "externalUrlCount": stats.get("externalUrlCount"),
            "nonAcceptedCount": stats.get("nonAcceptedCount"),
            "buckets": stats.get("buckets"),
            "newestIndexedAt": stats.get("newestIndexedAt"),
        }, indent=2))
    except Exception as err:
        print(f"statsError={err}")

    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
