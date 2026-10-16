#!/usr/bin/env python3
"""
Ingest watcher — bridges the Chrome extension's downloads and the ESPN
ticker conversion.

The extension downloads client files plus a manifest.json into
~/Downloads/Ingest/<job>/. This script polls those folders, waits for each
download to finish, and for every file the tracking sheet flagged
needs_espn, runs espn_ticker.sh to produce <name>_ticker.mp4.

Failures and stuck downloads raise a macOS notification and are recorded
in report.json inside the job folder so someone can take over.

Usage:
    python3 ingest_watch.py          # poll forever (Ctrl+C to stop)
    python3 ingest_watch.py --once   # single pass, for testing
"""

import json
import os
import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

# ---- config ----------------------------------------------------------------
WATCH_DIR = Path.home() / "Downloads" / "Ingest"
LOG_DIR = Path(__file__).resolve().parent.parent / "logs"
ESPN_SCRIPT = Path("/Users/tim.blair/Devin/espn_ticker.sh")
TICKER_IMAGE = Path("/Users/tim.blair/Devin/ticker.png")
POLL_SECONDS = 15
LOG_PORT = 8770
MEDIA_EXTS = {".mp4", ".mov", ".mpg", ".mxf"}
# -----------------------------------------------------------------------------


def start_log_server():
    """Tiny loopback endpoint: POST /ingest-log writes the extension's debug
    log straight into logs/ - no Downloads round-trip, no download entries."""
    class H(BaseHTTPRequestHandler):
        def _cors(self, code=204):
            self.send_response(code)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_OPTIONS(self):
            self._cors()

        def do_POST(self):
            if self.path != "/ingest-log":
                self._cors(404)
                return
            try:
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                LOG_DIR.mkdir(exist_ok=True)
                (LOG_DIR / "ingest-tools-log.txt").write_bytes(body)
                self._cors()
            except Exception:
                self._cors(500)

        def log_message(self, *a):
            pass

    try:
        srv = HTTPServer(("127.0.0.1", LOG_PORT), H)
    except OSError as e:
        print(f"log server disabled: {e}", file=sys.stderr, flush=True)
        return
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"Log endpoint on 127.0.0.1:{LOG_PORT}", flush=True)


