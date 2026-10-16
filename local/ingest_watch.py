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
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

# ---- config ----------------------------------------------------------------
WATCH_DIR = Path.home() / "Downloads" / "Ingest"
LOG_DIR = Path(__file__).resolve().parent.parent / "logs"
ESPN_SCRIPT = Path("/Users/tim.blair/Devin/espn_ticker.sh")
TICKER_IMAGE = Path("/Users/tim.blair/Devin/ticker.png")
POLL_SECONDS = 15
LOG_PORT = 8770
MEDIA_EXTS = {".mp4", ".mov", ".mpg", ".mxf", ".mkv"}
# Other video containers get probed too - a real spec verdict beats a
# generic non-media flag even when the container itself isn't gated.
PROBEABLE_EXTS = MEDIA_EXTS | {".avi", ".wmv", ".m4v", ".m2ts",
                               ".ts", ".webm", ".mpeg", ".m2v", ".vob", ".3gp"}
# Finished ingests are filed under ~/Documents/Customer Content/<Client>/.
ARCHIVE_ROOT = Path.home() / "Documents" / "Customer Content"
# The portal's records API (SIDMAP surface) - same read-only endpoint the
# extension's verify step uses. Files only archive after every reporting
# ID reaches a terminal ingest state, plus a rest beat for big-file lag.
FI_BASE = "https://fileingest.cognet.tv"
FI_AUTH = "Basic Y3Jvb21pYW46c1pJUiNVWmVkNVVNZzQ4Sg=="
FI_ALIASES = {"horizon": "horizonmedia", "in-market": "inmarket",
              "itn": "itnnetworks", "chief": "chiefmedia"}
PORTAL_CHECK_SECONDS = 60   # min gap between record polls per job
ARCHIVE_REST_SECONDS = 30   # settle after all-terminal (portal's own
                            # New-Ingest un-gray lag is ~20s per the user)
# Standard ingest spec (user-supplied): H.264/H.265/MPEG-2 (+ ProRes -
# the portal demonstrably accepts it, dozens of files completed), the
# three listed 16:9 resolutions, 24-30fps, 10s minimum runtime.
# Container is NOT gated (mp4/mov/mxf/mkv all ingest) and neither is
# bit rate: the sheet's 4-40Mbps bears no relation to reality - the
# accepted archive corpus spans ~2-182Mbps. No audio stream is OK too
# (video-only fingerprints), but a PRESENT audio stream in an exotic
# codec fails portal-side as INGEST_FAILED_Invalid_audio_codec.
MIN_DURATION = 10.0
SPEC_RES = {(3840, 2160), (1920, 1080), (1280, 720)}
SPEC_CODECS = {"h264", "hevc", "mpeg2video", "prores"}
AUDIO_OK = {"aac", "mp3", "mp2", "ac3", "eac3", "s302m", "alac", "lpcm"}
# -----------------------------------------------------------------------------


def start_log_server():
    """Tiny loopback endpoint: POST /ingest-log writes the extension's debug
    log straight into logs/ - no Downloads round-trip, no download entries."""
    class H(BaseHTTPRequestHandler):
        def _cors(self, code=204):
            self.send_response(code)
            self.send_header("Access-Control-Allow-Origin", "*")
            # Chrome Private Network Access: https page -> http://127.0.0.1
            # needs this on the preflight and the response.
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def _send(self, code, body, ctype):
            self.send_response(code)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self._cors()

        # The extension's portal tab streams job files from here into the
        # page's file picker - "Feed files to portal" in step 5.
        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(u.query)
            if u.path == "/ingest-files":
                files = job_media_files((q.get("job") or [""])[0])
                self._send(200, json.dumps({"files": files}).encode(), "application/json")
            elif u.path == "/spec-failures":
                self._send(200, json.dumps({"failures": spec_failures((q.get("job") or [""])[0])}).encode(),
                           "application/json")
            elif u.path == "/ingest-file":
                p = resolve_job_file((q.get("job") or [""])[0], (q.get("name") or [""])[0])
                if not p:
                    self._cors(404)
                    return
                self.send_response(200)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Private-Network", "true")
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(p.stat().st_size))
                self.end_headers()
                with open(p, "rb") as f:
                    shutil.copyfileobj(f, self.wfile)
            else:
                self._cors(404)

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
    """A "video" that is actually an HTML/XML error page is a bad download
    (portal preview links, expired URLs) - reject it so it can't be
    ingested by accident. Size is no longer judged here: ffprobe gives
    the real verdict (spec fail vs unreadable)."""
    try:
        with open(path, "rb") as f:
            head = f.read(512).lstrip()
        if head[:1] == b"<":
            return "html payload (portal/error page, not video)"
    except Exception:
        pass
    return ""


