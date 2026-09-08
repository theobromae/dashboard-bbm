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

   KALIBRASI PER PRODUK (hasil backtest 93 bulan, 2019-2026, dengan crack
   spread aktual RON92=10,32 dan RON98=17,02 dari data historis):
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

function hargaKeekonomian(icp, kurs, monthStr, product, mogas92Live) {
  const konst = regimeConstant(monthStr, product);
  let mops;
  if (product === "ron92" && mogas92Live != null) {
    mops = mogas92Live; // harga Mogas92 live (oilpriceapi) -- lebih akurat dari ICP+crack
  } else {
    const crack = product === "ron92" ? 10.32 : 17.02; // rata-rata crack spread aktual (data historis)
    mops = icp + crack;
  }
  const rpPerLiter = (mops * kurs) / 159;
  const hargaDasar = (rpPerLiter + konst) / 0.9; // margin 10% dari harga dasar (batas atas)
  return hargaDasar * 1.15;                        // + PPN & PBBKB (estimasi ~15%)
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

function getActualForDate(data, product, region, dateStr) {
  const prodKey = product === "ron92" ? "pertamax" : "turbo";
  const field = product === "ron92" ? "pertamax_actual" : "turbo_actual";
  const month = dateStr.slice(0, 7);
  const monthRow = data.monthly.find((r) => r.month === month);
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
  if (dailyRow) return { icp: dailyRow.icp, kurs: dailyRow.kurs, mogas92_live: dailyRow.mogas92_live };
  const month = dateStr.slice(0, 7);
  const monthRow = data.monthly.find((r) => r.month === month);
  return monthRow ? { icp: monthRow.icp, kurs: monthRow.kurs, mogas92_live: monthRow.mogas92_live } : { icp: null, kurs: null };
}

function buildDailyTimeline(data, product, region) {
  const firstMonth = data.monthly[0].month;
  const startStr = `${firstMonth}-01`;
  const todayStr = new Date().toISOString().slice(0, 10);
  const lastDaily = (data.daily || [])[data.daily.length - 1]?.date;
  const endStr = lastDaily && lastDaily > todayStr ? lastDaily : todayStr;

  // Map sekali di awal -- jauh lebih cepat drpd .find() per hari saat
  // data.daily sudah berisi ribuan baris (histori penuh 2019-2026).
  const dailyMap = new Map((data.daily || []).map((d) => [d.date, d]));

  const days = dateRangeDays(startStr, endStr);
  return days.map((date) => {
    const actual = getActualForDate(data, product, region, date);
    const { icp, kurs, mogas92_live } = getIcpKursForDate(data, date, dailyMap);
    const eco = icp != null && kurs != null ? hargaKeekonomian(icp, kurs, date.slice(0, 7), product, mogas92_live) : null;
    return { date, actual, icp, kurs, eco };
  }).filter((r) => r.actual != null);
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
    const valid = items.filter((i) => i.icp != null);
    const avgIcp = valid.length ? valid.reduce((s, i) => s + i.icp, 0) / valid.length : null;
    const avgKurs = valid.length ? valid.reduce((s, i) => s + i.kurs, 0) / valid.length : null;
    const last = items[items.length - 1];
    return { date: weekStart, actual: last.actual, icp: avgIcp, kurs: avgKurs, eco: last.eco };
  });
}

function getTimelineForResolution(data, product, region, resolution) {
  const daily = buildDailyTimeline(data, product, region);
  if (resolution === "harian") return daily;
  if (resolution === "mingguan") return resampleWeekly(daily);
  return null; // "bulanan" pakai jalur computeSeries yang sudah ada
}

