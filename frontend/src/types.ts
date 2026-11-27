export type SourceType = "community" | "user";

export interface CommunitySearchItem {
  id: number;
  name: string;
  screen_name: string | null;
  url: string;
  photo: string | null;
  members_count: number | null;
  activity: string | null;
  is_verified: boolean;
}

export interface UserExtras {
  followers?: {
    accessible: boolean;
    total: number | null;
    sample: { id: number; name: string; url: string }[];
  };
  photos?: {
    accessible: boolean;
    total: number | null;
    sample: { id: number; url: string; link: string }[];
  };
  videos?: {
    accessible: boolean;
    total: number | null;
    sample: { id: number; title: string; views?: number | null; link: string }[];
  };
  subscriptions?: {
    accessible: boolean;
    groups_total: number | null;
    users_total: number | null;
    groups_sample: { id: number; name: string; members_count?: number | null; url: string }[];
    users_sample: { id: number; name: string; url: string }[];
  };
}

export interface ProfileData {
  first_name?: string | null;
  last_name?: string | null;
  photo?: string | null;
  sex?: string | null;
  status?: string | null;
  about?: string | null;
  bdate?: string | null;
  city?: string | null;
  country?: string | null;
  home_town?: string | null;
  followers_count?: number | null;
  site?: string | null;
  occupation?: string | null;
  universities?: string[];
  is_verified?: boolean;
  is_online?: boolean;
  last_seen?: string | null;
  can_access_closed?: boolean;
  accessible_fields?: string[];
  extras?: UserExtras;
}

export interface Source {
  id: number;
  source_type: SourceType;
  input_ref: string;
  vk_owner_id: number;
  screen_name: string | null;
  title: string;
  url: string;
  is_active: boolean;
  is_closed: boolean;
  profile_data?: ProfileData | null;
  created_at: string;
  updated_at: string;
}

export interface ScrapeRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  added_count: number;
  updated_count: number;
  error_summary: string | null;
}

export interface Overview {
  total_sources: number;
  active_sources: number;
  total_posts: number;
  is_running: boolean;
  last_run: ScrapeRun | null;
}

export interface PostListItem {
  id: number;
  source_id: number;
  source_title: string;
  vk_post_id: number;
  url: string;
  text_preview: string | null;
  published_at: string;
  likes_count: number;
  comments_count: number;
  reposts_count: number;
  views_count: number | null;
}

export interface Attachment {
  type: string;
  url?: string;
  title?: string;
}

export interface PostDetail {
  id: number;
  source_id: number;
  source_title: string;
  source_url: string;
  vk_post_id: number;
  url: string;
  text: string | null;
  published_at: string;
  likes_count: number;
  comments_count: number;
  reposts_count: number;
  views_count: number | null;
  attachments: Attachment[] | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface PaginatedPosts {
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  items: PostListItem[];
}