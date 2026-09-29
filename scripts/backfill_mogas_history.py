"""
backfill_mogas_history.py
------------------------------------------------------------
Mengisi histori harga Mogas 92 & Mogas 97 (TradingView) ke data.json,
dan menghitung rerata selisih (gap) Mogas 97 - Mogas 92 yang dipakai
untuk memproyeksikan MOPS Pertamax Turbo (RON 98).

Sumber (data/raw/):
  X01_Date_Close.csv   Mogas 97 harga absolut (US$/bbl)
  1NA1_Date_Close.csv  Crack spread Mogas 92 vs Dubai (US$/bbl)
  DCB1_Date_Close.csv  Dubai crude (US$/bbl)

Mogas 92 absolut direkonstruksi = Dubai (DCB1) + crack 1NA1, karena
1NA1 memang didefinisikan sebagai selisih Mogas 92 terhadap Dubai.

Kenapa gap 97-92, bukan crack spread X01 - ICP?
Backtest 430 hari (Sep 2022 - Ags 2024 + Jun 2026):
  - Mogas92 + rerata gap : MAE 0,87 US$/bbl (out-of-sample 2024: 0,86)
  - ICP + crack98 (X01-ICP): MAE 5,20 (out-of-sample 2024: 4,79)
Gap 97-92 jauh lebih stabil (std 1,27) dibanding crack98 (std 6,29),
dan menjamin MOPS RON98 selalu di atas MOPS RON92.

Jalankan ulang kapan saja CSV di data/raw/ diperbarui:
  python3 scripts/backfill_mogas_history.py
"""
import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
DATA = ROOT / "data.json"
FFILL_MAX_DAYS = 5  # isi hari tanpa kuotasi (libur bursa) maks 5 hari kalender


def load(name, col):
    df = pd.read_csv(RAW / f"{name}_Date_Close.csv", parse_dates=["Date"])
    return df.rename(columns={"Close": col}).set_index("Date")[col].sort_index()


def main():
    m97 = load("X01", "m97")
    crack92 = load("1NA1", "crack92")
    dubai = load("DCB1", "dubai")

    tv = pd.concat([m97, crack92, dubai], axis=1, join="inner")
    tv["m92"] = tv.dubai + tv.crack92
    tv["gap"] = tv.m97 - tv.m92

    gap = {
        "value": round(float(tv.gap.mean()), 2),
        "median": round(float(tv.gap.median()), 2),
        "std": round(float(tv.gap.std()), 2),
        "n_days": int(len(tv)),
        "period": f"{tv.index.min().date()} s/d {tv.index.max().date()}",
        "note": (
            "Rerata selisih harian Mogas 97 (TradingView X01) - Mogas 92 (DCB1 + 1NA1). "
            "MOPS Pertamax Turbo = MOPS RON92 + nilai ini, kecuali di tanggal yang punya "
            "harga Mogas 97 historis (mogas97_hist). Menggantikan crack spread RON98 "
            "(X01 - ICP = 17,02) yang jauh kurang akurat (MAE 5,2 vs 0,87 US$/bbl)."
        ),
    }

    data = json.loads(DATA.read_text(encoding="utf-8"))
    data["mogas_gap_97_92"] = gap

    # ---------------- harian ----------------
    daily_dates = pd.to_datetime([r["date"] for r in data["daily"]])
    tv_ff = (
        tv[["m92", "m97"]]
        .reindex(tv.index.union(daily_dates))
        .ffill(limit=FFILL_MAX_DAYS)
    )
    # jangan forward-fill menyeberangi gap data yang panjang (Ags 2024 - Jun 2026)
    last_obs = pd.Series(tv.index, index=tv.index).reindex(tv_ff.index).ffill()
    stale = (tv_ff.index.to_series() - last_obs).dt.days > FFILL_MAX_DAYS
    tv_ff.loc[stale.values] = None
    tv_ff.loc[tv_ff.index > tv.index.max()] = None  # jangan isi melewati akhir data

    n_daily = 0
    for row in data["daily"]:
        row.pop("mogas92_hist", None)
        row.pop("mogas97_hist", None)
        ts = pd.Timestamp(row["date"])
        if ts in tv_ff.index and pd.notna(tv_ff.at[ts, "m92"]):
            row["mogas92_hist"] = round(float(tv_ff.at[ts, "m92"]), 2)
            row["mogas97_hist"] = round(float(tv_ff.at[ts, "m97"]), 2)
            n_daily += 1

    # ---------------- bulanan ----------------
    monthly_tv = tv.groupby(tv.index.to_period("M"))[["m92", "m97"]].mean()
    n_monthly = 0
    for row in data["monthly"]:
        p = pd.Period(row["month"], freq="M")
        row.pop("mogas92_hist", None)
        row.pop("mogas97_hist", None)
        if p in monthly_tv.index:
            # nilai lama di field mogas92_live utk bulan histori = ICP + 1NA1
            # (basis ICP, bukan Dubai) -- diganti dgn rekonstruksi yg konsisten
            if row.get("updated_via") is None:
                row.pop("mogas92_live", None)
            row["mogas92_hist"] = round(float(monthly_tv.at[p, "m92"]), 2)
            row["mogas97_hist"] = round(float(monthly_tv.at[p, "m97"]), 2)
            n_monthly += 1

    # estimasi Mogas 97 utk baris yg punya Mogas 92 live/estimasi tapi tanpa X01
    for rows in (data["daily"], data["monthly"]):
        for row in rows:
            row.pop("mogas97_estimated", None)
            if "mogas97_hist" in row:
                continue
            base = row.get("mogas92_live", row.get("mogas92_estimated"))
            if isinstance(base, (int, float)):
                row["mogas97_estimated"] = round(base + gap["value"], 2)

    data["daily_note"] = (
        data.get("daily_note", "").split(" Mogas 92/97 historis")[0]
        + " Mogas 92/97 historis (mogas92_hist/mogas97_hist) dari TradingView "
        "(DCB1+1NA1 / X01), tersedia Sep 2022 - Ags 2024 & awal Jun 2026."
    )

    DATA.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"gap 97-92: {gap}")
    print(f"baris harian terisi: {n_daily}, bulanan terisi: {n_monthly}")


if __name__ == "__main__":
    main()