def norm_stem(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", Path(name).stem.lower())


def unzip_media(zip_path: Path, job_dir: Path) -> list[str]:
    """Extract media members of a zip into job_dir, flattened to basenames
    (nested folder structure inside the zip is irrelevant to ingest).
    Returns the extracted filenames."""
    out = []
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            base = Path(info.filename).name
            if info.is_dir() or not base:
                continue
            if Path(base).suffix.lower() not in PROBEABLE_EXTS:
                continue
            if info.file_size > 8 * 1024**3:
                continue
            target = job_dir / base
            n = 1
            while target.exists():
                target = job_dir / f"{Path(base).stem} ({n}){Path(base).suffix}"
                n += 1
            with z.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
            out.append(target.name)
    return out


def pair_members(members: list[str], expected: list[str], job_dir: Path):
    """Rename extracted members to their manifest-expected filenames where
    stems overlap. An expected .zip name inherits the member's real ext."""
    for i, mem in enumerate(members):
        mstem = norm_stem(mem)
        for want in expected:
            wstem = norm_stem(want)
            if not wstem or len(wstem) < 4:
                continue
            if wstem not in mstem and mstem not in wstem:
                continue
            want_name = Path(want).stem + Path(mem).suffix if want.lower().endswith(".zip") else want
            target = job_dir / want_name
            if mem != want_name and not target.exists():
                try:
                    (job_dir / mem).rename(target)
                    members[i] = want_name
                except Exception:
                    pass
            break


def _fps(v: dict) -> float:
    for k in ("avg_frame_rate", "r_frame_rate"):
        r = v.get(k) or ""
        if "/" in r:
            try:
                n, d = r.split("/")
                if float(d):
                    return float(n) / float(d)
            except Exception:
                pass
    return 0.0


def probe_spec(path: Path) -> dict:
    """ffprobe facts + spec violations for a downloaded file."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, timeout=120)
        d = json.loads(r.stdout or "{}")
    except Exception as e:
        return {"info": {}, "fails": [], "error": str(e)[:80]}
    fmt = d.get("format") or {}
    fmtname = fmt.get("format_name") or "?"
    vids = [s for s in d.get("streams", []) if s.get("codec_type") == "video"]
    auds = [s for s in d.get("streams", []) if s.get("codec_type") == "audio"]
    try:
        dur = float(fmt.get("duration") or 0)
    except Exception:
        dur = 0
    fails = []
    v = vids[0] if vids else {}
    if not vids:
        fails.append("no video stream")
    else:
        codec = v.get("codec_name") or "?"
        if codec not in SPEC_CODECS:
            fails.append(f"video codec {codec} not H.264/H.265/MPEG-2/ProRes")
        w, h = v.get("width") or 0, v.get("height") or 0
        if (w, h) not in SPEC_RES:
            fails.append(f"resolution {w}x{h} not 3840x2160/1920x1080/1280x720")
        # Aspect is a real portal gate (INGEST_FAILED_Unsupported_Aspect_
        # Ratio). Display ratio when signaled, else storage ratio.
        dar = v.get("display_aspect_ratio") or ""
        try:
            ratio = (float(dar.split(":")[0]) / float(dar.split(":")[1])
                     if ":" in dar else (w / h if h else 0))
        except Exception:
            ratio = 0
        if ratio and not (1.74 <= ratio <= 1.81):
            fails.append(f"aspect ratio {dar or f'{w}x{h}'} not 16:9")
        fps = _fps(v)
        # NTSC fractional rates (23.976, 29.97) count as their nominal 24/30.
        if fps and not (23.9 <= fps <= 30.6):
            fails.append(f"frame rate {fps:.2f}fps outside 24-30")
    # Absent audio is fine (video-only fingerprint); a present stream in
    # an exotic codec is what the portal rejects as Invalid_audio_codec.
    acodec = (auds[0].get("codec_name") or "") if auds else ""
    if acodec and acodec not in AUDIO_OK and not acodec.startswith("pcm_"):
        fails.append(f"audio codec {acodec} may fail ingest")
    if dur and dur < MIN_DURATION:
        fails.append(f"{dur:.1f}s under {MIN_DURATION:.0f}s minimum duration")
    br = int(fmt.get("bit_rate") or 0)
    mbps = br / 1e6 if br else 0
    info = {"duration": round(dur, 2),
            "container": fmtname,
            "video": vids and f"{v.get('codec_name')} {v.get('width')}x{v.get('height')}",
            "fps": round(_fps(v), 2), "mbps": round(mbps, 2),
            "audio": bool(auds)}
    return {"info": info, "fails": fails}


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


def client_folder(client_name: str):
    """Map a playbook name to its Customer Content folder. Prefix match
    either way: 'Horizon Next' -> Horizon, 'ITN' -> ITN Networks. No folder
    is ever created - an unmatched client leaves files in place."""
    if not ARCHIVE_ROOT.exists():
        return None
    first = norm_stem((client_name or "").split(" / ")[0].split(" (")[0])
    if len(first) < 3:
        return None
    best = None
    for d in ARCHIVE_ROOT.iterdir():
        if not d.is_dir():
            continue
        dn = norm_stem(d.name)
        if dn and (dn.startswith(first) or first.startswith(dn)):
            if best is None or len(dn) > len(norm_stem(best.name)):
                best = d
    return best


def uniquified(dest: Path) -> Path:
    if not dest.exists():
        return dest
    n = 1
    while True:
        c = dest.with_name(f"{dest.stem} ({n}){dest.suffix}")
        if not c.exists():
            return c
        n += 1


def ingest_realm(client: dict) -> str:
    cid = client.get("cidMap") or ""
    first = cid[0] if isinstance(cid, list) else cid
    n = str(first).lower().replace(" ", "")
    return FI_ALIASES.get(n, n)


def reporting_ids(manifest: dict, client: dict, skip=frozenset()) -> list[str]:
    """Reporting IDs exactly as pushed to the portal: bare tracking id per
    row, plus id+ticker suffix for rows flagged for an ESPN version.
    Rejected files (bad payload, spec fail) never reach the portal - their
    IDs can't hold the archive gate."""
    suffix = client.get("tickerSuffix") or "_ticker"
    ids = []
    for e in manifest.get("files", []):
        if e.get("file") in skip:
            continue
        rid = e.get("tracking_id") or Path(e.get("file", "")).stem.split()[0]
        if not rid:
            continue
        ids.append(rid)
        if e.get("needs_espn"):
            ids.append(rid + suffix)
    return ids


def portal_statuses(realm: str, wanted: list[str]) -> dict:
    """reporting id -> {status, detection_result, pct} (None when the
    record doesn't exist yet). The progress bars on the portal page are
    rendered off this same record data."""
    req = urllib.request.Request(
        FI_BASE + "/v1/" + realm + "/content?offset=1&limit=500",
        headers={"Authorization": FI_AUTH})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read())
    idx = {}
    for rec in data.get("content", []):
        idx[norm_stem(rec.get("reportingId", ""))] = {
            "status": rec.get("status") or "",
            "result": rec.get("detection_result") or "",
            "pct": (rec.get("admin_visible") or {}).get("detection_percentage"),
        }
    return {w: idx.get(norm_stem(w)) for w in wanted}


