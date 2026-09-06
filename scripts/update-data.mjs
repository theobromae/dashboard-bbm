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
// ============================================================

const CODES = ["BRENT_SPOT_USD", "DUBAI_CRUDE_USD", "SINGAPORE_MOGAS_92_USD"];

// Kalibrasi regresi linear ICP = a*Brent + b*Dubai + c, dari 51 bulan data
// ICP resmi (ESDM, tersitasi) dicocokkan dengan rata-rata bulanan Brent &
// Dubai (DCB1) 2019-2026. R2=0.985, RMSE=US$2.55/barel.
// Catatan: model ini melemah saat guncangan geopolitik ekstrem (mis. April
// 2026 saat konflik Timur Tengah -- selisih bisa >US$12/barel).
const ICP_MODEL = { a: 0.7575, b: 0.2887, c: -4.722 };

const CRACK_SPREAD_RON98 = 17.02; // hasil riset & backtest sebelumnya

async function fetchOilPrices() {
  const apiKey = process.env.OILPRICEAPI_KEY;
  if (!apiKey) throw new Error("OILPRICEAPI_KEY tidak ditemukan di environment (cek GitHub Secret).");

  const url = `https://api.oilpriceapi.com/v1/prices/latest?by_code=${CODES.join(",")}`;
  const res = await fetch(url, { headers: { Authorization: `Token ${apiKey}` } });
  if (!res.ok) throw new Error(`oilpriceapi.com gagal: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();

  // Respons bisa berupa objek tunggal atau array tergantung jumlah kode;
  // normalisasi jadi map { code: price }
  const list = Array.isArray(json.data) ? json.data : [json.data];
  const prices = {};
  for (const item of list) {
    prices[item.code] = item.price;
  }
  return prices;
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

  const prices = await fetchOilPrices();
  const kurs = await fetchKurs();

  const brent = prices["BRENT_CRUDE_USD"];
  const dubai = prices["DUBAI_CRUDE_USD"];
  const mogas92 = prices["SINGAPORE_MOGAS_92_USD"];

  if (brent == null || dubai == null) {
    throw new Error("Brent/Dubai tidak ditemukan di respons API -- cek nama kode & langganan akun.");
  }

  const icpEstimate = ICP_MODEL.a * brent + ICP_MODEL.b * dubai + ICP_MODEL.c;

  const now = new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

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
  if (mogas92 != null) {
    row.mogas92_live = Math.round(mogas92 * 100) / 100; // dipakai app.js sbg MOPS RON92 langsung, prioritas di atas ICP+crack
  }
  row.updated_via = "oilpriceapi+frankfurter";
  row.updated_at = now.toISOString();

  await fs.writeFile(dataPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  console.log(`Updated ${monthKey}: ICP~${row.icp} (Brent=${brent}, Dubai=${dubai}), kurs=${row.kurs}, mogas92_live=${row.mogas92_live ?? "n/a"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
