import io
import importlib.metadata
import json
import os
import shutil
import subprocess
import time
import uuid
import threading
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

import requests
from flask import Flask, render_template, request, jsonify, send_file, Response, after_this_request

import yt_dlp

app = Flask(__name__)

DOWNLOAD_DIR = Path("/tmp/ytdlp-downloads")
DOWNLOAD_DIR.mkdir(exist_ok=True)
# Nettoyage des fichiers orphelins au démarrage
for _orphan in DOWNLOAD_DIR.iterdir():
    try:
        if _orphan.is_dir():
            shutil.rmtree(_orphan, ignore_errors=True)
        else:
            _orphan.unlink(missing_ok=True)
    except Exception:
        pass

# Drop a cookies.txt here (exported from browser) to unlock Instagram,
# TikTok private content, age-restricted videos, etc.
COOKIES_FILE = Path("cookies.txt")

downloads: dict = {}

# ── Auto-updater ──────────────────────────────────────────────────────────────

UPDATE_INTERVAL = 48 * 3600  # secondes
UPDATE_STATE_FILE = Path(__file__).parent / ".update_state.json"

_upd: dict = {"status": "idle", "last_check": None, "version": None}


def _current_ytdlp_version() -> str:
    try:
        return importlib.metadata.version("yt-dlp")
    except Exception:
        return "?"


def _load_upd_state():
    try:
        if UPDATE_STATE_FILE.exists():
            _upd.update(json.loads(UPDATE_STATE_FILE.read_text()))
    except Exception:
        pass


def _save_upd_state():
    try:
        UPDATE_STATE_FILE.write_text(json.dumps(_upd))
    except Exception:
        pass


def _run_update():
    _upd["status"] = "checking"
    try:
        result = subprocess.run(
            ["pip3", "install", "--upgrade", "yt-dlp", "--break-system-packages"],
            capture_output=True, text=True, timeout=180,
        )
        _upd["last_check"] = datetime.now().isoformat()
        _upd["version"]    = _current_ytdlp_version()
        _upd["status"]     = "ok" if result.returncode == 0 else "error"
    except Exception:
        _upd["status"] = "error"
    finally:
        _save_upd_state()


def _updater_loop():
    _load_upd_state()
    _upd.setdefault("version", _current_ytdlp_version())
    while True:
        should_update = True
        last = _upd.get("last_check")
        if last:
            try:
                if datetime.now() - datetime.fromisoformat(last) < timedelta(seconds=UPDATE_INTERVAL):
                    should_update = False
            except Exception:
                pass
        if should_update:
            _run_update()
        time.sleep(3600)  # réévalue toutes les heures


threading.Thread(target=_updater_loop, daemon=True).start()


def _base_ydl_opts(out_tmpl: str, progress_hook, is_playlist: bool) -> dict:
    opts = {
        "outtmpl": out_tmpl,
        "progress_hooks": [progress_hook],
        "quiet": True,
        "no_warnings": True,
        "concurrent_fragment_downloads": 8,
        "retries": 10,
        "fragment_retries": 10,
        "http_chunk_size": 10485760,
        "ignoreerrors": is_playlist,
        # Realistic browser UA avoids many platform blocks
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/125.0.0.0 Safari/537.36"
            ),
        },
    }
    if COOKIES_FILE.exists():
        opts["cookiefile"] = str(COOKIES_FILE)
    return opts


def _info_ydl_opts(extra: dict | None = None) -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/125.0.0.0 Safari/537.36"
            ),
        },
    }
    if COOKIES_FILE.exists():
        opts["cookiefile"] = str(COOKIES_FILE)
    if extra:
        opts.update(extra)
    return opts


def fmt_duration(s):
    if not s:
        return ""
    s = int(s)
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def fmt_views(n):
    if not n:
        return ""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M vues"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K vues"
    return f"{n} vues"


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/version")
def get_version():
    last = _upd.get("last_check")
    next_check = None
    if last:
        try:
            next_dt = datetime.fromisoformat(last) + timedelta(seconds=UPDATE_INTERVAL)
            next_check = next_dt.isoformat()
        except Exception:
            pass
    return jsonify({
        "version":    _upd.get("version") or _current_ytdlp_version(),
        "status":     _upd.get("status", "idle"),
        "last_check": last,
        "next_check": next_check,
    })


