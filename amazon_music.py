"""Client Amazon Music « compte personnel » pour la source « Amazon (mon compte) ».

Télécharge depuis TON compte Amazon Music Unlimited (cookies du web player),
y compris les flux spatiaux Dolby Atmos (E-AC-3 JOC / AC-4), sans passer par
une API tierce type zarz.moe : tout se joue entre ce serveur et Amazon.

Protocole (reverse-engineering du web player music.amazon.com, vérifié le
2026-09-25) :

1. Session : GET music.amazon.com/config.json?skipToken=false&clientApplication=skyfire
   avec les cookies du compte → accessToken (Bearer « panda »), customerId,
   deviceType du web player, sessionId, CSRF, marketplace/territoire.
   (Repli : GET /pandaToken?deviceType=… si config ne renvoie pas de token.)
2. Catalogue : POST {na|eu}.mesk.skill.music.a2z.com/api/showSearch
   (mêmes en-têtes x-amzn-* que le player) → rangées de pistes avec ASIN.
3. Manifestes : POST music.amazon.com/{NA|EU}/api/dmls/getDashManifestsV2
   → URL de manifestes DASH (CloudFront .mpd) : AdaptationSets SD/HD/3D,
   Representations opus/flac/ec-3/ac-4, protection Widevine CENC (pssh).
4. Audio : segments CMAF par plages d'octets (Range) sur CloudFront,
   URL signées valables ~1 h. Le flux est chiffré Widevine (CENC AES-CTR).
5. Clé : POST …/api/dmls/getLicenseForPlaybackV2 avec le challenge d'un CDM
   local (pywidevine + fichier .wvd fourni par l'utilisateur) → licence →
   clé de contenu (mise en cache par KID dans data/amazon_keys.json).
6. Décryptage/remux : ffmpeg -decryption_key (le même chemin que les
   extracteurs existants), FLAC → .flac, EC-3/AC-4 → .m4a tel quel.
"""

from __future__ import annotations

import json
import random
import re
import subprocess
import time
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path
from typing import Callable, Iterable
from urllib.parse import urljoin

# curl_cffi reproduit l'empreinte TLS d'un vrai Chrome : Amazon sert une
# session anonyme aux clients Python « nus » (requests/urllib3) même avec un
# cookie valide. Repli standard si curl_cffi manque.
try:
    from curl_cffi import requests as _http
    _SESSION_KWARGS = {"impersonate": "chrome"}
except ImportError:  # pragma: no cover
    import requests as _http
    _SESSION_KWARGS = {}

import requests  # exceptions communes (RequestException existe dans les deux)

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36")
MUSIC_BASE = "https://music.amazon.com"
CLIENT_APPLICATION = "skyfire"

# Host local du web player par territoire : un compte FR est mieux servi
# (config + token + dmls) par music.amazon.fr que par le .com US.
_TERRITORY_HOST = {
    "US": "https://music.amazon.com", "CA": "https://music.amazon.com",
    "MX": "https://music.amazon.com.mx", "BR": "https://music.amazon.com.br",
    "GB": "https://music.amazon.co.uk", "DE": "https://music.amazon.de",
    "FR": "https://music.amazon.fr", "IT": "https://music.amazon.it",
    "ES": "https://music.amazon.es", "IN": "https://music.amazon.in",
    "JP": "https://music.amazon.co.jp", "AU": "https://music.amazon.com.au",
}

# Territoire (musicTerritory) → segment d'URL (/{segment}/api/…) et préfixe
# du host du catalogue. Repli « NA » comme dans le player.
_TERRITORY_SEGMENT = {
    "US": "NA", "CA": "NA", "MX": "LA", "BR": "LA", "AR": "LA", "CL": "LA", "CO": "LA",
    "GB": "EU", "IE": "EU", "DE": "EU", "FR": "EU", "IT": "EU", "ES": "EU", "NL": "EU",
    "BE": "EU", "PT": "EU", "AT": "EU", "CH": "EU", "PL": "EU", "SE": "EU", "DK": "EU",
    "NO": "EU", "FI": "EU", "JP": "JP", "AU": "NA", "IN": "NA", "ZA": "EU",
}
_SEGMENT_SKILL_PREFIX = {"NA": "na", "EU": "eu", "JP": "jp", "LA": "na"}

_ASIN_RE = re.compile(r"^B[0-9A-Z]{9}$")


class AmazonMusicError(Exception):
    """Erreur générique, message affichable tel quel à l'utilisateur."""


class AmazonAuthError(AmazonMusicError):
    """Cookies absents, invalides ou expirés."""


class AmazonCancelled(Exception):
    """Annulation demandée par l'utilisateur pendant le téléchargement."""


# ───────────────────────────────── Utilitaires ─────────────────────────────────