# Status vocabulary from the portal page's own JS (examples/ saved pages):
# INGEST_STARTED -> INGEST_COMPLETED -> DETECTION_STARTED -> DETECTION_COMPLETED,
# INGEST_FAILED_<reason> as terminal failures. UI progress bars render
# detection_results + detection_percentage - the same fields we poll.
PORTAL_STAGE = {
    "INGEST_STARTED": "uploading to portal",
    "INGEST_COMPLETED": "queued for detection",
    "DETECTION_STARTED": "detecting",
    "PROCESSING": "processing",
    "DETECTION_COMPLETED": "done",
}


def portal_terminal(rec) -> bool:
    """Terminal = done either way (pass or fail); detection_result 'pass'
    counts even on an unrecognized status string."""
    if not rec:
        return False
    s, res = rec.get("status") or "", rec.get("result") or ""
    return s == "DETECTION_COMPLETED" or s.startswith("INGEST_FAILED") or res == "pass"


def portal_gate(manifest_path: Path, job_dir: Path, manifest: dict,
                state: dict, report: dict, client: dict) -> bool:
    """True when the portal confirms every reporting ID reached a terminal
    ingest state and the rest beat has elapsed - or an archive.ok marker
    overrides the gate entirely."""
    marker = job_dir / ((manifest.get("job") or manifest_path.stem) + "-archive.ok")
    if marker.exists():
        return True
    realm = ingest_realm(client)
    wanted = reporting_ids(manifest, client, skip=frozenset(state.get("rejected", [])))
    if not realm or not wanted:
        return True  # nothing verifiable - settle-and-move as before
    now = time.time()
    statuses = state.get("portal_status") or {}
    if now - state.get("portal_check_at", 0) >= PORTAL_CHECK_SECONDS:
        state["portal_check_at"] = now
        try:
            statuses = portal_statuses(realm, wanted)
            state["portal_status"] = statuses
        except Exception as e:
            log(f"portal check failed ({realm}): {e}")
    failed = [k for k, v in statuses.items()
              if v and ((v.get("status") or "").startswith("INGEST_FAILED")
                        or (v.get("result") or "") == "fail")]
    if failed and not state.get("portal_alerted"):
        state["portal_alerted"] = True
        notify("Ingest watcher",
               f"Portal ingest: {len(failed)} failed ({', '.join(failed[:4])}) - review in portal")
    report["portal"] = {
        "realm": realm,
        "statuses": {k: ((v.get("status") or "?") +
                         (" (" + PORTAL_STAGE[v["status"]] + ")" if v.get("status") in PORTAL_STAGE else "") +
                         (" %.0f%%" % v["pct"] if v.get("pct") is not None else ""))
                        if v else "no record"
                     for k, v in statuses.items()},
        "failed": failed,
    }
    pending = [k for k, v in statuses.items() if not portal_terminal(v)]
    if pending:
        report["archive"] = "waiting on portal ingest: " + ", ".join(pending[:6]) + \
            (" +%d" % (len(pending) - 6) if len(pending) > 6 else "")
        return False
    # All terminal - rest a beat: large files can lag after the record posts.
    first = state.setdefault("portal_done_at", now)
    remain = ARCHIVE_REST_SECONDS - (now - first)
    if remain > 0:
        report["archive"] = f"portal confirmed - resting {int(remain)}s before archive"
        return False
    return True


