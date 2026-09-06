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

function computeSeries(monthly, product, apbnData) {
  const W = WEIGHTS[product];
  const rows = monthly.map((r) => {
    const actual = product === "ron92" ? r.pertamax_actual : r.turbo_actual;
    const eco = hargaKeekonomian(r.icp, r.kurs, r.month, product, r.mogas92_live);
    const gapPct = ((eco - actual) / actual) * 100;
    return { month: r.month, icp: r.icp, kurs: r.kurs, actual, eco, gapPct };
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

function renderScoreCard(containerId, label, row) {
  const el = document.getElementById(containerId);
  el.innerHTML = `
    <h2>${label}</h2>
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

function renderChart(canvasId, rows, label, color) {
  const ctx = document.getElementById(canvasId).getContext("2d");
  new Chart(ctx, {
    type: "line",
    data: {
      labels: rows.map((r) => r.month),
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

function renderTable(tbodyId, rows) {
  const tbody = document.getElementById(tbodyId);
  const last12 = rows.slice(-12);
  tbody.innerHTML = last12
    .map(
      (r) => `
    <tr>
      <td>${r.month}</td>
      <td>${fmtRp(r.actual)}</td>
      <td>${fmtRp(r.eco)}</td>
      <td>${fmtPct(r.gapPct)}</td>
      <td>${r.duration}</td>
      <td>${Math.round(r.composite)}</td>
      <td><span class="badge ${r.light}">${lightLabel(r.light)}</span></td>
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

async function main() {
  await waitForChart();
  const res = await fetch("data.json");
  const data = await res.json();
  const apbnData = data.apbn_icp_assumptions || { values: {}, revisions: [] };

  const ron92Rows = computeSeries(data.monthly, "ron92", apbnData);
  const ron98Rows = computeSeries(data.monthly, "ron98", apbnData);

  const last92 = ron92Rows[ron92Rows.length - 1];
  const last98 = ron98Rows[ron98Rows.length - 1];

  renderScoreCard("card-pertamax", "Pertamax (RON 92)", last92);
  renderScoreCard("card-turbo", "Pertamax Turbo (RON 98)", last98);

  renderChart("chart-pertamax", ron92Rows, "Pertamax", "#e0524a");
  renderChart("chart-turbo", ron98Rows, "Pertamax Turbo", "#e0524a");

  renderTable("table-pertamax", ron92Rows);
  renderTable("table-turbo", ron98Rows);

  document.getElementById("last-updated").textContent =
    "Data bulanan sampai: " + data.monthly[data.monthly.length - 1].month;
}

main().catch((err) => {
  console.error(err);
  document.getElementById("last-updated").textContent = "Gagal memuat dashboard: " + err.message;
  document.getElementById("last-updated").style.color = "#e0524a";
});
