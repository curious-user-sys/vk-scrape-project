# app/scraper/vk_client.py
from datetime import datetime, timezone
import html as html_lib
import re
import threading
import time
from urllib.parse import urlparse

from curl_cffi import requests as cffi_requests

from app.core.config import settings

VK_API_BASE = "https://web.api.vk.ru"
VK_LOGIN_BASE = "https://login.vk.ru"
VK_SITE = "https://vk.com"
VK_APP_ID = 6287487
VK_APP_SECRET = "QbYic1K3lEV5kTGiqlq2"
VK_ANONYMOUS_SCOPES = "audio_anonymous,video_anonymous,photos_anonymous,profile_anonymous"
VK_API_VERSION = "5.289"
POSTS_PER_PAGE = 20

_VK_HOSTS = ("vk.com", "vk.ru", "vkontakte.ru")
_SCREEN_NAME_RE = re.compile(r"^[A-Za-z0-9_.]{2,32}$")
_NUMERIC_ALIAS_RE = re.compile(r"^(club|public|event)(\d{1,12})$", re.I)

_API_HEADERS = {
    "accept": "application/json, text/plain, */*",
    "origin": "https://vk.ru",
    "referer": "https://vk.ru/",
}

_ERR_TOKEN = {5}
_ERR_RATE = {6, 9, 29, 14}
_ERR_TRANSIENT = {1, 10}
_ERR_NOT_FOUND = {15, 18, 30, 113, 125, 203, 204, 220}


_USER_ALIAS_RE = re.compile(r"^id(\d{1,12})$", re.I)

USER_FIELDS = (
    "about,bdate,can_access_closed,career,city,country,deactivated,domain,"
    "followers_count,home_town,is_closed,last_seen,occupation,online,"
    "photo_100,photo_200,screen_name,sex,site,status,universities,verified"
)


class VkScraperError(Exception):
    """Temel VK hata sınıfı."""


class VkAuthError(VkScraperError):
    """Yetkilendirme hatası (süresiz tekrar denenmez)."""


class VkNotFoundError(VkScraperError):
    """Kaynak bulunamadı, gizli veya silinmiş (tekrar denenmez)."""


class VkTransientError(VkScraperError):
    """Geçici ağ / rate-limit / sunucu hatası (sınırlı retry yapılır)."""


def parse_community_ref(raw_input: str) -> dict:
    """Kullanıcı girdisini doğrular; rastgele URL'leri (SSRF) engeller."""
    value = (raw_input or "").strip()
    if not value:
        raise ValueError("Kaynak adresi boş olamaz.")

    if value.startswith("//"):
        value = "https:" + value
    elif re.match(r"^(m\.|www\.)?(vk\.com|vk\.ru)/", value, re.I):
        value = "https://" + value

    if value.startswith(("http://", "https://")):
        parsed = urlparse(value)
        host = (parsed.hostname or "").lower()
        if not any(host == h or host.endswith("." + h) for h in _VK_HOSTS):
            raise ValueError("Yalnızca vk.com veya vk.ru adresleri kabul edilir.")
        segment = parsed.path.strip("/").split("/")[0] if parsed.path.strip("/") else ""
    else:
        segment = value.lstrip("@")

    if not segment:
        raise ValueError("Geçerli bir VK topluluk kimliği veya URL'si girin.")

    if re.fullmatch(r"-?\d{1,12}", segment):
        num = abs(int(segment))
        if num == 0:
            raise ValueError("Geçersiz topluluk ID'si.")
        return {"id": num, "screen_name": None}

    alias = _NUMERIC_ALIAS_RE.match(segment)
    if alias:
        return {"id": int(alias.group(2)), "screen_name": None}

    if not _SCREEN_NAME_RE.match(segment):
        raise ValueError("Geçersiz VK topluluk adı veya bağlantısı.")

    return {"id": None, "screen_name": segment}

