import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type {
  CommunitySearchItem,
  FollowerEntry,
  Overview,
  PaginatedPosts,
  PhotoEntry,
  PostDetail,
  PostEngagementData,
  Source,
  SourceType,
  SubscriptionGroupEntry,
  SubscriptionUserEntry,
  VideoEntry,
} from "./types";
import "./App.css";

type ThemeMode = "light" | "dark";

const getInitialTheme = (): ThemeMode => {
  try {
    const saved = localStorage.getItem("vk_theme");
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // depolama erişimi yoksa varsayılan koyu tema kullanılır
  }
  return "dark";
};

const fmtDate = (iso?: string | number | null) => {
  if (iso === null || iso === undefined || iso === "") return "Erişilemez / Veri yok";
  const d =
    typeof iso === "number"
      ? new Date(iso > 1e12 ? iso : iso * 1000)
      : new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("tr-TR");
};

const fmtNumber = (val?: number | null, fallback = "Erişilemez / Veri yok") => {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return fallback;
  return Number(val).toLocaleString("tr-TR");
};

const fmtFieldText = (val?: string | number | string[] | null, fallback = "Erişilemez / Veri yok") => {
  if (val === null || val === undefined) return fallback;
  if (Array.isArray(val)) {
    return val.length > 0 ? val.join(" | ") : "Veri yok";
  }
  const str = String(val).trim();
  return str.length > 0 ? str : fallback;
};