@app.route("/api/info")
def get_info():
    url = request.args.get("url", "").strip()
    if not url:
        return jsonify({"error": "URL manquante"}), 400

    try:
        with yt_dlp.YoutubeDL(_info_ydl_opts({"extract_flat": "in_playlist"})) as ydl:
            info = ydl.extract_info(url, download=False)

        # Detect audio-only services (SoundCloud, Bandcamp…)
        audio_only_domains = ["soundcloud.com", "bandcamp.com", "audiomack.com"]
        is_audio_only = any(d in url.lower() for d in audio_only_domains)

        # Playlist / channel
        if info.get("_type") in ("playlist", "multi_video") or (
            "entries" in info and info.get("webpage_url_basename") != "watch"
        ):
            entries = [e for e in (info.get("entries") or []) if e]
            thumb = info.get("thumbnail") or (entries[0].get("thumbnail") if entries else "")
            return jsonify({
                "type": "playlist",
                "title": info.get("title") or info.get("uploader", "Playlist"),
                "channel": info.get("uploader") or info.get("channel", ""),
                "thumbnail": thumb,
                "count": len(entries),
                "url": url,
                "audio_only": is_audio_only,
            })

        # Single video — re-fetch full info for thumbnail + available formats
        with yt_dlp.YoutubeDL(_info_ydl_opts()) as ydl:
            full = ydl.extract_info(url, download=False)

        # Extract available video heights
        fmts = full.get("formats") or []
        heights = sorted(set(
            f["height"] for f in fmts
            if f.get("height") and f.get("vcodec") not in ("none", None, "")
        ), reverse=True)
        max_height = heights[0] if heights else None

        return jsonify({
            "type": "video",
            "title": full.get("title", ""),
            "thumbnail": full.get("thumbnail", ""),
            "duration": fmt_duration(full.get("duration")),
            "channel": full.get("channel") or full.get("uploader", ""),
            "views": fmt_views(full.get("view_count")),
            "url": url,
            "max_height": max_height,
            "audio_only": is_audio_only,
        })

    except yt_dlp.utils.DownloadError:
        return jsonify({"error": "URL invalide ou contenu inaccessible"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/download", methods=["POST"])
def start_download():
    data = request.get_json()
    url = data.get("url", "").strip()
    fmt = data.get("format", "mp4")   # mp4 | mkv | mp3 | m4a
    quality = data.get("quality", "1080")
    mode = data.get("mode", "single")  # single | playlist

    if not url:
        return jsonify({"error": "URL manquante"}), 400

    download_id = str(uuid.uuid4())
    downloads[download_id] = {
        "status": "pending",
        "progress": 0,
        "speed": "",
        "eta": "",
        "current": 0,
        "total": 1,
        "current_title": "",
        "filepath": None,
        "filename": None,
        "is_playlist": mode == "playlist",
        "error": None,
    }

    threading.Thread(
        target=_do_download,
        args=(download_id, url, fmt, quality, mode),
        daemon=True,
    ).start()

    return jsonify({"download_id": download_id})


def _do_download(download_id: str, url: str, fmt: str, quality: str, mode: str):
    state = downloads[download_id]
    is_playlist = mode == "playlist"

    if is_playlist:
        out_dir = DOWNLOAD_DIR / download_id
        out_dir.mkdir(exist_ok=True)
        out_tmpl = str(out_dir / "%(playlist_index)03d - %(title).80s.%(ext)s")
    else:
        out_tmpl = str(DOWNLOAD_DIR / f"{download_id}.%(ext)s")

    def progress_hook(d):
        if d["status"] == "downloading":
            try:
                pct = float(d.get("_percent_str", "0%").strip().replace("%", ""))
                if is_playlist and state["total"] > 1:
                    done = max(0, state["current"] - 1)
                    state["progress"] = (done + pct / 100) / state["total"] * 100
                else:
                    state["progress"] = pct
            except (ValueError, AttributeError):
                pass
            state["speed"] = d.get("_speed_str", "").strip()
            state["eta"] = d.get("_eta_str", "").strip()
            state["status"] = "downloading"
            state["current_title"] = (d.get("info_dict") or {}).get("title", "")
        elif d["status"] == "finished":
            if is_playlist:
                state["current"] = state.get("current", 0) + 1
            state["status"] = "processing"

    res_map = {"360": 360, "480": 480, "720": 720, "1080": 1080,
               "2k": 1440, "4k": 2160, "8k": 4320}
    height = res_map.get(quality, 1080)

    base = _base_ydl_opts(out_tmpl, progress_hook, is_playlist)

    # ── Optimal mode: best video + audio.
    # Prefer MP4 (H.264+AAC compatible). yt-dlp falls back to MKV automatically
    # when the selected streams use VP9/AV1/Opus which MP4 can't contain natively.
    if fmt == "best":
        ydl_opts = {
            **base,
            "format": "bestvideo+bestaudio/best",
            "merge_output_format": "mp4/mkv",
        }
        expected_ext = ".mp4"

    elif fmt == "mp3":
        bitrate = quality if quality in ("128", "256") else "256"
        ydl_opts = {
            **base,
            "format": "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
            "postprocessors": [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": bitrate,
            }],
            "postprocessor_args": {"ffmpeg": ["-threads", "0"]},
        }
        expected_ext = ".mp3"

    elif fmt == "m4a":
        # Download AAC directly — no transcoding, fastest audio option
        ydl_opts = {
            **base,
            "format": "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio",
            "postprocessors": [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "m4a",
                "preferredquality": "0",
            }],
        }
        expected_ext = ".m4a"

    elif fmt == "mkv":
        ydl_opts = {
            **base,
            "format": (
                f"bestvideo[height<={height}]+bestaudio"
                f"/best[height<={height}]"
            ),
            "merge_output_format": "mkv",
        }
        expected_ext = ".mkv"

    else:  # mp4 — préfère H.264+AAC, bascule sur MKV si les codecs ne sont pas compatibles MP4
        ydl_opts = {
            **base,
            "format": (
                f"bestvideo[height<={height}][vcodec^=avc1]+bestaudio[ext=m4a]"
                f"/bestvideo[height<={height}][vcodec^=avc]+bestaudio[ext=m4a]"
                f"/bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]"
                f"/bestvideo[height<={height}]+bestaudio"
                f"/best[height<={height}]"
            ),
            "merge_output_format": "mp4/mkv",
        }
        expected_ext = ".mp4"

    try:
        if is_playlist:
            with yt_dlp.YoutubeDL(_info_ydl_opts({"extract_flat": True})) as ydl:
                flat = ydl.extract_info(url, download=False)
            state["total"] = len([e for e in (flat.get("entries") or []) if e])
            state["current"] = 1

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)

        if is_playlist:
            state["status"] = "done"
            state["progress"] = 100
            state["filepath"] = str(DOWNLOAD_DIR / download_id)
            total = state["total"]
            title = info.get("title") or "playlist"
            state["filename"] = f"{_clean(title)} ({total} fichiers)"
        else:
            filepath = DOWNLOAD_DIR / f"{download_id}{expected_ext}"
            if not filepath.exists():
                candidates = list(DOWNLOAD_DIR.glob(f"{download_id}.*"))
                if candidates:
                    filepath = sorted(candidates)[-1]
                    expected_ext = filepath.suffix

            title = info.get("title", download_id)
            state["status"] = "done"
            state["progress"] = 100
            state["filepath"] = str(filepath)
            state["filename"] = f"{_clean(title)}{expected_ext}"

    except Exception as e:
        state["status"] = "error"
        state["error"] = str(e)


