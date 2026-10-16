#!/usr/bin/env python3
"""
File-ingest status sampler — watches the portal records API during a live
ingest and logs every status transition per reporting ID, so we can learn
the intermediate vocabulary (the watcher only ever sees terminal states).

Usage:
    python3 fi_status_watch.py <realm> [id1 id2 ...] [--seconds N]

    realm   e.g. horizonmedia, tatari, inmarket (the cidMap alias)
    ids     optional reporting IDs to filter on; omit to watch the realm's
            most recent records
    --seconds   total watch window (default 1800 = 30 min)

Output: logs/fi-transitions.log + stdout. Each line is a transition:
    15:22:41 VSWT6157000H  RECEIVED -> INGESTING  (pct 12)
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

FI_BASE = "https://fileingest.cognet.tv"
FI_AUTH = "Basic Y3Jvb21pYW46c1pJUiNVWmVkNVVNZzQ4Sg=="
LOG = Path(__file__).resolve().parent.parent / "logs" / "fi-transitions.log"
POLL = 5


def fetch(realm, limit=50):
    req = urllib.request.Request(
        f"{FI_BASE}/v1/{realm}/content?offset=1&limit={limit}",
        headers={"Authorization": FI_AUTH})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read()).get("content", [])


def norm(s):
    return "".join(c for c in str(s or "").lower() if c.isalnum())


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        return
    realm, wanted = args[0], {norm(a) for a in args[1:]}
    secs = 1800
    if "--seconds" in sys.argv:
        secs = int(sys.argv[sys.argv.index("--seconds") + 1])
    LOG.parent.mkdir(exist_ok=True)

    seen = {}          # id -> last (status, result, pct)
    deadline = time.time() + secs
    print(f"Watching {realm} for {secs}s (poll {POLL}s) -> {LOG}")
    while time.time() < deadline:
        try:
            recs = fetch(realm)
        except Exception as e:
            print(f"poll failed: {e}")
            time.sleep(POLL)
            continue
        for rec in recs:
            rid = rec.get("reportingId") or ""
            if wanted and norm(rid) not in wanted:
                continue
            cur = (rec.get("status") or "?",
                   rec.get("detection_result") or "",
                   (rec.get("admin_visible") or {}).get("detection_percentage"))
            prev = seen.get(rid)
            if prev is None:
                line = f"{time.strftime('%H:%M:%S')} {rid}  first seen: {cur[0]} result={cur[1] or '-'} pct={cur[2]}"
                print(line, flush=True)
                with open(LOG, "a") as f:
                    f.write(line + "\n")
                seen[rid] = cur
            elif cur != prev:
                line = (f"{time.strftime('%H:%M:%S')} {rid}  {prev[0]}/{prev[1] or '-'} -> "
                        f"{cur[0]}/{cur[1] or '-'}  pct {prev[2]} -> {cur[2]}")
                print(line, flush=True)
                with open(LOG, "a") as f:
                    f.write(line + "\n")
                seen[rid] = cur
        time.sleep(POLL)


if __name__ == "__main__":
    main()