const STATUS_LABELS: Record<string, string> = {
  running: "Çalışıyor",
  completed: "Tamamlandı",
  partial: "Kısmen Tamamlandı",
  failed: "Hatalı",
};

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [activeTab, setActiveTab] = useState<SourceType>("community");

  const [overview, setOverview] = useState<Overview | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [posts, setPosts] = useState<PaginatedPosts | null>(null);
  const [selectedPost, setSelectedPost] = useState<PostDetail | null>(null);
  const [engagement, setEngagement] = useState<PostEngagementData | null>(null);
  const [loadingEngagement, setLoadingEngagement] = useState(false);
  const [selectedUser, setSelectedUser] = useState<Source | null>(null);

  useEffect(() => {
    setFollowerSearch("");
    setFollowerPage(1);
  }, [selectedUser?.id]);

  // Kaynak ekleme ve canlı topluluk araması
  const [newRef, setNewRef] = useState("");
  const [sourceErr, setSourceErr] = useState<string | null>(null);
  const [addingSource, setAddingSource] = useState(false);
  const [suggestions, setSuggestions] = useState<CommunitySearchItem[]>([]);
  const [searchingVk, setSearchingVk] = useState(false);

  // Filtreler
  const [q, setQ] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sort, setSort] = useState<"desc" | "asc">("desc");
  const [page, setPage] = useState(1);

  // Global çeviri aç/kapa, iptal kontrolü ve önbellek
  const [translateEnabled, setTranslateEnabled] = useState(false);
  const [translations, setTranslations] = useState<Record<number, string>>({});
  const [isTranslating, setIsTranslating] = useState(false);
  const cancelTranslationRef = useRef(false);

  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("vk_theme", theme);
    } catch {
      // yoksay
    }
  }, [theme]);

  const communities = sources.filter((s) => s.source_type !== "user");
  const users = sources.filter((s) => s.source_type === "user");
  const visibleSources = activeTab === "community" ? communities : users;

  const loadOverviewAndSources = useCallback(async () => {
    const [ov, src] = await Promise.all([api.getOverview(activeTab), api.getSources()]);
    setOverview(ov);
    setSources(src);
  }, [activeTab]);

  const loadPosts = useCallback(async () => {
    const data = await api.getPosts({
      source_type: activeTab,
      q,
      source_id: sourceId,
      date_from: dateFrom,
      date_to: dateTo,
      sort,
      page,
      page_size: 20,
    });
    setPosts(data);
  }, [activeTab, q, sourceId, dateFrom, dateTo, sort, page]);

  useEffect(() => {
    loadOverviewAndSources().catch((e) => setBanner(e.message));
  }, [loadOverviewAndSources]);

  useEffect(() => {
    loadPosts().catch((e) => setBanner(e.message));
  }, [loadPosts]);

  // Toplama çalışıyorsa 3 saniyede bir durumu güncelle
  useEffect(() => {
    if (!overview?.is_running) return;
    const timer = setInterval(async () => {
      const ov = await api.getOverview(activeTab);
      setOverview(ov);
      if (!ov.is_running) {
        loadOverviewAndSources();
        loadPosts();
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [overview?.is_running, activeTab, loadOverviewAndSources, loadPosts]);

  // Topluluk sekmesinde yazarken canlı VK araması (350ms debounce)
  useEffect(() => {
    const term = newRef.trim();
    if (
      activeTab !== "community" ||
      term.length < 2 ||
      term.startsWith("http://") ||
      term.startsWith("https://") ||
      term.includes("vk.com") ||
      term.includes("vk.ru")
    ) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearchingVk(true);
      try {
        const res = await api.searchCommunities(term);
        if (!cancelled) setSuggestions(res.items);
      } catch {
        if (!cancelled) setSuggestions([]);
      } finally {
        if (!cancelled) setSearchingVk(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [newRef, activeTab]);

  // Çeviri açıksa yalnızca mevcut sayfadaki (posts.items) henüz çevrilmemiş gönderileri çevir
  useEffect(() => {
    if (!translateEnabled || !posts?.items.length) return;

    const currentPageItems = posts.items;
    const missing = currentPageItems.filter(
      (p) => p.text_preview && translations[p.id] === undefined
    );
    if (missing.length === 0) return;

    let effectCancelled = false;
    cancelTranslationRef.current = false;
    setIsTranslating(true);

    (async () => {
      for (const p of missing) {
        if (effectCancelled || cancelTranslationRef.current) break;
        try {
          const res = await api.translatePost(p.id);
          if (!effectCancelled && !cancelTranslationRef.current) {
            setTranslations((prev) => ({ ...prev, [p.id]: res.translated_text }));
          }
          await new Promise((r) => setTimeout(r, 200));
        } catch {
          // Tek bir gönderi hata verirse diğerlerine devam et
        }
      }
      if (!effectCancelled) setIsTranslating(false);
    })();

    return () => {
      effectCancelled = true;
    };
  }, [translateEnabled, posts, page]);

  const handleToggleTranslateSwitch = () => {
    if (isTranslating) {
      cancelTranslationRef.current = true;
      setIsTranslating(false);
      setTranslateEnabled(false);
      return;
    }
    setTranslateEnabled((v) => !v);
  };

  const handleCancelTranslation = () => {
    cancelTranslationRef.current = true;
    setIsTranslating(false);
  };

  const handleSwitchTab = (tab: SourceType) => {
    if (tab === activeTab) return;
    cancelTranslationRef.current = true;
    setIsTranslating(false);
    setActiveTab(tab);
    setSourceId("");
    setPage(1);
    setNewRef("");
    setSuggestions([]);
    setSourceErr(null);
  };

  const addSourceByRef = async (refValue: string) => {
    setAddingSource(true);
    setSourceErr(null);
    try {
      await api.createSource(refValue, activeTab);
      setNewRef("");
      setSuggestions([]);
      await loadOverviewAndSources();
    } catch (err) {
      setSourceErr(
        err instanceof Error
          ? err.message
          : activeTab === "community"
          ? "Topluluk eklenemedi."
          : "Kişi eklenemedi."
      );
    } finally {
      setAddingSource(false);
    }
  };

  const handleAddSource = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRef.trim()) return;
    await addSourceByRef(newRef.trim());
  };

  const handleToggleSource = async (s: Source) => {
    await api.toggleSource(s.id, !s.is_active);
    await loadOverviewAndSources();
  };

  const handleDeleteSource = async (id: number) => {
    if (!confirm("Bu kaynağı ve bağlı gönderilerini silmek istiyor musunuz?")) return;
    await api.deleteSource(id);
    await loadOverviewAndSources();
    await loadPosts();
  };

  const handleTriggerScrape = async () => {
    setBanner(null);
    try {
      const res = await api.triggerScrape(activeTab);
      setBanner(res.message);
      await loadOverviewAndSources();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "Toplama başlatılamadı.");
    }
  };

  const [followerSearch, setFollowerSearch] = useState("");
  const [onlyUnfollowed, setOnlyUnfollowed] = useState(false);
  const [followerPage, setFollowerPage] = useState(1);
  const [dbFollowers, setDbFollowers] = useState<FollowerEntry[]>([]);
  const [dbFollowersTotal, setDbFollowersTotal] = useState(0);
  const [dbFollowersTotalPages, setDbFollowersTotalPages] = useState(1);

  useEffect(() => {
    setFollowerSearch("");
    setOnlyUnfollowed(false);
    setFollowerPage(1);
  }, [selectedUser?.id]);

  useEffect(() => {
    if (!selectedUser) {
      setDbFollowers([]);
      setDbFollowersTotal(0);
      setDbFollowersTotalPages(1);
      return;
    }

    let cancelled = false;
    api
      .getSourceFollowers(selectedUser.id, {
        q: followerSearch,
        only_unfollowed: onlyUnfollowed,
        page: followerPage,
        page_size: 25,
      })
      .then((res) => {
        if (cancelled) return;
        setDbFollowers(res.items ?? []);
        setDbFollowersTotal(res.total ?? 0);
        setDbFollowersTotalPages(res.total_pages ?? 1);
      })
      .catch(() => {
        if (cancelled) return;
        setDbFollowers([]);
        setDbFollowersTotal(0);
        setDbFollowersTotalPages(1);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedUser, followerSearch, onlyUnfollowed, followerPage]);

  const openDetail = async (id: number) => {
    setEngagement(null);
    setLoadingEngagement(true);
    try {
      const detail = await api.getPostDetail(id);
      setSelectedPost(detail);

      if (translateEnabled && detail.text && translations[detail.id] === undefined) {
        api
          .translatePost(detail.id)
          .then((res) =>
            setTranslations((prev) => ({ ...prev, [detail.id]: res.translated_text }))
          )
          .catch(() => {});
      }

      const src = sources.find((s) => s.id === detail.source_id);
      const ownerId =
        detail.vk_owner_id ??
        (src
          ? src.source_type === "user"
            ? Math.abs(src.vk_owner_id)
            : -Math.abs(src.vk_owner_id)
          : null);

      if (ownerId !== null) {
        const eng = await api.getPostEngagement(ownerId, detail.vk_post_id);
        setEngagement(eng);
      } else {
        setEngagement({
          likes_accessible: false,
          likes_error: "Kaynak owner_id bulunamadı",
          likes_total: detail.likes_count,
          likers: [],
          comments_accessible: false,
          comments_error: "Kaynak owner_id bulunamadı",
          comments_total: detail.comments_count,
          comments: [],
        });
      }
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "Gönderi detayı yüklenemedi.");
    } finally {
      setLoadingEngagement(false);
    }
  };

  const updateFilter = (setter: () => void) => {
    setter();
    setPage(1);
  };

  const renderPreview = (postId: number, original: string | null) => {
    if (!original) return "(Metin yok)";
    if (!translateEnabled) return original;
    const tr = translations[postId];
    if (tr === undefined) return original;
    return tr.length > 220 ? tr.slice(0, 220) + "…" : tr;
  };

  const getSourcePostCount = (s: Source) => {
    if (typeof s.posts_count === "number") return s.posts_count;
    if (typeof s.profile_data?.posts_count === "number") return s.profile_data.posts_count;
    if (posts && Number(sourceId) === s.id) return posts.total;
    return null;
  };

  const getListEntries = <T,>(
    block?: { items?: T[]; sample?: T[] } | null
  ): T[] => {
    if (!block) return [];
    if (Array.isArray(block.items) && block.items.length > 0) return block.items;
    if (Array.isArray(block.sample) && block.sample.length > 0) return block.sample;
    return [];
  };

  const renderExtraStatus = (
    block?: { accessible?: boolean; error?: string | null; total?: number | null; count?: number | null } | null
  ) => {
    if (!block) return "Erişilemez / Veri yok";
    if (block.error) return `Hata: ${block.error}`;
    if (block.accessible === false) return "Erişime kapalı";
    const num = block.total ?? block.count ?? null;
    return `Erişilebilir (${fmtNumber(num, "0")})`;
  };

  const userProfile = selectedUser?.profile_data ?? null;
  const userExtras = userProfile?.extras ?? null;
  const photoEntries: PhotoEntry[] = getListEntries(userExtras?.photos);
  const videoEntries: VideoEntry[] = getListEntries(userExtras?.videos);
  const subGroupEntries: SubscriptionGroupEntry[] =
    userExtras?.subscriptions?.groups_items?.length
      ? userExtras.subscriptions.groups_items
      : userExtras?.subscriptions?.groups_sample || [];
  const subUserEntries: SubscriptionUserEntry[] =
    userExtras?.subscriptions?.users_items?.length
      ? userExtras.subscriptions.users_items
      : userExtras?.subscriptions?.users_sample || [];
  
  return (
    <div className="container">
      <header className="header">
        <div>
          <h1>VK Veri Toplama Paneli</h1>
          <p className="muted">VK toplulukları ve kişi profillerini toplama ve inceleme</p>
        </div>
        <div className="source-actions">
          <button
            type="button"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          >
            {theme === "dark" ? "Açık Tema" : "Koyu Tema"}
          </button>
          <button
            className={translateEnabled ? "btn-primary" : ""}
            onClick={handleToggleTranslateSwitch}
          >
            {isTranslating
              ? "Çevriliyor..."
              : translateEnabled
              ? "TR Çeviri: Açık"
              : "TR Çeviri: Kapalı"}
          </button>
          {isTranslating && (
            <button className="btn-danger" onClick={handleCancelTranslation}>
              Çeviriyi İptal Et
            </button>
          )}
          <button
            className="btn-primary"
            onClick={handleTriggerScrape}
            disabled={overview?.is_running}
          >
            {overview?.is_running
              ? "Toplama Devam Ediyor..."
              : activeTab === "community"
              ? "Aktif Toplulukları Topla"
              : "Aktif Kişileri Topla"}
          </button>
        </div>
      </header>

      {/* Topluluk / Kişi Toggle */}
      <nav className="mode-toggle" aria-label="Kaynak türü seçimi">
        <button
          className={`toggle-btn ${activeTab === "community" ? "active" : ""}`}
          onClick={() => handleSwitchTab("community")}
        >
          Topluluklar ({communities.length})
        </button>
        <button
          className={`toggle-btn ${activeTab === "user" ? "active" : ""}`}
          onClick={() => handleSwitchTab("user")}
        >
          Kişiler ({users.length})
        </button>
      </nav>

      {banner && <div className="banner">{banner}</div>}

      {/* Genel Bakış */}
      <section className="cards">
        <div className="card">
          <span className="label">
            {activeTab === "community"
              ? "Topluluklar (Aktif / Toplam)"
              : "Kişiler (Aktif / Toplam)"}
          </span>
          <strong>
            {overview ? `${overview.active_sources} / ${overview.total_sources}` : "—"}
          </strong>
        </div>
        <div className="card">
          <span className="label">
            {activeTab === "community" ? "Topluluk Gönderileri" : "Kişi Gönderileri"}
          </span>
          <strong>{overview?.total_posts ?? "—"}</strong>
        </div>
        <div className="card">
          <span className="label">Son Çalışma</span>
          <strong>
            {overview?.last_run
              ? STATUS_LABELS[overview.last_run.status] || overview.last_run.status
              : "Henüz yok"}
          </strong>
          <small className="muted">{fmtDate(overview?.last_run?.started_at)}</small>
        </div>
        <div className="card">
          <span className="label">Son Tarama Özeti</span>
          <strong>
            {overview?.last_run
              ? `+${overview.last_run.added_count} yeni / ${overview.last_run.updated_count} güncel`
              : "—"}
          </strong>
        </div>
      </section>

      {overview?.last_run?.error_summary && (
        <div className="error-box">
          <strong>Son Çalışma Hataları:</strong>
          <pre>{overview.last_run.error_summary}</pre>
        </div>
      )}

      {/* Kaynak Yönetimi */}
      <section className="panel">
        <h2>
          {activeTab === "community" ? "Topluluk Yönetimi" : "Kişi Yönetimi"} (
          {visibleSources.length})
        </h2>
        <div className="search-wrap">
          <form className="source-form" onSubmit={handleAddSource}>
            <input
              type="text"
              placeholder={
                activeTab === "community"
                  ? "Topluluk adı yazarak ara (örn: gazeta) veya VK URL'si yapıştır..."
                  : "VK profil URL'si, kullanıcı adı veya ID (örn: durov, id1, https://vk.com/durov)"
              }
              value={newRef}
              onChange={(e) => setNewRef(e.target.value)}
            />
            <button type="submit" disabled={addingSource}>
              {addingSource
                ? "Ekleniyor..."
                : activeTab === "community"
                ? "Topluluk Ekle"
                : "Kişi Ekle"}
            </button>
          </form>

          {activeTab === "community" && (searchingVk || suggestions.length > 0) && (
            <div className="autocomplete-list">
              {searchingVk && <div className="autocomplete-empty">VK'da aranıyor...</div>}
              {!searchingVk &&
                suggestions.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className="autocomplete-item"
                    onClick={() => addSourceByRef(item.url)}
                    disabled={addingSource}
                  >
                    <div className="source-info">
                      {item.photo && <img src={item.photo} alt={item.name} className="avatar-sm" />}
                      <div style={{ textAlign: "left" }}>
                        <strong>
                          {item.name} {item.is_verified ? "✓" : ""}
                        </strong>
                        <div className="muted">
                          {item.screen_name ? `@${item.screen_name}` : `club${item.id}`}
                          {item.members_count != null
                            ? ` · ${item.members_count.toLocaleString("tr-TR")} üye`
                            : ""}
                          {item.activity ? ` · ${item.activity}` : ""}
                        </div>
                      </div>
                    </div>
                    <span className="add-pill">+ Ekle</span>
                  </button>
                ))}
            </div>
          )}
        </div>

        {activeTab === "user" && (
          <p className="muted" style={{ marginBottom: "0.75rem" }}>
            Not: VK anonim erişimde isimle kişi aramasına izin vermediği için kişi profili URL,
            kullanıcı adı (screen name) veya ID ile eklenir.
          </p>
        )}
        {sourceErr && <p className="error-text">{sourceErr}</p>}

        <div className="source-list">
          {visibleSources.map((s) => {
            const srcPostCount = getSourcePostCount(s);
            return (
              <div key={s.id} className="source-item">
                <div className="source-info">
                  {activeTab === "user" && s.profile_data?.photo && (
                    <img src={s.profile_data.photo} alt={s.title} className="avatar" />
                  )}
                  <div>
                    <strong>
                      {s.title} {s.profile_data?.is_verified ? "✓" : ""}
                    </strong>{" "}
                    <a href={s.url} target="_blank" rel="noopener noreferrer">
                      ({s.screen_name || (activeTab === "user" ? `id${s.vk_owner_id}` : s.vk_owner_id)})
                    </a>
                    {srcPostCount !== null && (
                      <span className="muted"> · {srcPostCount} gönderi</span>
                    )}
                    {activeTab === "user" && (
                      <span className="muted">
                        {" "}
                        ·{" "}
                        <span className={s.profile_data?.is_online ? "badge-online" : "badge-offline"}>
                          {s.profile_data?.is_online ? "Çevrimiçi" : "Çevrimdışı"}
                        </span>{" "}
                        · {s.is_closed ? "Kapalı Profil" : "Açık Profil"}
                        {s.profile_data?.sex ? ` · ${s.profile_data.sex}` : ""}
                        {s.profile_data?.city ? ` · ${s.profile_data.city}` : ""}
                        {s.profile_data?.followers_count != null
                          ? ` · ${s.profile_data.followers_count.toLocaleString("tr-TR")} takipçi`
                          : ""}
                      </span>
                    )}
                  </div>
                </div>
                <div className="source-actions">
                  {activeTab === "user" && (
                    <button onClick={() => setSelectedUser(s)}>Profil & Ek Veriler</button>
                  )}
                  <button onClick={() => handleToggleSource(s)}>
                    {s.is_active ? "Aktif" : "Pasif"}
                  </button>
                  <button className="btn-danger" onClick={() => handleDeleteSource(s.id)}>
                    Sil
                  </button>
                </div>
              </div>
            );
          })}
          {visibleSources.length === 0 && (
            <p className="muted">
              {activeTab === "community"
                ? "Henüz tanımlı topluluk yok."
                : "Henüz tanımlı kişi yok."}
            </p>
          )}
        </div>
      </section>

      {/* Gönderi Listesi */}
      <section className="panel">
        <h2>
          {activeTab === "community" ? "Topluluk Gönderileri" : "Kişi Gönderileri"} (
          {posts?.total ?? 0})
        </h2>
        <div className="filters">
          <input
            type="search"
            placeholder="Gönderi metninde ara..."
            value={q}
            onChange={(e) => updateFilter(() => setQ(e.target.value))}
          />
          <select
            value={sourceId}
            onChange={(e) => updateFilter(() => setSourceId(e.target.value))}
          >
            <option value="">
              {activeTab === "community" ? "Tüm Topluluklar" : "Tüm Kişiler"}
            </option>
            {visibleSources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => updateFilter(() => setDateFrom(e.target.value))}
          />
          <input
            type="date"
            value={dateTo}
            onChange={(e) => updateFilter(() => setDateTo(e.target.value))}
          />
          <select
            value={sort}
            onChange={(e) => updateFilter(() => setSort(e.target.value as "desc" | "asc"))}
          >
            <option value="desc">En yeni önce</option>
            <option value="asc">En eski önce</option>
          </select>
        </div>

        <div className="post-list">
          {posts?.items.map((p) => (
            <article key={p.id} className="post-card">
              <div className="post-meta">
                <strong>{p.source_title}</strong>
                <span className="muted">{fmtDate(p.published_at)}</span>
              </div>
              <p className="post-text">{renderPreview(p.id, p.text_preview)}</p>
              <div className="post-footer">
                <span className="stats">
                  Beğeni: {p.likes_count} · Yorum: {p.comments_count} · Paylaşım: {p.reposts_count}
                  {p.views_count !== null ? ` · Görüntülenme: ${p.views_count}` : ""}
                </span>
                <div className="post-actions">
                  <button onClick={() => openDetail(p.id)}>Detay</button>
                  <a href={p.url} target="_blank" rel="noopener noreferrer">
                    VK'da Aç ↗
                  </a>
                </div>
              </div>
            </article>
          ))}
          {posts && posts.items.length === 0 && (
            <p className="muted">
              {activeTab === "user"
                ? "Henüz kişi gönderisi yok. Açık profillerin gönderilerini çekmek için yukarıdaki 'Aktif Kişileri Topla' butonuna basın."
                : "Filtrelere uygun gönderi bulunamadı."}
            </p>
          )}
        </div>

        {posts && posts.total_pages > 1 && (
          <div className="pagination">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Önceki
            </button>
            <span>
              Sayfa {posts.page} / {posts.total_pages}
            </span>
            <button disabled={page >= posts.total_pages} onClick={() => setPage((p) => p + 1)}>
              Sonraki
            </button>
          </div>
        )}
      </section>

      {/* Gönderi Detay Modalı */}
      {selectedPost && (
        <div className="modal-backdrop" onClick={() => setSelectedPost(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{selectedPost.source_title}</h3>
              <button onClick={() => setSelectedPost(null)}>Kapat</button>
            </div>
            <p className="muted">
              Yayın: {fmtDate(selectedPost.published_at)} · İlk görülme:{" "}
              {fmtDate(selectedPost.first_seen_at)} · Son görülme:{" "}
              {fmtDate(selectedPost.last_seen_at)}
            </p>
            <div className="modal-text">
              {translateEnabled && translations[selectedPost.id]
                ? translations[selectedPost.id]
                : selectedPost.text || "(Metin yok)"}
            </div>
            <p className="stats">
              Beğeni: {selectedPost.likes_count} · Yorum: {selectedPost.comments_count} · Paylaşım:{" "}
              {selectedPost.reposts_count}
              {selectedPost.views_count !== null
                ? ` · Görüntülenme: ${selectedPost.views_count}`
                : ""}
            </p>

            {selectedPost.attachments && selectedPost.attachments.length > 0 && (
              <div className="attachments">
                <strong>Ekler:</strong>
                {selectedPost.attachments.map((att, idx) => (
                  <div key={idx} className="attachment-item">
                    {att.type === "photo" && att.url ? (
                      <img src={att.url} alt="Gönderi eki" />
                    ) : att.url ? (
                      <a href={att.url} target="_blank" rel="noopener noreferrer">
                        [{att.type}] {att.title || att.url}
                      </a>
                    ) : (
                      <span>
                        [{att.type}] {att.title || ""}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Etkileşim Detayları: Kim Beğendi & Yorumlar */}
            <div
              style={{
                marginTop: "1rem",
                borderTop: "1px solid var(--border)",
                paddingTop: "0.9rem",
                display: "grid",
                gap: "0.9rem",
              }}
            >
              {loadingEngagement ? (
                <div className="muted">Beğenenler ve yorumlar VK'dan çekiliyor...</div>
              ) : engagement ? (
                <>
                  <div>
                    <strong>
                      Beğenenler (
                      {engagement.likes_accessible
                        ? fmtNumber(engagement.likes_total ?? engagement.likers.length, "0")
                        : engagement.likes_error
                        ? `Hata: ${engagement.likes_error}`
                        : "Erişilemez"}
                      ):
                    </strong>
                    {engagement.likers.length > 0 ? (
                      <div style={{ marginTop: "0.4rem", display: "flex", flexWrap: "wrap", gap: "0.45rem" }}>
                        {engagement.likers.map((lk) => (
                          <a
                            key={lk.id}
                            href={lk.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "0.35rem",
                              padding: "0.25rem 0.5rem",
                              border: "1px solid var(--border)",
                              borderRadius: "6px",
                              fontSize: "0.85rem",
                            }}
                          >
                            {lk.photo && (
                              <img
                                src={lk.photo}
                                alt={lk.name}
                                style={{ width: 20, height: 20, borderRadius: "50%", objectFit: "cover" }}
                              />
                            )}
                            <span>{lk.name}</span>
                            {lk.reaction_type && (
                              <span className="muted">({lk.reaction_type})</span>
                            )}
                          </a>
                        ))}
                      </div>
                    ) : (
                      <div className="muted">
                        {engagement.likes_error
                          ? `Hata: ${engagement.likes_error}`
                          : engagement.likes_accessible
                          ? "Beğeni listesi boş veya anonim erişimde gizli"
                          : "Erişilemez"}
                      </div>
                    )}
                  </div>

                  <div>
                    <strong>
                      Yorumlar (
                      {engagement.comments_accessible
                        ? fmtNumber(engagement.comments_total ?? engagement.comments.length, "0")
                        : engagement.comments_error
                        ? `Hata: ${engagement.comments_error}`
                        : "Erişilemez"}
                      ):
                    </strong>
                    {engagement.comments.length > 0 ? (
                      <div style={{ marginTop: "0.4rem", display: "grid", gap: "0.5rem" }}>
                        {engagement.comments.map((cm) => (
                          <div
                            key={cm.id}
                            style={{
                              padding: "0.55rem 0.7rem",
                              border: "1px solid var(--border)",
                              borderRadius: "6px",
                              fontSize: "0.88rem",
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
                              {cm.author_url ? (
                                <a href={cm.author_url} target="_blank" rel="noopener noreferrer">
                                  <strong>{cm.author_name}</strong>
                                </a>
                              ) : (
                                <strong>{cm.author_name}</strong>
                              )}
                              <span className="muted">{fmtDate(cm.date)}</span>
                            </div>
                            <div style={{ marginTop: "0.25rem", whiteSpace: "pre-wrap" }}>
                              {cm.text}
                            </div>
                            {cm.likes_count !== null && cm.likes_count !== undefined && (
                              <div className="muted" style={{ fontSize: "0.8rem" }}>
                                Beğeni: {cm.likes_count}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="muted">
                        {engagement.comments_error
                          ? `Hata: ${engagement.comments_error}`
                          : engagement.comments_accessible
                          ? "Yorum yok veya erişime kapalı"
                          : "Erişilemez"}
                      </div>
                    )}
                  </div>
                </>
              ) : null}
            </div>

            <div style={{ marginTop: "0.9rem" }}>
              <a href={selectedPost.url} target="_blank" rel="noopener noreferrer">
                Orijinal VK Gönderisini Aç ↗
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Kişi Profil & Ek Veriler Modalı */}
      {selectedUser && (
        <div className="modal-backdrop" onClick={() => setSelectedUser(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="source-info">
                {userProfile?.photo && (
                  <img
                    src={userProfile.photo}
                    alt={selectedUser.title}
                    className="avatar-lg"
                  />
                )}
                <div>
                  <h3 style={{ margin: 0 }}>
                    {selectedUser.title} {userProfile?.is_verified ? "✓" : ""}
                  </h3>
                  <span
                    className={
                      userProfile?.is_online ? "badge-online" : "badge-offline"
                    }
                  >
                    {userProfile?.is_online === true
                      ? "Şu an çevrimiçi"
                      : userProfile?.is_online === false
                      ? "Çevrimdışı"
                      : "Çevrimiçi durumu: Erişilemez"}
                  </span>
                </div>
              </div>
              <button onClick={() => setSelectedUser(null)}>Kapat</button>
            </div>

            <p className="muted">
              Profil Erişimi:{" "}
              {selectedUser.is_closed
                ? "Kapalı Profil (yalnızca açık meta veriler erişilebilir)"
                : "Açık Profil"}
            </p>

            <div className="profile-grid">
              <div>
                <strong>Kaydedilen Gönderi Sayısı:</strong>{" "}
                {fmtNumber(getSourcePostCount(selectedUser), "0")}
              </div>
              <div>
                <strong>Cinsiyet:</strong> {fmtFieldText(userProfile?.sex, "Cinsiyet: Erişilemez")}
              </div>
              <div>
                <strong>Durum:</strong> {fmtFieldText(userProfile?.status, "Durum: Erişilemez / Yok")}
              </div>
              <div>
                <strong>Hakkında:</strong> {fmtFieldText(userProfile?.about, "Hakkında: Erişilemez / Yok")}
              </div>
              <div>
                <strong>Şehir:</strong> {fmtFieldText(userProfile?.city, "Şehir: Erişilemez / Yok")}
              </div>
              <div>
                <strong>Ülke:</strong> {fmtFieldText(userProfile?.country, "Ülke: Erişilemez / Yok")}
              </div>
              <div>
                <strong>Memleket:</strong> {fmtFieldText(userProfile?.home_town, "Memleket: Erişilemez / Yok")}
              </div>
              <div>
                <strong>Doğum Tarihi:</strong> {fmtFieldText(userProfile?.bdate, "Doğum tarihi: Erişilemez / Yok")}
              </div>
              <div>
                <strong>İş / Eğitim:</strong> {fmtFieldText(userProfile?.occupation, "İş / Eğitim: Erişilemez / Yok")}
              </div>
              <div>
                <strong>Kariyer:</strong> {fmtFieldText(userProfile?.career, "Kariyer: Erişilemez / Yok")}
              </div>
              <div>
                <strong>Üniversiteler:</strong>{" "}
                {fmtFieldText(userProfile?.universities, "Üniversiteler: Erişilemez / Yok")}
              </div>
              <div>
                <strong>Takipçi Sayısı:</strong>{" "}
                {fmtNumber(userProfile?.followers_count, "Takipçi sayısı: Erişilemez")}
              </div>
              <div>
                <strong>Son Görülme:</strong>{" "}
                {userProfile?.last_seen !== undefined && userProfile?.last_seen !== null
                  ? fmtDate(userProfile.last_seen)
                  : "Son görülme: Erişilemez"}
              </div>
              <div>
                <strong>Web Sitesi:</strong>{" "}
                {fmtFieldText(userProfile?.site, "Web sitesi: Erişilemez / Yok")}
              </div>

              {/* Ek Veriler */}
              <div
                style={{
                  marginTop: "0.75rem",
                  borderTop: "1px solid var(--border)",
                  paddingTop: "0.75rem",
                }}
              >
                <strong>Ek Veri Erişimi (Son Tarama):</strong>

                {!userExtras ? (
                  <div className="muted">
                    Ek veriler henüz çekilmemiş veya erişilemez (Önce "Aktif Kişileri Topla" ile tarayın).
                  </div>
                ) : (
                  <>
                    <div>
                      <strong>Takipçiler:</strong> {renderExtraStatus(userExtras.followers)}
                    </div>
                    <div>
                      <strong>Fotoğraflar:</strong> {renderExtraStatus(userExtras.photos)}
                    </div>
                    <div>
                      <strong>Videolar:</strong> {renderExtraStatus(userExtras.videos)}
                    </div>
                    <div>
                      <strong>Abonelikler:</strong>{" "}
                      {!userExtras.subscriptions
                        ? "Erişilemez / Veri yok"
                        : userExtras.subscriptions.error
                        ? `Hata: ${userExtras.subscriptions.error}`
                        : userExtras.subscriptions.accessible === false
                        ? "Erişime kapalı"
                        : `Erişilebilir (${fmtNumber(userExtras.subscriptions.groups_total, "0")} topluluk · ${fmtNumber(userExtras.subscriptions.users_total, "0")} kişi)`}
                    </div>

                    {/* Aranabilir ve Sayfalı Takipçiler Listesi */}
                    <div style={{ marginTop: "0.6rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                        <strong>Takipçiler Listesi ({dbFollowersTotal} kayıt):</strong>
                        <label style={{ fontSize: "0.82rem", display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                          <input
                            type="checkbox"
                            checked={onlyUnfollowed}
                            onChange={(e) => {
                              setOnlyUnfollowed(e.target.checked);
                              setFollowerPage(1);
                            }}
                          />
                          Sadece takibi bırakanlar
                        </label>
                      </div>

                      <div style={{ marginTop: "0.35rem", marginBottom: "0.4rem" }}>
                        <input
                          type="search"
                          placeholder="Veritabanındaki takipçilerde isim veya link ara..."
                          value={followerSearch}
                          onChange={(e) => {
                            setFollowerSearch(e.target.value);
                            setFollowerPage(1);
                          }}
                          style={{
                            width: "100%",
                            padding: "0.4rem 0.6rem",
                            border: "1px solid var(--border-input)",
                            borderRadius: "6px",
                            background: "var(--surface)",
                            color: "var(--text)",
                            fontSize: "0.85rem",
                          }}
                        />
                      </div>

                      {dbFollowers.length > 0 ? (
                        <>
                          <div
                            style={{
                              maxHeight: 200,
                              overflowY: "auto",
                              display: "flex",
                              flexWrap: "wrap",
                              gap: "0.4rem",
                              padding: "0.4rem",
                              border: "1px solid var(--border)",
                              borderRadius: "6px",
                            }}
                          >
                            {dbFollowers.map((f) => {
                              const fName = f.name || `id${f.id}`;
                              const avatar = f.photo || f.photo_url;
                              const isUnfollowed = f.is_following === false;
                              return (
                                <div
                                  key={f.id}
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "0.35rem",
                                    padding: "0.25rem 0.5rem",
                                    border: "1px solid var(--border)",
                                    borderRadius: "5px",
                                    fontSize: "0.82rem",
                                    opacity: isUnfollowed ? 0.75 : 1,
                                  }}
                                >
                                  {avatar && (
                                    <img
                                      src={avatar}
                                      alt={fName}
                                      style={{ width: 18, height: 18, borderRadius: "50%", objectFit: "cover" }}
                                    />
                                  )}
                                  <a href={f.url} target="_blank" rel="noopener noreferrer">
                                    {fName}
                                  </a>
                                  {isUnfollowed && (
                                    <span className="muted">
                                      (Takibi bıraktı: {fmtDate(f.unfollowed_at)})
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>

                          {dbFollowersTotalPages > 1 && (
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                marginTop: "0.4rem",
                                fontSize: "0.82rem",
                              }}
                            >
                              <button
                                type="button"
                                disabled={followerPage <= 1}
                                onClick={() => setFollowerPage((p) => Math.max(1, p - 1))}
                              >
                                Önceki
                              </button>
                              <span className="muted">
                                Sayfa {followerPage} / {dbFollowersTotalPages}
                              </span>
                              <button
                                type="button"
                                disabled={followerPage >= dbFollowersTotalPages}
                                onClick={() =>
                                  setFollowerPage((p) => Math.min(dbFollowersTotalPages, p + 1))
                                }
                              >
                                Sonraki
                              </button>
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="muted">Kayıtlı takipçi bulunamadı.</div>
                      )}
                    </div>

                    {/* Fotoğraflar */}
                    <div style={{ marginTop: "0.6rem" }}>
                      <strong>Fotoğraflar ({photoEntries.length} kayıt gösteriliyor):</strong>
                      {photoEntries.length > 0 ? (
                        <div
                          style={{
                            display: "flex",
                            gap: "0.5rem",
                            flexWrap: "wrap",
                            marginTop: "0.35rem",
                          }}
                        >
                          {photoEntries.map((ph, idx) => (
                            <a
                              key={`${ph.id}-${idx}`}
                              href={ph.link}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={ph.text || ph.link}
                            >
                              <img
                                src={ph.url}
                                alt={ph.text || "Profil fotoğrafı"}
                                style={{
                                  width: 72,
                                  height: 72,
                                  objectFit: "cover",
                                  borderRadius: 6,
                                  border: "1px solid var(--border)",
                                }}
                              />
                            </a>
                          ))}
                        </div>
                      ) : (
                        <div className="muted">
                          {userExtras.photos?.error
                            ? `Hata: ${userExtras.photos.error}`
                            : "Fotoğraf bulunamadı veya erişilemez"}
                        </div>
                      )}
                    </div>

                    {/* Videolar */}
                    <div style={{ marginTop: "0.6rem" }}>
                      <strong>Videolar ({videoEntries.length} kayıt gösteriliyor):</strong>
                      {videoEntries.length > 0 ? (
                        <ul style={{ margin: "0.25rem 0", paddingLeft: "1.2rem" }}>
                          {videoEntries.map((v, idx) => (
                            <li key={`${v.id}-${idx}`}>
                              <a href={v.link} target="_blank" rel="noopener noreferrer">
                                {v.title}
                              </a>
                              {v.views !== undefined && v.views !== null && (
                                <span className="muted">
                                  {" "}
                                  ({fmtNumber(v.views, "0")} görüntülenme)
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="muted">
                          {userExtras.videos?.error
                            ? `Hata: ${userExtras.videos.error}`
                            : "Video bulunamadı veya erişilemez"}
                        </div>
                      )}
                    </div>

                    {/* Takip Edilen Topluluklar ve Kişiler */}
                    <div style={{ marginTop: "0.6rem" }}>
                      <strong>Takip Edilen Topluluklar ({subGroupEntries.length}):</strong>
                      {subGroupEntries.length > 0 ? (
                        <div style={{ marginTop: "0.25rem" }}>
                          {subGroupEntries.map((g, i) => (
                            <span key={`${g.id}-${i}`}>
                              {i > 0 ? ", " : ""}
                              <a href={g.url} target="_blank" rel="noopener noreferrer">
                                {g.name}
                              </a>
                              {g.members_count != null && (
                                <span className="muted"> ({fmtNumber(g.members_count)})</span>
                              )}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div className="muted">Takip edilen topluluk yok veya erişilemez</div>
                      )}
                    </div>

                    <div style={{ marginTop: "0.5rem" }}>
                      <strong>Takip Edilen Kişiler ({subUserEntries.length}):</strong>
                      {subUserEntries.length > 0 ? (
                        <div style={{ marginTop: "0.25rem" }}>
                          {subUserEntries.map((su, i) => (
                            <span key={`${su.id}-${i}`}>
                              {i > 0 ? ", " : ""}
                              <a href={su.url} target="_blank" rel="noopener noreferrer">
                                {su.name}
                              </a>
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div className="muted">Takip edilen kişi yok veya erişilemez</div>
                      )}
                    </div>
                  </>
                )}
              </div>

              <div className="muted" style={{ marginTop: "0.5rem" }}>
                <strong>Erişilebilen Profil Alanları:</strong>{" "}
                {fmtFieldText(
                  userProfile?.accessible_fields,
                  "Erişilebilen alan listesi mevcut değil"
                )}
              </div>
            </div>

            <div style={{ marginTop: "0.75rem" }}>
              <a href={selectedUser.url} target="_blank" rel="noopener noreferrer">
                VK Profilini Aç ↗
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}