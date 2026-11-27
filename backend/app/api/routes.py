# app/api/routes.py
from datetime import datetime
import math
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import asc, desc
from sqlalchemy.orm import Session, joinedload

from app.db.session import SessionLocal, get_db
from app.models.vk import Post, ScrapeRun, Source
from app.schemas.vk import (
    OverviewOut,
    PaginatedPostsOut,
    PostDetailOut,
    PostListItem,
    ScrapeRunOut,
    ScrapeTriggerRequest,
    SourceCreate,
    SourceOut,
    SourceUpdate,
)
from app.scraper.vk_client import VkClient, VkNotFoundError, VkScraperError
from app.services.collector import run_collection
import httpx
import html as html_lib
import re
from pydantic import BaseModel
import json
from pathlib import Path
from urllib.parse import quote

router = APIRouter(prefix="/api", tags=["vk-scrape"])


def _run_collection_bg(limit: int | None, source_type: str | None) -> None:
    db = SessionLocal()
    try:
        run_collection(db, limit=limit, source_type=source_type)
    finally:
        db.close()

# ---- Genel Bakış ----

@router.get("/overview", response_model=OverviewOut)
def get_overview(
    source_type: str | None = Query(default=None, pattern="^(community|user)$"),
    db: Session = Depends(get_db),
):
    src_q = db.query(Source)
    post_q = db.query(Post).join(Source)
    if source_type:
        src_q = src_q.filter(Source.source_type == source_type)
        post_q = post_q.filter(Source.source_type == source_type)

    total_sources = src_q.count()
    active_sources = src_q.filter(Source.is_active.is_(True)).count()
    total_posts = post_q.count()
    last_run = db.query(ScrapeRun).order_by(desc(ScrapeRun.started_at)).first()
    is_running = db.query(ScrapeRun).filter(ScrapeRun.status == "running").first() is not None
    return OverviewOut(
        total_sources=total_sources,
        active_sources=active_sources,
        total_posts=total_posts,
        is_running=is_running,
        last_run=last_run,
    )


# ---- Kaynak Yönetimi ----

@router.get("/sources", response_model=list[SourceOut])
def list_sources(db: Session = Depends(get_db)):
    return db.query(Source).order_by(desc(Source.created_at)).all()


@router.post("/sources", response_model=SourceOut, status_code=status.HTTP_201_CREATED)
def create_source(payload: SourceCreate, db: Session = Depends(get_db)):
    client = VkClient()
    try:
        if payload.source_type == "user":
            info = client.resolve_user(payload.input_ref)
        else:
            info = client.resolve_community(payload.input_ref)
            info["source_type"] = "community"
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except VkNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except VkScraperError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    existing = db.query(Source).filter(Source.vk_owner_id == info["vk_owner_id"]).first()
    if existing:
        raise HTTPException(status_code=409, detail="Bu VK kaynağı zaten kayıtlı.")

    source = Source(input_ref=payload.input_ref.strip(), **info)
    db.add(source)
    db.commit()
    db.refresh(source)
    return source


@router.patch("/sources/{source_id}", response_model=SourceOut)
def update_source(source_id: int, payload: SourceUpdate, db: Session = Depends(get_db)):
    source = db.query(Source).filter(Source.id == source_id).first()
    if not source:
        raise HTTPException(status_code=404, detail="Kaynak bulunamadı.")
    source.is_active = payload.is_active
    db.commit()
    db.refresh(source)
    return source


