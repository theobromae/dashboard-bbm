// ============================================================
// update-data.mjs
// ------------------------------------------------------------
// Dijalankan otomatis oleh GitHub Actions (lihat
// .github/workflows/update-data.yml). Mengambil harga minyak
// live dari oilpriceapi.com + kurs USD/IDR dari API gratis,
// lalu memperbarui BULAN BERJALAN di data.json.
//
// TIDAK PERNAH menyentuh pertamax_actual / turbo_actual --
// itu tetap manual, kamu update sendiri di data.json begitu
// ada pengumuman resmi perubahan harga dari Pertamina.
//
// PENTING SEBELUM DIPAKAI:
// 1. Tambahkan API key oilpriceapi.com sebagai GitHub Secret
//    bernama OILPRICEAPI_KEY (Settings > Secrets and variables
//    > Actions > New repository secret). JANGAN taruh key di
//    file manapun yang di-commit ke repo.
// 2. Cek MOGAS92_CODE di bawah -- verifikasi kode commodity
//    yang benar untuk "Singapore Mogas 92" di dashboard/API
//    reference oilpriceapi.com akun kamu, karena dokumentasi
//    publik mereka tidak selalu konsisten soal nama kode ini.
//
// CATATAN PERBAIKAN (2026-09-10):
// Brent (BRENT_SPOT_USD) sekarang SENGAJA di-fetch di request
// terpisah dari Dubai+Mogas. Root cause bug sebelumnya: saat
// ketiga kode diminta dalam satu request gabungan, oilpriceapi
// tampaknya menerapkan satu freshness window per-batch (bukan
// per-kode) -- Dubai/Mogas pakai window ~1 hari (source
// "market_reporting"), sedangkan Brent sumbernya "eia_api" yang
// wajar update mingguan. Akibatnya Brent yang sebenarnya masih
// valid (8 hari, dalam window 13,75 harinya sendiri) malah
// dibuang ke data.missing dan dianggap "tidak ditemukan" oleh
// script lama. Memisahkan request Brent membuatnya dievaluasi
// dengan freshness window yang sesuai sumbernya sendiri.
// ============================================================

const MOGAS92_CODE = "SINGAPORE_MOGAS_92_USD"; // dikonfirmasi dari respons live API
const BRENT_CODE = "BRENT_SPOT_USD"; // dikonfirmasi dari respons live API
const DUBAI_CODE = "DUBAI_CRUDE_USD"; // dikonfirmasi dari respons live API

// Kalibrasi regresi linear ICP = a*Brent + b*Dubai + c, dari 51 bulan data
// ICP resmi (ESDM, tersitasi) dicocokkan dengan rata-rata bulanan Brent &
// Dubai (DCB1) 2019-2026. R2=0.985, RMSE=US$2.55/barel.
// Catatan: model ini melemah saat guncangan geopolitik ekstrem (mis. April
// 2026 saat konflik Timur Tengah -- selisih bisa >US$12/barel).
const ICP_MODEL = { a: 0.7575, b: 0.2887, c: -4.722 };
// Fallback kalau Dubai kebetulan tidak tersedia hari itu (R2=0.983, sedikit
// lebih rendah tapi tetap solid) -- dipakai jg utk rekonstruksi histori 2019-2026.
const ICP_MODEL_BRENT_ONLY = { a: 1.045, c: -5.00 };

const CRACK_SPREAD_RON98 = 17.02; // hasil riset & backtest sebelumnya

