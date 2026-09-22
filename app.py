import asyncio
import io
import importlib.metadata
import json
import os
import re
import secrets
import shutil
import subprocess
import time
import uuid
import threading
import zipfile
from copy import deepcopy
from datetime import datetime, timedelta
from functools import wraps
from pathlib import Path

import requests
from flask import (
    Flask, render_template, request, jsonify, send_file, Response,
    after_this_request, session, redirect, url_for, flash,
)
from werkzeug.security import generate_password_hash, check_password_hash
import yt_dlp
from yt_dlp.utils import DateRange, DownloadCancelled
import mutagen
from SpotiFLAC import AsyncSpotiFLAC
from SpotiFLAC.core.spotify_metadata import SpotifyMetadataClient
import SpotiFLAC.core.text_match as _spotiflac_text_match
import SpotiFLAC.extensions.provider as _spotiflac_provider

# Le repli "aucune métadonnée" de l'extension Amazon renvoie un titre
# placeholder ("Amazon Track <ASIN>") au lieu d'un titre vide quand sa propre
# recherche interne (showSearch, sur na.mesk.skill.music.a2z.com) échoue —
# ce qui arrive dès que l'extension n'a pas de session Amazon authentifiée.
# Le fichier audio, lui, se télécharge très bien (chemin CDN séparé, via le
# ticket signé zarz). Mais provider.py compare ensuite found_title au titre
# attendu et rejette comme "Wrong track", alors que track_identity_mismatch()
# est explicitement conçue pour ignorer une métadonnée vide plutôt que de
# rejeter — l'extension casse cette exemption en renvoyant une chaîne non
# vide au lieu de "". On restaure l'exemption prévue en traitant ce
# placeholder précis comme une métadonnée absente, sans toucher au reste de
# la vérification (un vrai titre différent reste rejeté normalement).
#
# provider.py fait "from SpotiFLAC.core.text_match import
# track_identity_mismatch" : patcher l'attribut du module text_match ne
# suffit pas, il faut aussi réécrire la référence déjà importée dans
# provider.py lui-même (résolue à l'appel, donc ce patch prend effet tout de
# suite, sans redémarrage du process).
_AMAZON_PLACEHOLDER_PREFIX = "Amazon Track "
_original_track_identity_mismatch = _spotiflac_text_match.track_identity_mismatch


def _patched_track_identity_mismatch(*, found_title="", **kwargs):
    if str(found_title or "").startswith(_AMAZON_PLACEHOLDER_PREFIX):
        found_title = ""
    return _original_track_identity_mismatch(found_title=found_title, **kwargs)


_spotiflac_text_match.track_identity_mismatch = _patched_track_identity_mismatch
_spotiflac_provider.track_identity_mismatch = _patched_track_identity_mismatch
from deezer import Deezer, TrackFormats
from deemix import generateDownloadObject
from deemix.settings import load as load_deemix_settings
from deemix.downloader import Downloader
from deemix.itemgen import GenerationError
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
# Sources que la page /spotify laisse choisir à l'utilisateur (menu réglages).
SPOTIFLAC_ALLOWED_SERVICES = {"ext:tidal-web", "ext:qobuz-web", "ext:amazon", "ext:deezer"}

# ── Comptes & configuration admin (persistés hors du dépôt, voir .gitignore) ──
DATA_DIR = Path("data")
DATA_DIR.mkdir(exist_ok=True)
USERS_FILE = DATA_DIR / "users.json"
ARLS_FILE = DATA_DIR / "arls.json"
SECRET_KEY_FILE = DATA_DIR / "secret_key.txt"
_data_lock = threading.Lock()


def _load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def _save_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False))


def _get_secret_key() -> str:
    """Clé de session Flask, générée une fois puis persistée pour que les
    sessions admin survivent aux redémarrages du conteneur."""
    if SECRET_KEY_FILE.exists():
        return SECRET_KEY_FILE.read_text().strip()
    key = secrets.token_hex(32)
    SECRET_KEY_FILE.write_text(key)
    return key


def _bootstrap_admin() -> None:
    """Crée le compte admin par défaut au tout premier démarrage.

    Identifiants faibles assumés (admin/1234) pour un démarrage rapide sur une
    instance personnelle : à changer depuis /admin dès que possible via
    ADMIN_USERNAME/ADMIN_PASSWORD ou la gestion de comptes du panneau admin.
    """
    with _data_lock:
        users = _load_json(USERS_FILE, {})
        if users:
            return
        username = os.environ.get("ADMIN_USERNAME", "admin")
        password = os.environ.get("ADMIN_PASSWORD", "1234")
        users[username] = {
            "password_hash": generate_password_hash(password),
            "is_admin": True,
        }
        _save_json(USERS_FILE, users)
        print(f"[admin] Compte '{username}' créé avec le mot de passe par défaut '{password}'.")
        print("[admin] Changez-le depuis /admin dès que possible.")


app.secret_key = _get_secret_key()
_bootstrap_admin()


def _current_user() -> dict | None:
    username = session.get("username")
    if not username:
        return None
    user = _load_json(USERS_FILE, {}).get(username)
    if not user:
        return None
    return {"username": username, **user}


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        user = _current_user()
        if not user or not user.get("is_admin"):
            return redirect(url_for("admin_login", next=request.path))
        return view(*args, **kwargs)
    return wrapped


def _mask_arl(arl: str) -> str:
    if len(arl) <= 8:
        return "•" * len(arl)
    return f"{arl[:4]}{'•' * (len(arl) - 8)}{arl[-4:]}"


@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        user = _load_json(USERS_FILE, {}).get(username)
        if user and check_password_hash(user["password_hash"], password):
            session.clear()
            session["username"] = username
            session.permanent = True
            next_url = request.args.get("next")
            if next_url and next_url.startswith("/admin"):
                return redirect(next_url)
            return redirect(url_for("admin_dashboard"))
        flash("Identifiants invalides", "error")
    return render_template("admin_login.html")


@app.route("/admin/logout")
def admin_logout():
    session.clear()
    return redirect(url_for("admin_login"))


@app.route("/admin/api/reset-admin", methods=["POST"])
def admin_api_reset():
    """Filet de secours : force le compte 'admin' à admin/1234 quel que soit
    l'état actuel de data/users.json (utile si le bootstrap au premier
    démarrage a créé un compte différent). À retirer une fois l'accès repris
    en main : `curl -X POST http://<host>:8080/admin/api/reset-admin`."""
    with _data_lock:
        users = _load_json(USERS_FILE, {})
        users["admin"] = {
            "password_hash": generate_password_hash("1234"),
            "is_admin": True,
        }
        _save_json(USERS_FILE, users)
    return jsonify({"status": "ok", "username": "admin", "password": "1234"})


