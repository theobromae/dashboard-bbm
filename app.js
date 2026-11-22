/* ============================================================
   DASHBOARD PERINGATAN DINI HARGA PERTAMAX / PERTAMAX TURBO
   ------------------------------------------------------------
   Cara update data bulanan:
   1. Buka data.json
   2. Tambahkan satu baris baru di array "monthly" untuk bulan berjalan:
      { "month": "2026-10", "icp": 82.5, "kurs": 17950,
        "pertamax_actual": 15950, "turbo_actual": 19600 }
      - icp: ICP bulan tsb dari rilis Kementerian ESDM (migas.esdm.go.id)
      - kurs: kurs tengah BI rata-rata bulan tsb (atau JISDOR)
      - pertamax_actual / turbo_actual: harga jual resmi TERAKHIR yang
        berlaku di bulan tsb (kalau tidak ada perubahan, ulangi angka
        bulan sebelumnya)
   3. Kalau riset asumsi ICP APBN sudah ada, isi di "apbn_icp_assumptions.values",
      format: { "2019": 60, "2020": 63, ... }
   4. Commit & push -- GitHub Pages otomatis update.

   MOPS (2026-09-29): RON92 = Mogas 92 live/historis, fallback ICP + 10,32.
   RON98 = Mogas 97 historis (X01) kalau ada, selain itu MOPS RON92 +
   rerata gap 97-92 (data.json -> mogas_gap_97_92). Crack spread RON98
   lama (ICP + 17,02) sudah tidak dipakai.

   KALIBRASI PER PRODUK (hasil backtest 93 bulan, 2019-2026):
   Pertamax (RON92) lebih dipengaruhi diskresi politik -- gap-nya bisa
   dibiarkan besar berbulan-bulan sebelum harga benar2 disesuaikan, jadi
   bobot "durasi tertahan" dinaikkan dan ambang lebih tinggi. Backtest:
   recall 50%, presisi 100% (0 false positive dari 4 bulan merah).

   Pertamax Turbo (RON98) jauh lebih "taat formula" (jarang ditahan
   lama), jadi bobot gap+durasi digabung lebih besar dan momentum/APBN
   dikurangi. Backtest: recall 75%, presisi 80%.

   Recall/presisi ini dihitung dari HANYA 4 kejadian kenaikan >=8% per
   produk sepanjang 2019-2026 -- sample kecil, jadi angka ini indikatif,
   bukan jaminan statistik. Kalibrasi ulang berkala dianjurkan begitu
   ada lebih banyak data/kejadian baru.
   ============================================================ */

const WEIGHTS = {
  ron92: {
    gap: 0.25, duration: 0.45, momentum: 0.15, apbn: 0.15,
    gapMaxPct: 50, durationMaxMonths: 4,
    icpMom3MaxPct: 30, kursMom3MaxPct: 10, apbnMaxDevPct: 30,
    gapThresholdPct: 31, redAt: 66, amberAt: 35,
  },
  ron98: {
    gap: 0.40, duration: 0.40, momentum: 0.10, apbn: 0.10,
    gapMaxPct: 50, durationMaxMonths: 4,
    icpMom3MaxPct: 30, kursMom3MaxPct: 10, apbnMaxDevPct: 30,
    gapThresholdPct: 20, redAt: 55, amberAt: 30,
  },
};

function regimeConstant(monthStr, product) {
  // Kepmen ESDM: konstanta Rp/liter (batas atas) per rezim
  const [y, m] = monthStr.split("-").map(Number);
  const ym = y * 100 + m;
  if (ym < 202001) return product === "ron92" ? 2542 : 3178;   // Kepmen 19/2019
  if (ym <= 202002) return product === "ron92" ? 1000 : 1200;  // Kepmen 187/2019
  return product === "ron92" ? 1800 : 2000;                     // Kepmen 62/2020
}

// Crack spread RON92 rata-rata (1NA1) -- fallback terakhir kalau tidak ada
// harga Mogas 92 sama sekali (histori 2019-2022 & Sep 2024 - Mei 2026).
const CRACK_SPREAD_RON92 = 10.32;

// Rerata selisih Mogas 97 - Mogas 92 (US$/bbl). Nilai resmi dibaca dari
// data.json -> mogas_gap_97_92.value (dihitung scripts/backfill_mogas_history.py,
// 430 hari data TradingView). Angka di bawah hanya default kalau field itu
// tidak ada. Menggantikan crack spread RON98 lama (ICP + 17,02) yang
// MAE-nya ~5,2 US$/bbl vs ~0,87 US$/bbl untuk metode gap ini, dan yang
// bisa membuat harga keekonomian Turbo < Pertamax saat ICP & Mogas92
// bergerak tidak searah.
let GAP_97_92 = 5.66;

// MOPS RON92 (US$/bbl), urutan prioritas:
//   1. mogas92_live      -- oilpriceapi (hari/bulan berjalan)
//   2. mogas92_hist      -- histori TradingView (Dubai + 1NA1)
//   3. mogas92_estimated -- fallback rolling-average dari update-data.mjs
//   4. ICP + crack spread RON92 rata-rata
function mopsRon92(r) {
  if (r.mogas92_live != null) return r.mogas92_live;
  if (r.mogas92_hist != null) return r.mogas92_hist;
  if (r.mogas92_estimated != null) return r.mogas92_estimated;
  return r.icp + CRACK_SPREAD_RON92;
}

// MOPS RON98 (US$/bbl): harga Mogas 97 historis kalau ada (X01), selain
// itu MOPS RON92 + rerata gap 97-92.
function mopsRon98(r) {
  if (r.mogas97_hist != null) return r.mogas97_hist;
  return mopsRon92(r) + GAP_97_92;
}

// Pajak: PPN 10% (s/d Mar 2022) / 11% (sejak Apr 2022) + PBBKB 5%.
function taxMultiplier(monthStr) {
  return monthStr >= "2022-04" ? 1.16 : 1.15;
}

// r = baris {icp, kurs, mogas92_live, mogas92_hist, mogas92_estimated, mogas97_hist}
// Kepmen 245.K/MG.01/MEM.M/2022: RON92 = 100% Gasoline 92, RON98 = 101%
// Gasoline 97; konstanta < RON95 Rp1.800, RON95/98 Rp2.000; margin 10/90.
// (Koreksi 101% & pajak 1,16 diterapkan 2026-11-22 -- backtest ulang:
// recall/presisi kedua produk tidak berubah, lihat scripts/backtest.py.)
function hargaKeekonomian(r, monthStr, product) {
  const konst = regimeConstant(monthStr, product);
  const mops = product === "ron92" ? mopsRon92(r) : mopsRon98(r) * 1.01;
  const kurs = r.kurs;
  const rpPerLiter = (mops * kurs) / 159;
  const hargaDasar = (rpPerLiter + konst) / 0.9; // margin 10% dari harga dasar (batas atas)
  return hargaDasar * taxMultiplier(monthStr);
}