def parse_user_ref(raw_input: str) -> dict:
    """Kullanıcı URL'si, id<N>, sayısal ID veya screen_name doğrular."""
    value = (raw_input or "").strip()
    if not value:
        raise ValueError("Kişi adresi boş olamaz.")

    if value.startswith("//"):
        value = "https:" + value
    elif re.match(r"^(m\.|www\.)?(vk\.com|vk\.ru)/", value, re.I):
        value = "https://" + value

    if value.startswith(("http://", "https://")):
        parsed = urlparse(value)
        host = (parsed.hostname or "").lower()
        if not any(host == h or host.endswith("." + h) for h in _VK_HOSTS):
            raise ValueError("Yalnızca vk.com veya vk.ru adresleri kabul edilir.")
        segment = parsed.path.strip("/").split("/")[0] if parsed.path.strip("/") else ""
    else:
        segment = value.lstrip("@")

    if not segment:
        raise ValueError("Geçerli bir VK profil kimliği veya URL'si girin.")

    if re.fullmatch(r"\d{1,12}", segment):
        num = int(segment)
        if num == 0:
            raise ValueError("Geçersiz kullanıcı ID'si.")
        return {"id": num, "screen_name": None}

    alias = _USER_ALIAS_RE.match(segment)
    if alias:
        return {"id": int(alias.group(1)), "screen_name": None}

    if _NUMERIC_ALIAS_RE.match(segment):
        raise ValueError("Girilen adres bir topluluk; lütfen Topluluk panelinden ekleyin.")

    if not _SCREEN_NAME_RE.match(segment):
        raise ValueError("Geçersiz VK kullanıcı adı veya bağlantısı.")

    return {"id": None, "screen_name": segment}