@app.route("/admin")
@admin_required
def admin_dashboard():
    users = _load_json(USERS_FILE, {})
    arls = _load_json(ARLS_FILE, [])
    users_view = sorted(
        ({"username": name, "is_admin": bool(info.get("is_admin"))} for name, info in users.items()),
        key=lambda u: u["username"],
    )
    arls_view = [
        {
            "id": a["id"],
            "label": a.get("label") or "Sans nom",
            "masked": _mask_arl(a["arl"]),
            "account": a.get("account", ""),
            "lossless": a.get("can_stream_lossless", False),
            "added_at": a.get("added_at", ""),
        }
        for a in arls
    ]
    return render_template(
        "admin.html",
        users=users_view,
        arls=arls_view,
        current_user=session.get("username"),
    )


@app.route("/admin/users", methods=["POST"])
@admin_required
def admin_add_user():
    username = request.form.get("username", "").strip()
    password = request.form.get("password", "")
    is_admin = request.form.get("is_admin") == "on"
    if not username or not password:
        flash("Nom d'utilisateur et mot de passe requis", "error")
        return redirect(url_for("admin_dashboard"))
    with _data_lock:
        users = _load_json(USERS_FILE, {})
        users[username] = {"password_hash": generate_password_hash(password), "is_admin": is_admin}
        _save_json(USERS_FILE, users)
    flash(f"Compte '{username}' créé", "success")
    return redirect(url_for("admin_dashboard"))


@app.route("/admin/users/<username>/delete", methods=["POST"])
@admin_required
def admin_delete_user(username):
    with _data_lock:
        users = _load_json(USERS_FILE, {})
        target = users.get(username)
        if not target:
            return redirect(url_for("admin_dashboard"))
        admins_left = sum(1 for u in users.values() if u.get("is_admin"))
        if username == session.get("username"):
            flash("Vous ne pouvez pas supprimer votre propre compte", "error")
        elif target.get("is_admin") and admins_left <= 1:
            flash("Impossible de supprimer le dernier compte admin", "error")
        else:
            users.pop(username, None)
            _save_json(USERS_FILE, users)
            flash(f"Compte '{username}' supprimé", "success")
    return redirect(url_for("admin_dashboard"))


@app.route("/admin/arls", methods=["POST"])
@admin_required
def admin_add_arl():
    arl = request.form.get("arl", "").strip()
    label = request.form.get("label", "").strip()
    if not arl:
        flash("ARL manquant", "error")
        return redirect(url_for("admin_dashboard"))

    dz = Deezer()
    try:
        valid = dz.login_via_arl(arl)
    except Exception:
        valid = False
    if not valid:
        flash("Cet ARL n'a pas pu se connecter à Deezer (expiré ou invalide)", "error")
        return redirect(url_for("admin_dashboard"))

    account = dz.current_user or {}
    with _data_lock:
        arls = _load_json(ARLS_FILE, [])
        arls.append({
            "id": uuid.uuid4().hex,
            "arl": arl,
            "label": label or account.get("name", ""),
            "account": account.get("name", ""),
            "can_stream_lossless": bool(account.get("can_stream_lossless")),
            "added_at": datetime.utcnow().isoformat(),
        })
        _save_json(ARLS_FILE, arls)
    flash("ARL ajouté et validé auprès de Deezer", "success")
    return redirect(url_for("admin_dashboard"))


@app.route("/admin/arls/<arl_id>/delete", methods=["POST"])
@admin_required
def admin_delete_arl(arl_id):
    with _data_lock:
        arls = _load_json(ARLS_FILE, [])
        arls = [a for a in arls if a["id"] != arl_id]
        _save_json(ARLS_FILE, arls)
    flash("ARL supprimé", "success")
    return redirect(url_for("admin_dashboard"))


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

# Client de métadonnées SpotiFLAC (session Spotify web) réutilisé entre les
# requêtes : (re)créer ce client à chaque recherche forçait une réauth Spotify
# (session + token TOTP + client-token, 3 aller-retours réseau) avant même la
# requête GraphQL de recherche elle-même, rendant chaque recherche très lente.
# Le client se réauthentifie déjà tout seul sur un 401 (voir SpotiFLAC.core
# .spotfetch.SpotifyWebClient.query), donc le garder en mémoire est sûr.
_spotify_metadata_client: SpotifyMetadataClient | None = None
_spotify_metadata_client_lock = threading.Lock()


def _get_spotify_metadata_client() -> SpotifyMetadataClient:
    global _spotify_metadata_client
    with _spotify_metadata_client_lock:
        if _spotify_metadata_client is None:
            _spotify_metadata_client = SpotifyMetadataClient()
        return _spotify_metadata_client


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
                "preview": (entity.get("audioPreview") or {}).get("url", ""),
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
                    "preview": (t.get("audioPreview") or {}).get("url", ""),
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

def _parse_artist_url(url: str) -> str | None:
    m = re.search(r"open\.spotify\.com/(?:intl-[a-zA-Z-]+/)?artist/([a-zA-Z0-9]+)", url)
    return m.group(1) if m else None