def archive_done(job_dir: Path, manifest: dict, state: dict, report: dict, client: dict):
    """Every entry resolved -> move this job's media (originals + ticker
    outputs) into Customer Content/<Client>/. Marker names stay in state so
    later passes report 'archived' instead of 'missing'."""
    dest_dir = client_folder(client.get("name", ""))
    if dest_dir is None:
        report["archive"] = "no Customer Content folder matches client " + repr(client.get("name"))
        return False
    suffix = client.get("tickerSuffix") or "_ticker"
    moved = []
    archived = state.setdefault("archived", {})
    # Work from the report's resolved filenames - a zip entry's real media
    # is its extracted member (downloaded_as/zip_extracted), not the
    # archive, which stays behind in Ingest/ as the raw source.
    for st in report.get("files", []):
        name = st.get("file", "")
        if not name:
            continue
        cands = []
        da = st.get("downloaded_as")
        if da and Path(da).suffix.lower() in MEDIA_EXTS:
            p = job_dir / da
            if p.exists():
                cands.append(p)
            for suf in {suffix, "_ticker"}:
                t = job_dir / (Path(da).stem + suf + ".mp4")
                if t.exists() and t not in cands:
                    cands.append(t)
        for mem in st.get("zip_extracted") or []:
            p = job_dir / mem
            if p.exists() and p not in cands:
                cands.append(p)
        if st.get("espn_output"):
            p = job_dir / st["espn_output"]
            if p.exists() and p not in cands:
                cands.append(p)
        for f in cands:
            try:
                f.replace(uniquified(dest_dir / f.name))
                moved.append(f.name)
            except Exception as e:
                log(f"archive move failed {f.name}: {e}")
        archived[name] = dest_dir.name
    report["archive"] = f"moved {len(moved)} file(s) -> {dest_dir}"
    if moved:
        notify("Ingest watcher", f"Archived {len(moved)} file(s) to Customer Content/{dest_dir.name}")
        log(f"archived {moved} -> {dest_dir}")
    return True


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

    # Loose zips no manifest entry names (scooped select-all archives,
    # manual drops): unpack once, pair members onto pending rows so the
    # entry loop finds them this same pass. Extraction dedup is tracked
    # in a shared dir-level dotfile - in the flat layout several manifests
    # share job_dir and must not re-unzip each other's archives.
    uzf = job_dir / ".unzipped.json"
    try:
        udone = set(json.loads(uzf.read_text()))
    except Exception:
        udone = set()
    sibling_expected = set()
    for mp in job_dir.glob("*.json"):
        if MANIFEST_RE.match(mp.name):
            try:
                sibling_expected.update(
                    e.get("file", "") for e in json.loads(mp.read_text()).get("files", [])
                    if e.get("file"))
            except Exception:
                pass
    uz_changed = False
    for zp in job_dir.glob("*.zip"):
        if zp.name in sibling_expected or zp.name in udone:
            continue
        try:
            members = unzip_media(zp, job_dir)
            pair_members(members, list(sibling_expected), job_dir)
        except Exception:
            members = []
            try:
                rej = job_dir / "_rejected"
                rej.mkdir(exist_ok=True)
                zp.rename(rej / zp.name)
            except Exception:
                pass
        udone.add(zp.name)
        uz_changed = True
        notify("Ingest watcher",
               f"{zp.name}: unpacked {len(members)} media file(s)" if members
               else f"{zp.name}: no usable media inside")
    if uz_changed:
        uzf.write_text(json.dumps(sorted(udone)))

    for entry in manifest.get("files", []):
        name = entry.get("file", "")
        status = {"file": name, "needs_espn": entry.get("needs_espn", False)}

        local = find_downloaded(job_dir, name)
        if local is None:
            if name in state.get("rejected", []):
                sf = (state.get("specfail") or {}).get(name)
                status["status"] = ("spec_fail: " + "; ".join(sf)) if sf else "rejected (moved to _rejected/)"
                report["files"].append(status)
                continue
            if name in state.get("archived", {}):
                status["status"] = "archived -> Customer Content/" + state["archived"][name]
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

        # Zip payloads (Drive select-all archives, direct zip links):
        # unpack media members into the job dir. A single-member zip stood
        # in for this row's file - it adopts the entry's stem and falls
        # through to the normal media checks / ESPN conversion below.
        # Multi-member zips get paired onto manifest rows by stem match so
        # sibling entries can find their files on the next pass.
        if local.suffix.lower() == ".zip":
            if name in state.get("unzipped", []):
                status["status"] = "zip already extracted"
                report["files"].append(status)
                continue
            try:
                members = unzip_media(local, job_dir)
            except Exception as e:
                rej = job_dir / "_rejected"
                try:
                    rej.mkdir(exist_ok=True)
                    local.rename(rej / local.name)
                except Exception:
                    pass
                state.setdefault("rejected", []).append(name)
                status["status"] = "rejected: unreadable zip - " + str(e)[:80]
                notify("Ingest watcher", f"{local.name}: rejected (unreadable zip) - not real media.")
                changed = True
                report["files"].append(status)
                continue
            state.setdefault("unzipped", []).append(name)
            changed = True
            if not members:
                status["status"] = "zip extracted - no media files inside"
                notify("Ingest watcher", f"{local.name}: zip held no media files.")
                report["files"].append(status)
                continue
            expected = [e.get("file", "") for e in manifest.get("files", []) if e.get("file")]
            pair_members(members, expected, job_dir)
            if len(members) == 1 and not any(members[0] == e for e in expected):
                # sole member takes this row's stem so the manifest name stays canonical
                single = job_dir / members[0]
                target = job_dir / (Path(name).stem + single.suffix)
                if not target.exists():
                    try:
                        single.rename(target)
                        members[0] = target.name
                    except Exception:
                        pass
            status["zip_extracted"] = members
            if len(members) == 1:
                local = job_dir / members[0]
                status["downloaded_as"] = local.name
            else:
                status["status"] = f"zip extracted ({len(members)} media file(s)): " + ", ".join(members[:5])
                notify("Ingest watcher", f"{job_dir.name}: zip unpacked {len(members)} media files.")
                report["files"].append(status)
                continue

        if local.suffix.lower() not in PROBEABLE_EXTS:
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

        # Minimum ingest spec (ffprobe once, cached): under-10s creatives,
        # missing video/audio - quarantine like a bad payload so it can't
        # reach the ingest queue, and surface it for the spec-fail reply.
        if name not in state.get("probed", {}):
            state.setdefault("probed", {})[name] = probe_spec(local)
            changed = True
        pr = state["probed"][name] or {}
        if not pr.get("info"):
            # ffprobe couldn't parse it at all - bad download, not a spec
            # question. Tiny junk keeps the old label for familiarity.
            reason = ("suspiciously small" if local.stat().st_size < 64 * 1024
                      else "unreadable media (ffprobe: " + str(pr.get("error", "no streams"))[:60] + ")")
            rej = job_dir / "_rejected"
            try:
                rej.mkdir(exist_ok=True)
                local.rename(rej / local.name)
            except Exception:
                pass
            state.setdefault("rejected", []).append(name)
            status["status"] = "rejected: " + reason
            if name not in state["notified"]:
                state["notified"].append(name)
                notify("Ingest watcher", f"{local.name}: rejected ({reason}) - not a real video.")
            changed = True
            report["files"].append(status)
            continue
        if pr.get("fails"):
            rej = job_dir / "_rejected"
            try:
                rej.mkdir(exist_ok=True)
                local.rename(rej / local.name)
            except Exception:
                pass
            state.setdefault("rejected", []).append(name)
            state.setdefault("specfail", {})[name] = pr["fails"]
            status["status"] = "spec_fail: " + "; ".join(pr["fails"])
            status["spec"] = pr.get("info")
            if name not in state["notified"]:
                state["notified"].append(name)
                notify("Ingest watcher",
                       f"{local.name}: fails ingest spec ({'; '.join(pr['fails'])}) - moved to _rejected/.")
            changed = True
            report["files"].append(status)
            continue
        status["spec"] = pr["info"]

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

    # All entries settled -> portal gate (SIDMAP terminal statuses + rest
    # beat) -> file the job's media under Customer Content. Rejected /
    # espn_failed count as settled; missing/downloading hold the job.
    if report["files"] and not state.get("archived_all") and all(
            s.get("status") not in ("missing", "downloading") for s in report["files"]):
        if portal_gate(manifest_path, job_dir, manifest, state, report, client):
            if archive_done(job_dir, manifest, state, report, client):
                state["archived_all"] = True
        changed = True  # portal_gate timestamps live in state

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