function computeSeries(monthly, product, apbnData, region) {
  const W = WEIGHTS[product];
  // Hanya proses bulan yang punya data harga untuk wilayah yang dipilih --
  // wilayah selain Jakarta bisa jadi belum ada histori sama sekali.
  const filtered = monthly.filter((r) => {
    const raw = product === "ron92" ? r.pertamax_actual : r.turbo_actual;
    return readActual(raw, region) != null;
  });
  const rows = filtered.map((r) => {
    const raw = product === "ron92" ? r.pertamax_actual : r.turbo_actual;
    const actual = readActual(raw, region);
    const eco = hargaKeekonomian(r.icp, r.kurs, r.month, product, r.mogas92_live);
    const gapPct = ((eco - actual) / actual) * 100;
    const estKey = product === "ron92" ? "pertamax" : "turbo";
    const isEstimated = region !== "jakarta" && !!r.sumut_estimated?.[estKey];
    return { month: r.month, icp: r.icp, kurs: r.kurs, actual, eco, gapPct, isEstimated };
  });

  // durasi: berapa bulan berturut-turut gapPct > threshold (threshold beda per produk)
  let duration = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].gapPct > W.gapThresholdPct) duration += 1;
    else duration = 0;
    rows[i].duration = duration;
  }

  // momentum ICP & kurs (3 bulan)
  for (let i = 0; i < rows.length; i++) {
    const j = Math.max(0, i - 3);
    rows[i].icpMom3 = ((rows[i].icp - rows[j].icp) / rows[j].icp) * 100;
    rows[i].kursMom3 = ((rows[i].kurs - rows[j].kurs) / rows[j].kurs) * 100;
  }

  // skor komponen + skor gabungan
  for (const row of rows) {
    const apbnAssumption = apbnAssumptionFor(row.month, apbnData);

    const gapScore = clamp((row.gapPct / W.gapMaxPct) * 100, 0, 100);
    const durationScore = clamp((row.duration / W.durationMaxMonths) * 100, 0, 100);
    const momentumScore = clamp(
      ((Math.max(0, row.icpMom3) / W.icpMom3MaxPct) * 60 +
        (Math.max(0, row.kursMom3) / W.kursMom3MaxPct) * 40),
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
      composite =
        W.gap * gapScore +
        W.duration * durationScore +
        W.momentum * momentumScore +
        W.apbn * apbnScore;
    } else {
      const wSum = W.gap + W.duration + W.momentum;
      composite =
        (W.gap * gapScore +
          W.duration * durationScore +
          W.momentum * momentumScore) / wSum;
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
      <div class="comp">
        <div class="k">Deviasi Asumsi APBN</div>
        <div class="v">${row.hasApbn ? `ICP ${fmtPct(row.apbnDevPct)} vs asumsi $${row.apbnAssumption}` : "belum ada data"}</div>
        <div class="bar"><div style="width:${row.apbnScore}%;background:var(--purple)"></div></div>
      </div>
    </div>
  `;
}

const chartInstances = {};

function renderChart(canvasId, rows, label, color) {
  if (chartInstances[canvasId]) {
    chartInstances[canvasId].destroy();
    chartInstances[canvasId] = null;
  }
  if (!rows.length) return; // wilayah ini belum ada data sama sekali
  const ctx = document.getElementById(canvasId).getContext("2d");
  chartInstances[canvasId] = new Chart(ctx, {
    type: "line",
    data: {
      labels: rows.map((r) => r.month || r.date),
      datasets: [
        {
          label: `${label} - Aktual`,
          data: rows.map((r) => r.actual),
          borderColor: color,
          borderWidth: 3,
          pointRadius: 0,
          tension: 0.15,
          yAxisID: "y",
        },
        {
          label: `${label} - Keekonomian (estimasi)`,
          data: rows.map((r) => r.eco),
          borderColor: "#e0a72b",
          borderDash: [6, 4],
          borderWidth: 2.5,
          pointRadius: 0,
          tension: 0.15,
          yAxisID: "y",
        },
        {
          label: "ICP (US$/barel)",
          data: rows.map((r) => r.icp),
          borderColor: "#5b9bd5aa",
          borderWidth: 1.2,
          pointRadius: 0,
          tension: 0.15,
          yAxisID: "y1",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#e8ecf5", boxWidth: 14, font: { size: 11 } } },
        tooltip: { mode: "index", intersect: false },
        zoom: {
          pan: { enabled: true, mode: "x", modifierKey: null },
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            drag: { enabled: false },
            mode: "x",
          },
          limits: { x: { minRange: 10 } },
        },
      },
      scales: {
        x: { ticks: { color: "#93a0b8", maxTicksLimit: window.innerWidth < 640 ? 6 : 14 }, grid: { color: "#2a3348" } },
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

function renderTable(tbodyId, rows, showAll) {
  const tbody = document.getElementById(tbodyId);
  if (!rows || !rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted)">Belum ada data histori untuk wilayah ini</td></tr>`;
    return;
  }
  const displayRows = showAll ? rows : rows.slice(-12);
  tbody.innerHTML = displayRows
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

  const regionLabel = region === "jakarta" ? "DKI Jakarta" : "Sumatera Utara";
  renderScoreCard("card-pertamax", `Pertamax (RON 92) — ${regionLabel}`, last92);
  renderScoreCard("card-turbo", `Pertamax Turbo (RON 98) — ${regionLabel}`, last98);

  const ron92Display = currentResolution === "bulanan" ? ron92Monthly : getTimelineForResolution(data, "ron92", region, currentResolution);
  const ron98Display = currentResolution === "bulanan" ? ron98Monthly : getTimelineForResolution(data, "ron98", region, currentResolution);

  renderChart("chart-pertamax", ron92Display, "Pertamax", "#e0524a");
  renderChart("chart-turbo", ron98Display, "Pertamax Turbo", "#e0524a");

  const showAll = currentResolution !== "bulanan";
  renderTable("table-pertamax", ron92Display, showAll);
  renderTable("table-turbo", ron98Display, showAll);

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

function setupRegionSwitch() {
  document.querySelectorAll(".region-btn").forEach((btn) => {
    btn.addEventListener("click", () => renderAll(btn.dataset.region, currentResolution));
  });
  document.querySelectorAll(".res-btn").forEach((btn) => {
    btn.addEventListener("click", () => renderAll(currentRegion, btn.dataset.res));
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
  const newContentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2) + "\n")));
  const putRes = await fetch(apiUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `chore: update harga ${product === "ron92" ? "Pertamax" : "Pertamax Turbo"} ${region} ${date} -> Rp${price}`,
      content: newContentB64,
      sha: fileMeta.sha,
    }),
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

async function main() {
  await waitForChart();
  const res = await fetch("data.json");
  dashboardData = await res.json();

  setupRegionSwitch();
  setupUpdateForm();
  renderAll("jakarta", "bulanan");
}

main().catch((err) => {
  console.error(err);
  document.getElementById("last-updated").textContent = "Gagal memuat dashboard: " + err.message;
  document.getElementById("last-updated").style.color = "#e0524a";
});