def _walk(obj):
    """Itère récursivement sur tous les conteneurs JSON (dict/list)."""
    if isinstance(obj, dict):
        yield obj
        for value in obj.values():
            yield from _walk(value)
    elif isinstance(obj, list):
        for value in obj:
            yield from _walk(value)


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _attrs(element: ET.Element) -> dict:
    return {_local(k): v for k, v in element.attrib.items()}


def parse_duration_mmss(text: str) -> int:
    m = re.match(r"^\s*(\d+):(\d{2})\s*$", str(text or ""))
    return int(m.group(1)) * 60 + int(m.group(2)) if m else 0


def normalize_asin(candidate: str) -> str:
    s = str(candidate or "").strip().upper()
    return s if _ASIN_RE.match(s) else ""


def extract_asin_from_url(url: str) -> tuple[str, str]:
    """(asin_piste, asin_album) depuis un deeplink Amazon Music.

    /tracks/<asin> → piste ; /albums/<asin>?trackAsin=<asin> → piste d'un
    album ; /albums/<asin> → album seul (album_id rempli, piste vide).
    """
    from urllib.parse import urlparse, parse_qs
    try:
        parsed = urlparse(str(url or ""), MUSIC_BASE)
    except ValueError:
        return "", ""
    segments = [s for s in parsed.path.split("/") if s]
    track_asin = normalize_asin((parse_qs(parsed.query).get("trackAsin") or [""])[0])
    if not segments:
        return "", ""
    kind = segments[0].lower()
    direct = normalize_asin(segments[1]) if len(segments) > 1 else ""
    if kind == "albums":
        if track_asin:
            return track_asin, direct
        return "", direct
    if kind in ("tracks", "track") and direct:
        return direct, ""
    # Dernier recours : premier ASIN du chemin.
    for segment in segments:
        asin = normalize_asin(segment)
        if asin:
            return asin, ""
    return "", ""


def _clean_cover_url(url: str) -> str:
    """Retire le sélecteur de taille (_SL300_…) pour obtenir le master."""
    return re.sub(r"\._[^.]+_\.", ".", str(url or ""))


# ─────────────────────────────── Représentations ───────────────────────────────

@dataclass
class Representation:
    codec: str                 # "flac" | "opus" | "ec-3" | "ac-4" | autre
    codecs_raw: str = ""       # attribut codecs du MPD, ex. "ac-4.02.02.00"
    bandwidth: int = 0         # bits/s
    sample_rate: int = 0
    track_type: str = ""       # SD | HD | UHD | 3D… (info uniquement)
    spatial: bool = False
    pssh: str = ""             # boîte Widevine pssh en base64
    kid: str = ""              # KID hex (sans tirets)
    base_url: str = ""
    init_url: str = ""
    init_range: str = ""
    segments: list = field(default_factory=list)   # [(url, "start-end")]
    segment_headers: dict = field(default_factory=dict)

    @property
    def is_atmos(self) -> bool:
        return self.codec in ("ec-3", "ac-4")

    @property
    def container_ext(self) -> str:
        return ".flac" if self.codec == "flac" else ".m4a"

    def label(self) -> str:
        if self.is_atmos:
            return f"Dolby Atmos {self.codec.upper()} {self.bandwidth // 1000} kb/s"
        if self.codec == "flac":
            depth = "24 bits" if self.sample_rate > 48000 else "16 bits"
            return f"FLAC {depth}/{self.sample_rate // 1000} kHz"
        return f"{self.codec.upper()} {self.bandwidth // 1000} kb/s"

    def total_bytes(self) -> int:
        total = 0
        for _, rng in ([("init", self.init_range)] if self.init_range else []) + self.segments:
            try:
                start, end = rng.split("-")
                total += int(end) - int(start) + 1
            except ValueError:
                pass
        return total