def _fetch_artist_discography(url: str) -> dict | None:
    """Récupère toute la discographie d'un artiste via SpotiFLAC (métadonnées seulement)."""
    artist_id = _parse_artist_url(url)
    if not artist_id:
        return None

    meta = _get_spotify_metadata_client()

    try:
        profile, discography = asyncio.run(meta.get_artist_albums_async(artist_id))
    except Exception as e:
        print(f"Erreur discographie artiste: {e}")
        return None

    name = (profile.get("profile") or {}).get("name", "Artiste")
    tracks = []
    for idx, t in enumerate(discography, 1):
        tracks.append({
            "title": getattr(t, "title", ""),
            "artist": getattr(t, "artists", ""),
            "album": getattr(t, "album", ""),
            "track_number": idx,
            "duration": fmt_duration((getattr(t, "duration_ms", 0) or 0) // 1000),
            "duration_seconds": (getattr(t, "duration_ms", 0) or 0) // 1000,
            "query": f"{getattr(t, 'artists', '')} - {getattr(t, 'title', '')}",
            "url": getattr(t, "external_url", ""),
            "preview": getattr(t, "preview_url", "") or "",
        })

    return {
        "type": "spotify_artist",
        "kind": "artist",
        "id": artist_id,
        "title": name,
        "artist": "",
        "thumbnail": profile.get("avatar", ""),
        "total_tracks": len(tracks),
        "tracks": tracks,
        "url": url,
    }


# ── Auto-updater ──────────────────────────────────────────────────────────────
# Vérifie et met à jour yt-dlp, SpotiFLAC et deemix toutes les 48h via pip,
# à l'intérieur du conteneur en cours d'exécution (persiste jusqu'au prochain
# rebuild de l'image, comme pour yt-dlp historiquement).

UPDATE_INTERVAL = 48 * 3600  # secondes
UPDATE_STATE_FILE = Path(__file__).parent / ".update_state.json"
UPDATABLE_PACKAGES = {
    "yt-dlp": ["pip3", "install", "--upgrade", "yt-dlp", "--break-system-packages"],
    "SpotiFLAC": ["pip3", "install", "--upgrade", "SpotiFLAC", "--break-system-packages"],
    "deemix": ["pip3", "install", "--upgrade", "deemix[spotify]", "--break-system-packages"],
}
_upd: dict = {name: {"status": "idle", "last_check": None, "version": None} for name in UPDATABLE_PACKAGES}


def _current_ytdlp_version() -> str:
    return _package_version("yt-dlp")


def _package_version(dist_name: str) -> str:
    try:
        return importlib.metadata.version(dist_name)
    except Exception:
        return "?"


def _load_upd_state():
    try:
        if UPDATE_STATE_FILE.exists():
            saved = json.loads(UPDATE_STATE_FILE.read_text())
            for name in UPDATABLE_PACKAGES:
                if isinstance(saved.get(name), dict):
                    _upd[name].update(saved[name])
    except Exception:
        pass


def _save_upd_state():
    try:
        UPDATE_STATE_FILE.write_text(json.dumps(_upd))
    except Exception:
        pass


def _run_update(name: str, cmd: list):
    _upd[name]["status"] = "checking"
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        _upd[name]["last_check"] = datetime.now().isoformat()
        _upd[name]["version"] = _package_version(name)
        _upd[name]["status"] = "ok" if result.returncode == 0 else "error"
        if result.returncode != 0:
            print(f"[updater] {name} : échec de la mise à jour : {result.stderr[-500:]}")
    except Exception as exc:
        _upd[name]["status"] = "error"
        print(f"[updater] {name} : exception pendant la mise à jour : {exc}")
    finally:
        _save_upd_state()


def _updater_loop():
    _load_upd_state()
    for name in UPDATABLE_PACKAGES:
        if not _upd[name].get("version") or _upd[name]["version"] == "?":
            _upd[name]["version"] = _package_version(name)
    while True:
        for name, cmd in UPDATABLE_PACKAGES.items():
            last = _upd[name].get("last_check")
            should_update = True
            if last:
                try:
                    if datetime.now() - datetime.fromisoformat(last) < timedelta(seconds=UPDATE_INTERVAL):
                        should_update = False
                except Exception:
                    pass
            if should_update:
                _run_update(name, cmd)
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


def _fmt_size(num_bytes: int) -> str:
    size = float(num_bytes)
    if size < 1024:
        return f"{size:.0f} o"
    for unit in ("Ko", "Mo", "Go"):
        size /= 1024
        if size < 1024 or unit == "Go":
            return f"{size:.1f} {unit}"
    return f"{size:.1f} Go"


def _dir_size_str(path: Path) -> str:
    total = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
    return _fmt_size(total)


def _cleanup_download_artifacts(download_id: str) -> None:
    """Supprime tout fichier/dossier partiel laissé par un téléchargement
    annulé (fichier unique DOWNLOAD_DIR/<id>.ext ou dossier DOWNLOAD_DIR/<id>
    pour une playlist/collection)."""
    for f in DOWNLOAD_DIR.glob(f"{download_id}*"):
        try:
            if f.is_dir():
                shutil.rmtree(f, ignore_errors=True)
            else:
                f.unlink(missing_ok=True)
        except Exception:
            pass


def _is_youtube_channel_url(url: str) -> bool:
    """Une chaîne (page @handle/channel/c/user), pas une playlist classique
    ni une vidéo isolée — seules les chaînes proposent le filtrage par
    intervalle/date, une playlist "list=" a déjà un ordre choisi par son auteur."""
    if "list=" in url or "/watch" in url.lower():
        return False
    return bool(re.search(r"youtube\.com/(@[\w.\-]+|channel/|c/|user/)", url, re.IGNORECASE))


def _channel_filter_opts(channel_scope: str, range_start, range_end, date_after) -> dict:
    """Options yt-dlp pour restreindre une chaîne : par position
    (playlist_items) ou par date de publication (daterange, qui accepte les
    expressions relatives de yt-dlp comme "now-1year")."""
    if channel_scope == "range":
        try:
            start = max(1, int(range_start or 1))
            end = int(range_end or start)
        except (TypeError, ValueError):
            raise ValueError("Intervalle invalide")
        if end < start:
            start, end = end, start
        return {"playlist_items": f"{start}-{end}"}

    if channel_scope == "date":
        if not date_after:
            raise ValueError("Date de début manquante")
        try:
            return {"daterange": DateRange(date_after)}
        except Exception as exc:
            raise ValueError(f"Date invalide : {exc}")

    return {}


# Dolby Atmos Music est toujours livré en codec objet Dolby (E-AC-3/JOC,
# jamais en PCM lossless) : quand une source n'a pas pu résoudre le vrai
# flux Atmos (ex. Amazon sans session valide, cf. contournement Wrong-track
# plus haut), elle retombe parfois sur un FLAC/ALAC stéréo classique sans le
# signaler — un "succès" qui n'est pas le contenu demandé. On vérifie le
# codec réel après coup plutôt que de faire confiance à l'étiquette de
# qualité demandée.
_NEVER_ATMOS_CODECS = {"flac", "alac", "pcm_s16le", "pcm_s24le", "pcm_s32le", "wavpack", "tta"}


def _audio_codec(filepath: Path) -> str | None:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(filepath)],
            capture_output=True, text=True, timeout=15,
        )
        return out.stdout.strip().lower() or None
    except Exception:
        return None


# Même angle mort que Dolby Atmos, moins sévère : une source qui ne trouve
# pas le vrai master Hi-Res peut discrètement renvoyer du CD-quality
# (16 bits / 44.1 kHz) en le faisant passer pour du Hi-Res. On ne bloque que
# le cas sans équivoque (ni le bit depth ni la fréquence ne dépassent le
# CD) — un 24 bits/44.1 kHz reste un vrai Hi-Res légitime.
_CD_SAMPLE_RATE = 44100
_CD_BIT_DEPTH = 16


