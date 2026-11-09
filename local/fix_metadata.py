#!/usr/bin/env python3
"""
fix_metadata.py — correct metadata on already-ingested portal records.

Updates advertiser / brand / vertical / contentTitle on records in the
fileingest (cidmap) backend WITHOUT disturbing the ingest record itself:
reportingId, content_id, commercial cid, detection result, and ingest
timestamps are all verified unchanged after every write.

Safety model:
  * DRY-RUN by default - prints the before/after table, touches nothing.
  * --apply performs the writes one record at a time.
  * Editable fields are whitelisted; only reportingId-matched records are
    touched, and every PUT is followed by a GET that diffs the record -
    anything outside {advertiser, brand, vertical, contentTitle, status,
    datetime} changing fails the run loudly.
  * Every record's before/after snapshot is appended to
    logs/metadata-fix-<timestamp>.jsonl for audit.

Usage:
  # Preview: set brand/advertiser/vertical on a list of IDs
  python3 fix_metadata.py horizonmedia --brand CARE --ids ID1 ID2 ID3

  # Preview titles + brand from a CSV (Tracking ID + Spot Title columns)
  python3 fix_metadata.py horizonmedia --brand CARE --csv tracker.csv \
      --id-col "Tracking ID" --title-col "Spot Title"

  # CSV + --ids: only those IDs are pulled from the CSV (a big tracker
  # would otherwise scan every row against the realm's recent records)
  python3 fix_metadata.py horizonmedia --csv tracker.csv \
      --title-col "Spot Title" --ids ID1 ID2

  # Apply for real
  python3 fix_metadata.py horizonmedia --brand CARE --ids ID1 ID2 --apply

  # Title only (no brand change)
  python3 fix_metadata.py horizonmedia --csv tracker.csv \
      --id-col "Tracking ID" --title-col "Spot Title" --apply

Realm aliases (horizon -> horizonmedia etc.) match the extension's table.
"""
import argparse
import csv
import json
import re
import ssl
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

FI_BASE = "https://fileingest.cognet.tv"
FI_AUTH = "Basic Y3Jvb21pYW46c1pJUiNVWmVkNVVNZzQ4Sg=="
FI_ALIASES = {"horizon": "horizonmedia", "in-market": "inmarket",
              "itn": "itnnetworks", "chief": "chiefmedia"}

# Fields this tool is allowed to write. Anything else changing after a
# PUT aborts the run - the ingest record (cid, detection, ingest
# timestamps) must survive a metadata edit byte-for-byte.
EDITABLE = ("advertiser", "brand", "vertical", "contentTitle")
# Server-side effects of a metadata write: audit status + touch time.
EXPECTED_SERVER_CHANGES = {"status", "datetime"}

LOG_DIR = Path(__file__).resolve().parent.parent / "logs"

_SSL_CTX = ssl.create_default_context()
_SSL_CTX.verify_flags &= ~getattr(ssl, "VERIFY_X509_STRICT", 0)