def log(msg):
    """Watch errors go to logs/watch.log as well as stdout - a terminal
    window's scrollback is gone forever once the session closes."""
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, file=sys.stderr, flush=True)
    try:
        LOG_DIR.mkdir(exist_ok=True)
        with open(LOG_DIR / "watch.log", "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


def notify(title, msg):
    try:
        # No timeout previously: a hung osascript (e.g. a notification
        # permission prompt) wedged the whole watch loop silently.
        subprocess.run(
            ["osascript", "-e", f'display notification {json.dumps(msg)} with title {json.dumps(title)}'],
            check=False, capture_output=True, timeout=15,
        )
    except Exception:
        pass


def find_downloaded(job_dir: Path, want_name: str):
    """Locate the downloaded file, tolerating Chrome's ' (n)' uniquify suffix."""
    exact = job_dir / want_name
    if exact.exists() and not (job_dir / (want_name + ".crdownload")).exists():
        return exact
    stem, ext = os.path.splitext(want_name)
    for n in range(1, 10):
        cand = job_dir / f"{stem} ({n}){ext}"
        if cand.exists():
            return cand
    # download still in progress?
    for p in job_dir.glob("*.crdownload"):
        if p.name.startswith(stem[:20]):
            return None
    return None


def state_file(manifest_path: Path) -> Path:
    # Per-manifest state: <job>-manifest.json -> .<job>-manifest-state.json.
    # Legacy plain "manifest.json" keeps the original dotfile name.
    stem = manifest_path.stem
    name = ".watcher_state.json" if stem == "manifest" else f".{stem}-state.json"
    return manifest_path.parent / name


def load_state(manifest_path: Path) -> dict:
    f = state_file(manifest_path)
    if f.exists():
        try:
            return json.loads(f.read_text())
        except Exception:
            pass
    return {"notified": [], "done": [], "failed": [], "rejected": []}


def save_state(manifest_path: Path, state: dict):
    state_file(manifest_path).write_text(json.dumps(state, indent=2))


def write_report(manifest_path: Path, report: dict):
    # <job>-manifest.json -> <job>-manifest-report.json; legacy "manifest"
    # keeps "report.json".
    stem = manifest_path.stem
    name = "report.json" if stem == "manifest" else f"{stem}-report.json"
    (manifest_path.parent / name).write_text(json.dumps(report, indent=2))


def sniff_bad_media(path: Path) -> str:
    """Real spots are MBs. A "video" that is actually an HTML/XML error
    page, or implausibly tiny, is a bad download (portal preview links,
    expired URLs) - reject it so it can't be ingested by accident."""
    try:
        if path.stat().st_size < 64 * 1024:
            return "suspiciously small"
        with open(path, "rb") as f:
            head = f.read(512).lstrip()
        if head[:1] == b"<":
            return "html payload (portal/error page, not video)"
    except Exception:
        pass
    return ""


def convert(job_dir: Path, file_path: Path, suffix: str = "_ticker") -> tuple[bool, str]:
    """Run espn_ticker.sh on <file>; rename to <suffix> when it differs."""
    ticker = job_dir / "ticker.png"
    if not ticker.exists():
        try:
            ticker.write_bytes(TICKER_IMAGE.read_bytes())
        except Exception as e:
            return False, f"could not copy ticker.png: {e}"
    stem = file_path.stem
    proc = subprocess.run(
        ["bash", str(ESPN_SCRIPT), stem],
        cwd=job_dir, capture_output=True, text=True, timeout=1800,
    )
    out = file_path.with_name(stem + "_ticker.mp4")
    if proc.returncode == 0 and out.exists():
        if suffix != "_ticker":
            try:
                target = file_path.with_name(stem + suffix + ".mp4")
                out.rename(target)
                return True, target.name
            except Exception:
                pass  # keep the _ticker name if the rename fails
        return True, str(out.name)
    tail = (proc.stdout + proc.stderr).strip().splitlines()[-3:]
    return False, "espn_ticker.sh failed: " + " | ".join(tail)


def process_job(manifest_path: Path):
    job_dir = manifest_path.parent
    try:
        manifest = json.loads(manifest_path.read_text())
    except Exception:
        return
    state = load_state(manifest_path)
    client = manifest.get("client") or {}
    ticker_suffix = client.get("tickerSuffix") or "_ticker"
    report = {"job": manifest.get("job"), "client": client or None, "files": []}
    changed = False

    for entry in manifest.get("files", []):
        name = entry.get("file", "")
        status = {"file": name, "needs_espn": entry.get("needs_espn", False)}

        local = find_downloaded(job_dir, name)
        if local is None:
            if name in state.get("rejected", []):
                status["status"] = "rejected (moved to _rejected/)"
                report["files"].append(status)
                continue
            any_partial = list(job_dir.glob("*.crdownload"))
            status["status"] = "downloading" if any_partial else "missing"
            if not any_partial and name not in state["notified"]:
                # give it a couple of passes before alerting? keep simple:
                state["notified"].append(name)
                changed = True
                notify("Ingest watcher", f"Download not found yet: {name} (job {manifest.get('job')})")
            report["files"].append(status)
            continue

        status["downloaded_as"] = local.name
        if local.suffix.lower() not in MEDIA_EXTS:
            status["status"] = "downloaded (non-media ext - check link type)"
            if name not in state["notified"]:
                state["notified"].append(name)
                changed = True
                notify("Ingest watcher", f"{local.name}: non-media file - the link may be a portal page, not a direct download.")
            report["files"].append(status)
            continue

        bad = sniff_bad_media(local)
        if bad:
            rej = job_dir / "_rejected"
            try:
                rej.mkdir(exist_ok=True)
                local.rename(rej / local.name)
            except Exception:
                pass
            state.setdefault("rejected", []).append(name)
            status["status"] = "rejected: " + bad
            if name not in state["notified"]:
                state["notified"].append(name)
                notify("Ingest watcher", f"{local.name}: rejected ({bad}) - not a real video.")
            changed = True
            report["files"].append(status)
            continue

        if not entry.get("needs_espn"):
            status["status"] = "downloaded"
            report["files"].append(status)
            continue

        espn_out = local.with_name(local.stem + ticker_suffix + ".mp4")
        if espn_out.exists() or name in state["done"]:
            status["status"] = "espn_done"
            report["files"].append(status)
            continue
        if name in state["failed"]:
            status["status"] = "espn_failed"
            report["files"].append(status)
            continue

        ok, msg = convert(job_dir, local, ticker_suffix)
        if ok:
            state["done"].append(name)
            status["status"] = "espn_done"
            status["espn_output"] = msg
        else:
            state["failed"].append(name)
            status["status"] = "espn_failed"
            status["error"] = msg
            notify("Ingest watcher", f"ESPN conversion failed: {local.name} — {msg[:120]}")
        changed = True
        report["files"].append(status)

    write_report(manifest_path, report)
    if changed:
        save_state(manifest_path, state)


def relocate_debug_logs():
    """Extension-internal files (debug log) land in Downloads only because
    chrome.downloads has no other channel - move them into the project's
    logs/ folder so Downloads stays clean."""
    debug_dir = WATCH_DIR / "_debug"
    if not debug_dir.exists():
        return
    try:
        LOG_DIR.mkdir(exist_ok=True)
    except Exception as e:
        log(f"relocate_debug_logs: cannot create {LOG_DIR}: {e}")
        return
    for f in debug_dir.glob("*"):
        if f.suffix == ".crdownload" or not f.is_file():
            continue
        try:
            f.replace(LOG_DIR / f.name)
        except Exception:
            pass


# A real manifest is exactly: manifest.json, Chrome-uniquified
# "manifest (n).json", or "<job>-manifest.json". Reports/state derived
# from a manifest must never re-match - "manifest (1)-report.json" still
# starts with 'manifest' and would spawn -report-report-report chains.
MANIFEST_RE = re.compile(r"^(?:manifest(?: \(\d+\))?|.+-manifest)\.json$")


def run_once():
    if not WATCH_DIR.exists():
        return
    relocate_debug_logs()
    for manifest in sorted(WATCH_DIR.glob("*/*.json")):
        if MANIFEST_RE.match(manifest.name):
            process_job(manifest)


def main():
    if not ESPN_SCRIPT.exists():
        log(f"warning: {ESPN_SCRIPT} not found - conversions will fail")
    start_log_server()
    if "--once" in sys.argv:
        run_once()
        return
    log(f"Watching {WATCH_DIR} every {POLL_SECONDS}s (Ctrl+C to stop)")
    while True:
        try:
            run_once()
        except Exception as e:
            log(f"watch error: {e}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
