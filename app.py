import asyncio
import io
import importlib.metadata
import json
import os
import re
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
import mutagen
from SpotiFLAC import AsyncSpotiFLAC
from mutagen.flac import FLAC, Picture
from mutagen.easyid3 import EasyID3
from mutagen.id3 import ID3, APIC, USLT
from mutagen.mp4 import MP4, MP4Cover


def _load_dotenv():
    env_file = Path(__file__).parent / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if key and value:
            os.environ.setdefault(key, value)


_load_dotenv()

app = Flask(__name__)

DOWNLOAD_DIR = Path("/tmp/ytdlp-downloads")
DOWNLOAD_DIR.mkdir(exist_ok=True)
SPOTIFLAC_REGISTRY = os.environ.get(
    "SPOTIFLAC_REGISTRY",
    "https://raw.githubusercontent.com/spotiflacapp/SpotiFLAC-Extension/main/registry.json",
)
SPOTIFLAC_SERVICES = [
    service.strip()
    for service in os.environ.get(
        "SPOTIFLAC_SERVICES",
        "ext:tidal-web,ext:qobuz-web,ext:deezer,ext:amazon",
    ).split(",")
    if service.strip()
]

# Nettoyage des fichiers orphelins au démarrage
for _orphan in DOWNLOAD_DIR.iterdir():
    try:
        if _orphan.is_dir():
            shutil.rmtree(_orphan, ignore_errors=True)
        else:
            _orphan.unlink(missing_ok=True)
    except Exception:
        pass

COOKIES_FILE = Path("cookies.txt")
downloads: dict = {}

# ── Cache des recherches ──────────────────────────────────────────────────────

SEARCH_CACHE_TTL = 300  # secondes
_search_cache: dict = {}
_search_cache_lock = threading.Lock()


def _search_cached(key: str, fn):
    now = time.time()
    with _search_cache_lock:
        hit = _search_cache.get(key)
        if hit and now - hit[0] < SEARCH_CACHE_TTL:
            return hit[1]

    results = fn()
    with _search_cache_lock:
        _search_cache[key] = (now, results)
        # garde le cache borne (~50 dernieres requetes)
        while len(_search_cache) > 50:
            _search_cache.pop(next(iter(_search_cache)))
    return results

# ── Spotify / SpotiFLAC Parser ────────────────────────────────────────────────

_spotify_token_cache: dict = {"token": None, "expires_at": 0}


def _get_spotify_token():
    now = time.time()
    if _spotify_token_cache["token"] and now < _spotify_token_cache["expires_at"] - 30:
        return _spotify_token_cache["token"]

    client_id = os.environ.get("SPOTIFY_CLIENT_ID")
    client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET")
    if not client_id or not client_secret:
        return None

    try:
        resp = requests.post(
            "https://accounts.spotify.com/api/token",
            data={"grant_type": "client_credentials"},
            auth=(client_id, client_secret),
            timeout=10,
        )
        if resp.status_code == 200:
            payload = resp.json()
            _spotify_token_cache["token"] = payload["access_token"]
            _spotify_token_cache["expires_at"] = now + payload.get("expires_in", 3600)
            return _spotify_token_cache["token"]
    except Exception:
        pass
    return None


