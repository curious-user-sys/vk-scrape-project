import type {
  CommunitySearchItem,
  Overview,
  PaginatedPosts,
  PostCommentItem,
  PostDetail,
  PostEngagementData,
  PostLiker,
  Source,
  SourceType,
} from "./types";

const BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";
const VK_WEB_API = "https://web.api.vk.ru/method";
const VK_API_VERSION = "5.289";

let cachedAnonToken: string | null = null;

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

async function getAnonToken(): Promise<string> {
  if (cachedAnonToken) return cachedAnonToken;
  const res = await fetch(
    "https://login.vk.ru/?act=get_anonym_token&client_id=6287487&v=5.289"
  );
  if (!res.ok) throw new Error(`Anonim token alınamadı (HTTP ${res.status})`);
  const data = await res.json();
  const token = data?.token || data?.response?.token;
  if (!token) throw new Error("Anonim token yanıtı boş");
  cachedAnonToken = String(token);
  return cachedAnonToken;
}

async function callVkDirect<T>(
  method: string,
  params: Record<string, string | number>
): Promise<T> {
  const token = await getAnonToken();
  const body = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    access_token: token,
    v: VK_API_VERSION,
  });
  const res = await fetch(`${VK_WEB_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`VK ${method} HTTP ${res.status}`);
  const json = await res.json();
  if (json?.error) {
    throw new Error(json.error.error_msg || `VK hata kodu ${json.error.error_code}`);
  }
  return json.response as T;
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
  async getPostEngagement(
    ownerId: number,
    postId: number
  ): Promise<PostEngagementData> {
    let likesAccessible = false;
    let likesError: string | null = null;
    let likesTotal: number | null = null;
    let likers: PostLiker[] = [];

    let commentsAccessible = false;
    let commentsError: string | null = null;
    let commentsTotal: number | null = null;
    let comments: PostCommentItem[] = [];

    try {
      const likesRes = await callVkDirect<{
        count?: number;
        items?: Array<number | { id?: number; user_id?: number; reaction_type?: string }>;
      }>("likes.getList", {
        type: "post",
        owner_id: ownerId,
        item_id: postId,
        extended: 1,
        count: 50,
      });
      likesAccessible = true;
      likesTotal = typeof likesRes?.count === "number" ? likesRes.count : null;
      const rawItems = likesRes?.items || [];
      const ids: number[] = [];
      const reactionMap = new Map<number, string | null>();

      for (const entry of rawItems) {
        if (typeof entry === "number") {
          ids.push(entry);
        } else if (entry && typeof entry === "object") {
          const uid = Number(entry.id ?? entry.user_id ?? 0);
          if (uid) {
            ids.push(uid);
            reactionMap.set(uid, entry.reaction_type || null);
          }
        }
      }

      if (ids.length > 0) {
        try {
          const profiles = await callVkDirect<
            Array<{
              id: number;
              first_name?: string;
              last_name?: string;
              screen_name?: string;
              photo_50?: string;
            }>
          >("users.get", {
            user_ids: ids.slice(0, 50).join(","),
            fields: "photo_50,screen_name",
          });
          const pMap = new Map(profiles.map((p) => [p.id, p]));
          likers = ids.slice(0, 50).map((uid) => {
            const p = pMap.get(uid);
            const fullName = p
              ? `${p.first_name || ""} ${p.last_name || ""}`.trim()
              : "";
            return {
              id: uid,
              name: fullName || `id${uid}`,
              url: `https://vk.com/${p?.screen_name || `id${uid}`}`,
              photo: p?.photo_50 || null,
              reaction_type: reactionMap.get(uid) || null,
            };
          });
        } catch {
          likers = ids.slice(0, 50).map((uid) => ({
            id: uid,
            name: `id${uid}`,
            url: `https://vk.com/id${uid}`,
            photo: null,
            reaction_type: reactionMap.get(uid) || null,
          }));
        }
      }
    } catch (err) {
      likesAccessible = false;
      likesError = err instanceof Error ? err.message : "Beğenenler alınamadı";
    }

    try {
      const cRes = await callVkDirect<{
        count?: number;
        items?: Array<{
          id: number;
          from_id?: number;
          date?: number;
          text?: string;
          likes?: { count?: number };
        }>;
        profiles?: Array<{
          id: number;
          first_name?: string;
          last_name?: string;
          screen_name?: string;
        }>;
        groups?: Array<{
          id: number;
          name?: string;
          screen_name?: string;
        }>;
      }>("wall.getComments", {
        owner_id: ownerId,
        post_id: postId,
        extended: 1,
        count: 50,
      });
      commentsAccessible = true;
      commentsTotal = typeof cRes?.count === "number" ? cRes.count : null;

      const profMap = new Map<number, { name: string; url: string }>();
      for (const pr of cRes?.profiles || []) {
        profMap.set(pr.id, {
          name: `${pr.first_name || ""} ${pr.last_name || ""}`.trim() || `id${pr.id}`,
          url: `https://vk.com/${pr.screen_name || `id${pr.id}`}`,
        });
      }
      for (const gr of cRes?.groups || []) {
        profMap.set(-Math.abs(gr.id), {
          name: gr.name || `club${gr.id}`,
          url: `https://vk.com/${gr.screen_name || `club${gr.id}`}`,
        });
      }

      comments = (cRes?.items || []).map((c) => {
        const fid = c.from_id ?? null;
        const author = fid !== null ? profMap.get(fid) : undefined;
        return {
          id: c.id,
          from_id: fid,
          author_name:
            author?.name || (fid !== null ? `id${fid}` : "Bilinmeyen kullanıcı"),
          author_url:
            author?.url || (fid !== null ? `https://vk.com/id${Math.abs(fid)}` : null),
          text: c.text || "(Yorum metni yok)",
          date: c.date ?? null,
          likes_count: c.likes?.count ?? null,
        };
      });
    } catch (err) {
      commentsAccessible = false;
      commentsError = err instanceof Error ? err.message : "Yorumlar alınamadı";
    }

    return {
      likes_accessible: likesAccessible,
      likes_error: likesError,
      likes_total: likesTotal,
      likers,
      comments_accessible: commentsAccessible,
      comments_error: commentsError,
      comments_total: commentsTotal,
      comments,
    };
  },
};