// ============================================================
// PERTALITE (RON 90, JBKP) -- indikator tekanan fiskal
// ------------------------------------------------------------
// Rumus resmi (dicek 2026-11-22):
//   HIP RON90  = 99,21% x MOPS/Argus Gasoline 92
//                (Kepmen 62.K/12/MEM/2020 jo. 245.K/MG.01/MEM.M/2022)
//   Harga dasar = 100% HIP + Rp1.200/liter (Kepmen 255.K/MG.01/MEM.M/2022)
//   HJE formula = harga dasar + Rp90 (distribusi penugasan, Permen 11/2022)
//                 + PPN + PBBKB
// TIDAK ada margin 10/90 seperti JBU -- margin sudah masuk Rp1.200.
// Harga jual ditetapkan Menteri (Rp7.650 -> Rp10.000 sejak 3 Sep 2022);
// selisih HJE formula - harga jual = kompensasi per liter yang ditanggung
// APBN. Tidak ada skor peringatan dini terkalibrasi utk Pertalite (baru 1
// kejadian kenaikan dalam data) -- yang ditampilkan gap & beban kompensasi.
// Nilai di bawah default; dibaca dari data.json -> pertalite.formula.
// ============================================================
let PERTALITE_FORMULA = {
  hip_pct_mogas92: 0.9921,
  konstanta_harga_dasar: 1200,
  biaya_distribusi_penugasan: 90,
  ppn: [{ from: "2019-01", rate: 0.10 }, { from: "2022-04", rate: 0.11 }],
  pbbkb: 0.05,
};

function ppnRateFor(monthStr) {
  let rate = PERTALITE_FORMULA.ppn[0].rate;
  for (const p of PERTALITE_FORMULA.ppn) if (monthStr >= p.from) rate = p.rate;
  return rate;
}

function hargaKeekonomianPertalite(r, monthStr) {
  const F = PERTALITE_FORMULA;
  const hip = (F.hip_pct_mogas92 * mopsRon92(r) * r.kurs) / 159;
  const hargaDasar = hip + F.konstanta_harga_dasar;
  return (hargaDasar + F.biaya_distribusi_penugasan) * (1 + ppnRateFor(monthStr) + F.pbbkb);
}

// Harga jual Pertalite yang berlaku pada tanggal tsb (satu harga nasional).
function pertalitePriceOn(data, dateStr) {
  const changes = data.pertalite?.price_changes || [];
  let price = null;
  for (const c of changes) if (c.date <= dateStr) price = c.price;
  return price;
}

// Harga di AKHIR bulan (konsisten dgn kolom aktual bulanan Pertamax:
// harga resmi terakhir yang berlaku di bulan tsb).
function pertalitePriceForMonth(data, monthStr) {
  const [y, m] = monthStr.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return pertalitePriceOn(data, lastDay);
}

function kuotaBulananKl(data, monthStr) {
  const kuota = data.pertalite?.kuota_kl?.[monthStr.slice(0, 4)];
  return kuota ? kuota / 12 : null;
}

// Zona tekanan fiskal Pertalite + frekuensi historis perubahan harga
// Pertamax/Turbo dalam 3 bulan (data.json -> pertalite.fiscal_model,
// dihitung scripts/backtest.py --write-model). Indikator TAMBAHAN: tidak
// masuk skor gabungan (uji grid + leave-one-out: overfit).
function fiscalBand(data, productKey, gapPct) {
  const fm = data.pertalite?.fiscal_model?.[productKey];
  if (!fm) return null;
  return fm.bands.find((b) => (b.min == null || gapPct >= b.min) && (b.max == null || gapPct < b.max)) || null;
}
function bandLabel(b) {
  if (b.min == null) return `< ${b.max}%`;
  if (b.max == null) return `≥ ${b.min}%`;
  return `${b.min}–${b.max}%`;
}
function pctOf(k, n) { return n ? Math.round((k / n) * 100) : 0; }

function seriesPertalite(baseRows, data, resolution) {
  const ppm = PERIODS_PER_MONTH[resolution] || 1;
  const rows = baseRows.map((r) => {
    const key = r.month || r.date;
    const month = key.slice(0, 7);
    const eco = hargaKeekonomianPertalite(r, month);
    const selisih = eco - r.actual;
    const gapPct = (selisih / r.actual) * 100;
    const kuotaBln = kuotaBulananKl(data, month);
    // Rp/liter x kl/bulan x 1000 liter/kl -> Rp/bulan
    const bebanBulanan = kuotaBln != null && selisih > 0 ? selisih * kuotaBln * 1000 : null;
    return { ...r, eco, selisih, gapPct, bebanBulanan };
  });
  // Durasi (dlm bulan) harga jual di bawah harga formula secara beruntun.
  let n = 0;
  for (const row of rows) {
    n = row.gapPct > 0 ? n + 1 : 0;
    row.durationPeriods = n;
    row.duration = Math.round(n / ppm);
  }
  return rows;
}

function computePertaliteMonthly(data) {
  const rows = data.monthly
    .map((r) => ({
      month: r.month, icp: r.icp, kurs: r.kurs,
      mogas92_live: r.mogas92_live, mogas92_hist: r.mogas92_hist,
      mogas92_estimated: r.mogas92_estimated,
      actual: pertalitePriceForMonth(data, r.month),
    }))
    .filter((r) => r.actual != null && r.icp != null && r.kurs != null);
  return seriesPertalite(rows, data, "bulanan");
}

