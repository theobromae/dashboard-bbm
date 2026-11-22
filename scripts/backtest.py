"""Backtest bulanan skor peringatan dini (replika app.js, wilayah DKI Jakarta).

Definisi (sama dengan backtest kalibrasi Sep 2026):
  - Kejadian = kenaikan harga aktual bulanan >= 8% (bulan t vs t-1).
  - Recall   : kejadian dianggap tertangkap kalau ada bulan MERAH di t-3..t-1.
  - Presisi  : bulan MERAH dianggap benar kalau ada kejadian di i+1..i+3.

Pakai:  python3 scripts/backtest.py
"""
import json, itertools, pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parents[1]
D = json.loads((ROOT / "data.json").read_text())
GAP_97_92 = D["mogas_gap_97_92"]["value"]
CRACK92 = 10.32
EVENT_PCT = 8.0
LOOK = 3

def regime_const(m, prod):
    ym = int(m[:4]) * 100 + int(m[5:7])
    if ym < 202001: return 2542 if prod == "ron92" else 3178
    if ym <= 202002: return 1000 if prod == "ron92" else 1200
    return 1800 if prod == "ron92" else 2000

def mops92(r):
    for k in ("mogas92_live", "mogas92_hist", "mogas92_estimated"):
        if r.get(k) is not None: return r[k]
    return r["icp"] + CRACK92

def mops98_base(r):  # harga Mogas 97 (US$/bbl)
    return r["mogas97_hist"] if r.get("mogas97_hist") is not None else mops92(r) + GAP_97_92

def tax_mult(m, fixed):
    if not fixed: return 1.15
    return 1.16 if m >= "2022-04" else 1.15   # PPN 10%->11% (Apr 2022) + PBBKB 5%

def eco(r, prod, fixed):
    m = r["month"]
    if prod == "ron92": mops = mops92(r)
    else: mops = mops98_base(r) * (1.01 if fixed else 1.0)  # Kepmen: RON98 = 101% x Mogas 97
    dasar = (mops * r["kurs"] / 159 + regime_const(m, prod)) / 0.9
    return dasar * tax_mult(m, fixed)

def pertalite_price(m):
    last = None
    y, mo = int(m[:4]), int(m[5:7])
    import calendar
    end = f"{m}-{calendar.monthrange(y, mo)[1]:02d}"
    for c in D["pertalite"]["price_changes"]:
        if c["date"] <= end: last = c["price"]
    return last

def eco_pertalite(r):
    m = r["month"]
    ppn = 0.11 if m >= "2022-04" else 0.10
    dasar = 0.9921 * mops92(r) * r["kurs"] / 159 + 1200
    return (dasar + 90) * (1 + ppn + 0.05)

def apbn_for(m):
    a = D["apbn_icp_assumptions"]; y = m[:4]
    rev = [x for x in a["revisions"] if x["effective_month"][:4] == y and x["effective_month"] <= m]
    if rev: return sorted(rev, key=lambda x: x["effective_month"])[-1]["value"]
    return a["values"].get(y)

def actual(r, prod):
    v = r["pertamax_actual" if prod == "ron92" else "turbo_actual"]
    return v if isinstance(v, (int, float)) else (v or {}).get("jakarta")

def base_rows(prod, fixed):
    rows = []
    for r in D["monthly"]:
        a = actual(r, prod)
        if a is None: continue
        e = eco(r, prod, fixed)
        pe = eco_pertalite(r); pp = pertalite_price(r["month"])
        rows.append(dict(month=r["month"], icp=r["icp"], kurs=r["kurs"], actual=a, eco=e,
                         gap=(e - a) / a * 100,
                         plite_gap=(pe - pp) / pp * 100, plite_selisih=pe - pp,
                         disparitas=a - pp))
    return rows

def clamp(v, lo, hi): return max(lo, min(hi, v))

def score(rows, W):
    dur = 0
    out = []
    for i, r in enumerate(rows):
        dur = dur + 1 if r["gap"] > W["gapThresholdPct"] else 0
        j = max(0, i - 3)
        icpm = (r["icp"] - rows[j]["icp"]) / rows[j]["icp"] * 100
        kursm = (r["kurs"] - rows[j]["kurs"]) / rows[j]["kurs"] * 100
        gs = clamp(r["gap"] / W["gapMaxPct"] * 100, 0, 100)
        ds = clamp(dur / W["durationMaxMonths"] * 100, 0, 100)
        ms = clamp(max(0, icpm) / 30 * 60 + max(0, kursm) / 10 * 40, 0, 100)
        ap = apbn_for(r["month"])
        as_ = clamp(((r["icp"] - ap) / ap * 100) / 30 * 100, 0, 100) if ap else 0
        fs = clamp(r["plite_gap"] / W.get("fiscalMaxPct", 60) * 100, 0, 100)
        wf = W.get("fiscal", 0.0)
        if ap:
            comp = W["gap"]*gs + W["duration"]*ds + W["momentum"]*ms + W["apbn"]*as_ + wf*fs
            comp /= (W["gap"] + W["duration"] + W["momentum"] + W["apbn"] + wf)
        else:
            comp = (W["gap"]*gs + W["duration"]*ds + W["momentum"]*ms + wf*fs) / (W["gap"]+W["duration"]+W["momentum"]+wf)
        out.append({**r, "dur": dur, "comp": comp, "red": comp >= W["redAt"]})
    return out