@router.delete("/sources/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_source(source_id: int, db: Session = Depends(get_db)):
    source = db.query(Source).filter(Source.id == source_id).first()
    if not source:
        raise HTTPException(status_code=404, detail="Kaynak bulunamadı.")
    db.delete(source)
    db.commit()


# ---- Toplama İşlemi ----

@router.post("/scrape/run", status_code=status.HTTP_202_ACCEPTED)
def trigger_scrape(
    background_tasks: BackgroundTasks,
    payload: ScrapeTriggerRequest | None = None,
    db: Session = Depends(get_db),
):
    running = db.query(ScrapeRun).filter(ScrapeRun.status == "running").first()
    if running:
        raise HTTPException(status_code=409, detail="Devam eden bir toplama işlemi zaten var.")

    limit = payload.limit if payload else None
    source_type = payload.source_type if payload else None
    background_tasks.add_task(_run_collection_bg, limit, source_type)
    return {"message": "Toplama işlemi arka planda başlatıldı."}


@router.get("/scrape/runs", response_model=list[ScrapeRunOut])
def list_scrape_runs(limit: int = Query(default=20, ge=1, le=100), db: Session = Depends(get_db)):
    return db.query(ScrapeRun).order_by(desc(ScrapeRun.started_at)).limit(limit).all()


# ---- Gönderiler ----

@router.get("/posts", response_model=PaginatedPostsOut)
def list_posts(
    q: str | None = Query(default=None, description="Gönderi metninde arama"),
    source_id: int | None = Query(default=None),
    source_type: str | None = Query(default=None, pattern="^(community|user)$"),
    date_from: datetime | None = Query(default=None),
    date_to: datetime | None = Query(default=None),
    sort: str = Query(default="desc", pattern="^(asc|desc)$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    query = db.query(Post).join(Source).options(joinedload(Post.source))

    if source_type:
        query = query.filter(Source.source_type == source_type)
    if q and q.strip():
        query = query.filter(Post.text.ilike(f"%{q.strip()}%"))
    if source_id is not None:
        query = query.filter(Post.source_id == source_id)
    if date_from is not None:
        query = query.filter(Post.published_at >= date_from)
    if date_to is not None:
        query = query.filter(Post.published_at <= date_to)

    total = query.count()
    order_col = asc(Post.published_at) if sort == "asc" else desc(Post.published_at)
    rows = query.order_by(order_col).offset((page - 1) * page_size).limit(page_size).all()

    items = [
        PostListItem(
            id=p.id,
            source_id=p.source_id,
            source_title=p.source.title,
            vk_post_id=p.vk_post_id,
            url=p.url,
            text_preview=(p.text[:220] + "…") if p.text and len(p.text) > 220 else p.text,
            published_at=p.published_at,
            likes_count=p.likes_count,
            comments_count=p.comments_count,
            reposts_count=p.reposts_count,
            views_count=p.views_count,
        )
        for p in rows
    ]

    total_pages = math.ceil(total / page_size) if total else 0
    return PaginatedPostsOut(
        total=total,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
        items=items,
    )


@router.get("/posts/{post_id}", response_model=PostDetailOut)
def get_post_detail(post_id: int, db: Session = Depends(get_db)):
    post = db.query(Post).options(joinedload(Post.source)).filter(Post.id == post_id).first()
    if not post:
        raise HTTPException(status_code=404, detail="Gönderi bulunamadı.")
    return PostDetailOut(
        id=post.id,
        source_id=post.source_id,
        source_title=post.source.title,
        source_url=post.source.url,
        vk_post_id=post.vk_post_id,
        url=post.url,
        text=post.text,
        published_at=post.published_at,
        likes_count=post.likes_count,
        comments_count=post.comments_count,
        reposts_count=post.reposts_count,
        views_count=post.views_count,
        attachments=post.attachments,
        first_seen_at=post.first_seen_at,
        last_seen_at=post.last_seen_at,
    )

# ---- Canlı Topluluk Arama ----

@router.get("/vk/search/communities")
def search_vk_communities(
    q: str = Query(..., min_length=2, max_length=100),
    limit: int = Query(default=8, ge=1, le=20),
):
    client = VkClient(request_delay=0.0, max_retries=1)
    try:
        return {"items": client.search_communities(q.strip(), count=limit)}
    except VkScraperError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


# ---- Kalıcı Önbellekli Çeviri ----

_CACHE_FILE = Path(__file__).resolve().parent.parent.parent / "translation_cache.json"
_TRANSLATION_CACHE: dict[str, str] = {}
if _CACHE_FILE.exists():
    try:
        _TRANSLATION_CACHE = json.loads(_CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        _TRANSLATION_CACHE = {}

_MOBILE_RESULT_RE = re.compile(r'<div class="result-container">(.*?)</div>', re.S)
_CYRILLIC_RE = re.compile(r"[\u0400-\u04FF]")
_TR_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36"
}


def _save_cache() -> None:
    try:
        _CACHE_FILE.write_text(
            json.dumps(_TRANSLATION_CACHE, ensure_ascii=False), encoding="utf-8"
        )
    except Exception:
        pass


def _translate_piece(client: httpx.Client, text: str, target: str) -> str:
    # 1. Google clients5
    try:
        resp = client.get(
            "https://clients5.google.com/translate_a/t",
            params={"client": "dict-chrome-ex", "sl": "auto", "tl": target, "q": text},
            headers=_TR_HEADERS,
        )
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data, list) and data:
                first = data[0]
                if isinstance(first, list) and first:
                    return str(first[0])
                if isinstance(first, str):
                    return first
    except Exception:
        pass

    # 2. Google Mobil HTML
    try:
        resp = client.get(
            "https://translate.google.com/m",
            params={"sl": "auto", "tl": target, "q": text},
            headers=_TR_HEADERS,
        )
        if resp.status_code == 200:
            match = _MOBILE_RESULT_RE.search(resp.text)
            if match:
                return html_lib.unescape(match.group(1)).strip()
    except Exception:
        pass

    # 3. Lingva (Google proxy, ayrı IP)
    for host in ("https://lingva.thedaviddiem.com", "https://lingva.ml"):
        try:
            resp = client.get(
                f"{host}/api/v1/auto/{target}/{quote(text, safe='')}",
                headers=_TR_HEADERS,
            )
            if resp.status_code == 200:
                tr = resp.json().get("translation")
                if tr:
                    return tr
        except Exception:
            continue

    # 4. MyMemory (Kiril varsa ru, yoksa en olarak otomatik seçer)
    src_lang = "ru" if _CYRILLIC_RE.search(text) else "en"
    parts: list[str] = []
    for i in range(0, len(text), 450):
        piece = text[i : i + 450]
        resp = client.get(
            "https://api.mymemory.translated.net/get",
            params={"q": piece, "langpair": f"{src_lang}|{target}"},
            headers=_TR_HEADERS,
        )
        resp.raise_for_status()
        tr = (resp.json().get("responseData") or {}).get("translatedText")
        if tr:
            parts.append(html_lib.unescape(tr))
    if parts:
        return "".join(parts)

    raise RuntimeError("Tüm çeviri servisleri yanıt vermedi.")


@router.post("/posts/{post_id}/translate")
def translate_post(post_id: int, target: str = Query(default="tr"), db: Session = Depends(get_db)):
    cache_key = f"{post_id}:{target}"
    if cache_key in _TRANSLATION_CACHE:
        return {"post_id": post_id, "translated_text": _TRANSLATION_CACHE[cache_key]}

    post = db.query(Post).filter(Post.id == post_id).first()
    if not post:
        raise HTTPException(status_code=404, detail="Gönderi bulunamadı.")
    if not post.text or not post.text.strip():
        return {"post_id": post.id, "translated_text": ""}

    try:
        chunks = [post.text[i : i + 1800] for i in range(0, len(post.text), 1800)]
        with httpx.Client(timeout=15.0, follow_redirects=True) as client:
            translated = "".join(_translate_piece(client, c, target) for c in chunks)
        _TRANSLATION_CACHE[cache_key] = translated
        _save_cache()
        return {"post_id": post.id, "translated_text": translated}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Çeviri başarısız: {exc}") from exc