const pertaliteCache = new Map();
function getPertaliteTimeline(data, resolution) {
  if (resolution === "bulanan") return computePertaliteMonthly(data);
  if (pertaliteCache.has(resolution)) return pertaliteCache.get(resolution);
  const daily = buildDailyTimeline(data, "ron90", "jakarta");
  const raw = resolution === "harian" ? daily : resampleWeekly(daily);
  const rows = seriesPertalite(raw, data, resolution);
  pertaliteCache.set(resolution, rows);
  return rows;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function apbnAssumptionFor(monthStr, apbnData) {
  const year = monthStr.slice(0, 4);
  // Revisi (Perpres) HANYA berlaku pada tahun yang sama -- tidak terbawa ke tahun berikutnya,
  // karena tahun baru punya asumsi awal baru dari UU APBN yang baru.
  if (apbnData && apbnData.revisions) {
    const applicable = apbnData.revisions
      .filter((r) => r.effective_month.slice(0, 4) === year && r.effective_month <= monthStr)
      .sort((a, b) => (a.effective_month < b.effective_month ? -1 : 1));
    if (applicable.length > 0) return applicable[applicable.length - 1].value;
  }
  return apbnData && apbnData.values ? apbnData.values[year] : undefined;
}

// Baca harga aktual dengan dukungan 2 format: angka biasa (lama, selalu
// dianggap data Jakarta) ATAU objek per-wilayah { jakarta, sumut } (baru).
function readActual(raw, region) {
  if (raw == null) return null;
  if (typeof raw === "number") return region === "jakarta" ? raw : null;
  return raw[region] ?? null;
}

// ============================================================
// TIMELINE HARIAN/MINGGUAN -- dibangun dari price_changes (tanggal presisi)
// + daily (ICP/kurs harian, mulai terkumpul sejak fitur ini aktif) dengan
// fallback ke nilai bulanan yang sudah tervalidasi utk histori sebelum itu.
// (Skor peringatan dini TETAP dihitung bulanan -- ini hanya utk chart/tabel.)
// ============================================================

function dateRangeDays(startStr, endStr) {
  const out = [];
  let d = new Date(startStr + "T00:00:00Z");
  const end = new Date(endStr + "T00:00:00Z");
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

function getActualForDate(data, product, region, dateStr, monthlyMap) {
  if (product === "ron90") return pertalitePriceOn(data, dateStr); // satu harga nasional
  const prodKey = product === "ron92" ? "pertamax" : "turbo";
  const field = product === "ron92" ? "pertamax_actual" : "turbo_actual";
  const month = dateStr.slice(0, 7);
  const monthRow = monthlyMap ? monthlyMap.get(month) : data.monthly.find((r) => r.month === month);
  const monthValue = monthRow ? readActual(monthRow[field], region) : null;

  const changes = data.price_changes?.[prodKey]?.[region] || [];
  // perubahan presisi DI DALAM bulan ini yang bukan tanggal 1 (mis. 10 Agu, 29 Mar)
  const sameMonthMidChanges = changes.filter((c) => c.date.slice(0, 7) === month && c.date.slice(8, 10) !== "01");
  if (sameMonthMidChanges.length === 0) return monthValue; // tidak ada info presisi -> pakai nilai bulanan (flat)

  const applicable = sameMonthMidChanges.filter((c) => c.date <= dateStr);
  if (applicable.length > 0) return applicable[applicable.length - 1].price;

  // sebelum tanggal perubahan pertama di bulan ini -> pakai nilai bulan sebelumnya
  const idx = data.monthly.findIndex((r) => r.month === month);
  const prevRow = idx > 0 ? data.monthly[idx - 1] : null;
  return prevRow ? readActual(prevRow[field], region) : monthValue;
}

function getIcpKursForDate(data, dateStr, dailyMap) {
  const dailyRow = dailyMap ? dailyMap.get(dateStr) : (data.daily || []).find((d) => d.date === dateStr);
  if (dailyRow) {
    return {
      icp: dailyRow.icp,
      kurs: dailyRow.kurs,
      mogas92_live: dailyRow.mogas92_live,
      mogas92_hist: dailyRow.mogas92_hist,
      mogas92_estimated: dailyRow.mogas92_estimated,
      mogas97_hist: dailyRow.mogas97_hist,
    };
  }
  const month = dateStr.slice(0, 7);
  const monthRow = data.monthly.find((r) => r.month === month);
  // PENTING: mogas92_live/mogas92_estimated di baris bulanan cuma snapshot
  // SATU hari tertentu (bukan rata-rata bulan) -- jangan dipakai utk tanggal
  // lain yg kebetulan tidak punya entri "daily" sendiri, atau nilainya akan
  // salah diulang di banyak tanggal berbeda. Fallback bulan hanya pakai
  // ICP+kurs, MOPS RON92 kembali ke estimasi ICP+crack statis seperti biasa
  // (dan RON98 = itu + gap 97-92).
  return monthRow
    ? { icp: monthRow.icp, kurs: monthRow.kurs, mogas92_live: null, mogas92_estimated: null }
    : { icp: null, kurs: null };
}

// ------------------------------------------------------------
// CACHE PERFORMA -- membangun timeline harian (~2.800+ baris x 2 produk)
// dari nol itu mahal (puluhan-ratusan ms di HP), dan sebelumnya dilakukan
// ULANG dari awal SETIAP kali tombol wilayah/resolusi diklik. Di sinilah
// sebagian besar "processing time" INP berasal. Cache di bawah menyimpan
// hasil per kombinasi (produk, wilayah) dan (produk, wilayah, resolusi),
// dan hanya dihitung ulang saat data.json benar2 berubah (lihat
// invalidatePerfCaches()).
// ------------------------------------------------------------
const dailyRawCache = new Map();   // key `${product}:${region}` -> baris harian mentah (belum diskor)
const scoredCache = new Map();     // key `${product}:${region}:${resolution}` -> baris sudah diskor
let monthlyMapCache = null;        // Map month -> row bulanan

function getMonthlyMap(data) {
  if (!monthlyMapCache) monthlyMapCache = new Map(data.monthly.map((r) => [r.month, r]));
  return monthlyMapCache;
}

function invalidatePerfCaches() {
  dailyRawCache.clear();
  scoredCache.clear();
  pertaliteCache.clear();
  monthlyMapCache = null;
}

function buildDailyTimeline(data, product, region) {
  const cacheKey = `${product}:${region}`;
  if (dailyRawCache.has(cacheKey)) return dailyRawCache.get(cacheKey);

  const firstMonth = data.monthly[0].month;
  const startStr = `${firstMonth}-01`;
  const todayStr = new Date().toISOString().slice(0, 10);
  const lastDaily = (data.daily || [])[data.daily.length - 1]?.date;
  const endStr = lastDaily && lastDaily > todayStr ? lastDaily : todayStr;

  // Map sekali di awal -- jauh lebih cepat drpd .find() per hari saat
  // data.daily/data.monthly sudah berisi ribuan/puluhan baris.
  const dailyMap = new Map((data.daily || []).map((d) => [d.date, d]));
  const monthlyMap = getMonthlyMap(data);

  const days = dateRangeDays(startStr, endStr);
  const result = days.map((date) => {
    const actual = getActualForDate(data, product, region, date, monthlyMap);
    const m = getIcpKursForDate(data, date, dailyMap);
    return { date, actual, ...m };
  }).filter((r) => r.actual != null && r.icp != null && r.kurs != null);

  dailyRawCache.set(cacheKey, result);
  return result;
}

function isoWeekKey(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7; // Senin=0
  d.setUTCDate(d.getUTCDate() - day); // mundur ke Senin minggu ini
  return d.toISOString().slice(0, 10);
}

function resampleWeekly(daily) {
  const buckets = new Map();
  for (const r of daily) {
    const wk = isoWeekKey(r.date);
    if (!buckets.has(wk)) buckets.set(wk, []);
    buckets.get(wk).push(r);
  }
  return [...buckets.entries()].map(([weekStart, items]) => {
    const avgIcp = items.reduce((s, i) => s + i.icp, 0) / items.length;
    const avgKurs = items.reduce((s, i) => s + i.kurs, 0) / items.length;
    const last = items[items.length - 1];
    return {
      date: weekStart, actual: last.actual, icp: avgIcp, kurs: avgKurs,
      mogas92_live: last.mogas92_live, mogas92_hist: last.mogas92_hist,
      mogas92_estimated: last.mogas92_estimated, mogas97_hist: last.mogas97_hist,
      isEstimated: last.isEstimated,
    };
  });
}

function getTimelineForResolution(data, product, region, resolution, apbnData) {
  if (resolution === "bulanan") return null; // pakai jalur computeSeries yang sudah ada
  const cacheKey = `${product}:${region}:${resolution}`;
  if (scoredCache.has(cacheKey)) return scoredCache.get(cacheKey);
  const daily = buildDailyTimeline(data, product, region);
  const raw = resolution === "harian" ? daily : resampleWeekly(daily);
  const scored = scoreSeries(raw, product, apbnData, resolution);
  scoredCache.set(cacheKey, scored);
  return scored;
}

// Berapa "periode" setara 1 bulan kalender, dipakai utk menyesuaikan skala
// waktu durasi & momentum supaya artinya tetap sama (dlm bulan riil) di
// resolusi manapun -- durasi "4 bulan" pada resolusi harian = ~122 hari,
// BUKAN 4 hari.
const PERIODS_PER_MONTH = { bulanan: 1, mingguan: 4.345, harian: 30.44 };

// Hitung gap/durasi/momentum/skor pada deret {icp,kurs,actual,mogas92_live,
// month|date} apapun resolusinya. Dipakai baik utk tampilan bulanan (skor
// resmi dashboard) maupun mingguan/harian (skor turut disesuaikan skala waktu).
function scoreSeries(baseRows, product, apbnData, resolution) {
  const W = WEIGHTS[product];
  const ppm = PERIODS_PER_MONTH[resolution] || 1;
  const durationMaxPeriods = Math.max(1, W.durationMaxMonths * ppm);
  const momLookback = Math.max(1, Math.round(3 * ppm));

  const rows = baseRows.map((r) => {
    const key = r.month || r.date;
    const eco = hargaKeekonomian(r, key.slice(0, 7), product);
    const gapPct = ((eco - r.actual) / r.actual) * 100;
    return { ...r, eco, gapPct };
  });

  let duration = 0;
  for (let i = 0; i < rows.length; i++) {
    duration = rows[i].gapPct > W.gapThresholdPct ? duration + 1 : 0;
    rows[i].duration = duration;
  }

  for (let i = 0; i < rows.length; i++) {
    const j = Math.max(0, i - momLookback);
    rows[i].icpMom3 = rows[j].icp ? ((rows[i].icp - rows[j].icp) / rows[j].icp) * 100 : 0;
    rows[i].kursMom3 = rows[j].kurs ? ((rows[i].kurs - rows[j].kurs) / rows[j].kurs) * 100 : 0;
  }

  for (const row of rows) {
    const monthKey = (row.month || row.date).slice(0, 7);
    const apbnAssumption = apbnAssumptionFor(monthKey, apbnData);

    const gapScore = clamp((row.gapPct / W.gapMaxPct) * 100, 0, 100);
    const durationScore = clamp((row.duration / durationMaxPeriods) * 100, 0, 100);
    const momentumScore = clamp(
      (Math.max(0, row.icpMom3) / W.icpMom3MaxPct) * 60 + (Math.max(0, row.kursMom3) / W.kursMom3MaxPct) * 40,
      0, 100
    );
    let apbnScore = 0, hasApbn = false, apbnDevPct = 0;
    if (apbnAssumption) {
      hasApbn = true;
      apbnDevPct = ((row.icp - apbnAssumption) / apbnAssumption) * 100;
      apbnScore = clamp((apbnDevPct / W.apbnMaxDevPct) * 100, 0, 100);
    }

    let composite;
    if (hasApbn) {
      composite = W.gap * gapScore + W.duration * durationScore + W.momentum * momentumScore + W.apbn * apbnScore;
    } else {
      const wSum = W.gap + W.duration + W.momentum;
      composite = (W.gap * gapScore + W.duration * durationScore + W.momentum * momentumScore) / wSum;
    }

    row.gapScore = gapScore;
    row.durationScore = durationScore;
    row.momentumScore = momentumScore;
    row.apbnScore = apbnScore;
    row.apbnDevPct = apbnDevPct;
    row.apbnAssumption = apbnAssumption;
    row.hasApbn = hasApbn;
    row.composite = composite;
    row.light = composite >= W.redAt ? "red" : composite >= W.amberAt ? "amber" : "green";
  }
  return rows;
}

function computeSeries(monthly, product, apbnData, region) {
  // Skor bulanan resmi (kartu skor peringatan dini) -- TIDAK berubah.
  const filtered = monthly.filter((r) => {
    const raw = product === "ron92" ? r.pertamax_actual : r.turbo_actual;
    return readActual(raw, region) != null;
  });
  const estKey = product === "ron92" ? "pertamax" : "turbo";
  const baseRows = filtered.map((r) => {
    const raw = product === "ron92" ? r.pertamax_actual : r.turbo_actual;
    const actual = readActual(raw, region);
    const isEstimated = region !== "jakarta" && !!r.sumut_estimated?.[estKey];
    return {
      month: r.month, icp: r.icp, kurs: r.kurs,
      mogas92_live: r.mogas92_live, mogas92_hist: r.mogas92_hist,
      mogas92_estimated: r.mogas92_estimated, mogas97_hist: r.mogas97_hist,
      actual, isEstimated,
    };
  });
  return scoreSeries(baseRows, product, apbnData, "bulanan");
}

function lightLabel(light) {
  if (light === "red") return "RISIKO TINGGI";
  if (light === "amber") return "WASPADA";
  return "AMAN";
}

function fmtRp(n) {
  return "Rp" + Math.round(n).toLocaleString("id-ID");
}
function fmtPct(n) {
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
}

let dashboardData = null;
let currentRegion = "jakarta";

// Kotak tambahan di kartu Pertamax/Turbo: tekanan fiskal Pertalite bulan
// terakhir + frekuensi historis kenaikan >=8% produk ini di zona tsb.
let lastPertaliteRow = null;
function fiscalCompHtml(label) {
  const row = lastPertaliteRow;
  if (!row) return "";
  const key = label.startsWith("Pertamax Turbo") ? "turbo" : "pertamax";
  const b = fiscalBand(dashboardData, key, row.gapPct);
  if (!b) return "";
  const pct = pctOf(b.up8, b.n);
  return `
      <div class="comp wide">
        <div class="k">Tekanan Fiskal Pertalite <span class="muted">(indikator tambahan, tidak masuk skor)</span></div>
        <div class="v">Gap ${fmtPct(row.gapPct)} &middot; historis ${pct}% naik ≥8% dlm 3 bln</div>
        <div class="bar"><div style="width:${pct}%;background:var(--green, #3fb27f)"></div></div>
      </div>`;
}

function renderScoreCard(containerId, label, row) {
  const el = document.getElementById(containerId);
  if (!row) {
    el.innerHTML = `
      <h2>${label}</h2>
      <div class="sub">Belum ada data histori harga untuk wilayah ini.</div>
      <div class="footnote">Gunakan form "Update Harga BBM" di bawah untuk mulai mencatat harga di wilayah ini.</div>
    `;
    return;
  }
  el.innerHTML = `
    <h2>${label}</h2>
    <div class="current-price">${fmtRp(row.actual)}<span class="unit">/liter</span>${row.isEstimated ? '<span class="est-badge">estimasi</span>' : ''}</div>
    <div class="sub">Bulan acuan: ${row.month}</div>
    <div class="score-row">
      <div class="light ${row.light}">${Math.round(row.composite)}</div>
      <div class="score-detail">
        <div class="status-label ${row.light}">${lightLabel(row.light)}</div>
        <div class="score-num">Skor gabungan 0-100 &middot; Gap harga: ${fmtPct(row.gapPct)} &middot; Tertahan ${row.duration} bln</div>
      </div>
    </div>
    <div class="components">
      <div class="comp">
        <div class="k">Gap Harga</div>
        <div class="v">${fmtPct(row.gapPct)}</div>
        <div class="bar"><div style="width:${row.gapScore}%;background:var(--red)"></div></div>
      </div>
      <div class="comp">
        <div class="k">Durasi Tertahan</div>
        <div class="v">${row.duration} bulan</div>
        <div class="bar"><div style="width:${row.durationScore}%;background:var(--amber)"></div></div>
      </div>
      <div class="comp">
        <div class="k">Momentum ICP/Kurs</div>
        <div class="v">ICP ${fmtPct(row.icpMom3)} / 3bln</div>
        <div class="bar"><div style="width:${row.momentumScore}%;background:var(--blue)"></div></div>
      </div>
      ${fiscalCompHtml(label)}
      <div class="comp">
        <div class="k">Deviasi Asumsi APBN</div>
        <div class="v">${row.hasApbn ? `ICP ${fmtPct(row.apbnDevPct)} vs asumsi $${row.apbnAssumption}` : "belum ada data"}</div>
        <div class="bar"><div style="width:${row.apbnScore}%;background:var(--purple)"></div></div>
      </div>
    </div>
  `;
}

function fmtTriliun(rp) {
  return "Rp" + (rp / 1e12).toLocaleString("id-ID", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " T";
}

function renderPertaliteCard(row) {
  const el = document.getElementById("card-pertalite");
  if (!el) return;
  if (!row) {
    el.innerHTML = `<h2>Pertalite (RON 90) — Tekanan Fiskal</h2><div class="sub">Belum ada data.</div>`;
    return;
  }
  const data = dashboardData;
  const lines = [["pertamax", "Pertamax"], ["turbo", "Pertamax Turbo"]].map(([k, label]) => {
    const b = fiscalBand(data, k, row.gapPct);
    if (!b) return "";
    return `<tr><td>${label}</td><td>${pctOf(b.up8, b.n)}% <span class="muted">(${b.up8}/${b.n} bln)</span></td><td>${pctOf(b.up_any, b.n)}%</td><td>${pctOf(b.down_any, b.n)}%</td></tr>`;
  }).join("");
  const anyBand = fiscalBand(data, "pertamax", row.gapPct);
  const fm = data.pertalite?.fiscal_model;
  const allBands = fm ? fm.pertamax.bands.map((b, i) => {
    const t = fm.turbo.bands[i];
    const cur = anyBand && b.min === anyBand.min ? ' class="cur-band"' : "";
    return `<tr${cur}><td>${bandLabel(b)}</td><td>${pctOf(b.up8, b.n)}%</td><td>${pctOf(t.up8, t.n)}%</td><td>${b.n}</td></tr>`;
  }).join("") : "";
  el.innerHTML = `
    <h2>Pertalite (RON 90) — Indikator Tekanan Fiskal untuk Pertamax &amp; Turbo</h2>
    <div class="sub">Bulan acuan: ${row.month} &middot; harga jual ${fmtRp(row.actual)}/liter (nasional, ditetapkan Menteri ESDM) &middot; bukan peringatan dini Pertalite</div>
    <div class="components">
      <div class="comp"><div class="k">Harga Formula (HJE)</div><div class="v">${fmtRp(row.eco)}</div></div>
      <div class="comp"><div class="k">Gap / Kompensasi per liter</div><div class="v">${fmtPct(row.gapPct)} &middot; ${fmtRp(Math.max(0, row.selisih))}</div></div>
      <div class="comp"><div class="k">Di bawah formula</div><div class="v">${row.duration} bulan beruntun</div></div>
      <div class="comp"><div class="k">Estimasi beban / bulan</div><div class="v">${row.bebanBulanan != null ? fmtTriliun(row.bebanBulanan) : "belum ada data kuota"}</div></div>
    </div>
    ${anyBand ? `
    <h3 class="mini-h">Zona saat ini: gap ${bandLabel(anyBand)} — yang terjadi dalam 3 bulan berikutnya secara historis</h3>
    <div class="table-scroll"><table>
      <thead><tr><th>Produk</th><th>Naik ≥8%</th><th>Naik (berapa pun)</th><th>Turun</th></tr></thead>
      <tbody>${lines}</tbody>
    </table></div>
    <h3 class="mini-h">Peluang historis kenaikan ≥8% dalam 3 bulan per zona gap Pertalite</h3>
    <div class="table-scroll"><table>
      <thead><tr><th>Gap Pertalite</th><th>Pertamax</th><th>Turbo</th><th>n bulan</th></tr></thead>
      <tbody>${allBands}</tbody>
    </table></div>` : ""}
    <div class="footnote">Dari data 2019–2026: 3 dari 4 kenaikan Pertamax ≥8% didahului gap Pertalite ≥50% dalam 3 bulan sebelumnya (pengecualian: Okt 2023, gap 14–31%). Dari bulan-bulan di zona ≥50%, 64% diikuti kenaikan, dibanding 13% untuk semua bulan. Turbo di zona yang sama sering naik maupun turun, karena lebih mengikuti pasar. Indikator ini <b>tidak masuk skor gabungan</b>: saat dicoba sebagai komponen ke-5, hasilnya overfit (gagal di uji leave-one-out). Jendela 3 bulan tumpang tindih dan kejadian mengelompok di 2022 &amp; 2026, jadi baca sebagai indikasi, bukan probabilitas presisi.</div>
  `;
}

function renderPertaliteTable(tbodyId, rows, showAll, limit) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  if (!rows || !rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted)">Belum ada data</td></tr>`;
    return;
  }
  const displayRows = showAll ? rows : rows.slice(-(limit ?? 12));
  tbody.innerHTML = [...displayRows].reverse().map((r) => `
    <tr>
      <td>${r.month || r.date}</td>
      <td>${fmtRp(r.actual)}</td>
      <td>${fmtRp(r.eco)}</td>
      <td>${fmtRp(r.selisih)}</td>
      <td>${fmtPct(r.gapPct)}</td>
      <td>${r.duration}</td>
    </tr>`).join("");
}

const chartInstances = {};

function renderChart(canvasId, rows, label, color) {
  if (chartInstances[canvasId]) {
    chartInstances[canvasId].destroy();
    chartInstances[canvasId] = null;
  }
  if (!rows.length) return; // wilayah ini belum ada data sama sekali
  const ctx = document.getElementById(canvasId).getContext("2d");
  const labels = rows.map((r) => r.month || r.date);
  // Sumbu-X pakai INDEX numerik (bukan kategori teks) -- chartjs-plugin-zoom
  // hanya mendukung pan yang benar2 mulus pada skala numerik/waktu, bukan
  // skala kategori (label teks berbaris). Tanggal aslinya tetap ditampilkan
  // lewat callback tick & tooltip di bawah.
  const toXY = (getter) => rows.map((r, i) => ({ x: i, y: getter(r) }));

  chartInstances[canvasId] = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        {
          label: `${label} - Aktual`,
          data: toXY((r) => r.actual),
          borderColor: color,
          borderWidth: 3,
          pointRadius: 0,
          tension: 0.15,
          yAxisID: "y",
          parsing: false,
          normalized: true,
        },
        {
          label: `${label} - Keekonomian (estimasi)`,
          data: toXY((r) => r.eco),
          borderColor: "#e0a72b",
          borderDash: [6, 4],
          borderWidth: 2.5,
          pointRadius: 0,
          tension: 0.15,
          yAxisID: "y",
          parsing: false,
          normalized: true,
        },
        {
          label: "ICP (US$/barel)",
          data: toXY((r) => r.icp),
          borderColor: "#5b9bd5aa",
          borderWidth: 1.2,
          pointRadius: 0,
          tension: 0.15,
          yAxisID: "y1",
          parsing: false,
          normalized: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // Data sudah pre-sorted numerik (x = index 0..n-1) & sudah "parsed"
      // ({x,y} langsung) -- animation:false + decimation menghemat banyak
      // waktu render terutama di resolusi harian (ribuan titik) & saat
      // zoom/pan di HP.
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#e8ecf5", boxWidth: 14, font: { size: 11 } } },
        decimation: { enabled: true, algorithm: "min-max", samples: 500 },
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: { title: (items) => labels[items[0].parsed.x] ?? "" },
        },
        zoom: {
          pan: { enabled: true, mode: "x" },
          zoom: {
            wheel: { enabled: true, speed: 0.08 },
            pinch: { enabled: true },
            mode: "x",
          },
          limits: { x: { min: 0, max: labels.length - 1, minRange: 5 } },
        },
      },
      scales: {
        x: {
          type: "linear",
          min: 0,
          max: labels.length - 1,
          ticks: {
            color: "#93a0b8",
            maxTicksLimit: window.innerWidth < 640 ? 6 : 14,
            callback: (value) => labels[Math.round(value)] ?? "",
          },
          grid: { color: "#2a3348" },
        },
        y: {
          position: "left",
          ticks: { color: "#93a0b8", callback: (v) => "Rp" + v.toLocaleString("id-ID") },
          grid: { color: "#2a3348" },
          title: { display: true, text: "Rp/liter", color: "#93a0b8" },
        },
        y1: {
          position: "right",
          ticks: { color: "#5b9bd5" },
          grid: { drawOnChartArea: false },
          title: { display: true, text: "US$/barel", color: "#5b9bd5" },
        },
      },
    },
  });
}