def _parse_spotify_url(url: str) -> dict | None:
    """Parse Spotify track, album, or playlist URLs using open embed metadata."""
    m = re.search(r"open\.spotify\.com/(?:[a-zA-Z0-9_-]+/)*(track|album|playlist)/([a-zA-Z0-9]+)", url)
    if not m:
        return None

    kind, sp_id = m.group(1), m.group(2)
    embed_url = f"https://open.spotify.com/embed/{kind}/{sp_id}"

    try:
        r = requests.get(embed_url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}, timeout=10)
        if r.status_code != 200:
            return None

        script_m = re.search(r"<script[^>]*>\s*({.*?\"props\".*?})\s*</script>", r.text, re.DOTALL)
        if not script_m:
            return None

        data = json.loads(script_m.group(1))
        entity = data.get("props", {}).get("pageProps", {}).get("state", {}).get("data", {}).get("entity", {})

        title = entity.get("title") or entity.get("name") or "Musique Spotify"
        artist = entity.get("subtitle") or ""
        if not artist and entity.get("artists"):
            artist = ", ".join(a.get("name", "") for a in entity["artists"])

        visual = entity.get("visualIdentity", {})
        thumb = ""
        if visual and visual.get("image"):
            thumb = visual["image"][0].get("url", "")
        if not thumb and entity.get("thumbnail"):
            thumb = entity["thumbnail"]

        tracks = []
        raw_tracks = entity.get("trackList", [])

        if kind == "track" and not raw_tracks:
            tracks.append({
                "title": title,
                "artist": artist,
                "track_number": 1,
                "duration": fmt_duration((entity.get("duration") or 0) // 1000),
                "duration_seconds": (entity.get("duration") or 0) // 1000,
                "query": f"{artist} - {title}" if artist else title,
            })
        else:
            for idx, t in enumerate(raw_tracks, 1):
                t_title = t.get("title", f"Piste {idx}")
                t_artist = t.get("subtitle") or artist
                tracks.append({
                    "title": t_title,
                    "artist": t_artist,
                    "track_number": idx,
                    "duration": fmt_duration((t.get("duration") or 0) // 1000),
                    "duration_seconds": (t.get("duration") or 0) // 1000,
                    "query": f"{t_artist} - {t_title}" if t_artist else t_title,
                })

        return {
            "type": f"spotify_{kind}",
            "kind": kind,
            "id": sp_id,
            "title": title,
            "artist": artist,
            "thumbnail": thumb,
            "total_tracks": len(tracks),
            "tracks": tracks,
            "url": url,
        }
    except Exception as e:
        print(f"Erreur parsing Spotify: {e}")
        return None

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
        time.sleep(3600)


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
        "js_runtimes": {"node": {}},
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
    # Pas de "js_runtimes" ici : la recherche et les metadonnees n'en ont pas
    # besoin, et lancer un processus Node a chaque extraction ralentit tout.
    opts = {
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 15,
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


def _clean(s: str, maxlen: int = 80) -> str:
    return "".join(c for c in s if c not in r'\/:*?"<>|')[:maxlen]


def _fetch_lyrics(title: str, artist: str, album: str, duration: int | None = None) -> str:
    """Retourne les paroles de LRCLIB lorsque le morceau est référencé."""
    params = {"track_name": title, "artist_name": artist, "album_name": album}
    if duration:
        params["duration"] = duration

    try:
        response = requests.get(
            "https://lrclib.net/api/get",
            params=params,
            headers={"User-Agent": "YTDown/1.0 (https://github.com/maywix/ytdownloader)"},
            timeout=10,
        )
        if response.status_code == 200:
            data = response.json()
            return data.get("plainLyrics") or data.get("syncedLyrics") or ""
    except Exception:
        pass
    return ""


def _embed_music_metadata(filepath: Path, title: str, artist: str, album: str, track_num: int = 1, total_tracks: int = 1, cover_url: str = "", duration: int | None = None):
    """Incruste les métadonnées ID3/FLAC et la pochette d'album dans le fichier audio."""
    try:
        cover_data = None
        if cover_url:
            try:
                resp = requests.get(cover_url, timeout=10)
                if resp.status_code == 200:
                    cover_data = resp.content
            except Exception:
                pass

        lyrics = _fetch_lyrics(title, artist, album, duration)
        ext = filepath.suffix.lower()
        if ext == ".flac":
            audio = FLAC(str(filepath))
            audio["title"] = title
            audio["artist"] = artist
            audio["album"] = album
            audio["tracknumber"] = f"{track_num}/{total_tracks}"
            if lyrics:
                audio["lyrics"] = lyrics
            if cover_data:
                pic = Picture()
                pic.type = 3
                pic.mime = "image/jpeg"
                pic.data = cover_data
                audio.clear_pictures()
                audio.add_picture(pic)
            audio.save()

        elif ext == ".mp3":
            try:
                audio = EasyID3(str(filepath))
            except Exception:
                audio = EasyID3()
                audio.filename = str(filepath)
            audio["title"] = title
            audio["artist"] = artist
            audio["album"] = album
            audio["tracknumber"] = f"{track_num}/{total_tracks}"
            audio.save()

            if cover_data:
                id3 = ID3(str(filepath))
                id3.add(APIC(
                    encoding=3,
                    mime="image/jpeg",
                    type=3,
                    desc="Cover",
                    data=cover_data
                ))
                if lyrics:
                    id3.delall("USLT")
                    id3.add(USLT(encoding=3, lang="eng", desc="", text=lyrics))
                id3.save()

        elif ext in (".m4a", ".mp4"):
            audio = MP4(str(filepath))
            audio["\xa9nam"] = title
            audio["\xa9ART"] = artist
            audio["aART"] = artist
            audio["\xa9alb"] = album
            audio["trkn"] = [(track_num, total_tracks)]
            if lyrics:
                audio["\xa9lyr"] = lyrics
            if cover_data:
                audio["covr"] = [MP4Cover(cover_data, imageformat=MP4Cover.FORMAT_JPEG)]
            audio.save()
    except Exception as e:
        print(f"Erreur d incrustation des tags pour {filepath}: {e}")


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/spotify")
def spotify():
    return render_template("spotify.html")


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


@app.route("/api/music_info")
def get_music_info():
    url = request.args.get("url", "").strip()
    if not url:
        return jsonify({"error": "URL manquante"}), 400

    sp_data = _parse_spotify_url(url)
    if sp_data:
        return jsonify(sp_data)

    return jsonify({"error": "URL Spotify non reconnue ou invalide"}), 400


@app.route("/api/info")
def get_info():
    url = request.args.get("url", "").strip()
    if not url:
        return jsonify({"error": "URL manquante"}), 400

    sp_data = _parse_spotify_url(url)
    if sp_data:
        return jsonify({
            "type": "spotify",
            "spotify_data": sp_data,
            "title": sp_data["title"],
            "channel": sp_data["artist"],
            "thumbnail": sp_data["thumbnail"],
            "count": sp_data["total_tracks"],
            "url": url,
            "audio_only": True,
        })

    try:
        # Une seule extraction suffit : "extract_flat: in_playlist" aplatit les
        # playlists mais renvoie deja l'info COMPLETE pour une video seule.
        with yt_dlp.YoutubeDL(_info_ydl_opts({"extract_flat": "in_playlist"})) as ydl:
            info = ydl.extract_info(url, download=False)

        audio_only_domains = ["soundcloud.com", "bandcamp.com", "audiomack.com"]
        is_audio_only = any(d in url.lower() for d in audio_only_domains)

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

        fmts = info.get("formats") or []
        heights = sorted(set(
            f["height"] for f in fmts
            if f.get("height") and f.get("vcodec") not in ("none", None, "")
        ), reverse=True)
        max_height = heights[0] if heights else None

        return jsonify({
            "type": "video",
            "title": info.get("title", ""),
            "thumbnail": info.get("thumbnail", ""),
            "duration": fmt_duration(info.get("duration")),
            "channel": info.get("channel") or info.get("uploader", ""),
            "views": fmt_views(info.get("view_count")),
            "url": url,
            "max_height": max_height,
            "audio_only": is_audio_only,
        })

    except yt_dlp.utils.DownloadError:
        return jsonify({"error": "URL invalide ou contenu inaccessible"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _best_thumb(thumbs):
    if not thumbs:
        return ""
    return thumbs[-1].get("url", "")


def _search_youtube(q: str, limit: int = 12) -> list:
    with yt_dlp.YoutubeDL(_info_ydl_opts({"extract_flat": "in_playlist"})) as ydl:
        info = ydl.extract_info(f"ytsearch{limit}:{q}", download=False)
    out = []
    for e in (info.get("entries") or []):
        if not e:
            continue
        vid = e.get("id")
        out.append({
            "title": e.get("title", ""),
            "thumbnail": e.get("thumbnail") or _best_thumb(e.get("thumbnails")),
            "duration": fmt_duration(e.get("duration")),
            "channel": e.get("channel") or e.get("uploader", ""),
            "url": f"https://www.youtube.com/watch?v={vid}" if vid else e.get("url", ""),
        })
    return out


def _search_soundcloud(q: str, limit: int = 12) -> list:
    with yt_dlp.YoutubeDL(_info_ydl_opts({"extract_flat": "in_playlist"})) as ydl:
        info = ydl.extract_info(f"scsearch{limit}:{q}", download=False)
    out = []
    for e in (info.get("entries") or []):
        if not e:
            continue
        out.append({
            "title": e.get("title", ""),
            "thumbnail": e.get("thumbnail") or _best_thumb(e.get("thumbnails")),
            "duration": fmt_duration(e.get("duration")),
            "channel": e.get("uploader", ""),
            "url": e.get("url") or e.get("webpage_url", ""),
        })
    return out


def _search_spotify(q: str, limit: int = 12) -> list:
    """Search Spotify through SpotiFLAC's own metadata client.

    Do not silently substitute YouTube results here: selecting a result on
    the SpotiFLAC page must always give the downloader a Spotify URL.
    """
    async def _search_with_spotiflac():
        async with AsyncSpotiFLAC(
            output_dir=str(DOWNLOAD_DIR),
            sync_extensions=False,
        ) as client:
            return await client.search(q, limit=limit)

    try:
        found = asyncio.run(_search_with_spotiflac())
    except Exception as exc:
        raise RuntimeError(f"La recherche Spotify via SpotiFLAC a échoué : {exc}") from exc

    results = []
    for track in found.get("tracks", []):
        results.append({
            "type": "track",
            "title": getattr(track, "title", ""),
            "artist": getattr(track, "artists", ""),
            "album": getattr(track, "album", ""),
            "thumbnail": getattr(track, "cover_url", ""),
            "duration": fmt_duration((getattr(track, "duration_ms", 0) or 0) // 1000),
            "duration_seconds": (getattr(track, "duration_ms", 0) or 0) // 1000,
            "url": getattr(track, "external_url", ""),
        })
    for collection_type, label in (("albums", "album"), ("playlists", "playlist")):
        for item in found.get(collection_type, []):
            results.append({
                "type": label,
                "title": item.get("name", ""),
                "artist": item.get("artists", "") or item.get("owner", ""),
                "album": "",
                "thumbnail": item.get("cover_url", ""),
                "url": item.get("external_url", ""),
            })
    for artist in found.get("artists", []):
        results.append({
            "type": "artist",
            "title": artist.get("name", ""),
            "artist": "",
            "album": "",
            "thumbnail": artist.get("cover_url", ""),
            "url": artist.get("external_url", ""),
        })
    return [item for item in results if item["url"]]


@app.route("/api/search")
def search():
    q = request.args.get("q", "").strip()
    kind = request.args.get("type", "youtube")
    if not q:
        return jsonify({"error": "Requête manquante"}), 400

    try:
        if kind == "youtube":
            results = _search_cached(("yt", q), lambda: _search_youtube(q))
        elif kind == "soundcloud":
            results = _search_cached(("sc", q), lambda: _search_soundcloud(q))
        elif kind == "spotify":
            results = _search_cached(("sp", q), lambda: _search_spotify(q))
        else:
            return jsonify({"error": "Type de recherche inconnu"}), 400
        return jsonify({"results": results})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/resolve_music", methods=["POST"])
def resolve_music():
    data = request.get_json()
    query = (data.get("query") or "").strip()
    if not query:
        return jsonify({"error": "Requête manquante"}), 400

    try:
        with yt_dlp.YoutubeDL(_info_ydl_opts({"extract_flat": "in_playlist"})) as ydl:
            info = ydl.extract_info(f"ytsearch1:{query}", download=False)
            entries = info.get("entries") or []
            if not entries or not entries[0]:
                return jsonify({"error": "Aucun résultat trouvé"}), 404
            first = entries[0]
            vid = first.get("id")
            yt_url = f"https://www.youtube.com/watch?v={vid}" if vid else first.get("url", "")

        return get_info_for_url(yt_url)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def get_info_for_url(url: str):
    with yt_dlp.YoutubeDL(_info_ydl_opts()) as ydl:
        full = ydl.extract_info(url, download=False)

    fmts = full.get("formats") or []
    heights = sorted(set(
        f["height"] for f in fmts
        if f.get("height") and f.get("vcodec") not in ("none", None, "")
    ), reverse=True)

    return jsonify({
        "type": "video",
        "title": full.get("title", ""),
        "thumbnail": full.get("thumbnail", ""),
        "duration": fmt_duration(full.get("duration")),
        "channel": full.get("channel") or full.get("uploader", ""),
        "views": fmt_views(full.get("view_count")),
        "url": url,
        "max_height": heights[0] if heights else None,
        "audio_only": False,
    })


@app.route("/api/download", methods=["POST"])
def start_download():
    data = request.get_json()
    url = (data.get("url") or "").strip()
    fmt = data.get("format", "best")
    quality = data.get("quality", "1080")
    mode = data.get("mode", "single")
    spoti_data = data.get("spoti_data")

    if not url and not spoti_data:
        return jsonify({"error": "URL manquante"}), 400

    download_id = str(uuid.uuid4())
    downloads[download_id] = {
        "status": "pending",
        "progress": 0,
        "speed": "",
        "eta": "",
        "filename": "",
        "filepath": "",
        "current_title": "",
        "current": 0,
        "total": 1,
        "is_playlist": mode in ("playlist", "spoti_album"),
        "error": None,
    }

    t = threading.Thread(
        target=_download_thread,
        args=(download_id, url, fmt, quality, mode, spoti_data),
        daemon=True,
    )
    t.start()

    return jsonify({"download_id": download_id})


def _download_thread(download_id: str, url: str, fmt: str, quality: str, mode: str, spoti_data: dict | None):
    state = downloads[download_id]

    if mode == "spoti_album" or (spoti_data and spoti_data.get("tracks")):
        try:
            tracks = spoti_data.get("tracks") or []
            album_title = spoti_data.get("title") or "Album"
            album_artist = spoti_data.get("artist") or "Artiste"
            spotify_url = spoti_data.get("url") or (tracks[0].get("url") if tracks else "")
            if not spotify_url:
                raise ValueError("Lien Spotify manquant pour le téléchargement lossless")

            state["total"] = len(tracks) or 1
            state["current"] = 0
            state["status"] = "downloading"
            settings = spoti_data.get("settings") or {}
            source_quality = settings.get("source_quality", "LOSSLESS")
            transcode_to = settings.get("transcode_to", "flac")
            if source_quality not in {"LOSSLESS", "HI_RES_LOSSLESS", "HI_RES", "DOLBY_ATMOS", "HIGH", "LOW"}:
                raise ValueError("Qualité SpotiFLAC invalide")
            if transcode_to not in {"flac", "alac", "wavpack", "tta", "wav", "aiff", "mp3", None}:
                raise ValueError("Format de sortie SpotiFLAC invalide")
            bitrate = settings.get("transcode_bitrate", "320k")
            if bitrate not in {"128k", "192k", "256k", "320k"}:
                raise ValueError("Débit MP3 invalide")

            state["current_title"] = "Recherche d'une source SpotiFLAC..."

            out_dir = DOWNLOAD_DIR / download_id
            out_dir.mkdir(exist_ok=True)

            async def _run_spotiflac():
                async with AsyncSpotiFLAC(
                    output_dir=str(out_dir),
                    services=SPOTIFLAC_SERVICES,
                    registries=[SPOTIFLAC_REGISTRY],
                    quality=source_quality,
                    use_track_numbers=settings.get("use_track_numbers", True),
                    use_album_track_numbers=settings.get("use_album_track_numbers", True),
                    use_artist_subfolders=settings.get("use_artist_subfolders", False),
                    use_album_subfolders=settings.get("use_album_subfolders", False),
                    create_playlist_subfolders=settings.get("create_playlist_subfolders", False),
                    allow_fallback=settings.get("allow_fallback", True),
                    first_artist_only=settings.get("first_artist_only", False),
                    include_featuring=settings.get("include_featuring", True),
                    embed_lyrics=settings.get("embed_lyrics", True),
                    save_lrc=settings.get("save_lrc", False),
                    apple_lyrics_word_by_word=settings.get("apple_lyrics_word_by_word", True),
                    save_canvas=settings.get("save_canvas", False),
                    enrich_metadata=settings.get("enrich_metadata", True),
                    transcode_to=transcode_to,
                    transcode_bitrate=bitrate,
                    transcode_keep_original=settings.get("transcode_keep_original", False),
                    verify_hires=settings.get("verify_hires", False),
                    max_concurrent_downloads=settings.get("max_concurrent_downloads", 2),
                ) as client:
                    return await client.download_track(spotify_url)

            failed_tracks = asyncio.run(_run_spotiflac())
            files = [file for file in out_dir.rglob("*") if file.suffix.lower() in {".flac", ".m4a", ".wv", ".tta", ".wav", ".aiff", ".mp3"}]
            if failed_tracks or not files:
                raise RuntimeError("Aucun fournisseur SpotiFLAC n'a fourni le contenu demandé")

            state["status"] = "done"
            state["progress"] = 100
            state["current"] = state["total"]
            state["filepath"] = str(out_dir)
            state["filename"] = f"{_clean(album_artist)} - {_clean(album_title)} ({source_quality})"

        except Exception as e:
            state["status"] = "error"
            state["error"] = str(e)
        return

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

    res_map = {"360": 360, "480": 480, "720": 720, "1080": 1080, "2k": 1440, "4k": 2160, "8k": 4320}
    height = res_map.get(quality, 1080)
    base = _base_ydl_opts(out_tmpl, progress_hook, is_playlist)

    if fmt == "flac":
        ydl_opts = {
            **base,
            "format": "bestaudio/best",
            "writethumbnail": True,
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "flac",
                    "preferredquality": "0",
                },
                {
                    "key": "FFmpegMetadata",
                    "add_metadata": True,
                },
                {
                    "key": "EmbedThumbnail",
                    "already_have_thumbnail": False,
                },
            ],
        }
        expected_ext = ".flac"

    elif fmt == "mp3":
        bitrate = quality if quality in ("128", "256", "320") else "320"
        ydl_opts = {
            **base,
            "format": "bestaudio/best",
            "writethumbnail": True,
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": bitrate,
                },
                {
                    "key": "FFmpegMetadata",
                    "add_metadata": True,
                },
                {
                    "key": "EmbedThumbnail",
                    "already_have_thumbnail": False,
                },
            ],
        }
        expected_ext = ".mp3"

    elif fmt == "m4a":
        ydl_opts = {
            **base,
            "format": "bestaudio[ext=m4a]/bestaudio/best",
            "writethumbnail": True,
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "m4a",
                    "preferredquality": "0",
                },
                {
                    "key": "FFmpegMetadata",
                    "add_metadata": True,
                },
                {
                    "key": "EmbedThumbnail",
                    "already_have_thumbnail": False,
                },
            ],
        }
        expected_ext = ".m4a"

    elif fmt == "best":
        ydl_opts = {
            **base,
            "format": "bestvideo+bestaudio/best",
            "merge_output_format": "mp4/mkv",
        }
        expected_ext = ".mp4"

    elif fmt == "mkv":
        ydl_opts = {
            **base,
            "format": f"bestvideo[height<={height}]+bestaudio/best[height<={height}]",
            "merge_output_format": "mkv",
        }
        expected_ext = ".mkv"

    else:
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
            # SpotiFLAC may nest tracks inside artist/album folders.  The old
            # top-level-only loop created an empty ZIP in that valid case.
            for f in sorted(filepath.rglob("*")):
                if f.is_file():
                    zf.write(f, f.relative_to(filepath))
        buf.seek(0)
        shutil.rmtree(filepath, ignore_errors=True)
        downloads.pop(download_id, None)
        zip_name = f"{_clean(d.get('filename', 'album'))}.zip"
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
    print("\n  YTDown + SpotiFLAC → http://localhost:8080\n")
    app.run(host="0.0.0.0", port=8080, debug=False, threaded=True)