def _audio_specs(filepath: Path) -> tuple[int, int]:
    """(sample_rate_hz, bit_depth) du premier flux audio, (0, 0) si indisponible."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=sample_rate,bits_per_raw_sample,bits_per_sample",
             "-of", "csv=p=0", str(filepath)],
            capture_output=True, text=True, timeout=15,
        )
        parts = out.stdout.strip().split(",")
        sample_rate = int(parts[0]) if parts and parts[0].strip().isdigit() else 0
        bits = max((int(p) for p in parts[1:] if p.strip().isdigit()), default=0)
        return sample_rate, bits
    except Exception:
        return 0, 0


def _is_fake_hires(filepath: Path) -> bool:
    sample_rate, bits = _audio_specs(filepath)
    if sample_rate == 0 and bits == 0:
        return False  # ffprobe indisponible/illisible : ne pas bloquer sur notre propre incapacité à vérifier
    return sample_rate <= _CD_SAMPLE_RATE and bits <= _CD_BIT_DEPTH


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


@app.route("/deemix")
def deemix():
    return render_template("deemix.html")


def _package_status(name: str) -> dict:
    info = _upd.get(name, {})
    last = info.get("last_check")
    next_check = None
    if last:
        try:
            next_check = (datetime.fromisoformat(last) + timedelta(seconds=UPDATE_INTERVAL)).isoformat()
        except Exception:
            pass
    return {
        "version": info.get("version") or _package_version(name),
        "status": info.get("status", "idle"),
        "last_check": last,
        "next_check": next_check,
    }


@app.route("/api/version")
def get_version():
    packages = {name: _package_status(name) for name in UPDATABLE_PACKAGES}
    return jsonify({**packages["yt-dlp"], "packages": packages})


@app.route("/api/music_info")
def get_music_info():
    url = request.args.get("url", "").strip()
    if not url:
        return jsonify({"error": "URL manquante"}), 400
    url = _expand_spotify_short_link(url)

    artist_data = _fetch_artist_discography(url)
    if artist_data:
        return jsonify(artist_data)

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
                "is_channel": _is_youtube_channel_url(url),
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
    meta = _get_spotify_metadata_client()

    try:
        found = asyncio.run(meta.search_async(q, limit=limit))
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


def _search_deemix(q: str, limit: int = 8) -> list:
    """Recherche par mot-clé directement sur l'API publique Deezer (aucun ARL
    requis) : mêmes 4 types que la recherche SpotiFLAC, fusionnés en une liste."""
    dz = Deezer()
    results = []

    def _add(items, mapper):
        for item in items:
            try:
                results.append(mapper(item))
            except Exception:
                continue

    try:
        data = dz.api.search_track(q, limit=limit).get("data") or []
        _add(data, lambda t: {
            "type": "track",
            "title": t.get("title", ""),
            "artist": (t.get("artist") or {}).get("name", ""),
            "album": (t.get("album") or {}).get("title", ""),
            "thumbnail": (t.get("album") or {}).get("cover_xl") or (t.get("album") or {}).get("cover_big", ""),
            "duration": fmt_duration(t.get("duration")),
            "url": t.get("link", ""),
            "preview": t.get("preview", ""),
        })
    except Exception:
        pass
    try:
        data = dz.api.search_album(q, limit=limit).get("data") or []
        _add(data, lambda a: {
            "type": "album",
            "title": a.get("title", ""),
            "artist": (a.get("artist") or {}).get("name", ""),
            "album": "",
            "thumbnail": a.get("cover_xl") or a.get("cover_big", ""),
            "url": a.get("link", ""),
        })
    except Exception:
        pass
    try:
        data = dz.api.search_artist(q, limit=limit).get("data") or []
        _add(data, lambda ar: {
            "type": "artist",
            "title": ar.get("name", ""),
            "artist": "",
            "album": "",
            "thumbnail": ar.get("picture_xl") or ar.get("picture_big", ""),
            "url": ar.get("link", ""),
        })
    except Exception:
        pass
    try:
        data = dz.api.search_playlist(q, limit=limit).get("data") or []
        _add(data, lambda p: {
            "type": "playlist",
            "title": p.get("title", ""),
            "artist": (p.get("user") or {}).get("name", ""),
            "album": "",
            "thumbnail": p.get("picture_xl") or p.get("picture_big", ""),
            "url": p.get("link", ""),
        })
    except Exception:
        pass
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
        elif kind == "deemix":
            results = _search_cached(("dz", q), lambda: _search_deemix(q))
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
    channel_scope = data.get("channel_scope", "all")
    range_start = data.get("range_start")
    range_end = data.get("range_end")
    date_after = data.get("date_after")

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
        "cancel_requested": False,
    }

    t = threading.Thread(
        target=_download_thread,
        args=(download_id, url, fmt, quality, mode, spoti_data, channel_scope, range_start, range_end, date_after),
        daemon=True,
    )
    t.start()

    return jsonify({"download_id": download_id})


def _download_thread(
    download_id: str, url: str, fmt: str, quality: str, mode: str, spoti_data: dict | None,
    channel_scope: str = "all", range_start=None, range_end=None, date_after: str | None = None,
):
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
            if source_quality not in {"LOSSLESS", "HI_RES_LOSSLESS", "HI_RES", "HIGH", "LOW", "DOLBY_ATMOS"}:
                raise ValueError("Qualité SpotiFLAC invalide")
            if transcode_to not in {"flac", "alac", "wavpack", "tta", "wav", "aiff", "mp3", None}:
                raise ValueError("Format de sortie SpotiFLAC invalide")
            bitrate = settings.get("transcode_bitrate", "320k")
            if bitrate not in {"128k", "192k", "256k", "320k"}:
                raise ValueError("Débit MP3 invalide")
            requested_services = settings.get("services")
            if requested_services:
                services = [s for s in requested_services if s in SPOTIFLAC_ALLOWED_SERVICES]
                if not services:
                    raise ValueError("Aucune source SpotiFLAC valide sélectionnée")
            else:
                services = SPOTIFLAC_SERVICES

            state["current_title"] = "Recherche d'une source SpotiFLAC..."

            out_dir = DOWNLOAD_DIR / download_id
            out_dir.mkdir(exist_ok=True)

            # Sélection de pistes (style deemix) : la page envoie selected_tracks,
            # la liste des positions 1-based cochées. Si tout est coché (ou rien
            # n'est envoyé), on laisse SpotiFLAC résoudre la collection entière.
            track_urls: list[str] = []
            selected = spoti_data.get("selected_tracks")
            if selected is None and spoti_data.get("kind") == "artist" and tracks:
                # Une URL d'artiste n'est pas une collection SpotiFLAC :
                # on passe toujours par la liste de pistes explicite.
                selected = [t.get("track_number") for t in tracks]
            if selected is not None and tracks:
                want = {int(i) for i in selected}
                if all(t.get("url") for t in tracks):
                    track_urls = [t["url"] for t in tracks if t.get("track_number") in want]
                elif spotify_url:
                    async def _resolve_collection():
                        async with AsyncSpotiFLAC(output_dir=str(out_dir), sync_extensions=False) as client:
                            _, resolved = await client.get_playlist(spotify_url)
                            return [
                                t.external_url
                                for i, t in enumerate(resolved, 1)
                                if i in want and t.external_url
                            ]
                    track_urls = asyncio.run(_resolve_collection())
                state["total"] = len(track_urls) or 1

            async def _run_spotiflac():
                async with AsyncSpotiFLAC(
                    output_dir=str(out_dir),
                    services=services,
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
                    if track_urls:
                        return await client.download_tracks(track_urls)
                    return await client.download_track(spotify_url)

            if state.get("cancel_requested"):
                state["status"] = "cancelled"
                _cleanup_download_artifacts(download_id)
                return

            # Boucle asyncio gérée à la main (plutôt qu'asyncio.run) pour
            # pouvoir annuler la tâche depuis /api/cancel, appelée depuis un
            # autre thread (call_soon_threadsafe est la seule façon sûre de
            # toucher un event loop qui tourne ailleurs).
            loop = asyncio.new_event_loop()
            try:
                asyncio.set_event_loop(loop)
                task = loop.create_task(_run_spotiflac())
                state["_asyncio_cancel"] = {"loop": loop, "task": task}
                failed_tracks = loop.run_until_complete(task)
            except asyncio.CancelledError:
                state["status"] = "cancelled"
                _cleanup_download_artifacts(download_id)
                return
            finally:
                state["_asyncio_cancel"] = None
                loop.close()

            files = [file for file in out_dir.rglob("*") if file.suffix.lower() in {".flac", ".m4a", ".wv", ".tta", ".wav", ".aiff", ".mp3"}]
            if not files or (isinstance(failed_tracks, list) and failed_tracks):
                raise RuntimeError("Aucun fournisseur SpotiFLAC n'a fourni le contenu demandé")

            # Une source qui ne trouve pas le vrai master Atmos/Hi-Res peut
            # discrètement renvoyer du stéréo/CD-quality classique en le
            # faisant passer pour la qualité demandée (cf. contournement
            # Wrong-track plus haut). On ne supprime plus le fichier dans ce
            # cas : il reste utilisable (c'est quand même de la musique), on
            # se contente de prévenir plutôt que de forcer un échec — le
            # choix de le garder ou de réessayer revient à l'utilisateur.
            quality_mismatch = None
            if source_quality == "DOLBY_ATMOS":
                if any(_audio_codec(f) in _NEVER_ATMOS_CODECS for f in files):
                    quality_mismatch = "Qualité CD trouvée, pas de vrai Dolby Atmos (source repliée en stéréo classique)."
            elif source_quality in {"HI_RES_LOSSLESS", "HI_RES"} and transcode_to != "mp3":
                if any(_is_fake_hires(f) for f in files):
                    quality_mismatch = "Qualité CD trouvée (16 bits/44.1 kHz), pas de vrai Hi-Res."

            state["status"] = "done"
            state["progress"] = 100
            state["current"] = state["total"]
            state["filepath"] = str(out_dir)
            state["filename"] = f"{_clean(album_artist)} - {_clean(album_title)} ({source_quality})"
            state["quality_mismatch"] = quality_mismatch

        except Exception as e:
            state["status"] = "error"
            state["error"] = str(e)
        return

    is_playlist = mode == "playlist"

    channel_filter_opts = {}
    if is_playlist and channel_scope in ("range", "date"):
        try:
            channel_filter_opts = _channel_filter_opts(channel_scope, range_start, range_end, date_after)
        except ValueError as e:
            state["status"] = "error"
            state["error"] = str(e)
            return

    if is_playlist:
        out_dir = DOWNLOAD_DIR / download_id
        out_dir.mkdir(exist_ok=True)
        out_tmpl = str(out_dir / "%(playlist_index)03d - %(title).80s.%(ext)s")
    else:
        out_tmpl = str(DOWNLOAD_DIR / f"{download_id}.%(ext)s")

    def progress_hook(d):
        if state.get("cancel_requested"):
            raise DownloadCancelled("Annulé par l'utilisateur")
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

    if channel_filter_opts:
        ydl_opts.update(channel_filter_opts)

    try:
        if is_playlist:
            # "daterange" filtre par métadonnée complète (upload_date), pas
            # disponible en extraction "flat" : le total ci-dessous reste une
            # estimation haute pour ce cas (recompté sur disque une fois fini).
            flat_extra = {"extract_flat": True}
            if "playlist_items" in channel_filter_opts:
                flat_extra["playlist_items"] = channel_filter_opts["playlist_items"]
            with yt_dlp.YoutubeDL(_info_ydl_opts(flat_extra)) as ydl:
                flat = ydl.extract_info(url, download=False)
            state["total"] = len([e for e in (flat.get("entries") or []) if e])
            state["current"] = 1

        if state.get("cancel_requested"):
            state["status"] = "cancelled"
            _cleanup_download_artifacts(download_id)
            return

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)

        if is_playlist:
            actual_files = [f for f in out_dir.rglob("*") if f.is_file()]
            state["status"] = "done"
            state["progress"] = 100
            state["filepath"] = str(out_dir)
            title = info.get("title") or "playlist"
            size_str = _dir_size_str(out_dir)
            state["filename"] = f"{_clean(title)} ({len(actual_files)} fichiers, {size_str})"
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

    except DownloadCancelled:
        state["status"] = "cancelled"
        _cleanup_download_artifacts(download_id)
    except Exception as e:
        state["status"] = "error"
        state["error"] = str(e)


@app.route("/api/progress/<download_id>")
def get_progress(download_id):
    d = downloads.get(download_id)
    if d is None:
        return jsonify({"error": "Introuvable"}), 404
    return jsonify({k: v for k, v in d.items() if k != "filepath" and not k.startswith("_")})


@app.route("/api/cancel/<download_id>", methods=["POST"])
def cancel_download(download_id):
    state = downloads.get(download_id)
    if state is None:
        return jsonify({"error": "Introuvable"}), 404
    if state.get("status") in ("done", "error", "cancelled"):
        return jsonify({"status": state["status"]})

    state["cancel_requested"] = True

    # SpotiFLAC (mode spoti_album) : le téléchargement tourne dans une boucle
    # asyncio dédiée à ce thread, on annule sa tâche depuis cette requête via
    # call_soon_threadsafe (seul moyen sûr de toucher un event loop depuis un
    # autre thread).
    cancel_ctx = state.get("_asyncio_cancel")
    if cancel_ctx and cancel_ctx.get("loop") and cancel_ctx.get("task"):
        loop, task = cancel_ctx["loop"], cancel_ctx["task"]
        loop.call_soon_threadsafe(task.cancel)

    # Deemix : le Downloader consulte isCanceled avant chaque piste et
    # interrompt la collection dès la prochaine vérification.
    deemix_object = state.get("_deemix_object")
    if deemix_object is not None:
        deemix_object.isCanceled = True

    return jsonify({"status": "cancelling"})


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


def _serve_remote_image(image_url: str, title: str) -> Response:
    """Récupère une image distante et la renvoie en pièce jointe (utilisé
    aussi bien pour la miniature YouTube que pour les pochettes Spotify/Deezer,
    qu'il faut proxifier depuis le serveur pour éviter tout souci de CORS/
    hotlinking sur leurs CDN)."""
    resp = requests.get(image_url, timeout=15)
    resp.raise_for_status()

    raw_ext = image_url.split("?")[0].rsplit(".", 1)[-1].lower()
    ext = raw_ext if raw_ext in ("jpg", "jpeg", "png", "webp") else "jpg"
    filename = f"{_clean(title, 60)}.{ext}"

    return Response(
        resp.content,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Type": resp.headers.get("Content-Type", "image/jpeg"),
        },
    )


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

        return _serve_remote_image(thumb_url, title)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/cover", methods=["POST"])
def download_cover():
    """Pochette Spotify/Deezer : contrairement à /api/thumbnail, l'URL de
    l'image est déjà connue côté client (spotifyData.thumbnail /
    deemixData.thumbnail, résolue par /api/music_info ou /api/deemix/info),
    donc pas besoin de repasser par une extraction yt-dlp ici."""
    data = request.get_json() or {}
    image_url = (data.get("url") or "").strip()
    title = data.get("title") or "cover"
    if not image_url:
        return jsonify({"error": "URL manquante"}), 400

    try:
        return _serve_remote_image(image_url, title)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Deemix (téléchargement Deezer via ARL) ────────────────────────────────────

DEEMIX_QUALITY_MAP = {
    "FLAC": TrackFormats.FLAC,
    "MP3_320": TrackFormats.MP3_320,
    "MP3_128": TrackFormats.MP3_128,
}
DEEMIX_CONFIG_DIR = DATA_DIR / "deemix"
DEEMIX_SETTINGS = load_deemix_settings(str(DEEMIX_CONFIG_DIR / "config"))

_deemix_spotify_plugin = None
_deemix_spotify_plugin_lock = threading.Lock()
_deemix_arl_rotation_index = 0
_deemix_arl_rotation_lock = threading.Lock()


def _get_deemix_plugins() -> dict:
    """Plugin Spotify de deemix (résolution Spotify → Deezer par ISRC/UPC).

    Nécessite les identifiants d'appli Spotify (SPOTIFY_CLIENT_ID/SECRET,
    déjà utilisés ailleurs dans l'app) ; sans eux, seuls les liens Deezer
    directs fonctionnent sur la page Deemix.
    """
    global _deemix_spotify_plugin
    client_id = os.environ.get("SPOTIFY_CLIENT_ID")
    client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET")
    if not client_id or not client_secret:
        return {}
    with _deemix_spotify_plugin_lock:
        if _deemix_spotify_plugin is None:
            try:
                from deemix.plugins.spotify import Spotify as DeemixSpotify
                plugins_dir = DEEMIX_CONFIG_DIR / "plugins"
                plugins_dir.mkdir(parents=True, exist_ok=True)
                plugin = DeemixSpotify(configFolder=str(plugins_dir))
                plugin.setup()
                plugin.saveSettings({
                    "clientId": client_id,
                    "clientSecret": client_secret,
                    "fallbackSearch": True,
                })
                _deemix_spotify_plugin = plugin if plugin.enabled else False
            except Exception as exc:
                print(f"[deemix] Plugin Spotify indisponible : {exc}")
                _deemix_spotify_plugin = False
    return {"spotify": _deemix_spotify_plugin} if _deemix_spotify_plugin else {}


def _deemix_login():
    """Se connecte avec le prochain ARL du pool (rotation), pour répartir la
    charge/le rate-limit entre plusieurs comptes Deezer."""
    global _deemix_arl_rotation_index
    arls = _load_json(ARLS_FILE, [])
    if not arls:
        return None
    with _deemix_arl_rotation_lock:
        start = _deemix_arl_rotation_index % len(arls)
        _deemix_arl_rotation_index = (start + 1) % len(arls)
    order = arls[start:] + arls[:start]
    for entry in order:
        dz = Deezer()
        try:
            if dz.login_via_arl(entry["arl"]):
                return dz
        except Exception:
            continue
    return None


def _parse_deezer_url(url: str) -> tuple[str, str] | None:
    if "deezer.page.link" in url or "link.deezer.com" in url:
        try:
            resp = requests.head(url, allow_redirects=True, timeout=10)
            url = resp.url
        except Exception:
            pass
    m = re.search(r"deezer\.com/(?:[a-z]{2}/)?(track|album|artist|playlist)/(\d+)", url)
    if not m:
        return None
    return m.group(1), m.group(2)


def _expand_spotify_short_link(url: str) -> str:
    """Déplie les liens de partage courts (spotify.link/...) vers leur URL
    open.spotify.com canonique, avant tout regex de parsing."""
    if "spotify.link" in url or "spotify.app.link" in url:
        try:
            resp = requests.head(url, allow_redirects=True, timeout=10)
            return resp.url
        except Exception:
            try:
                resp = requests.get(url, allow_redirects=True, timeout=10)
                return resp.url
            except Exception:
                pass
    return url


def _resolve_deemix_link(url: str) -> dict:
    """Prévisualisation d'un lien Spotify ou Deezer pour la page Deemix.

    Ne fait que lire des métadonnées publiques (Deezer : api.deezer.com sans
    connexion ; Spotify : la même page embed que /spotify) — aucun ARL requis
    ici, seulement pour le téléchargement lui-même.
    """
    url = _expand_spotify_short_link(url)
    deezer_match = _parse_deezer_url(url)
    if deezer_match:
        kind, item_id = deezer_match
        dz = Deezer()
        try:
            if kind == "track":
                t = dz.api.get_track(item_id)
                album = t.get("album") or {}
                return {
                    "type": "deemix", "kind": "track", "url": url,
                    "title": t.get("title", ""),
                    "artist": (t.get("artist") or {}).get("name", ""),
                    "thumbnail": album.get("cover_xl") or album.get("cover_big", ""),
                    "total_tracks": 1,
                    "tracks": [{
                        "title": t.get("title", ""),
                        "artist": (t.get("artist") or {}).get("name", ""),
                        "track_number": 1,
                        "duration": fmt_duration(t.get("duration")),
                        "duration_seconds": t.get("duration", 0),
                        "preview": t.get("preview", ""),
                    }],
                }
            if kind == "album":
                a = dz.api.get_album(item_id)
                tracks = (a.get("tracks") or {}).get("data", [])
                return {
                    "type": "deemix", "kind": "album", "url": url,
                    "title": a.get("title", ""),
                    "artist": (a.get("artist") or {}).get("name", ""),
                    "thumbnail": a.get("cover_xl") or a.get("cover_big", ""),
                    "total_tracks": a.get("nb_tracks", len(tracks)),
                    "tracks": [{
                        "title": tr.get("title", ""),
                        "artist": (tr.get("artist") or {}).get("name", ""),
                        "track_number": tr.get("track_position", idx + 1),
                        "duration": fmt_duration(tr.get("duration")),
                        "duration_seconds": tr.get("duration", 0),
                        "preview": tr.get("preview", ""),
                    } for idx, tr in enumerate(tracks)],
                }
            if kind == "playlist":
                p = dz.api.get_playlist(item_id)
                tracks = (p.get("tracks") or {}).get("data", [])
                return {
                    "type": "deemix", "kind": "playlist", "url": url,
                    "title": p.get("title", ""),
                    "artist": (p.get("creator") or {}).get("name", ""),
                    "thumbnail": p.get("picture_xl") or p.get("picture_big", ""),
                    "total_tracks": p.get("nb_tracks", len(tracks)),
                    "tracks": [{
                        "title": tr.get("title", ""),
                        "artist": (tr.get("artist") or {}).get("name", ""),
                        "track_number": idx + 1,
                        "duration": fmt_duration(tr.get("duration")),
                        "duration_seconds": tr.get("duration", 0),
                        "preview": tr.get("preview", ""),
                    } for idx, tr in enumerate(tracks)],
                }
            if kind == "artist":
                # "Top titres" Deezer : rapide (un seul appel), et c'est
                # exactement ce que le téléchargement résout aussi (voir
                # _resolve_deemix_download_url) pour rester cohérent.
                ar = dz.api.get_artist(item_id)
                top = dz.api.get_artist_top(item_id, limit=50).get("data") or []
                return {
                    "type": "deemix", "kind": "artist", "url": url,
                    "title": ar.get("name", ""),
                    "artist": "",
                    "thumbnail": ar.get("picture_xl") or ar.get("picture_big", ""),
                    "total_tracks": len(top),
                    "tracks": [{
                        "title": t.get("title", ""),
                        "artist": (t.get("artist") or {}).get("name", ""),
                        "album": (t.get("album") or {}).get("title", ""),
                        "track_number": idx + 1,
                        "duration": fmt_duration(t.get("duration")),
                        "duration_seconds": t.get("duration", 0),
                        "preview": t.get("preview", ""),
                    } for idx, t in enumerate(top)],
                }
        except Exception as exc:
            raise RuntimeError(f"Impossible de récupérer ce lien Deezer : {exc}") from exc

    sp_data = _parse_spotify_url(url)
    if sp_data:
        return {**sp_data, "type": "deemix"}

    artist_data = _fetch_artist_discography(url)
    if artist_data:
        return {**artist_data, "type": "deemix"}

    raise RuntimeError("Lien Spotify ou Deezer non reconnu")


class _DeemixProgressListener:
    """Pont entre les évènements de deemix.downloader.Downloader et l'état de
    progression exposé par /api/progress/<id> (même format que SpotiFLAC)."""

    def __init__(self, state: dict):
        self.state = state

    def send(self, key, value=None):
        if key == "updateQueue" and isinstance(value, dict):
            if value.get("downloaded") or value.get("failed"):
                total = max(1, self.state.get("total", 1))
                current = min(total, self.state.get("current", 0) + 1)
                self.state["current"] = current
                self.state["progress"] = current / total * 100
            data = value.get("data") or {}
            title, artist = data.get("title"), data.get("artist")
            if title:
                self.state["current_title"] = f"{artist} - {title}" if artist else title


@app.route("/api/deemix/info")
def deemix_info():
    url = request.args.get("url", "").strip()
    if not url:
        return jsonify({"error": "URL manquante"}), 400
    try:
        return jsonify(_resolve_deemix_link(url))
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/deemix/download", methods=["POST"])
def deemix_download():
    data = request.get_json() or {}
    url = (data.get("url") or "").strip()
    quality = data.get("quality", "FLAC")
    settings = data.get("settings") or {}
    selected_tracks = data.get("selected_tracks")
    if not url:
        return jsonify({"error": "URL manquante"}), 400
    if quality not in DEEMIX_QUALITY_MAP:
        return jsonify({"error": "Qualité Deemix invalide"}), 400
    if not _load_json(ARLS_FILE, []):
        return jsonify({"error": "Aucun ARL Deezer configuré. Contactez l'administrateur (/admin)."}), 400

    download_id = uuid.uuid4().hex
    downloads[download_id] = {
        "progress": 0, "status": "starting", "current": 0, "total": 1,
        "is_playlist": False, "error": None, "cancel_requested": False,
    }
    t = threading.Thread(
        target=_deemix_download_thread,
        args=(download_id, url, quality, settings, selected_tracks),
        daemon=True,
    )
    t.start()
    return jsonify({"download_id": download_id})


def _resolve_deemix_artist_id(url: str) -> str | None:
    """Si l'URL (Deezer native ou Spotify) désigne un artiste, renvoie son id
    Deezer numérique — sinon None (lien track/album/playlist classique)."""
    deezer_match = _parse_deezer_url(url)
    if deezer_match and deezer_match[0] == "artist":
        return deezer_match[1]

    expanded = _expand_spotify_short_link(url)
    artist_id = _parse_artist_url(expanded)
    if artist_id:
        artist_data = _fetch_artist_discography(expanded)
        name = (artist_data or {}).get("title", "")
        if not name:
            raise RuntimeError("Impossible de résoudre cet artiste Spotify")
        found = Deezer().api.search_artist(name, limit=1).get("data") or []
        if not found:
            raise RuntimeError(f"Artiste introuvable sur Deezer : {name}")
        return str(found[0]["id"])

    return None


def _generate_deezer_artist_top(dz, artist_id: str, bitrate: int):
    """Reproduit deemix.itemgen.generateArtistTopItem, qui appelle une
    méthode GW renommée côté deezer-py (get_artist_toptracks a été renommée
    get_artist_top_tracks) et plante avec un AttributeError sur les versions
    actuelles des deux paquets — même logique, juste le bon nom de méthode."""
    from deemix.itemgen import generatePlaylistItem

    artist_api = dz.api.get_artist(artist_id)
    playlist_api = {
        "id": f"{artist_api['id']}_top_track",
        "title": f"{artist_api['name']} - Top Tracks",
        "description": f"Top Tracks for {artist_api['name']}",
        "duration": 0,
        "public": True,
        "is_loved_track": False,
        "collaborative": False,
        "nb_tracks": 0,
        "fans": artist_api["nb_fan"],
        "link": f"https://www.deezer.com/artist/{artist_api['id']}/top_track",
        "share": None,
        "picture": artist_api["picture"],
        "picture_small": artist_api["picture_small"],
        "picture_medium": artist_api["picture_medium"],
        "picture_big": artist_api["picture_big"],
        "picture_xl": artist_api["picture_xl"],
        "checksum": None,
        "tracklist": f"https://api.deezer.com/artist/{artist_api['id']}/top",
        "creation_date": "XXXX-00-00",
        "creator": {"id": f"art_{artist_api['id']}", "name": artist_api["name"], "type": "user"},
        "type": "playlist",
    }
    top_tracks_gw = dz.gw.get_artist_top_tracks(artist_id, limit=50)
    return generatePlaylistItem(
        dz, playlist_api["id"], bitrate,
        playlistAPI=playlist_api, playlistTracksAPI=top_tracks_gw,
    )


def _deemix_download_thread(
    download_id: str,
    url: str,
    quality: str,
    user_settings: dict | None = None,
    selected_tracks: list | None = None,
):
    state = downloads[download_id]
    out_dir = DOWNLOAD_DIR / download_id
    out_dir.mkdir(exist_ok=True)
    user_settings = user_settings or {}
    try:
        state["current_title"] = "Connexion à Deezer..."
        dz = _deemix_login()
        if dz is None:
            raise RuntimeError("Aucun ARL Deezer valide n'est disponible. Contactez l'administrateur.")

        bitrate = DEEMIX_QUALITY_MAP[quality]

        state["current_title"] = "Résolution du lien..."
        artist_id = _resolve_deemix_artist_id(url)

        try:
            if artist_id:
                download_object = _generate_deezer_artist_top(dz, artist_id, bitrate)
            else:
                plugins = _get_deemix_plugins()
                if "spotify" in url.lower() and "spotify" not in plugins:
                    raise RuntimeError(
                        "Les liens Spotify nécessitent SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET côté "
                        "serveur pour Deemix. Utilisez un lien Deezer direct en attendant."
                    )
                download_object = generateDownloadObject(dz, url, bitrate, plugins, listener=None)
        except GenerationError as exc:
            raise RuntimeError(f"Lien non reconnu ou indisponible sur Deezer : {exc}") from exc
        if isinstance(download_object, list):
            raise RuntimeError("Ce lien correspond à plusieurs éléments distincts, non pris en charge par Deemix.")

        # Sélection de pistes (style SpotiFLAC) : selected_tracks est la liste
        # des positions 1-based cochées. Une Collection expose sa tracklist
        # brute dans .collection, dans le même ordre que l'API Deezer d'où
        # elles viennent — donc le même ordre que /api/deemix/info.
        if selected_tracks and hasattr(download_object, "collection"):
            want = {int(i) for i in selected_tracks}
            download_object.collection = [
                t for i, t in enumerate(download_object.collection, 1) if i in want
            ]
            download_object.size = len(download_object.collection) or 1

        total = getattr(download_object, "size", 1) or 1
        state["total"] = total
        state["is_playlist"] = total > 1
        state["status"] = "downloading"
        # Le Downloader deemix consulte cet attribut avant chaque piste
        # (voir deemix.downloader.Downloader.download) : le mettre à True
        # interrompt la collection proprement.
        state["_deemix_object"] = download_object

        if state.get("cancel_requested"):
            state["status"] = "cancelled"
            _cleanup_download_artifacts(download_id)
            return

        settings = deepcopy(DEEMIX_SETTINGS)
        settings.update({
            "downloadLocation": str(out_dir),
            "maxBitrate": str(bitrate),
            "createPlaylistFolder": bool(user_settings.get("playlist_folders", False)),
            "createArtistFolder": bool(user_settings.get("artist_folders", False)),
            "createAlbumFolder": user_settings.get("album_folders", total > 1),
            "createSingleFolder": False,
            "fallbackBitrate": True,
            "fallbackSearch": bool(user_settings.get("allow_fallback", True)),
            "fallbackISRC": bool(user_settings.get("allow_fallback", True)),
            "queueConcurrency": max(1, min(4, int(user_settings.get("concurrency", 3) or 3))),
            "syncedLyrics": bool(user_settings.get("save_lrc", False)),
            "featuredToTitle": "0" if user_settings.get("keep_featuring", True) else "1",
        })
        embed_lyrics = bool(user_settings.get("embed_lyrics", True))
        settings["tags"] = {**settings.get("tags", {}), "lyrics": embed_lyrics, "syncedLyrics": embed_lyrics}

        Downloader(dz, download_object, settings, _DeemixProgressListener(state)).start()

        if state.get("cancel_requested") or download_object.isCanceled:
            state["status"] = "cancelled"
            _cleanup_download_artifacts(download_id)
            return

        errors = getattr(download_object, "errors", [])
        files = [f for f in out_dir.rglob("*") if f.is_file() and f.suffix.lower() in {".flac", ".mp3"}]
        if not files:
            detail = errors[0]["message"] if errors else "Aucun fichier récupéré depuis Deezer"
            raise RuntimeError(detail)

        title = getattr(download_object, "title", "") or "Deemix"
        artist = getattr(download_object, "artist", "") or ""
        base_name = _clean(f"{artist} - {title}".strip(" -")) or "deemix"
        state["status"] = "done"
        state["progress"] = 100
        state["current"] = total
        if total > 1:
            # /api/file/<id> zippe le dossier entier quand is_playlist est vrai.
            state["filepath"] = str(out_dir)
            state["filename"] = base_name
        else:
            # Un seul fichier : il faut pointer dessus (pas sur le dossier) et
            # garder son extension, sinon send_file() échoue avec un IsADirectoryError.
            state["filepath"] = str(files[0])
            state["filename"] = f"{base_name}{files[0].suffix}"
    except Exception as e:
        state["status"] = "error"
        state["error"] = str(e)


if __name__ == "__main__":
    print("\n  Eclypse Downloader → http://localhost:8080\n")
    app.run(host="0.0.0.0", port=8080, debug=False, threaded=True)