function renderTable(tbodyId, rows, showAll, limit) {
  const tbody = document.getElementById(tbodyId);
  if (!rows || !rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted)">Belum ada data histori untuk wilayah ini</td></tr>`;
    return;
  }
  const displayRows = showAll ? rows : rows.slice(-(limit ?? 12));
  // Tampilkan dari yang TERBARU ke yang terlama (baris asal tetap kronologis
  // menaik krn dipakai utk hitung durasi/momentum -- ini cuma urutan tampil).
  const reversedRows = [...displayRows].reverse();
  tbody.innerHTML = reversedRows
    .map(
      (r) => `
    <tr>
      <td>${r.month || r.date}</td>
      <td>${fmtRp(r.actual)}${r.isEstimated ? " *" : ""}</td>
      <td>${r.eco != null ? fmtRp(r.eco) : "-"}</td>
      <td>${r.gapPct != null ? fmtPct(r.gapPct) : "-"}</td>
      <td>${r.duration ?? "-"}</td>
      <td>${r.composite != null ? Math.round(r.composite) : "-"}</td>
      <td>${r.light ? `<span class="badge ${r.light}">${lightLabel(r.light)}</span>` : "-"}</td>
    </tr>`
    )
    .join("");
}

function waitForChart(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (typeof Chart !== "undefined") return resolve();
    const start = Date.now();
    const iv = setInterval(() => {
      if (typeof Chart !== "undefined") {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error("Chart.js gagal dimuat dari CDN (primer & fallback) setelah 5 detik."));
      }
    }, 100);
  });
}