def parse_mpd(xml_text: str, mpd_url: str) -> list[Representation]:
    """Extrait les Representations audio d'un manifeste DASH Amazon.

    Amazon vends du SegmentList avec plages d'octets (cf. doc playback Amazon) ;
    un SegmentTemplate (URLs à numéro calculer) n'est pas attendu ici et
    produit une erreur explicite plutôt qu'un fichier corrompu.
    """
    root = ET.fromstring(xml_text)
    reps: list[Representation] = []
    default_base = ""
    for element in root.iter():
        if _local(element.tag) == "BaseURL" and (element.text or "").strip():
            default_base = element.text.strip()
            break

    for adaptation in root.iter():
        if _local(adaptation.tag) != "AdaptationSet":
            continue
        a_attrs = _attrs(adaptation)
        track_type = str(a_attrs.get("trackType") or a_attrs.get("audioTrackType") or "")
        for rep_el in adaptation:
            if _local(rep_el.tag) != "Representation":
                continue
            r_attrs = _attrs(rep_el)
            rep = Representation(
                codec="",
                codecs_raw=str(r_attrs.get("codecs") or ""),
                bandwidth=int(r_attrs.get("bandwidth") or 0),
                sample_rate=int(r_attrs.get("audioSamplingRate") or 0),
                track_type=track_type,
            )
            base = default_base
            for child in rep_el:
                tag = _local(child.tag)
                if tag == "BaseURL" and (child.text or "").strip():
                    base = child.text.strip()
                elif tag == "ContentProtection":
                    cp = _attrs(child)
                    scheme = str(cp.get("schemeIdUri") or "").lower()
                    kid = str(cp.get("default_KID") or cp.get("cenc:default_KID") or "")
                    if kid:
                        rep.kid = kid.replace("-", "").lower()
                    if "edef8ba9" in scheme:  # Widevine
                        pssh = (child.text or "").strip() or str(cp.get("cenc:pssh") or "")
                        if pssh:
                            rep.pssh = pssh
                    # pssh parfois porté par un enfant <cenc:pssh>
                    for sub in child:
                        if _local(sub.tag) == "pssh" and (sub.text or "").strip():
                            rep.pssh = sub.text.strip()
                elif tag == "SegmentList":
                    for seg_el in child:
                        seg_tag = _local(seg_el.tag)
                        if seg_tag == "Initialization":
                            rep.init_url = urljoin(base, str(_attrs(seg_el).get("sourceURL") or ""))
                            rep.init_range = str(_attrs(seg_el).get("range") or "")
                        elif seg_tag == "SegmentURL":
                            media = urljoin(base, str(_attrs(seg_el).get("media") or ""))
                            rep.segments.append((media, str(_attrs(seg_el).get("mediaRange") or "")))
                elif tag == "SegmentBase":
                    # Init par plage sur le BaseURL (sans sidx exploitable ici) :
                    # on garde l'init et on téléchargera le fichier entier.
                    rep.init_url = base
                    rep.init_range = ""
                    for sub in child:
                        if _local(sub.tag) == "Initialization":
                            rep.init_range = str(_attrs(sub).get("range") or "")
                elif tag == "SegmentTemplate":
                    raise AmazonMusicError(
                        "Manifeste Amazon inattendu (SegmentTemplate) — "
                        "format non géré, essaie une autre qualité."
                    )

            codecs = rep.codecs_raw.lower()
            if codecs.startswith("ec-3"):
                rep.codec = "ec-3"
            elif codecs.startswith("ac-4"):
                rep.codec = "ac-4"
            elif "flac" in codecs:
                rep.codec = "flac"
            elif "opus" in codecs:
                rep.codec = "opus"
            else:
                rep.codec = codecs or "unknown"
            rep.spatial = rep.codec in ("ec-3", "ac-4") or "3d" in track_type.lower()
            if rep.segments or rep.init_range:
                reps.append(rep)
    return reps


def pick_representation(reps: list[Representation], quality: str) -> Representation:
    """Choisit la représentation pour une qualité demandée par l'UI.

    Échoue explicitement pour l'Atmos si le compte/le titre ne le propose pas :
    rendre silencieusement du stéréo FLAC à la place, c'est le bug « ça marche
    mais c'est pas de l'Atmos » que la page corrige déjà côté extensions.
    """
    if not reps:
        raise AmazonMusicError("Amazon n'a renvoyé aucun flux audio pour ce titre.")
    flac = sorted([r for r in reps if r.codec == "flac"], key=lambda r: (r.sample_rate, r.bandwidth))
    opus = sorted([r for r in reps if r.codec == "opus"], key=lambda r: r.bandwidth)

    if quality == "DOLBY_ATMOS":
        # EC-3 JOC d'abord (compatibilité Sonos, comme les extracteurs
        # existants), AC-4 (objet pur, plus riche) en repli.
        spatial = [r for r in reps if r.codec == "ec-3"] or [r for r in reps if r.codec == "ac-4"]
        if not spatial:
            raise AmazonMusicError(
                "Ce titre n'est pas disponible en Dolby Atmos sur ton compte "
                "(ou le catalogue n'en propose pas) — essaie Lossless/Hi-Res."
            )
        return max(spatial, key=lambda r: r.bandwidth)
    if quality == "HI_RES_LOSSLESS":
        hires = [r for r in flac if r.sample_rate > 48000]
        if hires:
            return hires[-1]
        if flac:
            return flac[-1]  # repli CD, l'app signalera le downgrade
        raise AmazonMusicError("Aucun FLAC disponible pour ce titre.")
    if quality == "HI_RES":
        return (flac[-1] if flac else (opus[-1] if opus else reps[0]))
    if quality == "LOSSLESS":
        if flac:
            return flac[-1]
        raise AmazonMusicError("Aucun FLAC disponible pour ce titre.")
    # HIGH / LOW : Opus par défaut, FLAC si c'est ce qu'Amazon propose.
    if quality == "LOW":
        return (opus[0] if opus else flac[0])
    return (opus[-1] if opus else (flac[-1] if flac else reps[0]))


