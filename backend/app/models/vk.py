# app/models/vk.py
from datetime import datetime, timezone
from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base
from sqlalchemy import BigInteger, Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship

class UserFollower(Base):
    __tablename__ = "user_followers"
    __table_args__ = (
        UniqueConstraint("source_id", "vk_user_id", name="uq_user_followers_source_vk_user"),
        Index("ix_user_followers_source_active", "source_id", "is_following"),
    )

    id = Column(Integer, primary_key=True, index=True)
    source_id = Column(Integer, ForeignKey("sources.id", ondelete="CASCADE"), nullable=False, index=True)
    vk_user_id = Column(BigInteger, nullable=False, index=True)
    full_name = Column(String(255), nullable=False)
    screen_name = Column(String(255), nullable=True)
    photo_url = Column(Text, nullable=True)
    profile_url = Column(Text, nullable=False)
    is_following = Column(Boolean, nullable=False, default=True)
    first_seen_at = Column(DateTime(timezone=True), nullable=False)
    last_seen_at = Column(DateTime(timezone=True), nullable=False)
    unfollowed_at = Column(DateTime(timezone=True), nullable=True)

def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Source(Base):
    __tablename__ = "sources"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    input_ref: Mapped[str] = mapped_column(String(255), nullable=False)
    vk_owner_id: Mapped[int] = mapped_column(Integer, unique=True, nullable=False, index=True)
    screen_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    url: Mapped[str] = mapped_column(String(500), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    source_type: Mapped[str] = mapped_column(String(20), default="community", server_default="community", nullable=False)
    is_closed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false", nullable=False)
    profile_data: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    posts: Mapped[list["Post"]] = relationship("Post", back_populates="source", cascade="all, delete-orphan")


class Post(Base):
    __tablename__ = "posts"
    __table_args__ = (
        UniqueConstraint("source_id", "vk_post_id", name="uq_posts_source_vk_post"),
        Index("ix_posts_published_at", "published_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("sources.id", ondelete="CASCADE"), nullable=False, index=True)
    vk_post_id: Mapped[int] = mapped_column(Integer, nullable=False)
    url: Mapped[str] = mapped_column(String(500), nullable=False)
    text: Mapped[str | None] = mapped_column(Text, nullable=True)
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    likes_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    comments_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    reposts_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    views_count: Mapped[int | None] = mapped_column(Integer, nullable=True)

    attachments: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    source: Mapped["Source"] = relationship("Source", back_populates="posts")


class ScrapeRun(Base):
    __tablename__ = "scrape_runs"
    __table_args__ = (Index("ix_scrape_runs_started_at", "started_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="running", nullable=False)  # running, completed, partial, failed
    added_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    updated_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error_summary: Mapped[str | None] = mapped_column(Text, nullable=True)