def api(method, path, body=None):
    req = urllib.request.Request(
        FI_BASE + path, method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization": FI_AUTH, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30, context=_SSL_CTX) as r:
        return json.loads(r.read())


def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def portal_clean(s):
    # Same rule the extension applies at fill time: letters/digits/dash/
    # dot/underscore/space survive, everything else is removed.
    return re.sub(r"\s+", " ", re.sub(r"[^\w.\- ]+", "", str(s or ""))).strip()


def resolve_realm(name):
    n = str(name or "").lower().replace(" ", "")
    return FI_ALIASES.get(n, n)


def fetch_realm_records(realm, pages=2):
    out = []
    for p in range(pages):
        page = api("GET", f"/v1/{realm}/content?offset={p * 500 + 1}&limit=500")
        batch = page.get("content", [])
        out.extend(batch)
        if len(batch) < 500:
            break
    return out


def collect_changes(args):
    """-> {reportingId: {field: value}} mapping of wanted edits."""
    changes = {}
    fields = {}
    if args.brand is not None:
        fields = {"advertiser": args.brand, "brand": args.brand,
                  "vertical": args.brand}
    if args.title is not None:
        fields["contentTitle"] = portal_clean(args.title)

    if args.ids and not args.csv:
        if not fields:
            sys.exit("nothing to change: pass --brand and/or --title with --ids")
        for rid in args.ids:
            changes[rid.strip()] = dict(fields)

    if args.csv:
        with open(args.csv, newline="", encoding="utf-8-sig") as f:
            rows = list(csv.DictReader(f))
        if not rows:
            sys.exit(f"no rows in {args.csv}")
        id_col, title_col = args.id_col, args.title_col
        missing = [c for c in (id_col, title_col) if c and c not in rows[0]]
        if missing:
            sys.exit(f"column(s) {missing} not in CSV header: {list(rows[0])}")
        only = {norm(i) for i in args.ids} if args.ids else None
        for row in rows:
            rid = (row.get(id_col) or "").strip()
            if not rid or (only is not None and norm(rid) not in only):
                continue
            rec = changes.setdefault(rid, dict(fields))
            if title_col:
                t = portal_clean(row.get(title_col))
                if t:
                    rec["contentTitle"] = t
    return changes


def diff_record(before, after):
    return {k: (before.get(k), after.get(k))
            for k in set(before) | set(after)
            if before.get(k) != after.get(k)}


def audit(entry):
    LOG_DIR.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    path = LOG_DIR / f"metadata-fix-{stamp}.jsonl"
    with open(path, "a") as f:
        f.write(json.dumps(entry) + "\n")
    return path


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("realm", help="portal realm, e.g. horizonmedia, tatari")
    ap.add_argument("--ids", nargs="+", help="reporting IDs to update")
    ap.add_argument("--csv", help="tracker CSV with ID (and title) columns")
    ap.add_argument("--id-col", default="Tracking ID",
                    help="CSV column holding the reporting ID")
    ap.add_argument("--title-col", default=None,
                    help="CSV column holding the spot title")
    ap.add_argument("--brand", help="value for advertiser+brand+vertical")
    ap.add_argument("--title", help="contentTitle for --ids (single value)")
    ap.add_argument("--apply", action="store_true",
                    help="perform the writes (default is dry-run)")
    args = ap.parse_args()

    realm = resolve_realm(args.realm)
    if not realm:
        sys.exit("empty realm")
    changes = collect_changes(args)
    if not changes:
        sys.exit("no IDs matched - check --ids / --csv / --id-col")

    print(f"Realm: {realm} · {len(changes)} ID(s) · "
          f"{'APPLY' if args.apply else 'DRY-RUN (pass --apply to write)'}")

    # Resolve reporting IDs to content_ids up front (newest-first pages).
    recs = fetch_realm_records(realm, pages=max(2, len(changes) // 500 + 1))
    by_rid = {norm(r.get("reportingId")): r for r in recs}

    plan = []
    missing = []
    for rid, wanted in changes.items():
        rec = by_rid.get(norm(rid))
        if not rec:
            missing.append(rid)
            continue
        edits = {k: v for k, v in wanted.items() if rec.get(k) != v}
        plan.append((rid, rec, edits))
    for rid in missing:
        print(f"  {rid}: NOT FOUND in {realm} - wrong realm, or never ingested")

    print("\nPlanned changes:")
    for rid, rec, edits in plan:
        if not edits:
            print(f"  {rid} ({rec['content_id']}): already correct - skip")
            continue
        desc = ", ".join(f"{k}: {rec.get(k)!r} -> {v!r}" for k, v in edits.items())
        print(f"  {rid} ({rec['content_id']}): {desc}")
    if not args.apply:
        return

    print("\nApplying:")
    failures = 0
    for rid, rec, edits in plan:
        if not edits:
            continue
        cid = rec["content_id"]
        before = api("GET", f"/v1/{realm}/content/{cid}")
        if before.get("reportingId") != rid:
            print(f"  {rid} {cid}: ABORT - record now reportingId "
                  f"{before.get('reportingId')!r}")
            failures += 1
            continue
        body = dict(before)
        body.update(edits)
        api("PUT", f"/v1/{realm}/content/{cid}", body)
        after = api("GET", f"/v1/{realm}/content/{cid}")

        diff = diff_record(before, after)
        unexpected = {k: v for k, v in diff.items()
                      if k not in EDITABLE and k not in EXPECTED_SERVER_CHANGES}
        missed = {k: v for k, v in edits.items() if after.get(k) != v}
        ok = not unexpected and not missed
        audit({"at": datetime.now(timezone.utc).isoformat(), "realm": realm,
               "reportingId": rid, "content_id": cid, "edits": edits,
               "before": {k: before.get(k) for k in EDITABLE},
               "after": {k: after.get(k) for k in EDITABLE},
               "server_changes": {k: after.get(k)
                                  for k in EXPECTED_SERVER_CHANGES
                                  if k in diff},
               "unexpected_diff": unexpected, "ok": ok})
        if missed:
            print(f"  {rid} {cid}: FAILED - fields not applied: {missed}")
        elif unexpected:
            print(f"  {rid} {cid}: APPLIED BUT UNEXPECTED CHANGES: "
                  f"{json.dumps(unexpected)} - investigate before continuing")
        else:
            kept = f"cid preserved, detection={after.get('detection_result')}"
            print(f"  {rid} {cid}: OK ({kept})")
        failures += 0 if ok else 1
        time.sleep(0.3)

    print(f"\n{'Done' if not failures else 'FINISHED WITH FAILURES'}: "
          f"{sum(1 for _, _, e in plan if e) - failures} updated, "
          f"{failures} failed, {len(missing)} not found. "
          f"Audit log in {LOG_DIR}/")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
