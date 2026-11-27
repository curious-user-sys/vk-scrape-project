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

export interface UserExtraList<T> {
  accessible?: boolean;
  error?: string | null;
  total?: number | null;
  count?: number | null;
  items?: T[];
  sample?: T[];
}

export interface FollowerEntry {
  id: number;
  name?: string;
  first_name?: string;
  last_name?: string;
  screen_name?: string | null;
  photo?: string | null;
  photo_url?: string | null;
  url: string;
  is_following?: boolean;
  unfollowed_at?: string | null;
}

export interface PhotoEntry {
  id: number;
  owner_id?: number;
  url: string;
  link: string;
  text?: string | null;
  date?: number | string | null;
}

export interface VideoEntry {
  id: number;
  owner_id?: number;
  title: string;
  views?: number | null;
  duration?: number | null;
  link: string;
}

export interface SubscriptionGroupEntry {
  id: number;
  name: string;
  screen_name?: string | null;
  members_count?: number | null;
  url: string;
}

export interface SubscriptionUserEntry {
  id: number;
  name: string;
  screen_name?: string | null;
  url: string;
}

export interface SubscriptionsExtra {
  accessible?: boolean;
  error?: string | null;
  groups_total?: number | null;
  users_total?: number | null;
  groups_items?: SubscriptionGroupEntry[];
  groups_sample?: SubscriptionGroupEntry[];
  users_items?: SubscriptionUserEntry[];
  users_sample?: SubscriptionUserEntry[];
}

export interface UserExtras {
  followers?: UserExtraList<FollowerEntry>;
  photos?: UserExtraList<PhotoEntry>;
  videos?: UserExtraList<VideoEntry>;
  subscriptions?: SubscriptionsExtra;
  friends?: UserExtraList<FollowerEntry>;
}

export interface ProfileData {
  first_name?: string | null;
  last_name?: string | null;
  photo?: string | null;
  sex?: string | number | null;
  status?: string | null;
  about?: string | null;
  bdate?: string | null;
  city?: string | null;
  country?: string | null;
  home_town?: string | null;
  followers_count?: number | null;
  posts_count?: number | null;
  site?: string | null;
  occupation?: string | null;
  career?: string | string[] | null;
  universities?: string[] | null;
  is_verified?: boolean;
  is_online?: boolean;
  last_seen?: string | number | null;
  can_access_closed?: boolean;
  accessible_fields?: string[] | null;
  extras?: UserExtras | null;
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
  posts_count?: number | null;
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
  vk_owner_id?: number;
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

export interface PostLiker {
  id: number;
  name: string;
  url: string;
  photo?: string | null;
  reaction_type?: string | null;
}

export interface PostCommentItem {
  id: number;
  from_id?: number | null;
  author_name: string;
  author_url?: string | null;
  text: string;
  date?: number | string | null;
  likes_count?: number | null;
}

export interface PostEngagementData {
  likes_accessible: boolean;
  likes_error?: string | null;
  likes_total: number | null;
  likers: PostLiker[];
  comments_accessible: boolean;
  comments_error?: string | null;
  comments_total: number | null;
  comments: PostCommentItem[];
}