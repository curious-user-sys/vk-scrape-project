import type {
  CommunitySearchItem,
  Overview,
  PaginatedPosts,
  PostDetail,
  Source,
  SourceType,
} from "./types";

const BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      if (err?.detail) msg = String(err.detail);
    } catch {
      // JSON değilse varsayılan mesaj kalır
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  getOverview: (source_type?: SourceType) => {
    const qs = source_type ? `?source_type=${source_type}` : "";
    return request<Overview>(`/api/overview${qs}`);
  },
  getSources: () => request<Source[]>("/api/sources"),
  createSource: (input_ref: string, source_type: SourceType = "community") =>
    request<Source>("/api/sources", {
      method: "POST",
      body: JSON.stringify({ input_ref, source_type }),
    }),
  toggleSource: (id: number, is_active: boolean) =>
    request<Source>(`/api/sources/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ is_active }),
    }),
  deleteSource: (id: number) =>
    request<void>(`/api/sources/${id}`, { method: "DELETE" }),
  triggerScrape: (source_type?: SourceType, limit?: number) =>
    request<{ message: string }>("/api/scrape/run", {
      method: "POST",
      body: JSON.stringify({
        ...(source_type ? { source_type } : {}),
        ...(limit ? { limit } : {}),
      }),
    }),
  getPosts: (params: {
    q?: string;
    source_id?: string;
    source_type?: SourceType;
    date_from?: string;
    date_to?: string;
    sort: "asc" | "desc";
    page: number;
    page_size: number;
  }) => {
    const qs = new URLSearchParams();
    if (params.source_type) qs.set("source_type", params.source_type);
    if (params.q?.trim()) qs.set("q", params.q.trim());
    if (params.source_id) qs.set("source_id", params.source_id);
    if (params.date_from) qs.set("date_from", `${params.date_from}T00:00:00Z`);
    if (params.date_to) qs.set("date_to", `${params.date_to}T23:59:59Z`);
    qs.set("sort", params.sort);
    qs.set("page", String(params.page));
    qs.set("page_size", String(params.page_size));
    return request<PaginatedPosts>(`/api/posts?${qs.toString()}`);
  },
  getPostDetail: (id: number) => request<PostDetail>(`/api/posts/${id}`),
  translatePost: (id: number) =>
    request<{ post_id: number; translated_text: string }>(`/api/posts/${id}/translate`, {
      method: "POST",
    }),
  searchCommunities: (q: string) =>
    request<{ items: CommunitySearchItem[] }>(
      `/api/vk/search/communities?q=${encodeURIComponent(q)}&limit=8`
    ),
};