def events(rows, pct=EVENT_PCT, direction=+1):
    ev = []
    for i in range(1, len(rows)):
        ch = (rows[i]["actual"] / rows[i-1]["actual"] - 1) * 100
        if (direction > 0 and ch >= pct) or (direction < 0 and ch <= -pct): ev.append(i)
    return ev

def evaluate(scored):
    ev = events(scored)
    caught = [i for i in ev if any(scored[k]["red"] for k in range(max(0, i-LOOK), i))]
    reds = [i for i, r in enumerate(scored) if r["red"]]
    tp = [i for i in reds if any(e in ev for e in range(i+1, i+LOOK+1))]
    # bulan merah di ujung data yg jendela 3 bulannya belum lewat: tidak dihitung
    n = len(scored)
    pending = [i for i in reds if i + LOOK >= n and i not in tp]
    judged = [i for i in reds if i not in pending]
    return dict(events=[scored[i]["month"] for i in ev], caught=[scored[i]["month"] for i in caught],
                n_events=len(ev), n_caught=len(caught), n_red=len(judged), n_tp=len(tp),
                pending=[scored[i]["month"] for i in pending],
                reds=[scored[i]["month"] for i in reds])

W_OLD = {
  "ron92": dict(gap=.25, duration=.45, momentum=.15, apbn=.15, gapMaxPct=50, durationMaxMonths=4, gapThresholdPct=31, redAt=66),
  "ron98": dict(gap=.40, duration=.40, momentum=.10, apbn=.10, gapMaxPct=50, durationMaxMonths=4, gapThresholdPct=20, redAt=55),
}

if __name__ == "__main__":
    for fixed in (False, True):
        for p in ("ron92", "ron98"):
            res = evaluate(score(base_rows(p, fixed), W_OLD[p]))
            print("FIX" if fixed else "OLD", p, f"recall {res['n_caught']}/{res['n_events']}",
                  f"presisi {res['n_tp']}/{res['n_red']}", "events", res["events"], "caught", res["caught"],
                  "reds", res["reds"], "pending", res["pending"])


# ------------------------------------------------------------
# Model tekanan fiskal Pertalite -> peluang historis perubahan harga
# Pertamax/Turbo. Indikator TAMBAHAN, tidak masuk skor gabungan:
# uji grid + leave-one-event-out menunjukkan menambahkannya ke skor
# overfit (peningkatan recall Pertamax hanya bergantung 1 bulan & gagal
# di leave-one-out). Yang dipakai: frekuensi empiris per zona gap.
# ------------------------------------------------------------
BANDS = [(None, 20), (20, 30), (30, 50), (50, None)]

def fiscal_model():
    out = {}
    for p, key in (("ron92", "pertamax"), ("ron98", "turbo")):
        rows = base_rows(p, True); n = len(rows)
        up = events(rows, EVENT_PCT, +1); dn = events(rows, EVENT_PCT, -1)
        upany = events(rows, 0.01, +1); dnany = events(rows, 0.01, -1)
        def fwd(i, ev): return any(e in ev for e in range(i + 1, i + LOOK + 1))
        bands = []
        for lo, hi in BANDS:
            idx = [i for i in range(n - LOOK)
                   if (lo is None or rows[i]["plite_gap"] >= lo) and (hi is None or rows[i]["plite_gap"] < hi)]
            bands.append(dict(min=lo, max=hi, n=len(idx),
                              up8=sum(fwd(i, up) for i in idx), up_any=sum(fwd(i, upany) for i in idx),
                              down_any=sum(fwd(i, dnany) for i in idx)))
        base_idx = range(n - LOOK)
        out[key] = dict(bands=bands, base=dict(n=len(base_idx), up8=sum(fwd(i, up) for i in base_idx)),
                        plite_gap_before_up8=[dict(month=rows[i]["month"], plite_gap=round(rows[i-1]["plite_gap"], 1),
                                                   gap=round(rows[i-1]["gap"], 1)) for i in up])
    return out

if __name__ == "__main__" and "--write-model" in sys.argv:
    fm = fiscal_model()
    D["pertalite"]["fiscal_model"] = {
        "note": "Frekuensi historis (2019-2026, DKI Jakarta, bulanan): dari bulan2 dgn gap Pertalite di zona tsb, berapa yg diikuti perubahan harga Pertamax/Turbo dalam 3 bulan. Jendela tumpang tindih & kejadian mengelompok (2022, 2026) -> efektif hanya beberapa episode; baca sbg indikasi, bukan probabilitas presisi. Dihitung ulang: python3 scripts/backtest.py --write-model",
        "lookahead_months": LOOK, "event_pct": EVENT_PCT, **fm}
    (ROOT / "data.json").write_text(json.dumps(D, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(fm, indent=1))
