import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type {
  CommunitySearchItem,
  Overview,
  PaginatedPosts,
  PostDetail,
  Source,
  SourceType,
} from "./types";
import "./App.css";

type ThemeMode = "light" | "dark";

const getInitialTheme = (): ThemeMode => {
  try {
    const saved = localStorage.getItem("vk_theme");
    if (saved === "dark" || saved === "light") return saved;
    if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) return "dark";
  } catch {
    // depolama erişimi yoksa varsayılan tema kullanılır
  }
  return "light";
};

const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString("tr-TR") : "—";

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
  const [selectedUser, setSelectedUser] = useState<Source | null>(null);

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

  const openDetail = async (id: number) => {
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
          {visibleSources.map((s) => (
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
          ))}
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
            <a href={selectedPost.url} target="_blank" rel="noopener noreferrer">
              Orijinal VK Gönderisini Aç ↗
            </a>
          </div>
        </div>
      )}

      {/* Kişi Profil & Ek Veriler Modalı */}
      {selectedUser && (
        <div className="modal-backdrop" onClick={() => setSelectedUser(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="source-info">
                {selectedUser.profile_data?.photo && (
                  <img
                    src={selectedUser.profile_data.photo}
                    alt={selectedUser.title}
                    className="avatar-lg"
                  />
                )}
                <div>
                  <h3 style={{ margin: 0 }}>
                    {selectedUser.title} {selectedUser.profile_data?.is_verified ? "✓" : ""}
                  </h3>
                  <span
                    className={
                      selectedUser.profile_data?.is_online ? "badge-online" : "badge-offline"
                    }
                  >
                    {selectedUser.profile_data?.is_online ? "Şu an çevrimiçi" : "Çevrimdışı"}
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
            {selectedUser.profile_data && (
              <div className="profile-grid">
                {selectedUser.profile_data.sex && (
                  <div><strong>Cinsiyet:</strong> {selectedUser.profile_data.sex}</div>
                )}
                {selectedUser.profile_data.status && (
                  <div><strong>Durum:</strong> {selectedUser.profile_data.status}</div>
                )}
                {selectedUser.profile_data.about && (
                  <div><strong>Hakkında:</strong> {selectedUser.profile_data.about}</div>
                )}
                {selectedUser.profile_data.city && (
                  <div><strong>Şehir:</strong> {selectedUser.profile_data.city}</div>
                )}
                {selectedUser.profile_data.country && (
                  <div><strong>Ülke:</strong> {selectedUser.profile_data.country}</div>
                )}
                {selectedUser.profile_data.bdate && (
                  <div><strong>Doğum Tarihi:</strong> {selectedUser.profile_data.bdate}</div>
                )}
                {selectedUser.profile_data.occupation && (
                  <div><strong>İş / Eğitim:</strong> {selectedUser.profile_data.occupation}</div>
                )}
                {selectedUser.profile_data.universities &&
                  selectedUser.profile_data.universities.length > 0 && (
                    <div>
                      <strong>Üniversiteler:</strong>{" "}
                      {selectedUser.profile_data.universities.join(" | ")}
                    </div>
                  )}
                {selectedUser.profile_data.followers_count != null && (
                  <div>
                    <strong>Takipçi:</strong>{" "}
                    {selectedUser.profile_data.followers_count.toLocaleString("tr-TR")}
                  </div>
                )}
                {selectedUser.profile_data.last_seen && (
                  <div><strong>Son Görülme:</strong> {fmtDate(selectedUser.profile_data.last_seen)}</div>
                )}
                {selectedUser.profile_data.site && (
                  <div><strong>Web Sitesi:</strong> {selectedUser.profile_data.site}</div>
                )}

                {selectedUser.profile_data.extras && (
                  <div style={{ marginTop: "0.75rem", borderTop: "1px solid var(--border)", paddingTop: "0.75rem" }}>
                    <strong>Ek Veri Erişimi (Son Tarama):</strong>
                    <div>
                      Takipçiler:{" "}
                      {selectedUser.profile_data.extras.followers?.accessible
                        ? `Erişilebilir (${selectedUser.profile_data.extras.followers.total?.toLocaleString("tr-TR") ?? 0})`
                        : "Erişime kapalı"}
                    </div>
                    <div>
                      Fotoğraflar:{" "}
                      {selectedUser.profile_data.extras.photos?.accessible
                        ? `Erişilebilir (${selectedUser.profile_data.extras.photos.total ?? 0})`
                        : "Erişime kapalı"}
                    </div>
                    <div>
                      Videolar:{" "}
                      {selectedUser.profile_data.extras.videos?.accessible
                        ? `Erişilebilir (${selectedUser.profile_data.extras.videos.total ?? 0})`
                        : "Erişime kapalı"}
                    </div>

                    {selectedUser.profile_data.extras.followers?.sample &&
                      selectedUser.profile_data.extras.followers.sample.length > 0 && (
                        <div style={{ marginTop: "0.5rem" }}>
                          <strong>Örnek Takipçiler:</strong>{" "}
                          {selectedUser.profile_data.extras.followers.sample.map((f, i) => (
                            <span key={f.id}>
                              {i > 0 ? ", " : ""}
                              <a href={f.url} target="_blank" rel="noopener noreferrer">
                                {f.name}
                              </a>
                            </span>
                          ))}
                        </div>
                      )}

                    {selectedUser.profile_data.extras.photos?.sample &&
                      selectedUser.profile_data.extras.photos.sample.length > 0 && (
                        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
                          {selectedUser.profile_data.extras.photos.sample.slice(0, 6).map((ph) => (
                            <a key={ph.id} href={ph.link} target="_blank" rel="noopener noreferrer">
                              <img
                                src={ph.url}
                                alt="Profil fotoğrafı"
                                style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 6 }}
                              />
                            </a>
                          ))}
                        </div>
                      )}

                    {selectedUser.profile_data.extras.videos?.sample &&
                      selectedUser.profile_data.extras.videos.sample.length > 0 && (
                        <div style={{ marginTop: "0.5rem" }}>
                          <strong>Son Videolar:</strong>
                          <ul style={{ margin: "0.25rem 0", paddingLeft: "1.2rem" }}>
                            {selectedUser.profile_data.extras.videos.sample.slice(0, 5).map((v) => (
                              <li key={v.id}>
                                <a href={v.link} target="_blank" rel="noopener noreferrer">
                                  {v.title}
                                </a>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                    {selectedUser.profile_data.extras.subscriptions && (
                      <div style={{ marginTop: "0.5rem" }}>
                        <div>
                          Abonelikler:{" "}
                          {selectedUser.profile_data.extras.subscriptions.accessible
                            ? `${selectedUser.profile_data.extras.subscriptions.groups_total ?? 0} topluluk · ${selectedUser.profile_data.extras.subscriptions.users_total ?? 0} kişi`
                            : "Erişime kapalı"}
                        </div>
                        {selectedUser.profile_data.extras.subscriptions.groups_sample.length > 0 && (
                          <div style={{ marginTop: "0.25rem" }}>
                            <strong>Takip Edilen Topluluklar:</strong>{" "}
                            {selectedUser.profile_data.extras.subscriptions.groups_sample.map((g, i) => (
                              <span key={g.id}>
                                {i > 0 ? ", " : ""}
                                <a href={g.url} target="_blank" rel="noopener noreferrer">
                                  {g.name}
                                </a>
                              </span>
                            ))}
                          </div>
                        )}
                        {selectedUser.profile_data.extras.subscriptions.users_sample.length > 0 && (
                          <div style={{ marginTop: "0.25rem" }}>
                            <strong>Takip Edilen Kişiler:</strong>{" "}
                            {selectedUser.profile_data.extras.subscriptions.users_sample.map((su, i) => (
                              <span key={su.id}>
                                {i > 0 ? ", " : ""}
                                <a href={su.url} target="_blank" rel="noopener noreferrer">
                                  {su.name}
                                </a>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {selectedUser.profile_data.accessible_fields && (
                  <div className="muted" style={{ marginTop: "0.5rem" }}>
                    <strong>Erişilebilen Profil Alanları:</strong>{" "}
                    {selectedUser.profile_data.accessible_fields.join(", ")}
                  </div>
                )}
              </div>
            )}
            <a href={selectedUser.url} target="_blank" rel="noopener noreferrer">
              VK Profilini Aç ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}