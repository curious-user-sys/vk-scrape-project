Seçilen Yöntem: VK'nın kendi web istemcisinin kullandığı dahili JSON API (web.api.vk.ru/method/*, API v5.289). Tarayıcı otomasyonu (Playwright/Selenium) veya kullanıcı oturumu gerektirmez; curl_cffi (impersonate="chrome") ile doğrudan HTTP POST istekleri atılır.

Erişim Bilgileri / Kimlik Doğrulama: Kullanıcı hesabı veya kişisel API anahtarı gerekmez. login.vk.ru/?act=get_anonym_token üzerinden VK'nın herkese açık web istemci sabitleriyle (client_id=6287487) 24 saat geçerli anonim token (anonym.<jwt>) üretilir ve süreç boyunca bellekte tutulur.

Doğrulanan Kaynak: [https://vk.ru/gazeta](https://vk.ru/gazeta) (Газета.Ru, id: 20169232, owner_id: -20169232, access: open, members_count: 506221). Hem vk.com hem vk.ru domainleri desteklenir.

Erişilebilir Alanlar:

    Topluluk: id, owner_id, name, screen_name, link, description, members_count, is_verified, photo, cover.

    Gönderi: id, owner_id, link, author, text, date (ISO-8601 UTC), edited, is_pinned, stats (likes, comments, reposts, views, reactions), attachments (fotoğraf, video, link, belge, anket, makale vb.), repost_of.

Bilinen Limitler ve Performans:

    wall.get sayfa başına 20 gönderi döndürür; 100 gönderi için 5 sayfa gerekir.

    5 sayfalık (100 gönderi) canlı testte tüm istekler HTTP 200 döndü; önbelleksiz sayfa başına yanıt süresi 0.78s – 1.54s aralığında ölçüldü (toplam ~4.7s).

    Anonim token ile groups.getMembers en fazla 8 üye önizlemesine izin verir; wall.get ve groups.getById tarafında 100 gönderilik taramada bloklama (429/403) gözlenmedi.


    # VK Veri Toplama ve Görüntüleme Paneli (`vk-scrape`)

VK (`vk.com` / `vk.ru`) üzerindeki herkese açık topluluklardan ve kişi profillerinden (açık/kapalı) veri toplayan, PostgreSQL veritabanında saklayan ve Türkçe web arayüzünde aranabilir, filtrelenebilir biçimde sunan uçtan uca uygulama.

## Teknoloji Seçimi ve Gerekçesi

- **Backend — Python + FastAPI + SQLAlchemy 2.0 + Alembic:** Hızlı REST API geliştirme, otomatik OpenAPI/Swagger (`/docs`) dokümantasyonu, arka plan görevleri (`BackgroundTasks`) ve şema sürümleme (migration) kolaylığı için seçildi.
- **Veritabanı — PostgreSQL:** Yapısal verilerle (`sources`, `posts`, `scrape_runs`) birlikte esnek ek verileri (`attachments`, `profile_data`) `JSONB` olarak saklamak ve indeksli arama/sıralama yapmak için tercih edildi.
- **Veri Çekme — `curl_cffi` (Chrome TLS taklidi):** Tarayıcı otomasyonu (Playwright/Selenium) maliyeti olmadan VK'nın dahili web API'siyle doğrudan ve hızlı iletişim kurar.
- **Frontend — React + TypeScript + Vite:** Tip güvenli, hızlı geliştirilen ve masaüstü/mobil uyumlu sade bir Türkçe yönetim paneli için kullanıldı.

---

## Özellikler

- **Topluluk ve Kişi Ayrımı:** Üstteki geçiş (toggle) ile topluluklar ve kişi profilleri ayrı istatistikler, kaynak listeleri ve gönderi akışlarıyla yönetilir.
- **Canlı Topluluk Araması (Autocomplete):** Topluluk adı yazıldıkça VK üzerinde anlık arama yapar; URL, kullanıcı adı (`screen_name`) veya ID ile ekleme de desteklenir.
- **Arka Plan Toplama ve Dayanıklılık:**
  - Toplama işlemi arayüzü bekletmeden arka planda çalışır.
  - `(source_id, vk_post_id)` benzersiz anahtarı üzerinden **upsert** yapılır; mükerrer kayıt oluşmaz, mevcut gönderilerin etkileşim sayıları ve `last_seen_at` zamanı güncellenir.
  - Son taramada görünmeyen gönderiler otomatik silinmez.
  - Bir kaynağın hata vermesi diğer kaynakların işlenmesini engellemez; çalışma özeti `scrape_runs` tablosuna kaydedilir.
- **Kişi Profilleri ve Kapalı Profil Analizi:** Açık profillerde duvar gönderileri, takipçi/fotoğraf/video özetleri ve profil detayları (cinsiyet, çevrimiçi durumu, üniversiteler vb.) çekilir. Kapalı profillerde erişilebilen açık meta veriler kaydedilir ve kapalı uç noktalar hata üretmeden raporlanır.
- **Arama, Filtreleme ve Sayfalama:** Gönderi metninde arama, kaynak ve tarih aralığı filtresi, artan/azalan sıralama ve sunucu tarafında sayfalama.
- **İçerik Çevirisi (TR):** Arayüzü bozmadan yalnızca gönderi içeriklerini Türkçeye çeviren aç/kapa anahtarı ve diske önbellekleme (`translation_cache.json`).
- **Güvenlik:** Kaynak girdileri yalnızca `vk.com` / `vk.ru` alan adlarıyla sınırlandırılır (SSRF koruması). Gönderi metinleri düz metin olarak güvenli biçimde render edilir.

---

## Teknik Erişim Notu (Veri Toplama Yöntemi ve Limitler)

- **Yöntem:** VK'nın web istemcisinin kullandığı dahili JSON API (`web.api.vk.ru/method/*`, API `v5.289`).
- **Kimlik Doğrulama:** Kullanıcı hesabı, cookie veya kişisel token gerektirmez. `login.vk.ru/?act=get_anonym_token` üzerinden 24 saat geçerli anonim token üretilir ve süreç boyunca bellekte tutulur.
- **Doğrulanan Kaynaklar:**
  - Topluluk: `https://vk.ru/gazeta` (`id: 20169232`, `owner_id: -20169232`) — 5 sayfa (100 gönderi) HTTP 200, sayfa başına ~0.8–1.5 sn.
  - Kişi: `https://vk.com/durov` (`id: 1`) — `users.get`, `wall.get`, `users.getFollowers`, `photos.getAll`, `video.get` doğrulandı.
- **Bilinen Limitler:**
  - `wall.get` sayfa başına 20 gönderi döndürür (100 gönderi = 5 istek).
  - Anonim token ile `users.search`, `search.getHints`, `friends.get` ve `users.getSubscriptions` metotları VK tarafından kısıtlıdır; bu nedenle kişi ekleme işlemi URL, kullanıcı adı veya ID ile yapılır.
  - İstek hızı `.env` içindeki `REQUEST_DELAY_SECONDS` ile yapılandırılabilir.

---

## Kurulum ve Çalıştırma (Linux)
# VK Veri Toplama ve Görüntüleme Paneli (`vk-scrape`)

VK (`vk.com` / `vk.ru`) üzerindeki topluluklardan ve kişi profillerinden (açık/kapalı) veri toplayan, PostgreSQL veritabanında saklayan ve Türkçe web arayüzünde sunan ygulama.

---

## Gereksinimler

- **Python** 3.11+
- **PostgreSQL** 14+
- **Node.js** 20+ ve **npm**

---

## Hızlı Kurulum ve Çalıştırma (Linux)

### 1. Repoyu İndir
```bash
git clone <REPO_URL>
cd vk-scrape

```

### 2. PostgreSQL Veritabanını Hazırla

```bash
sudo systemctl enable --now postgresql
sudo -u postgres psql -c "CREATE USER vkuser WITH PASSWORD 'vkpass';"
sudo -u postgres psql -c "CREATE DATABASE vk_scrape OWNER vkuser;"

```

### 3. Backend'i Kur ve Çalıştır

Yeni bir terminal aç:

```bash
cd vk-scrape/backend
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

cp .env.example .env
alembic upgrade head
uvicorn app.main:app --reload --port 8000

```

* Backend adresi: `http://localhost:8000`
* Swagger API dokümantasyonu: `http://localhost:8000/docs`

### 4. Frontend'i Kur ve Çalıştır

Başka bir terminal aç:

```bash
cd vk-scrape/frontend
cp .env.example .env
npm install
npm run dev

```

* Web arayüzü adresi: `http://localhost:5173`

---

## Kullanım Özeti

1. **Topluluk / Kişi Geçişi:** Üstteki **Topluluklar** ve **Kişiler** sekmeleriyle istatistikleri, kaynakları ve gönderileri ayrı ayrı görüntüleyebilirsin.
2. **Kaynak Ekleme ve Canlı Arama:**
* **Topluluklar** sekmesinde isim yazarak canlı arama sonuçlarından seçebilir veya VK topluluk URL'si/kimliği girebilirsin.
* **Kişiler** sekmesinde profil URL'si, kullanıcı adı (`screen_name`) veya sayısal ID (`id1`, `durov`, `https://vk.com/durov`) ile kişi ekleyebilirsin.


3. **Veri Toplama:** Sağ üstteki **Aktif Toplulukları Topla** veya **Aktif Kişileri Topla** butonu toplama işlemini arka planda başlatır.
4. **Filtreleme ve Detay:** Gönderilerde metin araması, kaynak filtresi, tarih aralığı ve sıralama yapabilir; **Detay** ile tam metin ve ekleri, **Profil & Ek Veriler** ile kişi profil detaylarını ve erişilebilen takipçi/fotoğraf/video/abonelik bilgilerini inceleyebilirsin.
5. **Türkçe Çeviri:** Üst bardaki **TR Çeviri** anahtarıyla yalnızca mevcut sayfadaki gönderi içeriklerini Türkçeye çevirebilir, **Çeviriyi İptal Et** ile işlemi durdurabilir ve anahtarı kapatarak orijinal metne dönebilirsin.

---

## Sık Karşılaşılan Durumlar

* **409 Conflict (`/api/scrape/run`):** Arka planda devam eden bir toplama işlemi varken tekrar tetiklendiğinde döner; mevcut tarama bitince tekrar çalıştırılabilir.
* **Kapalı Profiller (`is_closed: true`):** Gizli profillerde duvar gönderileri ve özel listeler VK gizlilik kuralları gereği erişime kapalıdır; yalnızca açık profil meta verileri kaydedilir.
* **Port Çakışması:** `8000` (backend) veya `5173` (frontend) portları doluysa ilgili süreci kapatıp veya port parametresi vererek yeniden başlatabilirsin.

```

```