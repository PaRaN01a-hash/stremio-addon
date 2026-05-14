#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import subprocess
import sys
from pathlib import Path

DEFAULT_CONTAINER = "stremio-redis"
PATTERN = "local:index:streams:*"


def run(cmd, *, input_text=None, check=True):
    result = subprocess.run(
        cmd,
        input=input_text,
        text=True,
        capture_output=True,
    )
    if check and result.returncode != 0:
        raise SystemExit(
            f"Command failed: {' '.join(cmd)}\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
    return result.stdout


def redis(container, *args, input_text=None):
    return run(
        ["docker", "exec", "-i", container, "redis-cli", "--raw", *args],
        input_text=input_text,
    )


def redis_set_raw(container, key, value):
    return run(
        ["docker", "exec", "-i", container, "redis-cli", "-x", "SET", key],
        input_text=value,
    )


def export_memory(container, output):
    keys_raw = redis(container, "--scan", "--pattern", PATTERN)
    keys = sorted([line.strip() for line in keys_raw.splitlines() if line.strip()])

    records = []
    for key in keys:
        raw_value = redis(container, "GET", key)
        ttl_raw = redis(container, "TTL", key).strip()

        try:
            ttl = int(ttl_raw)
        except ValueError:
            ttl = -2

        if not raw_value:
            continue

        records.append({
            "key": key,
            "ttl": ttl,
            "value": raw_value,
        })

    payload = {
        "format": "maximus-local-index-memory-v1",
        "createdAt": dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "redisContainer": container,
        "pattern": PATTERN,
        "count": len(records),
        "records": records,
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(f"✅ Exported {len(records)} local-index keys")
    print(f"📦 Backup: {output}")


def restore_memory(container, backup_file):
    payload = json.loads(backup_file.read_text(encoding="utf-8"))

    if payload.get("format") != "maximus-local-index-memory-v1":
        raise SystemExit("❌ Not a Maximus local-index memory backup file")

    records = payload.get("records") or []
    restored = 0

    for record in records:
        key = record.get("key")
        value = record.get("value")
        ttl = int(record.get("ttl", -1))

        if not key or value is None:
            continue

        redis_set_raw(container, key, value)

        if ttl > 0:
            redis(container, "EXPIRE", key, str(ttl))

        restored += 1

    print(f"✅ Restored {restored} local-index keys into {container}")


def main():
    parser = argparse.ArgumentParser(description="Export or restore Maximus local-index memory from Redis")
    parser.add_argument("action", choices=["export", "restore"])
    parser.add_argument("--container", default=DEFAULT_CONTAINER)
    parser.add_argument("--file", default="")

    args = parser.parse_args()

    if args.action == "export":
        if args.file:
            output = Path(args.file)
        else:
            stamp = dt.datetime.utcnow().strftime("%Y%m%d-%H%M%S")
            output = Path(f"/tmp/maximus-local-index-memory-{stamp}.json")

        export_memory(args.container, output)

    if args.action == "restore":
        if not args.file:
            raise SystemExit("❌ restore needs --file /path/to/backup.json")

        restore_memory(args.container, Path(args.file))


if __name__ == "__main__":
    main()