let currentResolution = "bulanan";

function renderAll(region, resolution) {
  currentRegion = region;
  currentResolution = resolution || currentResolution;
  const data = dashboardData;
  const apbnData = data.apbn_icp_assumptions || { values: {}, revisions: [] };

  // Skor peringatan dini SELALU dihitung bulanan (kalibrasi backtest kita
  // berbasis siklus bulanan) -- resolusi hanya memengaruhi chart & tabel.
  const ron92Monthly = computeSeries(data.monthly, "ron92", apbnData, region);
  const ron98Monthly = computeSeries(data.monthly, "ron98", apbnData, region);

  const last92 = ron92Monthly[ron92Monthly.length - 1] ?? null;
  const last98 = ron98Monthly[ron98Monthly.length - 1] ?? null;

  const ron90Monthly = computePertaliteMonthly(data);
  lastPertaliteRow = ron90Monthly[ron90Monthly.length - 1] ?? null;

  const regionLabel = region === "jakarta" ? "DKI Jakarta" : "Sumatera Utara";
  renderScoreCard("card-pertamax", `Pertamax (RON 92) — ${regionLabel}`, last92);
  renderScoreCard("card-turbo", `Pertamax Turbo (RON 98) — ${regionLabel}`, last98);

  const ron92Display = currentResolution === "bulanan" ? ron92Monthly : getTimelineForResolution(data, "ron92", region, currentResolution, apbnData);
  const ron98Display = currentResolution === "bulanan" ? ron98Monthly : getTimelineForResolution(data, "ron98", region, currentResolution, apbnData);

  renderChart("chart-pertamax", ron92Display, "Pertamax", "#e0524a");
  renderChart("chart-turbo", ron98Display, "Pertamax Turbo", "#e0524a");

  // Pertalite: satu harga nasional -> tidak tergantung tombol wilayah.
  renderPertaliteCard(lastPertaliteRow);
  const ron90Display = currentResolution === "bulanan" ? ron90Monthly : getPertaliteTimeline(data, currentResolution);
  renderChart("chart-pertalite", ron90Display, "Pertalite", "#3fb27f");

  lastRows.ron92 = ron92Display;
  lastRows.ron98 = ron98Display;
  lastRows.ron90 = ron90Display;
  refreshTables();

  const resLabel = { bulanan: "Bulanan", mingguan: "Mingguan", harian: "Harian" }[currentResolution];
  document.getElementById("last-updated").textContent =
    "Data bulanan sampai: " + data.monthly[data.monthly.length - 1].month + " · Wilayah: " + regionLabel + " · Resolusi: " + resLabel;

  // sinkronkan tampilan tombol switch
  document.querySelectorAll(".region-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.region === region);
  });
  document.querySelectorAll(".res-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.res === currentResolution);
  });
}