# ─────────────────────────────────── Client ───────────────────────────────────

class AmazonMusicClient:
    """Session authentifiée auprès du web player Amazon Music.

    Toutes les requêtes portent le Cookie fourni (copié depuis un navigateur
    connecté) : c'est lui qui fait office de connexion au compte.
    """

    def __init__(self, cookie_header: str, keys_path: Path | None = None,
                 wvd_dir: Path | None = None, log: Callable[[str], None] | None = None,
                 proxy: str | None = None):
        self.cookie = re.sub(r"\s*;\s*", "; ", str(cookie_header or "").strip()).strip("; ")
        if "=" not in self.cookie:
            raise AmazonAuthError(
                "Cookie Amazon invalide : colle la valeur complète de l'en-tête "
                "« Cookie » du navigateur sur music.amazon.com."
            )
        self.keys_path = Path(keys_path) if keys_path else None
        self.wvd_dir = Path(wvd_dir) if wvd_dir else None
        self._log = log or (lambda msg: None)
        # Proxy optionnel réservé au trafic Amazon : utile quand Amazon
        # n'attache la session que depuis certaines IPs (ex. exit VPN).
        # Préférer socks5h:// (DNS résolu côté proxy) ou http(s)://.
        self.proxy = (proxy or "").strip() or None
        self._session = _http.Session(**_SESSION_KWARGS)
        if self.proxy:
            self._session.proxies = {"http": self.proxy, "https": self.proxy}
        self._session.headers.update({"User-Agent": UA})
        self._base = MUSIC_BASE
        self._cfg: dict = {}
        self._cfg_at = 0.0

    # ── Session / auth ──────────────────────────────────────────────────────

    @property
    def territory(self) -> str:
        return self._cfg.get("musicTerritory") or "US"

    @property
    def music_base(self) -> str:
        return self._base

    @property
    def segment(self) -> str:
        return _TERRITORY_SEGMENT.get(self.territory, "NA")

    def config(self, force: bool = False) -> dict:
        if self._cfg and not force and time.time() - self._cfg_at < 600:
            return self._cfg
        cfg = self._fetch_config(MUSIC_BASE)
        # Un compte FR/DE/… est servi par le host local de son marché :
        # le .com peut rester « anonyme » là où le .fr reconnaît la session.
        local_host = _TERRITORY_HOST.get(cfg.get("musicTerritory") or "", MUSIC_BASE)
        if local_host != MUSIC_BASE and not cfg.get("customerId"):
            local_cfg = self._fetch_config(local_host)
            if local_cfg.get("customerId") or local_cfg.get("accessToken"):
                cfg, self._base = local_cfg, local_host
        if not cfg.get("accessToken"):
            cfg["accessToken"] = self._fetch_panda_token(cfg)
        if not cfg.get("accessToken"):
            cfg["accessToken"] = self._fetch_page_token()
        if not cfg.get("accessToken"):
            raise AmazonAuthError(
                "Cookies Amazon expirés ou invalides (aucun accessToken obtenu). "
                "Reconnecte-toi sur music.amazon.fr (ou .com) et recolle un "
                "Cookie frais, en étant bien connecté."
            )
        self._cfg, self._cfg_at = cfg, time.time()
        return cfg

    def _fetch_config(self, base: str) -> dict:
        try:
            resp = self._session.get(
                f"{base}/config.json",
                params={"skipToken": "false", "clientApplication": CLIENT_APPLICATION},
                headers={"Cookie": self.cookie, "Accept": "application/json",
                         "Referer": f"{base}/"},
                timeout=20,
            )
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            raise AmazonAuthError(f"Connexion à {base} impossible : {e}") from e

    def _fetch_panda_token(self, cfg: dict) -> str:
        # Repli officieux du player : pandaToken (même origine, mêmes cookies).
        try:
            resp = self._session.get(
                f"{self._base}/pandaToken",
                params={"deviceType": cfg.get("deviceType", "")},
                headers={"Cookie": self.cookie, "Referer": f"{self._base}/"},
                timeout=20,
            )
            return (resp.json() or {}).get("accessToken", "")
        except Exception:
            return ""

    def _fetch_page_token(self) -> str:
        # Dernier repli, celui du vrai player : l'accessToken est injecté dans
        # le HTML (window.amznMusic.appConfig) quand la session est reconnue.
        try:
            resp = self._session.get(
                f"{self._base}/", headers={"Cookie": self.cookie,
                                           "Referer": f"{self._base}/"},
                timeout=25,
            )
            m = re.search(r'accessToken["\']?\s*[:=]\s*["\']([A-Za-z0-9._-]{20,})',
                          resp.text)
            return m.group(1) if m else ""
        except Exception:
            return ""

    def account_info(self) -> dict:
        cfg = self.config(force=True)
        return {
            "customer_id": cfg.get("customerId", ""),
            "territory": cfg.get("musicTerritory", ""),
            "marketplace": cfg.get("marketplaceId", ""),
            "device_type": cfg.get("deviceType", ""),
            "benefits": cfg.get("benefits") or [],
        }

    # ── En-têtes communs ────────────────────────────────────────────────────

    def _csrf_headers(self) -> dict:
        cfg = self._cfg
        csrf_obj = cfg.get("csrf") if isinstance(cfg.get("csrf"), dict) else {}
        token = str(csrf_obj.get("token") or "")
        ts = str(csrf_obj.get("ts") or int(time.time()))
        rnd = str(csrf_obj.get("rnd") or random.randrange(2 ** 31))
        csrf = json.dumps({
            "interface": "CSRFInterface.v1_0.CSRFHeaderElement",
            "token": token, "timestamp": ts, "rndNonce": rnd,
        })
        return {
            "Authorization": f"Bearer {cfg.get('accessToken', '')}",
            "Cookie": self.cookie,
            "csrf-token": token,
            "csrf-ts": ts,
            "csrf-rnd": rnd,
            "x-amzn-csrf": csrf,
        }

    def _skill_headers(self, page_url: str) -> dict:
        """En-têtes x-amzn-* du player, sérialisés dans le corps showSearch."""
        cfg = self._cfg
        auth = json.dumps({
            "interface": "ClientAuthenticationInterface.v1_0.ClientTokenElement",
            "accessToken": cfg.get("accessToken", ""),
        })
        csrf = json.dumps({
            "interface": "CSRFInterface.v1_0.CSRFHeaderElement",
            "token": cfg.get("csrf", {}).get("token", "") if isinstance(cfg.get("csrf"), dict) else "",
            "timestamp": str(int(time.time())),
            "rndNonce": str(random.randrange(2 ** 31)),
        })
        return json.dumps({
            "x-amzn-authentication": auth,
            "x-amzn-device-model": "Chrome",
            "x-amzn-device-width": "1920",
            "x-amzn-device-family": "WEB_WEBPLAYER_OREGON",
            "x-amzn-device-id": cfg.get("deviceId", ""),
            "x-amzn-user-agent": UA,
            "x-amzn-session-id": cfg.get("sessionId", ""),
            "x-amzn-device-height": "1080",
            "x-amzn-request-id": f"{random.randrange(16 ** 8):08x}-{int(time.time() * 1000)}",
            "x-amzn-device-language": cfg.get("displayLanguage", "en_US"),
            "x-amzn-currency-of-preference": "USD",
            "x-amzn-os-version": "1.0",
            "x-amzn-application-version": cfg.get("version", ""),
            "x-amzn-device-time-zone": "UTC",
            "x-amzn-timestamp": str(int(time.time() * 1000)),
            "x-amzn-csrf": csrf,
            "x-amzn-music-domain": self._base.split("//", 1)[-1],
            "x-amzn-referer": "",
            "x-amzn-affiliate-tags": "",
            "x-amzn-ref-marker": "",
            "x-amzn-page-url": page_url,
            "x-amzn-weblab-id-overrides": "",
            "x-amzn-video-player-token": "",
            "x-amzn-feature-flags": "",
            "x-amzn-has-profile-id": "",
            "x-amzn-age-band": "",
        })

    # ── Catalogue (recherche de l'ASIN) ─────────────────────────────────────

    def search_tracks(self, query: str, limit: int = 20) -> list[dict]:
        self.config()
        prefix = _SEGMENT_SKILL_PREFIX.get(self.segment, "na")
        base = self.music_base
        page_url = f"{base}/search/{query}"
        body = {
            "filter": json.dumps({"IsLibrary": ["false"]}),
            "keyword": json.dumps({
                "interface": "Web.TemplatesInterface.v1_0.Touch.SearchTemplateInterface.SearchKeywordClientInformation",
                "keyword": query,
            }),
            "suggestedKeyword": query,
            "userHash": json.dumps({"level": "LIBRARY_MEMBER"}),
            "headers": self._skill_headers(page_url),
        }
        last_error = ""
        for host in (f"https://{prefix}.mesk.skill.music.a2z.com",
                     f"https://{prefix}.web.skill.music.a2z.com"):
            try:
                resp = self._session.post(
                    f"{host}/api/showSearch", data=json.dumps(body),
                    headers={"Content-Type": "text/plain;charset=UTF-8",
                             "Origin": base, "Referer": f"{base}/"},
                    timeout=25,
                )
                if resp.status_code == 401:
                    self.config(force=True)
                    continue
                if resp.status_code != 200:
                    last_error = f"{host} → HTTP {resp.status_code}"
                    continue
                return _parse_search_rows(resp.json(), limit)
            except Exception as e:
                last_error = f"{host} → {e}"
        raise AmazonMusicError(f"Recherche Amazon impossible ({last_error}).")

    def match_track(self, title: str, artist: str, duration_seconds: int | None) -> dict | None:
        """Cherche la meilleure piste Amazon (durée puis titre/artiste)."""
        for query in filter(None, [f"{artist} {title}".strip(), title]):
            try:
                candidates = self.search_tracks(query)
            except AmazonMusicError:
                continue
            best, best_score = None, -1.0
            for cand in candidates:
                title_ratio = SequenceMatcher(
                    None, title.lower(), str(cand.get("title", "")).lower()).ratio()
                artist_ratio = SequenceMatcher(
                    None, artist.lower(), str(cand.get("artist", "")).lower()).ratio()
                duration = cand.get("duration_seconds") or 0
                duration_score = 0.0
                if duration_seconds and duration:
                    diff = abs(duration - duration_seconds)
                    duration_score = max(0.0, 1.0 - diff / 10.0) if diff <= 10 else -1.0
                score = title_ratio * 0.55 + artist_ratio * 0.25 + duration_score * 0.20
                if duration_score < 0:  # durée incompatible (>10 s d'écart)
                    continue
                if score > best_score:
                    best, best_score = cand, score
            if best and best_score >= 0.45:
                return best
        return None

    # ── Manifestes DASH ─────────────────────────────────────────────────────

    def _dmls(self, method: str, body: dict) -> dict:
        self.config()
        cfg = self._cfg
        url = f"{self.music_base}/{self.segment}/api/dmls/{method}"
        payload = {
            "deviceToken": {
                "deviceTypeId": cfg.get("deviceType", ""),
                "deviceId": cfg.get("deviceId", ""),
            },
            "appMetadata": {"https": "true"},
            "clientMetadata": {
                "clientId": cfg.get("deviceType", "Eclypse"),
                "clientRequestId": uuid.uuid4().hex,
            },
            **body,
        }
        if cfg.get("customerId"):
            payload["customerId"] = cfg["customerId"]

        def _post() -> requests.Response:
            headers = {
                "Content-Type": "application/json",
                "Content-Encoding": "amz-1.0",
                "X-Amz-Target": f"com.amazon.digitalmusiclocator.DigitalMusicLocatorServiceExternal.{method}",
                **self._csrf_headers(),
            }
            return self._session.post(url, data=json.dumps(payload), headers=headers, timeout=30)

        resp = _post()
        if resp.status_code in (401, 403):
            # Le Bearer panda expire au bout d'~1 h : on rafraîchit la
            # session et on retente une fois au lieu d'échouer la piste.
            self.config(force=True)
            resp = _post()
        if resp.status_code != 200:
            snippet = resp.text[:200].replace("\n", " ")
            raise AmazonMusicError(
                f"Amazon a refusé {method} (HTTP {resp.status_code}) : {snippet}"
            )
        try:
            return resp.json()
        except ValueError as e:
            raise AmazonMusicError(f"Réponse illisible d'Amazon ({method}).") from e

    def representations(self, asin: str) -> list[Representation]:
        data = self._dmls("getDashManifestsV2", {
            "contentIdList": [{"identifier": asin, "identifierType": "ASIN"}],
            "bitrateTypeList": ["LOW", "MEDIUM", "HIGH"],
            "musicDashVersionList": ["V1", "V2"],
            "appInfo": {"musicAgent": UA},
        })
        manifest_urls: list[tuple[str, dict]] = []
        for node in _walk(data):
            for key, value in node.items():
                if isinstance(value, str) and "http" in value and ".mpd" in value.lower():
                    headers = {}
                    for hkey, hval in node.items():
                        if isinstance(hval, dict):
                            headers.update({str(k): str(v) for k, v in hval.items()})
                    manifest_urls.append((value, headers))
        if not manifest_urls:
            raise AmazonMusicError(
                "Amazon n'a pas renvoyé de manifeste pour ce titre "
                "(titre indisponible sur ton compte ou dans ton pays)."
            )
        reps: list[Representation] = []
        errors = []
        for mpd_url, seg_headers in manifest_urls[:4]:
            try:
                resp = self._session.get(mpd_url, headers={"User-Agent": UA, **seg_headers}, timeout=30)
                if resp.status_code != 200:
                    errors.append(f"HTTP {resp.status_code}")
                    continue
                for rep in parse_mpd(resp.text, mpd_url):
                    rep.segment_headers = seg_headers
                    reps.append(rep)
            except AmazonMusicError as e:
                errors.append(str(e))
        if not reps:
            detail = f" ({'; '.join(errors)})" if errors else ""
            raise AmazonMusicError(f"Manifestes Amazon illisibles{detail}.")
        return reps

    # ── Widevine ────────────────────────────────────────────────────────────

    def _key_cache(self) -> dict:
        if not self.keys_path or not self.keys_path.exists():
            return {}
        try:
            return json.loads(self.keys_path.read_text())
        except Exception:
            return {}

    def _save_key_cache(self, cache: dict) -> None:
        if self.keys_path:
            try:
                self.keys_path.write_text(json.dumps(cache, indent=1))
            except Exception:
                pass

    def _wvd_files(self) -> list[Path]:
        if not self.wvd_dir or not self.wvd_dir.exists():
            return []
        return sorted(self.wvd_dir.glob("*.wvd"))

    def widevine_ready(self) -> bool:
        try:
            import pywidevine  # noqa: F401
        except ImportError:
            return False
        return bool(self._wvd_files())

    def content_key(self, rep: Representation) -> str:
        """Clé CENC (hex) pour une représentation, via CDM local + cache."""
        if not rep.pssh and not rep.kid:
            raise AmazonMusicError(
                "Flux Amazon non chiffré inattendu (aucune protection Widevine trouvée)."
            )
        cache = self._key_cache()
        if rep.kid and cache.get(rep.kid):
            return cache[rep.kid]
        if not self.widevine_ready():
            raise AmazonMusicError(
                "Décryptage Widevine indisponible : installe pywidevine "
                "(requirements.txt) et place un fichier .wvd dans data/widevine/. "
                "Sans lui, Amazon ne livre que 30 s non chiffrées."
            )
        try:
            from pywidevine.cdm import Cdm
            from pywidevine.device import Device
            from pywidevine.pssh import PSSH
        except ImportError as e:
            raise AmazonMusicError("pywidevine n'est pas installé (pip install pywidevine).") from e

        last_error = ""
        for wvd in self._wvd_files():
            try:
                device = Device.load(wvd)
                cdm = Cdm.from_device(device)
                session_id = cdm.open()
                try:
                    challenge = cdm.get_license_challenge(session_id, PSSH(rep.pssh))
                    license_b64 = self._get_license(challenge)
                    cdm.parse_license(session_id, license_b64)
                    content_keys = [k for k in cdm.get_keys(session_id)
                                    if getattr(k, "type", "") == "CONTENT" or str(k.type) == "CONTENT"]
                    if not content_keys:
                        raise AmazonMusicError("Licence Amazon sans clé de contenu.")
                    wanted_kid = rep.kid
                    chosen = None
                    for key in content_keys:
                        kid_hex = key.kid.hex()
                        cache.setdefault(kid_hex, key.key.hex())
                        if wanted_kid and kid_hex == wanted_kid:
                            chosen = key
                    chosen = chosen or content_keys[0]
                    self._save_key_cache(cache)
                    return chosen.key.hex()
                finally:
                    cdm.close(session_id)
            except AmazonMusicError:
                raise
            except Exception as e:
                last_error = f"{wvd.name}: {e}"
                continue
        raise AmazonMusicError(f"Le CDM Widevine n'a pas pu obtenir de clé ({last_error}).")

    def _get_license(self, challenge: bytes) -> str:
        import base64
        data = self._dmls("getLicenseForPlaybackV2", {
            "DrmType": "WIDEVINE",
            "licenseChallenge": base64.b64encode(challenge).decode(),
        })
        for node in _walk(data):
            for key, value in node.items():
                if key.lower() == "license" and isinstance(value, str) and value:
                    return value
        raise AmazonMusicError("Amazon n'a pas renvoyé de licence Widevine.")

    # ── Téléchargement ──────────────────────────────────────────────────────

    def download_representation(
        self,
        rep: Representation,
        out_raw: Path,
        on_progress: Callable[[int, int], None] | None = None,
        cancel_check: Callable[[], bool] | None = None,
    ) -> Path:
        """Télécharge init + segments CMAF par plages d'octets."""
        headers = {"User-Agent": UA, **(rep.segment_headers or {})}
        pieces = ([("init", rep.init_url, rep.init_range)] if rep.init_url else [])
        pieces += [(f"seg{i}", url, rng) for i, (url, rng) in enumerate(rep.segments)]
        if not pieces:
            raise AmazonMusicError("Flux Amazon sans segments téléchargeables.")
        total = rep.total_bytes() or sum(
            int(r.split("-")[1]) - int(r.split("-")[0]) + 1
            for _, _, r in pieces if "-" in r
        )
        done = 0
        with open(out_raw, "wb") as out:
            for _, url, rng in pieces:
                if cancel_check and cancel_check():
                    raise AmazonCancelled()
                req_headers = dict(headers)
                if rng and "-" in rng:
                    req_headers["Range"] = f"bytes={rng}"
                last_error = None
                for attempt in range(3):
                    try:
                        resp = self._session.get(url, headers=req_headers, stream=True, timeout=90)
                        if resp.status_code not in (200, 206):
                            raise AmazonMusicError(f"Segment Amazon HTTP {resp.status_code}")
                        for chunk in resp.iter_content(chunk_size=256 * 1024):
                            out.write(chunk)
                            done += len(chunk)
                        last_error = None
                        break
                    except AmazonMusicError as e:
                        last_error = str(e)
                        time.sleep(1.0 + attempt)
                    except requests.RequestException as e:
                        last_error = str(e)
                        time.sleep(1.0 + attempt)
                if last_error:
                    raise AmazonMusicError(f"Échec du téléchargement d'un segment : {last_error}")
                if on_progress:
                    on_progress(min(done, total), total)
        return out_raw

    @staticmethod
    def decrypt_and_mux(
        raw_path: Path, rep: Representation, out_path: Path,
        key_hex: str, transcode_to: str | None = None, bitrate: str = "320k",
    ) -> Path:
        """Décrypte (CENC) puis remux/encode via ffmpeg.

        FLAC reste FLAC (.flac, copie bit à bit). EC-3/AC-4 restent du MP4
        (.m4a) tel quel — c'est de l'audio objet, le convertir détruirait
        l'Atmos. Opus peut être converti vers le format choisi.
        """
        ext = out_path.suffix.lower() or rep.container_ext
        cmd = ["ffmpeg", "-y", "-v", "error"]
        if key_hex:
            cmd += ["-decryption_key", key_hex]
        cmd += ["-i", str(raw_path), "-map", "0:a:0"]
        copy_stream = (ext == ".m4a") or (rep.codec == "flac" and ext == ".flac")
        if copy_stream:
            cmd += ["-c:a", "copy"]
            if rep.is_atmos:
                cmd += ["-metadata:s:a:0", "atmos=true"]
        elif ext == ".mp3":
            cmd += ["-c:a", "libmp3lame", "-b:a", bitrate]
        elif ext == ".flac":
            cmd += ["-c:a", "flac"]
        elif ext == ".alac":
            cmd += ["-c:a", "alac"]
        else:
            cmd += ["-c:a", "copy"]
        cmd += [str(out_path)]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if result.returncode != 0 or not out_path.exists() or out_path.stat().st_size == 0:
            raise AmazonMusicError(
                ffmpeg_error(result.stderr, rep)
            )
        return out_path