def _clean(s: str, maxlen: int = 80) -> str:
    return "".join(c for c in s if c not in r'\/:*?"<>|')[:maxlen]


@app.route("/api/progress/<download_id>")
def get_progress(download_id):
    d = downloads.get(download_id)
    if d is None:
        return jsonify({"error": "Introuvable"}), 404
    return jsonify({k: v for k, v in d.items() if k != "filepath"})


@app.route("/api/file/<download_id>")
def serve_file(download_id):
    d = downloads.get(download_id)
    if d is None:
        return jsonify({"error": "Introuvable"}), 404
    if d["status"] != "done":
        return jsonify({"error": "Pas encore prêt"}), 400

    filepath = Path(d.get("filepath", ""))
    if not filepath.exists():
        return jsonify({"error": "Fichier introuvable"}), 404

    if d.get("is_playlist"):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in sorted(filepath.iterdir()):
                if f.is_file():
                    zf.write(f, f.name)
        buf.seek(0)
        # Suppression immédiate du dossier playlist après zip en mémoire
        shutil.rmtree(filepath, ignore_errors=True)
        downloads.pop(download_id, None)
        zip_name = f"{_clean(d.get('filename', 'playlist'))}.zip"
        return Response(
            buf.read(),
            headers={
                "Content-Disposition": f'attachment; filename="{zip_name}"',
                "Content-Type": "application/zip",
            },
        )

    @after_this_request
    def cleanup(response):
        try:
            filepath.unlink(missing_ok=True)
            downloads.pop(download_id, None)
        except Exception:
            pass
        return response

    return send_file(filepath, as_attachment=True, download_name=d["filename"])


@app.route("/api/thumbnail", methods=["POST"])
def download_thumbnail():
    data = request.get_json()
    url = data.get("url", "").strip()
    if not url:
        return jsonify({"error": "URL manquante"}), 400

    try:
        with yt_dlp.YoutubeDL(_info_ydl_opts()) as ydl:
            info = ydl.extract_info(url, download=False)
            thumb_url = info.get("thumbnail", "")
            title = info.get("title", "thumbnail")

        if not thumb_url:
            return jsonify({"error": "Miniature introuvable"}), 404

        resp = requests.get(thumb_url, timeout=15)
        resp.raise_for_status()

        raw_ext = thumb_url.split("?")[0].rsplit(".", 1)[-1].lower()
        ext = raw_ext if raw_ext in ("jpg", "jpeg", "png", "webp") else "jpg"
        filename = f"{_clean(title, 60)}.{ext}"

        return Response(
            resp.content,
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Content-Type": resp.headers.get("Content-Type", "image/jpeg"),
            },
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    print("\n  YTDown → http://localhost:8080\n")
    app.run(host="0.0.0.0", port=8080, debug=False, threaded=True)
