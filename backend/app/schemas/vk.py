# app/schemas/vk.py
from datetime import datetime
from typing import Any
from pydantic import BaseModel, ConfigDict, Field
from typing import Any, Literal

class SourceCreate(BaseModel):
    input_ref: str = Field(..., min_length=1, max_length=255, examples=["https://vk.ru/gazeta"])
    source_type: Literal["community", "user"] = "community"

class SourceUpdate(BaseModel):
    is_active: bool


class SourceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source_type: str
    input_ref: str
    vk_owner_id: int
    screen_name: str | None
    title: str
    url: str
    is_active: bool
    is_closed: bool
    profile_data: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime


class ScrapeTriggerRequest(BaseModel):
    limit: int | None = Field(default=None, ge=1, le=1000)
    source_type: Literal["community", "user"] | None = None


class ScrapeRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    started_at: datetime
    finished_at: datetime | None
    status: str
    added_count: int
    updated_count: int
    error_summary: str | None


class OverviewOut(BaseModel):
    total_sources: int
    active_sources: int
    total_posts: int
    is_running: bool
    last_run: ScrapeRunOut | None


class PostListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source_id: int
    source_title: str
    vk_post_id: int
    url: str
    text_preview: str | None
    published_at: datetime
    likes_count: int
    comments_count: int
    reposts_count: int
    views_count: int | None


class PostDetailOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source_id: int
    source_title: str
    source_url: str
    vk_post_id: int
    url: str
    text: str | None
    published_at: datetime
    likes_count: int
    comments_count: int
    reposts_count: int
    views_count: int | None
    attachments: list[dict[str, Any]] | None
    first_seen_at: datetime
    last_seen_at: datetime


class PaginatedPostsOut(BaseModel):
    total: int
    page: int
    page_size: int
    total_pages: int
    items: list[PostListItem]