# ---- Downloads scoop --------------------------------------------------------
# Chrome's own downloads (Drive select-all zips, manual saves) land in
# ~/Downloads, outside the job folders. A file moves into a job ONLY when
# its name - or a zip's media members - matches a pending manifest row;
# everything else stays put and silent. Recency + seen-set bound the scan.
DOWNLOADS_DIR = WATCH_DIR.parent
SCOOP_WINDOW = 6 * 3600
_seen_dl = set()


def all_manifests():
    """Flat layout keeps manifests at Ingest/ top level; legacy job dirs
    kept them one level deep. Support both."""
    return sorted(list(WATCH_DIR.glob("*.json")) + list(WATCH_DIR.glob("*/*.json")))


def find_manifest_for_job(slug: str):
    """Locate the manifest for a job slug - matches the manifest's job
    field or its <slug>-manifest.json filename."""
    for mp in all_manifests():
        if not MANIFEST_RE.match(mp.name):
            continue
        try:
            m = json.loads(mp.read_text())
        except Exception:
            continue
        if slug and (m.get("job") == slug or mp.stem == slug
                     or mp.stem == slug + "-manifest"):
            return mp, m
    return None, None


def job_media_files(slug: str) -> list[str]:
    mp, m = find_manifest_for_job(slug)
    if not m:
        return []
    return [e["file"] for e in m.get("files", [])
            if e.get("file") and Path(e["file"]).suffix.lower() in MEDIA_EXTS
            and (mp.parent / e["file"]).exists()]