// Fetch satu atau lebih kode dari oilpriceapi.com dalam SATU request.
// Kode yang tergolong "stale" menurut freshness window request ini akan
// muncul di data.missing, bukan data.prices -- keduanya dikembalikan
// apa adanya supaya caller yang memutuskan (bukan fungsi ini) apakah itu
// masalah nyata atau cuma window yang tidak cocok untuk kode tsb.
async function fetchOilPricesFor(codes) {
  const apiKey = process.env.OILPRICEAPI_KEY;
  if (!apiKey) throw new Error("OILPRICEAPI_KEY tidak ditemukan di environment (cek GitHub Secret).");

  const url = `https://api.oilpriceapi.com/v1/prices/latest?by_code=${codes.join(",")}`;
  const res = await fetch(url, { headers: { Authorization: `Token ${apiKey}` } });
  if (!res.ok) throw new Error(`oilpriceapi.com gagal: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  console.log(`Respons oilpriceapi.com [${codes.join(",")}]:`, JSON.stringify(json));

  // Struktur nyata: { status, data: { prices: [...], missing: [...], metadata } }
  // (bukan array/objek langsung di bawah "data" seperti dugaan awal)
  const list = json.data?.prices ?? (Array.isArray(json.data) ? json.data : [json.data]);
  const prices = {};
  const meta = {};
  for (const item of list) {
    prices[item.code] = item.price;
    meta[item.code] = item;
  }

  const missing = json.data?.missing ?? [];
  for (const m of missing) {
    console.warn(`oilpriceapi.com: ${m.code} tidak masuk "prices" (${m.reason}): ${m.message ?? "(tanpa pesan detail)"}`);
  }

  return { prices, meta, missing };
}

async function fetchKurs() {
  // Coba dulu provider Bank Indonesia (lebih otoritatif, sesuai definisi
  // formula Kepmen ESDM). Kalau bentuk responsnya tidak seperti yang
  // diharapkan, fallback ke endpoint Frankfurter standar (basis ECB).
  try {
    const res = await fetch("https://api.frankfurter.dev/v2/rate/USD/IDR?providers=BI");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    console.log("Respons Frankfurter (provider BI):", JSON.stringify(json));
    const val = json?.rates?.IDR ?? json?.rate ?? json?.IDR ?? json?.data?.rates?.IDR;
    if (typeof val === "number") return val;
    throw new Error("Struktur respons tidak dikenali");
  } catch (err) {
    console.warn(`Provider BI gagal (${err.message}), fallback ke Frankfurter standar (ECB)...`);
  }

  const res2 = await fetch("https://api.frankfurter.app/latest?from=USD&to=IDR");
  if (!res2.ok) throw new Error(`Frankfurter fallback gagal: HTTP ${res2.status}`);
  const json2 = await res2.json();
  console.log("Respons Frankfurter (fallback ECB):", JSON.stringify(json2));
  if (typeof json2?.rates?.IDR !== "number") {
    throw new Error(`Tidak bisa membaca kurs dari respons manapun: ${JSON.stringify(json2)}`);
  }
  return json2.rates.IDR;
}

async function main() {
  const fs = await import("fs/promises");
  const dataPath = new URL("../data.json", import.meta.url);
  const data = JSON.parse(await fs.readFile(dataPath, "utf-8"));

  // Brent diminta SENDIRIAN (lihat catatan perbaikan di atas) supaya
  // freshness window-nya tidak tercampur dengan Dubai/Mogas yang window-nya
  // jauh lebih ketat.
  const [brentResult, restResult] = await Promise.all([
    fetchOilPricesFor([BRENT_CODE]),
    fetchOilPricesFor([DUBAI_CODE, MOGAS92_CODE]),
  ]);
  const prices = { ...brentResult.prices, ...restResult.prices };
  const meta = { ...brentResult.meta, ...restResult.meta };
  const kurs = await fetchKurs();

  const brent = prices[BRENT_CODE];
  const dubai = prices[DUBAI_CODE];
  const mogas92 = prices[MOGAS92_CODE];
  const mogas92Meta = meta[MOGAS92_CODE];

  if (brent == null) {
    // Kalau sampai di sini Brent tetap tidak ada PADAHAL sudah diminta
    // sendirian (window freshness-nya sendiri, bukan window Dubai/Mogas),
    // ini kemungkinan besar masalah nyata (mis. EIA belum update lebih
    // lama dari biasanya, atau memang soal kode/langganan) -- bukan lagi
    // artefak dari request gabungan. Tetap gagalkan workflow (jangan diam-
    // diam pakai data basi ke model), tapi dengan alasan asli dari API.
    const missEntry = brentResult.missing.find((m) => m.code === BRENT_CODE);
    const detail = missEntry
      ? `alasan dari API: "${missEntry.reason}" -- ${missEntry.message ?? "(tanpa pesan)"} (terakhir terlihat ${missEntry.last_seen ?? "?"}, ${missEntry.days_stale ?? "?"} hari basi)`
      : "tidak ada entri di data.missing untuk kode ini -- cek respons lengkap di log run ini";
    throw new Error(`Brent tidak tersedia dari oilpriceapi.com meski diminta sendirian. ${detail}`);
  }

  // Mogas92 dari oilpriceapi adalah kontrak calendar-month average swap yang
  // kadang stale/tidak wajar (pernah dapat $214/barel saat status "stale").
  // Hanya pakai sebagai MOPS langsung kalau data_status="current" DAN dalam
  // rentang harga wajar (di bawah 2x Brent, penyaring sanity check kasar).
  const mogas92Usable =
    mogas92 != null &&
    mogas92Meta?.data_status === "current" &&
    mogas92 < brent * 2;
  if (mogas92 != null && !mogas92Usable) {
    console.warn(
      `Mogas92 diabaikan (data_status=${mogas92Meta?.data_status}, harga=${mogas92}) -- pakai fallback ICP+crack untuk bulan ini.`
    );
  }

  const icpEstimate =
    dubai != null
      ? ICP_MODEL.a * brent + ICP_MODEL.b * dubai + ICP_MODEL.c
      : ICP_MODEL_BRENT_ONLY.a * brent + ICP_MODEL_BRENT_ONLY.c;

  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const monthKey = dateKey.slice(0, 7);

  // --- Simpan snapshot HARIAN (upsert -- kalau workflow jalan >1x sehari,
  // timpa entri hari ini, jangan duplikat) ---
  if (!Array.isArray(data.daily)) data.daily = [];
  const dailyRow = {
    date: dateKey,
    icp: Math.round(icpEstimate * 100) / 100,
    kurs: Math.round(kurs),
  };
  if (mogas92Usable) dailyRow.mogas92_live = Math.round(mogas92 * 100) / 100;
  const existingDailyIdx = data.daily.findIndex((d) => d.date === dateKey);
  if (existingDailyIdx >= 0) data.daily[existingDailyIdx] = dailyRow;
  else data.daily.push(dailyRow);
  data.daily.sort((a, b) => (a.date < b.date ? -1 : 1));

  const monthly = data.monthly;
  let row = monthly.find((r) => r.month === monthKey);
  if (!row) {
    // bulan baru -- carry-forward harga aktual dari bulan sebelumnya (belum ada perubahan resmi)
    const prev = monthly[monthly.length - 1];
    row = {
      month: monthKey,
      icp: 0,
      kurs: 0,
      pertamax_actual: prev.pertamax_actual,
      turbo_actual: prev.turbo_actual,
    };
    monthly.push(row);
  }

  row.icp = Math.round(icpEstimate * 100) / 100;
  row.kurs = Math.round(kurs);
  if (mogas92Usable) {
    row.mogas92_live = Math.round(mogas92 * 100) / 100; // dipakai app.js sbg MOPS RON92 langsung, prioritas di atas ICP+crack
  } else {
    delete row.mogas92_live; // pastikan tidak ada nilai basi/aneh yang nyangkut dari run sebelumnya
  }
  row.updated_via = "oilpriceapi+frankfurter";
  row.updated_at = now.toISOString();

  await fs.writeFile(dataPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  console.log(`Updated ${dateKey} (bulan ${monthKey}): ICP~${dailyRow.icp} (Brent=${brent}, Dubai=${dubai}), kurs=${dailyRow.kurs}, mogas92_live=${dailyRow.mogas92_live ?? "n/a (fallback ke ICP+crack)"}. Total snapshot harian: ${data.daily.length}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
