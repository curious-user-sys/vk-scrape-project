# app/services/collector.py
from datetime import datetime, timezone
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.vk import Post, ScrapeRun, Source
from app.scraper.vk_client import VkClient


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def upsert_posts(db: Session, source_id: int, posts_data: list[dict]) -> tuple[int, int]:
    """Yeni gönderileri ekler, mevcutların değişen alanlarını günceller."""
    added = 0
    updated = 0
    now = utcnow()

    for item in posts_data:
        existing = (
            db.query(Post)
            .filter(Post.source_id == source_id, Post.vk_post_id == item["vk_post_id"])
            .first()
        )
        if existing:
            existing.text = item["text"]
            existing.likes_count = item["likes_count"]
            existing.comments_count = item["comments_count"]
            existing.reposts_count = item["reposts_count"]
            existing.views_count = item["views_count"]
            existing.attachments = item["attachments"]
            existing.last_seen_at = now
            updated += 1
        else:
            db.add(
                Post(
                    source_id=source_id,
                    vk_post_id=item["vk_post_id"],
                    url=item["url"],
                    text=item["text"],
                    published_at=item["published_at"],
                    likes_count=item["likes_count"],
                    comments_count=item["comments_count"],
                    reposts_count=item["reposts_count"],
                    views_count=item["views_count"],
                    attachments=item["attachments"],
                    first_seen_at=now,
                    last_seen_at=now,
                )
            )
            added += 1

    return added, updated

def run_collection(
    db: Session,
    limit: int | None = None,
    source_type: str | None = None,
    client: VkClient | None = None,
) -> ScrapeRun:
    """Aktif kaynakları (isteğe bağlı olarak türe göre) tarar ve özeti scrape_runs tablosuna yazar."""
    post_limit = limit or settings.default_post_limit
    vk_client = client or VkClient()

    run = ScrapeRun(started_at=utcnow(), status="running", added_count=0, updated_count=0)
    db.add(run)
    db.commit()
    db.refresh(run)

    q = db.query(Source).filter(Source.is_active.is_(True))
    if source_type in ("community", "user"):
        q = q.filter(Source.source_type == source_type)
    sources = q.all()

    errors: list[str] = []
    total_added = 0
    total_updated = 0

    for source in sources:
        try:
            if source.source_type == "user":
                fresh = vk_client.resolve_user(str(source.vk_owner_id))
                extras = vk_client.fetch_user_extras(source.vk_owner_id)
                profile_data = dict(fresh["profile_data"] or {})
                profile_data["extras"] = extras

                source.title = fresh["title"]
                source.screen_name = fresh["screen_name"]
                source.is_closed = fresh["is_closed"]
                source.profile_data = profile_data
                db.commit()

                if source.is_closed:
                    continue

            posts_data = vk_client.fetch_wall_posts(source.vk_owner_id, limit=post_limit)
            added, updated = upsert_posts(db, source.id, posts_data)
            db.commit()
            total_added += added
            total_updated += updated
        except Exception as exc:
            db.rollback()
            errors.append(f"{source.title} ({source.vk_owner_id}): {exc}")

    run.finished_at = utcnow()
    run.added_count = total_added
    run.updated_count = total_updated
    run.error_summary = "\n".join(errors) if errors else None

    if not errors:
        run.status = "completed"
    elif sources and len(errors) < len(sources):
        run.status = "partial"
    else:
        run.status = "failed"

    db.commit()
    db.refresh(run)
    return run