def ffmpeg_error(stderr: str, rep: Representation) -> str:
    detail = (stderr or "").strip().splitlines()
    detail = detail[-1] if detail else "aucun détail"
    return (
        f"ffmpeg n'a pas pu traiter le flux Amazon {rep.codec} : {detail}. "
        "Vérifie que ffmpeg est à jour (CENC AES-CTR requis)."
    )


# ─────────────────────────────── Parsing recherche ─────────────────────────────

_ROW_INTERFACE = "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.DescriptiveRowItemElement"
_VISUAL_INTERFACE = "Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.VisualRowItemElement"


def _text_value(value) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return str(value.get("text") or value.get("defaultValue") or "")
    return str(value)


def _parse_search_rows(data, limit: int) -> list[dict]:
    tracks: list[dict] = []
    seen: set[str] = set()

    def row_to_track(row: dict) -> dict | None:
        title = _text_value(row.get("primaryText"))
        deeplink = ((row.get("primaryTextLink") or {}).get("deeplink")
                    or (row.get("primaryLink") or {}).get("deeplink") or "")
        track_id, album_id = extract_asin_from_url(deeplink)
        if not track_id or not title:
            return None
        duration = parse_duration_mmss(_text_value(row.get("secondaryText3")))
        cover = _clean_cover_url(str(row.get("image") or ""))
        return {
            "asin": track_id,
            "album_asin": album_id,
            "title": re.sub(r"\s*\[explicit\]\s*$", "", title, flags=re.I),
            "artist": (_text_value(row.get("secondaryText1"))
                       or _text_value(row.get("secondaryText2"))
                       or _text_value(row.get("secondaryText"))),
            "duration_seconds": duration,
            "cover": cover,
        }

    for row in _iter_interface(data, _ROW_INTERFACE) + _iter_interface(data, _VISUAL_INTERFACE):
        track = row_to_track(row)
        if track and track["asin"] not in seen:
            seen.add(track["asin"])
            tracks.append(track)
        if len(tracks) >= limit:
            break
    return tracks


def _iter_interface(data, interface: str) -> list[dict]:
    found: list[dict] = []

    def walk(node):
        if isinstance(node, dict):
            if node.get("interface") == interface:
                found.append(node)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(data)
    return found
