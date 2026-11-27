from datetime import datetime, timezone
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.vk import Post, ScrapeRun, Source, UserFollower
from app.scraper.vk_client import VkClient, VkScraperError


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def upsert_posts(db: Session, source_id: int, posts_data: list[dict]) -> tuple[int, int]:
    """Gönderileri (source_id, vk_post_id) üzerinden ekler veya günceller."""
    now = utcnow()
    added = 0
    updated = 0

    for item in posts_data:
        vk_post_id = item["vk_post_id"]
        existing = (
            db.query(Post)
            .filter(Post.source_id == source_id, Post.vk_post_id == vk_post_id)
            .first()
        )
        if existing:
            existing.url = item["url"]
            existing.text = item.get("text")
            existing.published_at = item["published_at"]
            existing.likes_count = item.get("likes_count", 0)
            existing.comments_count = item.get("comments_count", 0)
            existing.reposts_count = item.get("reposts_count", 0)
            existing.views_count = item.get("views_count")
            existing.attachments = item.get("attachments")
            existing.last_seen_at = now
            updated += 1
        else:
            db.add(
                Post(
                    source_id=source_id,
                    vk_post_id=vk_post_id,
                    url=item["url"],
                    text=item.get("text"),
                    published_at=item["published_at"],
                    likes_count=item.get("likes_count", 0),
                    comments_count=item.get("comments_count", 0),
                    reposts_count=item.get("reposts_count", 0),
                    views_count=item.get("views_count"),
                    attachments=item.get("attachments"),
                    first_seen_at=now,
                    last_seen_at=now,
                )
            )
            added += 1

    return added, updated


def sync_user_followers(
    db: Session,
    source: Source,
    vk_client: VkClient,
    max_pages: int = 10,
    page_size: int = 200,
) -> dict:
    """Takipçileri sayfalı çeker, DB'ye yazar ve listeden düşenleri unfollowed_at ile işaretler."""
    now = utcnow()
    fetched_map: dict[int, dict] = {}
    total_reported: int | None = None
    offset = 0

    for _ in range(max_pages):
        total_reported, batch = vk_client.fetch_all_followers_page(
            source.vk_owner_id, offset=offset, count=page_size
        )
        if not batch:
            break
        for row in batch:
            fetched_map[row["vk_user_id"]] = row
        if len(batch) < page_size:
            break
        offset += len(batch)

    existing_rows = (
        db.query(UserFollower)
        .filter(UserFollower.source_id == source.id)
        .all()
    )
    existing_by_vk_id = {r.vk_user_id: r for r in existing_rows}

    for vk_uid, data in fetched_map.items():
        existing = existing_by_vk_id.get(vk_uid)
        if existing:
            existing.full_name = data["full_name"]
            existing.screen_name = data["screen_name"]
            existing.photo_url = data["photo_url"]
            existing.profile_url = data["profile_url"]
            existing.last_seen_at = now
            if not existing.is_following:
                existing.is_following = True
                existing.unfollowed_at = None
        else:
            db.add(
                UserFollower(
                    source_id=source.id,
                    vk_user_id=vk_uid,
                    full_name=data["full_name"],
                    screen_name=data["screen_name"],
                    photo_url=data["photo_url"],
                    profile_url=data["profile_url"],
                    is_following=True,
                    first_seen_at=now,
                    last_seen_at=now,
                    unfollowed_at=None,
                )
            )

    if fetched_map:
        for existing in existing_rows:
            if existing.vk_user_id not in fetched_map and existing.is_following:
                existing.is_following = False
                existing.unfollowed_at = now

    db.flush()
    all_stored = db.query(UserFollower).filter(UserFollower.source_id == source.id).all()
    sample_list = [
        {
            "id": r.vk_user_id,
            "name": r.full_name,
            "photo": r.photo_url,
            "url": r.profile_url,
            "is_following": r.is_following,
            "unfollowed_at": r.unfollowed_at.isoformat() if r.unfollowed_at else None,
        }
        for r in all_stored[:50]
    ]

    return {
        "accessible": True,
        "total": total_reported if total_reported is not None else len(all_stored),
        "stored_total": len(all_stored),
        "fetched_in_run": len(fetched_map),
        "sample": sample_list,
    }


def run_collection(
    db: Session,
    limit: int | None = None,
    source_type: str | None = None,
    client: VkClient | None = None,
) -> ScrapeRun:
    """Aktif kaynakları tarar ve özeti scrape_runs tablosuna yazar."""
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

                try:
                    extras["followers"] = sync_user_followers(db, source, vk_client)
                except VkScraperError as exc:
                    extras["followers"] = {
                        "accessible": False,
                        "total": None,
                        "sample": [],
                        "error": str(exc),
                    }

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