def spec_failures(slug: str) -> list[dict]:
    """Spec-rejected files for a job, with the ffprobe facts - the panel
    drafts the 'does not meet our requirements' reply off this."""
    mp, m = find_manifest_for_job(slug)
    if not m:
        return []
    state = load_state(mp)
    out = []
    for name, fails in (state.get("specfail") or {}).items():
        e = next((x for x in m.get("files", []) if x.get("file") == name), {})
        out.append({"file": name,
                    "id": e.get("tracking_id") or Path(name).stem.split()[0],
                    "fails": fails,
                    "info": (state.get("probed", {}).get(name) or {}).get("info") or {}})
    return out


def resolve_job_file(slug: str, name: str):
    """Only serve basenames that the job's manifest actually expects -
    no traversal, no arbitrary file reads off the loopback port."""
    mp, m = find_manifest_for_job(slug)
    if not m:
        return None
    name = Path(name).name
    if name not in {e.get("file", "") for e in m.get("files", [])}:
        return None
    p = mp.parent / name
    return p if p.exists() and p.suffix.lower() in MEDIA_EXTS else None


def pending_expectations():
    """job_dir -> list of manifest filenames that still have no local file."""
    jobs = {}
    for manifest in all_manifests():
        if not MANIFEST_RE.match(manifest.name):
            continue
        try:
            m = json.loads(manifest.read_text())
        except Exception:
            continue
        job_dir = manifest.parent
        state = load_state(manifest)
        for e in m.get("files", []):
            name = e.get("file", "")
            if not name:
                continue
            if name in state.get("rejected", []) or name in state.get("unzipped", []):
                continue
            if state.get("archived_all") or name in state.get("archived", {}):
                continue
            if find_downloaded(job_dir, name) is not None:
                continue
            jobs.setdefault(job_dir, []).append(name)
    return jobs