// Update tampilan tombol SEGERA (synchronous, dalam handler klik) supaya
// browser bisa langsung menggambar frame itu, lalu kerja berat (hitung
// timeline + gambar chart + isi tabel) ditunda ke frame berikutnya lewat
// requestAnimationFrame. Ini yang paling menentukan skor INP: bagian
// "processing" yang benar2 terjadi SAAT event klik jadi sangat kecil.
function setupRegionSwitch() {
  document.querySelectorAll(".region-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".region-btn").forEach((b) => b.classList.toggle("active", b === btn));
      requestAnimationFrame(() => renderAll(btn.dataset.region, currentResolution));
    });
  });
  document.querySelectorAll(".res-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".res-btn").forEach((b) => b.classList.toggle("active", b === btn));
      requestAnimationFrame(() => renderAll(currentRegion, btn.dataset.res));
    });
  });
  document.querySelectorAll(".reset-zoom-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const chart = chartInstances[btn.dataset.target];
      if (chart) chart.resetZoom();
    });
  });
}

// ============================================================
// FORM UPDATE HARGA -- commit langsung ke data.json di GitHub
// lewat GitHub Contents API, pakai Personal Access Token yang
// diketik sendiri oleh pengguna (TIDAK disimpan permanen -- cuma
// sessionStorage, hilang saat tab ditutup).
// ============================================================
const GITHUB_OWNER = location.hostname.split(".")[0];
const GITHUB_REPO = location.pathname.split("/").filter(Boolean)[0] || "";

