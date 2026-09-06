# Dashboard Peringatan Dini Harga Pertamax & Pertamax Turbo

Dashboard statis (HTML/CSS/JS) + otomasi update data via GitHub Actions, untuk memantau skor risiko kenaikan harga Pertamax & Pertamax Turbo.

## Cara deploy ke GitHub Pages (sekali saja)

1. Buat repository baru di GitHub (bisa publik atau privat), misal nama `bbm-dashboard`.
2. Upload SEMUA file & folder ini ke root repository, termasuk folder `.github/` dan `scripts/` (jangan cuma file HTML/CSS/JS-nya saja):
   `index.html`, `style.css`, `app.js`, `data.json`, `README.md`, `.github/workflows/update-data.yml`, `scripts/update-data.mjs`
   - Paling gampang: **Add file → Upload files**, drag semua file & folder ini sekaligus, lalu **Commit changes**. GitHub otomatis mempertahankan struktur folder `.github/` dan `scripts/`.
3. Masuk **Settings → Pages** → **Source: Deploy from a branch** → pilih `main` / `/ (root)` → **Save**.
4. Tunggu 1-2 menit, situsnya live di `https://<username>.github.io/bbm-dashboard/`.

## Cara mengaktifkan update otomatis ICP & kurs (oilpriceapi.com)

1. Daftar API key di oilpriceapi.com.
2. Di repo GitHub: **Settings → Secrets and variables → Actions → New repository secret**.
   - Name: `OILPRICEAPI_KEY`
   - Value: (tempel API key kamu di sini — HANYA di sini, jangan pernah di file/chat manapun)
3. **PENTING:** buka `scripts/update-data.mjs`, cek konstanta `MOGAS92_CODE` di bagian atas. Verifikasi kode commodity yang benar untuk "Singapore Mogas 92" di dashboard/API reference akun oilpriceapi kamu (dokumentasi publik mereka tidak selalu konsisten soal nama kode ini) — sesuaikan kalau perlu.
4. Workflow (`update-data.yml`) akan otomatis jalan tiap hari (05:00 WIB) untuk:
   - Ambil harga Brent, Dubai, dan Mogas92 live dari oilpriceapi.com
   - Ambil kurs USD/IDR **langsung dari Bank Indonesia** via Frankfurter.dev (`providers=BI`) — gratis, tanpa key
   - Estimasi ICP Pertamax Turbo dari blend Brent+Dubai (50/50, placeholder — lihat catatan kalibrasi di bawah)
   - Pakai harga Mogas92 live LANGSUNG sebagai MOPS Pertamax (lebih akurat dari estimasi ICP+crack)
   - Update bulan berjalan di `data.json`, commit & push otomatis
5. Bisa juga dipicu manual: tab **Actions** di repo → pilih workflow **"Update BBM dashboard data"** → **Run workflow**.
6. Setiap kali `data.json` ter-update (otomatis maupun manual), GitHub Pages otomatis rebuild dashboard.

## Cara update harga Pertamax/Pertamax Turbo (TETAP MANUAL)

Harga real Pertamax & Pertamax Turbo TIDAK diambil otomatis (tidak ada API resmi untuk ini). Begitu ada pengumuman resmi perubahan harga dari Pertamina:
1. Buka `data.json`
2. Cari baris bulan berjalan di array `"monthly"`, ubah `pertamax_actual` dan/atau `turbo_actual` sesuai harga baru
3. Commit — dashboard otomatis update

## Kalibrasi ICP estimasi (Brent+Dubai) — SUDAH DIKALIBRASI

Regresi linear terhadap 51 bulan ICP resmi (ESDM, tersitasi) 2019-2026:

```
ICP_estimasi = 0,7575 × Brent + 0,2887 × Dubai − 4,722
```

R²=0,985, RMSE≈US$2,55/barel. Formula ini sudah diterapkan di `update-data.mjs` (`ICP_MODEL`). **Keterbatasan:** model ini melemah saat guncangan geopolitik ekstrem — pada April 2026 (konflik Timur Tengah), selisih estimasi vs ICP asli sempat >US$12/barel. Kalibrasi ulang berkala dianjurkan begitu ada lebih banyak data, terutama untuk menangkap periode-periode krisis.

## Cara kerja skor & kalibrasi ambang (hasil backtest + bootstrap)

- **Pertamax**: ambang gap 31%, recall 50%, presisi 100% (n=6 bulan merah) — CI presisi perlu dibaca hati-hati karena sample kecil (lihat diskusi bootstrap).
- **Pertamax Turbo**: ambang gap 20%, recall 75%, presisi 80% (n=10 bulan merah).
- Bobot & ambang lengkap ada di `WEIGHTS` (`app.js`), terpisah per produk.
- `data.json` sudah diisi `mogas92_live` untuk bulan-bulan yang punya data pasar riil historis (Sep 2022 - Ags 2024, Jun 2026) dari kontrak TradingView X01/1NA1 — field ini otomatis diprioritaskan dibanding estimasi ICP+crack.

## Keterbatasan yang perlu diketahui

- **Harga keekonomian adalah estimasi**, bukan angka resmi Pertamina.
- **Backtest hanya berdasarkan 4 kejadian kenaikan besar per produk** — sample kecil, angka recall/presisi indikatif, bukan jaminan statistik ke depan.
- **Model ini secara struktural tidak bisa menangkap kenaikan bertahap kecil (~10-12%) tanpa penahanan gap besar** — hanya efektif untuk pola "ditahan lama lalu meledak."
- **Estimasi ICP dari Brent/Dubai (regresi terkalibrasi, R²=0,985) melemah saat guncangan geopolitik ekstrem** — bisa meleset >US$12/barel pada bulan dengan lonjakan tiba-tiba seperti April 2026.