def stem_match(a: str, b: str) -> bool:
    a, b = norm_stem(a), norm_stem(b)
    return len(a) >= 4 and len(b) >= 4 and (a in b or b in a)


def scoop_downloads():
    if not DOWNLOADS_DIR.exists():
        return
    pending = pending_expectations()
    if not pending:
        return
    now = time.time()
    try:
        entries = list(DOWNLOADS_DIR.iterdir())
    except Exception:
        return
    for p in entries:
        if not p.is_file() or p.suffix.lower() == ".crdownload" or p.name in _seen_dl:
            continue
        try:
            if now - p.stat().st_mtime > SCOOP_WINDOW:
                _seen_dl.add(p.name)
                continue
        except Exception:
            continue
        ext = p.suffix.lower()
        if ext in MEDIA_EXTS:
            for job_dir, wants in pending.items():
                match = next((w for w in wants if stem_match(w, p.name)), None)
                if match:
                    try:
                        p.replace(job_dir / match)
                    except Exception:
                        continue
                    notify("Ingest watcher", f"{p.name} -> {job_dir.name}/{match}")
                    log(f"scooped {p.name} into {job_dir.name} as {match}")
                    break
            _seen_dl.add(p.name)
        elif ext == ".zip":
            try:
                with zipfile.ZipFile(p) as z:
                    med = [Path(i.filename).name for i in z.infolist()
                           if not i.is_dir()
                           and Path(i.filename).suffix.lower() in MEDIA_EXTS]
            except Exception:
                med = []
            hit = next((jd for jd, wants in pending.items()
                        if any(stem_match(w, m) for m in med for w in wants)), None)
            if hit:
                try:
                    p.replace(hit / p.name)
                    notify("Ingest watcher", f"{p.name} -> {hit.name}/ (zip matched pending rows)")
                    log(f"scooped zip {p.name} into {hit.name}")
                except Exception:
                    pass
            _seen_dl.add(p.name)


def run_once():
    if not WATCH_DIR.exists():
        return
    relocate_debug_logs()
    scoop_downloads()
    for manifest in all_manifests():
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