function getToken() {
  return sessionStorage.getItem("bbm_gh_token") || "";
}
function setToken(t) {
  if (t) sessionStorage.setItem("bbm_gh_token", t);
  else sessionStorage.removeItem("bbm_gh_token");
}

async function commitPriceUpdate({ token, product, region, date, price }) {
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/data.json`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };

  // 1. Ambil isi & sha terbaru data.json langsung dari GitHub (bukan dari
  //    cache browser) supaya tidak menimpa perubahan lain yang mungkin
  //    sudah terjadi (mis. dari GitHub Actions).
  const getRes = await fetch(apiUrl, { headers });
  if (!getRes.ok) throw new Error(`Gagal mengambil data.json (HTTP ${getRes.status}). Cek token & nama repo.`);
  const fileMeta = await getRes.json();
  const content = JSON.parse(decodeURIComponent(escape(atob(fileMeta.content))));

  const productLabel = { ron92: "Pertamax", ron98: "Pertamax Turbo", ron90: "Pertalite" }[product];

  if (product === "ron90") {
    // Pertalite: satu harga nasional, cukup dicatat di pertalite.price_changes
    // (kolom bulanan diturunkan dari log ini, jadi wilayah diabaikan).
    if (!content.pertalite) content.pertalite = { price_changes: [] };
    const plog = content.pertalite.price_changes || (content.pertalite.price_changes = []);
    const i = plog.findIndex((e) => e.date === date);
    if (i >= 0) plog[i] = { date, price };
    else plog.push({ date, price });
    plog.sort((a, b) => (a.date < b.date ? -1 : 1));
    return await putDataJson(apiUrl, headers, fileMeta.sha, content,
      `chore: update harga Pertalite (nasional) ${date} -> Rp${price}`);
  }

  const prodKey = product === "ron92" ? "pertamax" : "turbo";

  // 2. Catat di log price_changes (tanggal presisi) -- ini yg dipakai
  //    tampilan harian/mingguan.
  if (!content.price_changes) content.price_changes = { pertamax: { jakarta: [], sumut: [] }, turbo: { jakarta: [], sumut: [] } };
  if (!content.price_changes[prodKey]) content.price_changes[prodKey] = { jakarta: [], sumut: [] };
  if (!content.price_changes[prodKey][region]) content.price_changes[prodKey][region] = [];
  const log = content.price_changes[prodKey][region];
  const existingIdx = log.findIndex((e) => e.date === date);
  if (existingIdx >= 0) log[existingIdx] = { date, price };
  else log.push({ date, price });
  log.sort((a, b) => (a.date < b.date ? -1 : 1));

  // 3. Sinkronkan juga baris bulan terkait di "monthly" (dipakai tampilan
  //    bulanan & skor peringatan dini) -- hanya kalau tanggal ini adalah
  //    perubahan TERBARU untuk bulan tsb (biar tidak menimpa dgn nilai lama
  //    kalau user input tanggal mundur).
  const month = date.slice(0, 7);
  let row = content.monthly.find((r) => r.month === month);
  if (!row) {
    const prev = content.monthly[content.monthly.length - 1];
    row = { month, icp: prev.icp, kurs: prev.kurs, pertamax_actual: prev.pertamax_actual, turbo_actual: prev.turbo_actual };
    content.monthly.push(row);
    content.monthly.sort((a, b) => (a.month < b.month ? -1 : 1));
  }
  const field = product === "ron92" ? "pertamax_actual" : "turbo_actual";
  if (typeof row[field] === "number") row[field] = { jakarta: row[field], sumut: null };
  else if (row[field] == null) row[field] = { jakarta: null, sumut: null };

  // hanya update nilai bulanan kalau tanggal ini adalah entri TERBARU utk bulan tsb
  const monthEntries = log.filter((e) => e.date.slice(0, 7) === month);
  const latestInMonth = monthEntries[monthEntries.length - 1];
  if (latestInMonth && latestInMonth.date === date) {
    row[field][region] = price;
    if (region !== "jakarta" && row.sumut_estimated) delete row.sumut_estimated[prodKey];
  }

  // 4. Commit balik ke GitHub
  return await putDataJson(apiUrl, headers, fileMeta.sha, content,
    `chore: update harga ${productLabel} ${region} ${date} -> Rp${price}`);
}

async function putDataJson(apiUrl, headers, sha, content, message) {
  const newContentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2) + "\n")));
  const putRes = await fetch(apiUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: newContentB64, sha }),
  });
  if (!putRes.ok) {
    const errBody = await putRes.text();
    throw new Error(`Gagal commit (HTTP ${putRes.status}): ${errBody}`);
  }
  return content;
}

function setupUpdateForm() {
  const form = document.getElementById("price-update-form");
  if (!form) return;

  const tokenInput = document.getElementById("gh-token");
  tokenInput.value = getToken();
  tokenInput.addEventListener("change", () => setToken(tokenInput.value.trim()));

  const dateInput = document.getElementById("upd-date");
  const now = new Date();
  dateInput.value = now.toISOString().slice(0, 10);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const statusEl = document.getElementById("update-status");
    const token = tokenInput.value.trim();
    const product = document.getElementById("upd-product").value;
    const region = document.getElementById("upd-region").value;
    const date = dateInput.value;
    const price = Number(document.getElementById("upd-price").value);

    if (!token) { statusEl.textContent = "Isi GitHub Token dulu."; statusEl.className = "status-err"; return; }
    if (!date) { statusEl.textContent = "Isi tanggal berlaku."; statusEl.className = "status-err"; return; }
    if (!price || price <= 0) { statusEl.textContent = "Harga tidak valid."; statusEl.className = "status-err"; return; }

    statusEl.textContent = "Mengirim ke GitHub...";
    statusEl.className = "status-pending";
    try {
      setToken(token);
      const updatedData = await commitPriceUpdate({ token, product, region, date, price });
      dashboardData = updatedData;
      invalidatePerfCaches(); // data.json berubah -> cache timeline lama sudah tidak valid
      renderAll(currentRegion, currentResolution);
      statusEl.textContent = `Berhasil! ${date} disimpan ke GitHub. Situs akan ikut ter-update dalam 1-2 menit.`;
      statusEl.className = "status-ok";
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Gagal: " + err.message;
      statusEl.className = "status-err";
    }
  });
}

let lastRows = { ron92: [], ron98: [], ron90: [] };

function getDateFilterRange() {
  const from = document.getElementById("filter-from")?.value || "";
  const to = document.getElementById("filter-to")?.value || "";
  return { from, to };
}

function applyDateFilter(rows) {
  const { from, to } = getDateFilterRange();
  if (!from && !to) return null; // tidak ada filter aktif -> pakai default (last 12 / semua)
  return rows.filter((r) => {
    const key = r.month ? r.month + "-01" : r.date;
    if (from && key < from) return false;
    if (to && key > to) return false;
    return true;
  });
}

// Default baris yang ditampilkan kalau TIDAK ada filter tanggal aktif.
// PENTING: sebelumnya resolusi harian/mingguan menampilkan SEMUA baris
// (bisa >2.800 <tr> x 2 tabel) pada SETIAP klik tombol -- ini penyumbang
// terbesar processing time (INP) di HP. Sekarang dibatasi seperti halnya
// tampilan bulanan (12 bulan terakhir); histori penuh tetap bisa dilihat
// lewat Filter Riwayat di atas.
const TABLE_DEFAULT_LIMIT = { bulanan: 12, mingguan: 26, harian: 90 };

function refreshTables() {
  const filtered92 = applyDateFilter(lastRows.ron92);
  const filtered98 = applyDateFilter(lastRows.ron98);
  const hasDateFilter = filtered92 != null;
  const limit = TABLE_DEFAULT_LIMIT[currentResolution] ?? 12;
  renderTable("table-pertamax", filtered92 ?? lastRows.ron92, hasDateFilter, limit);
  renderTable("table-turbo", filtered98 ?? lastRows.ron98, hasDateFilter, limit);
  const filtered90 = applyDateFilter(lastRows.ron90);
  renderPertaliteTable("table-pertalite", filtered90 ?? lastRows.ron90, hasDateFilter, limit);
}

function setupDateFilter() {
  const from = document.getElementById("filter-from");
  const to = document.getElementById("filter-to");
  const resetBtn = document.getElementById("filter-reset");
  if (!from || !to) return;
  from.addEventListener("change", refreshTables);
  to.addEventListener("change", refreshTables);
  resetBtn?.addEventListener("click", () => {
    from.value = "";
    to.value = "";
    refreshTables();
  });
}

async function main() {
  await waitForChart();
  const res = await fetch("data.json");
  dashboardData = await res.json();
  if (typeof dashboardData.mogas_gap_97_92?.value === "number") GAP_97_92 = dashboardData.mogas_gap_97_92.value;
  if (dashboardData.pertalite?.formula) PERTALITE_FORMULA = { ...PERTALITE_FORMULA, ...dashboardData.pertalite.formula };
  invalidatePerfCaches();

  setupRegionSwitch();
  setupUpdateForm();
  setupDateFilter();
  renderAll("jakarta", "bulanan");
}

main().catch((err) => {
  console.error(err);
  document.getElementById("last-updated").textContent = "Gagal memuat dashboard: " + err.message;
  document.getElementById("last-updated").style.color = "#e0524a";
});