class VkClient:
    def __init__(self, request_delay: float | None = None, max_retries: int | None = None):
        self.request_delay = settings.request_delay_seconds if request_delay is None else request_delay
        self.max_retries = settings.max_retries if max_retries is None else max_retries
        self._session = cffi_requests.Session(impersonate="chrome")
        self._token_lock = threading.Lock()
        self._token: str | None = None
        self._token_expires: float = 0.0

    def _mint_token(self) -> tuple[str, float]:
        
        try:
            resp = self._session.post(
                f"{settings.vk_login_base}/?act=get_anonym_token",
                data={
                    "client_id": settings.vk_app_id,
                    "client_secret": settings.vk_app_secret,
                    "scopes": VK_ANONYMOUS_SCOPES,
                    "version": 1,
                    "app_id": settings.vk_app_id,
                },
                headers=_API_HEADERS,
                timeout=30,
            )
        except Exception as exc:
            raise VkTransientError(f"Token isteği başarısız: {exc}") from exc

        if resp.status_code in (401, 403):
            raise VkAuthError(f"Anonim token reddedildi (HTTP {resp.status_code}).")
        if resp.status_code != 200:
            raise VkTransientError(f"Token sunucusu HTTP {resp.status_code} döndü.")

        payload = resp.json()
        data = payload.get("data") if isinstance(payload, dict) else None
        token = (data or {}).get("access_token")
        if payload.get("type") != "okay" or not token:
            raise VkAuthError("Anonim token üretilemedi.")

        expires = float(data.get("expired_at") or (time.time() + 24 * 3600))
        return token, expires

    def _get_token(self, force: bool = False) -> str:
        with self._token_lock:
            if not force and self._token and time.time() < self._token_expires - 1800:
                return self._token
            self._token, self._token_expires = self._mint_token()
            return self._token

    def _call(self, method: str, params: dict) -> dict | list:
        clean_params = {k: v for k, v in params.items() if v is not None}
        token_refreshed = False

        for attempt in range(1, self.max_retries + 1):
            try:
                token = self._get_token()
                url = f"{settings.vk_api_base}/method/{method}?v={settings.vk_api_version}&client_id={settings.vk_app_id}"
                resp = self._session.post(
                    url,
                    data={**clean_params, "access_token": token},
                    headers=_API_HEADERS,
                    timeout=30,
                )

                if resp.status_code in (403, 429) or resp.status_code >= 500:
                    raise VkTransientError(f"HTTP {resp.status_code} ({method})")
                if resp.status_code != 200:
                    raise VkScraperError(f"Beklenmeyen HTTP {resp.status_code} ({method})")

                payload = resp.json()
                if "error" in payload:
                    err = payload["error"]
                    code = err.get("error_code")
                    msg = err.get("error_msg", "Bilinmeyen VK hatası")

                    if code in _ERR_TOKEN:
                        if not token_refreshed:
                            token_refreshed = True
                            self._get_token(force=True)
                            continue
                        raise VkAuthError(f"VK yetkilendirme hatası ({code}): {msg}")
                    if code in _ERR_NOT_FOUND:
                        raise VkNotFoundError(f"Erişilemeyen/bulunamayan kaynak ({code}): {msg}")
                    if code in _ERR_RATE or code in _ERR_TRANSIENT:
                        raise VkTransientError(f"VK geçici hata ({code}): {msg}")
                    raise VkScraperError(f"VK API hatası ({code}): {msg}")

                if self.request_delay > 0:
                    time.sleep(self.request_delay)
                return payload["response"]

            except (VkAuthError, VkNotFoundError):
                raise
            except (VkTransientError, Exception) as exc:
                if attempt == self.max_retries:
                    raise VkTransientError(f"{method} başarısız ({self.max_retries} deneme): {exc}") from exc
                time.sleep(2 * attempt)

        raise VkTransientError(f"{method} için maksimum deneme aşıldı.")

    def resolve_community(self, raw_input: str) -> dict:
        """Topluluk URL/ID'sini doğrular ve VK meta verilerini döner."""
        ref = parse_community_ref(raw_input)
        group_id = ref["id"]
        if group_id is None:
            resolved = self._call("utils.resolveScreenName", {"screen_name": ref["screen_name"]})
            if not isinstance(resolved, dict) or not resolved.get("object_id"):
                raise VkNotFoundError(f"'{ref['screen_name']}' bulunamadı.")
            if resolved.get("type") == "user":
                raise ValueError("Girilen adres bir topluluk değil, kullanıcı profili.")
            group_id = int(resolved["object_id"])

        data = self._call("groups.getById", {"group_ids": group_id, "fields": "description,members_count,screen_name"})
        groups = data.get("groups") if isinstance(data, dict) else data
        if not groups:
            raise VkNotFoundError(f"Topluluk bulunamadı: {group_id}")

        g = groups[0]
        screen_name = g.get("screen_name")
        return {
            "vk_owner_id": -int(g["id"]),
            "screen_name": screen_name,
            "title": g.get("name") or f"club{g['id']}",
            "url": f"{VK_SITE}/{screen_name}" if screen_name else f"{VK_SITE}/club{g['id']}",
        }

    def resolve_user(self, raw_input: str) -> dict:
        """VK kullanıcı profilini çözümler; açık/kapalı profil meta verilerini döner."""
        ref = parse_user_ref(raw_input)
        user_id = ref["id"]
        if user_id is None:
            resolved = self._call("utils.resolveScreenName", {"screen_name": ref["screen_name"]})
            if not isinstance(resolved, dict) or not resolved.get("object_id"):
                raise VkNotFoundError(f"'{ref['screen_name']}' bulunamadı.")
            if resolved.get("type") != "user":
                raise ValueError("Girilen adres bir kişi değil, topluluk.")
            user_id = int(resolved["object_id"])

        users = self._call("users.get", {"user_ids": user_id, "fields": USER_FIELDS})
        if not isinstance(users, list) or not users:
            raise VkNotFoundError(f"Kullanıcı bulunamadı: {user_id}")

        u = users[0]
        if u.get("deactivated"):
            raise VkNotFoundError(f"Kullanıcı hesabı aktif değil ({u['deactivated']}).")

        uid = int(u["id"])
        screen_name = u.get("screen_name") or u.get("domain")
        full_name = " ".join(p for p in (u.get("first_name"), u.get("last_name")) if p) or f"id{uid}"
        last_seen = u.get("last_seen") if isinstance(u.get("last_seen"), dict) else {}
        last_seen_iso = (
            datetime.fromtimestamp(int(last_seen["time"]), tz=timezone.utc).isoformat()
            if last_seen.get("time")
            else None
        )
        sex_map = {1: "Kadın", 2: "Erkek"}
        universities = [
            " · ".join(
                str(x)
                for x in (uni.get("name"), uni.get("faculty_name"), uni.get("graduation"))
                if x
            )
            for uni in (u.get("universities") or [])
            if isinstance(uni, dict) and uni.get("name")
        ]

        profile_data = {
            "first_name": u.get("first_name"),
            "last_name": u.get("last_name"),
            "photo": u.get("photo_200") or u.get("photo_100"),
            "sex": sex_map.get(u.get("sex")),
            "status": u.get("status") or None,
            "about": u.get("about") or None,
            "bdate": u.get("bdate") or None,
            "city": (u.get("city") or {}).get("title") if isinstance(u.get("city"), dict) else None,
            "country": (u.get("country") or {}).get("title") if isinstance(u.get("country"), dict) else None,
            "home_town": u.get("home_town") or None,
            "followers_count": u.get("followers_count"),
            "site": u.get("site") or None,
            "occupation": (u.get("occupation") or {}).get("name") if isinstance(u.get("occupation"), dict) else None,
            "universities": universities,
            "is_verified": bool(u.get("verified")),
            "is_online": bool(u.get("online")),
            "last_seen": last_seen_iso,
            "can_access_closed": bool(u.get("can_access_closed")),
            "accessible_fields": sorted(k for k, v in u.items() if v not in (None, "", [], {})),
        }

        return {
            "source_type": "user",
            "vk_owner_id": uid,
            "screen_name": screen_name,
            "title": full_name,
            "url": f"{VK_SITE}/{screen_name}" if screen_name else f"{VK_SITE}/id{uid}",
            "is_closed": bool(u.get("is_closed")),
            "profile_data": profile_data,
        }

    def fetch_user_extras(self, user_id: int) -> dict:
        """Açık/kapalı profil için takipçi, fotoğraf ve video erişimini test edip özet veriyi çeker."""
        extras: dict = {}

        # # 1. Takipçiler
        # try:
        #     f_resp = self._call(
        #         "users.getFollowers",
        #         {"user_id": user_id, "offset": 0, "count": 10, "fields": "photo_50,screen_name"},
        #     )
        #     extras["followers"] = {
        #         "accessible": True,
        #         "total": f_resp.get("count", 0),
        #         "sample": [
        #             {
        #                 "id": item.get("id"),
        #                 "name": f"{item.get('first_name', '')} {item.get('last_name', '')}".strip(),
        #                 "url": f"{VK_SITE}/{item.get('screen_name') or 'id' + str(item.get('id'))}",
        #             }
        #             for item in (f_resp.get("items") or [])
        #         ],
        #     }
        # except VkScraperError as exc:
        #     extras["followers"] = {"accessible": False, "total": None, "sample": [], "reason": str(exc)}
        

        # 1. Takipçiler (sayfalı çekim, varsayılan en fazla 500 kayıt)
        try:
            follower_items: list[dict] = []
            followers_total: int | None = None
            batch_size = 200
            max_followers = 500
            offset = 0

            while offset < max_followers:
                take = min(batch_size, max_followers - offset)
                f_resp = self._call(
                    "users.getFollowers",
                    {
                        "user_id": user_id,
                        "offset": offset,
                        "count": take,
                        "fields": "photo_50,screen_name",
                    },
                )
                if followers_total is None and isinstance(f_resp, dict):
                    followers_total = f_resp.get("count")

                batch = (f_resp.get("items") or []) if isinstance(f_resp, dict) else []
                if not batch:
                    break

                for item in batch:
                    if isinstance(item, dict):
                        uid = item.get("id")
                        full_name = f"{item.get('first_name', '')} {item.get('last_name', '')}".strip()
                        follower_items.append(
                            {
                                "id": uid,
                                "name": full_name or f"id{uid}",
                                "photo": item.get("photo_50"),
                                "url": f"{VK_SITE}/{item.get('screen_name') or 'id' + str(uid)}",
                            }
                        )
                    else:
                        follower_items.append(
                            {
                                "id": item,
                                "name": f"id{item}",
                                "photo": None,
                                "url": f"{VK_SITE}/id{item}",
                            }
                        )

                if len(batch) < take:
                    break
                offset += len(batch)

            extras["followers"] = {
                "accessible": True,
                "total": followers_total if followers_total is not None else len(follower_items),
                "fetched": len(follower_items),
                "items": follower_items,
                "sample": follower_items[:10],
            }
        except VkScraperError as exc:
            extras["followers"] = {
                "accessible": False,
                "total": None,
                "fetched": 0,
                "items": [],
                "sample": [],
                "error": str(exc),
            }

        # 2. Fotoğraflar
        try:
            p_resp = self._call(
                "photos.getAll",
                {"owner_id": user_id, "offset": 0, "count": 10, "photo_sizes": 1},
            )
            photos = []
            for item in (p_resp.get("items") or []):
                sizes = item.get("sizes") or []
                best = max(sizes, key=lambda s: (s.get("width", 0), s.get("height", 0))) if sizes else {}
                if best.get("url"):
                    photos.append(
                        {
                            "id": item.get("id"),
                            "url": best["url"],
                            "link": f"{VK_SITE}/photo{user_id}_{item.get('id')}",
                        }
                    )
            extras["photos"] = {"accessible": True, "total": p_resp.get("count", 0), "sample": photos}
        except VkScraperError as exc:
            extras["photos"] = {"accessible": False, "total": None, "sample": [], "reason": str(exc)}

        # 3. Videolar
        try:
            v_resp = self._call("video.get", {"owner_id": user_id, "offset": 0, "count": 10})
            videos = [
                {
                    "id": item.get("id"),
                    "title": item.get("title") or "Video",
                    "views": item.get("views"),
                    "link": f"{VK_SITE}/video{item.get('owner_id')}_{item.get('id')}",
                }
                for item in (v_resp.get("items") or [])
            ]
            extras["videos"] = {"accessible": True, "total": v_resp.get("count", 0), "sample": videos}
        except VkScraperError as exc :
            extras["videos"] = {"accessible": False, "total": None, "sample": [], "reason": str(exc)}

        return extras

    def fetch_wall_posts(self, vk_owner_id: int, limit: int = 100) -> list[dict]:
        """Sayfalı olarak en fazla `limit` güncel gönderi çeker."""
        collected: list[dict] = []
        offset = 0

        while len(collected) < limit:
            count = min(POSTS_PER_PAGE, limit - len(collected))
            resp = self._call("wall.get", {"owner_id": vk_owner_id, "offset": offset, "count": count})
            items = resp.get("items") or []
            if not items:
                break

            for raw in items:
                collected.append(self._parse_post(raw, vk_owner_id))

            offset += len(items)
            total = resp.get("count")
            if len(items) < count or (total is not None and offset >= int(total)):
                break

        return collected

    @staticmethod
    def _parse_post(raw: dict, owner_id: int) -> dict:
        post_id = int(raw["id"])
        raw_text = raw.get("text")
        clean_text = html_lib.unescape(raw_text).strip() if isinstance(raw_text, str) else None
        ts = raw.get("date")
        published_at = datetime.fromtimestamp(int(ts), tz=timezone.utc) if ts else datetime.now(timezone.utc)

        attachments = []
        for att in raw.get("attachments") or []:
            att_type = att.get("type")
            body = att.get(att_type) if isinstance(att, dict) and att_type else None
            if not isinstance(body, dict):
                continue
            item = {"type": att_type}
            if att_type == "photo":
                sizes = body.get("sizes") or []
                if sizes:
                    best = max(sizes, key=lambda s: (s.get("width", 0), s.get("height", 0)))
                    item["url"] = best.get("url")
            elif att_type == "link":
                item["url"] = body.get("url")
                item["title"] = body.get("title")
            elif att_type == "video":
                item["title"] = body.get("title")
                item["url"] = f"{VK_SITE}/video{body.get('owner_id')}_{body.get('id')}"
            elif att_type == "doc":
                item["title"] = body.get("title")
                item["url"] = body.get("url")
            attachments.append(item)

        return {
            "vk_post_id": post_id,
            "url": f"{VK_SITE}/wall{owner_id}_{post_id}",
            "text": clean_text or None,
            "published_at": published_at,
            "likes_count": int((raw.get("likes") or {}).get("count", 0)),
            "comments_count": int((raw.get("comments") or {}).get("count", 0)),
            "reposts_count": int((raw.get("reposts") or {}).get("count", 0)),
            "views_count": (raw.get("views") or {}).get("count"),
            "attachments": attachments,
        }

    def search_communities(self, query: str, count: int = 8) -> list[dict]:
        """catalog.getSearchGroups ile anonim token üzerinden topluluk arar."""
        resp = self._call(
            "catalog.getSearchGroups",
            {"q": query, "count": count, "need_blocks": 1},
        )
        groups = resp.get("groups") if isinstance(resp, dict) else []
        results = []
        for g in (groups or [])[:count]:
            gid = g.get("id")
            if not gid:
                continue
            screen_name = g.get("screen_name")
            results.append(
                {
                    "id": int(gid),
                    "name": g.get("name") or f"club{gid}",
                    "screen_name": screen_name,
                    "url": f"{VK_SITE}/{screen_name}" if screen_name else f"{VK_SITE}/club{gid}",
                    "photo": g.get("photo_100") or g.get("photo_50"),
                    "members_count": g.get("members_count"),
                    "activity": g.get("activity"),
                    "is_verified": bool(g.get("verified")),
                }
            )
        return results

    def fetch_all_followers_page(
        self, user_id: int, offset: int = 0, count: int = 200
    ) -> tuple[int | None, list[dict]]:
        """users.getFollowers çağrısını verilen offset ve count ile yapar."""
        resp = self._call(
            "users.getFollowers",
            {
                "user_id": user_id,
                "offset": offset,
                "count": count,
                "fields": "photo_50,screen_name",
            },
        )
        total = resp.get("count") if isinstance(resp, dict) else None
        raw_items = (resp.get("items") or []) if isinstance(resp, dict) else []
        parsed: list[dict] = []

        for item in raw_items:
            if isinstance(item, dict):
                uid = item.get("id")
                if uid is None:
                    continue
                uid_int = int(uid)
                screen = item.get("screen_name")
                full_name = f"{item.get('first_name', '')} {item.get('last_name', '')}".strip()
                parsed.append(
                    {
                        "vk_user_id": uid_int,
                        "full_name": full_name or f"id{uid_int}",
                        "screen_name": screen,
                        "photo_url": item.get("photo_50"),
                        "profile_url": f"{VK_SITE}/{screen or f'id{uid_int}'}",
                    }
                )
            elif isinstance(item, (int, str)) and str(item).isdigit():
                uid_int = int(item)
                parsed.append(
                    {
                        "vk_user_id": uid_int,
                        "full_name": f"id{uid_int}",
                        "screen_name": None,
                        "photo_url": None,
                        "profile_url": f"{VK_SITE}/id{uid_int}",
                    }
                )

        return total, parsed