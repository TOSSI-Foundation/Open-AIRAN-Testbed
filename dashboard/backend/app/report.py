from __future__ import annotations

import html
import time
from pathlib import Path
from typing import Optional

from . import calibration, runs_store, stability

MIN_POINTS = 30
MIN_DISTINCT_X = 8
MIN_SPAN_DB = 5.0
STRONG_R2 = 0.8
FAIR_R2 = 0.5
SLOPE_TOLERANCE = 0.25

SHORT_RUN_S = 120.0


def _fmt(v, digits: int = 1, unit: str = "") -> str:
    if v is None:
        return "—"
    if isinstance(v, float):
        return f"{v:.{digits}f}{unit}"
    return f"{v}{unit}"


def _stat_line(stat: Optional[dict], unit: str = "") -> Optional[str]:
    if not stat:
        return None
    return (f"{_fmt(stat.get('min'), 1, unit)} to {_fmt(stat.get('max'), 1, unit)}, "
            f"mean {_fmt(stat.get('avg'), 1, unit)} over {stat.get('n')} samples")


def _section(name: str, *, available: bool, why: str = "", **body) -> dict:
    out = {"name": name, "available": bool(available)}
    if not available:
        out["why"] = why or "not recorded"
        return out
    out.update(body)
    return out


def fit_verdict(fit: Optional[dict]) -> dict:
    if not fit or fit.get("n") is None:
        return {"verdict": "none", "claim": "No fit could be made.", "usable": False}

    n = fit.get("n") or 0
    r2 = fit.get("r2")
    slope = fit.get("slope")
    distinct = fit.get("distinct_x") or 0
    span = fit.get("x_span") or 0.0

    limits = []
    if n < MIN_POINTS:
        limits.append(f"only {n} paired samples (want {MIN_POINTS}+)")
    if distinct < MIN_DISTINCT_X:
        limits.append(f"only {distinct} distinct traced values")
    if span < MIN_SPAN_DB:
        limits.append(f"the traced channel varied by {span:.1f} dB, too little to fit against")

    if limits:
        return {"verdict": "insufficient", "usable": False, "limits": limits,
                "claim": "Not enough here to say whether the model predicts the radio: "
                         + "; ".join(limits) + "."}

    if r2 is None:
        return {"verdict": "none", "claim": "No correlation could be computed.", "usable": False}

    if r2 >= STRONG_R2:
        level = "strong"
    elif r2 >= FAIR_R2:
        level = "partial"
    else:
        level = "weak"

    off_scale = slope is not None and abs(slope - 1.0) > SLOPE_TOLERANCE
    claim = {
        "strong": f"The traced channel predicts the measurement: r²={r2:.3f} over {n} samples.",
        "partial": f"The traced channel partly explains the measurement: r²={r2:.3f} over "
                   f"{n} samples — real, but something else is moving it too.",
        "weak": f"The traced channel does not explain the measurement here: r²={r2:.3f} over "
                f"{n} samples.",
    }[level]
    if off_scale and level != "weak":
        claim += (f" The slope is {slope:.3f}, not 1 — it tracks the shape of the measurement "
                  "but not its scale, which is agreement in trend rather than in value.")
    return {"verdict": level, "usable": True, "claim": claim,
            "limits": [], "slope_off_scale": bool(off_scale)}


def _identity(run: dict, d: Path) -> dict:
    started, ended = run.get("started"), run.get("ended")
    prov = (run.get("params") or {}).get("provenance") or {}
    stack = (prov.get("stack") or {}).get("repos") or {}
    return _section(
        "What this run was", available=True,
        run_id=run.get("id"),
        label=run.get("label"),
        scene=run.get("scene_name") or run.get("scene_id"),
        du_config=run.get("du_config"),
        state=run.get("state"),
        started=time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(started)) if started else None,
        duration_s=round(ended - started, 1) if (started and ended) else None,
        commits={k: (v or {}).get("commit_short") for k, v in stack.items() if v},
        dirty=[k for k, v in stack.items() if (v or {}).get("dirty")],
        scene_fingerprint=(prov.get("scene") or {}).get("sha256", "")[:12] or None,
    )


def _channel(summary: dict, d: Path) -> dict:
    n = summary.get("telemetry_samples") or 0
    if n:
        return _section(
            "What the channel did", available=True,
            updates=n,
            gain=_stat_line(summary.get("gain_db"), " dB"),
            paths=_stat_line(summary.get("paths")),
        )

    live = calibration.load_series(d / "telemetry.jsonl")
    if not live:
        return _section("What the channel did", available=False,
                        why="no channel updates were recorded")

    def _stat(key):
        vals = [s.get(key) for s in live if s.get(key) is not None]
        if not vals:
            return None
        return {"min": round(min(vals), 1), "max": round(max(vals), 1),
                "avg": round(sum(vals) / len(vals), 1), "n": len(vals)}

    return _section(
        "What the channel did", available=True,
        updates=len(live),
        gain=_stat_line(_stat("gain_db"), " dB"),
        paths=_stat_line(_stat("paths")),
        from_live_file=True,
    )


def _radio(summary: dict, d: Path) -> dict:
    ue = calibration.load_series(d / "ue_kpi.jsonl")
    sinrs = [s.get("sinr") for s in ue if s.get("sinr") is not None]
    rsrp, snr = summary.get("rsrp_db"), summary.get("snr_db")
    if not (rsrp or snr or sinrs):
        return _section("What the radio measured", available=False,
                        why="no modem samples were recorded — the UE may never have attached")
    return _section(
        "What the radio measured", available=True,
        rsrp=_stat_line(rsrp, " dB"),
        snr=_stat_line(snr, " dB"),
        ue_sinr=(f"{min(sinrs):.0f} to {max(sinrs):.0f}, mean {sum(sinrs)/len(sinrs):.1f} "
                 f"over {len(sinrs)} samples") if sinrs else None,
        ue_sinr_samples=len(sinrs),
    )


def _agreement(d: Path, run: dict, tolerance_s: float) -> dict:
    try:
        cal = calibration.calibrate(d, run, tolerance_s=tolerance_s)
    except Exception as exc:
        return _section("Did the model predict reality", available=False,
                        why=f"the comparison could not be run: {exc}")

    usable = [c for c in cal.get("comparisons", []) if c.get("available")]
    if not usable:
        return _section("Did the model predict reality", available=False,
                        why="nothing measured was recorded beside the traced channel, so there "
                            "is nothing to compare it against")

    out = []
    for c in usable:
        fit = c.get("aligned_fit") or c.get("fit")
        lag = (c.get("lag") or {}).get("seconds") if c.get("lag") else None
        out.append({
            "label": c.get("label"),
            "unit": c.get("unit"),
            "role": c.get("role"),
            "lag_s": lag,
            "lag_corrected": bool(c.get("aligned_fit")),
            "fit": {k: fit.get(k) for k in
                    ("n", "slope", "intercept", "r2", "distinct_x", "x_span", "y_span")},
            "verdict": fit_verdict(fit),
            "note": c.get("note"),
        })
    ranked = sorted(out, key=lambda c: (c["verdict"]["usable"], c["fit"].get("r2") or -1),
                    reverse=True)
    return _section("Did the model predict reality", available=True,
                    comparisons=out, headline=ranked[0] if ranked else None,
                    tolerance_s=cal.get("tolerance_s"),
                    traced_span_db=cal.get("traced_span_db"))


def _stability(d: Path) -> dict:
    try:
        diag = stability.diagnose(d)
    except Exception as exc:
        return _section("What ended the link", available=False,
                        why=f"the logs could not be read: {exc}")
    if diag.get("dropped") is None:
        return _section("What ended the link", available=False,
                        why="; ".join(diag.get("findings") or ["no logs were kept"]))
    return _section("What ended the link", available=True,
                    dropped=diag["dropped"],
                    findings=diag.get("findings") or [],
                    shared_logs=[k for k, v in (diag.get("sources") or {}).items()
                                 if v.get("shared")])


def _caveats(run: dict, sections: dict) -> list[str]:
    out = []
    ident = sections["identity"]
    dur = ident.get("duration_s")
    if run.get("state") == "recording":
        out.append("This run is still recording, so every figure here is a partial one.")
    elif dur is not None and dur < SHORT_RUN_S:
        out.append(f"The run lasted {dur:.0f} s, which is short enough that these averages "
                   "mostly describe bring-up rather than steady state.")
    if ident.get("dirty"):
        out.append("Uncommitted changes were present in " + ", ".join(ident["dirty"])
                   + " when this ran, so the commit above does not fully identify the code.")

    ag = sections["agreement"]
    if ag.get("available"):
        for c in ag["comparisons"]:
            for lim in c["verdict"].get("limits", []):
                out.append(f"{c['label']}: {lim}.")
            if c.get("role") == "control":
                out.append(f"{c['label']} is a control on this build, not a result — it is "
                           "shown so it can be checked, not so it can be cited.")
            if c.get("lag_corrected") and c.get("lag_s"):
                out.append(f"{c['label']} is fitted after correcting a {c['lag_s']:.0f} s lag "
                           "between the two series; the uncorrected fit is weaker.")

    st = sections["stability"]
    if st.get("available") and st.get("shared_logs"):
        out.append("Read from logs shared with every other run on this stack ("
                   + ", ".join(st["shared_logs"]) + "), so events outside this run's window "
                   "may appear.")
    if not sections["radio"].get("available"):
        out.append("Nothing the modem reported was recorded, so nothing here is evidence about "
                   "a real radio — only about what was traced.")
    return out


def build(run_id: str, *, tolerance_s: float = calibration.DEFAULT_TOLERANCE_S) -> dict:
    run = runs_store.get_run(run_id)
    if not run:
        raise FileNotFoundError(run_id)
    d = runs_store.run_dir(run_id)
    if not d.is_dir():
        raise FileNotFoundError(run_id)
    summary = run.get("summary") or {}

    sections = {
        "identity": _identity(run, d),
        "channel": _channel(summary, d),
        "radio": _radio(summary, d),
        "agreement": _agreement(d, run, tolerance_s),
        "stability": _stability(d),
    }
    caveats = _caveats(run, sections)

    ag = sections["agreement"]
    head = ag.get("headline") if ag.get("available") else None
    return {
        "run_id": run_id,
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "headline": (head or {}).get("verdict", {}).get("claim")
                    or "This run made no comparison between the model and a radio.",
        "sections": sections,
        "caveats": caveats,
    }


_CSS = """
:root{--fg:#1a1d21;--dim:#5b6572;--line:#dfe3e8;--bg:#fff;--accent:#0b5cd5;--warn:#8a5a00;
--warnbg:#fff8e6;--ok:#0a7a4a;--bad:#b3261e}
@media(prefers-color-scheme:dark){:root{--fg:#e8eaed;--dim:#9aa4b2;--line:#2c3238;--bg:#15181c;
--accent:#7aa7ff;--warn:#e0b25c;--warnbg:#2a2416;--ok:#5cc98f;--bad:#ff8a80}}
*{box-sizing:border-box}
body{margin:0;padding:2.5rem 1.25rem;background:var(--bg);color:var(--fg);
font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:52rem;margin:0 auto}
h1{font-size:1.5rem;margin:0 0 .25rem}
h2{font-size:1.05rem;margin:2.25rem 0 .5rem;padding-bottom:.3rem;border-bottom:1px solid var(--line)}
.sub{color:var(--dim);font-size:.9rem;margin:0 0 1.5rem}
.headline{font-size:1.15rem;line-height:1.5;padding:1rem 1.15rem;border-left:3px solid var(--accent);
background:color-mix(in srgb,var(--accent) 7%,transparent);border-radius:0 4px 4px 0;margin:0 0 .5rem}
table{border-collapse:collapse;width:100%;font-size:.92rem}
td{padding:.4rem .6rem .4rem 0;vertical-align:top;border-bottom:1px solid var(--line)}
td:first-child{color:var(--dim);width:34%;white-space:nowrap}
.absent{color:var(--dim);font-style:italic}
.verdict{font-weight:600}
.v-strong{color:var(--ok)}.v-weak,.v-insufficient{color:var(--bad)}.v-partial{color:var(--warn)}
ul{margin:.4rem 0;padding-left:1.2rem}
li{margin:.3rem 0}
.caveats{background:var(--warnbg);border:1px solid color-mix(in srgb,var(--warn) 35%,transparent);
border-radius:6px;padding:.9rem 1.15rem;font-size:.9rem}
.caveats h2{border:0;margin:0 0 .4rem;font-size:.95rem;color:var(--warn)}
code{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim)}
.wrap{overflow-x:auto}
"""


def _rows(pairs) -> str:
    out = []
    for k, v in pairs:
        if v is None or v == [] or v == {}:
            v = '<span class="absent">not recorded</span>'
        else:
            v = html.escape(str(v))
        out.append(f"<tr><td>{html.escape(k)}</td><td>{v}</td></tr>")
    return "".join(out)


def _render_section(sec: dict) -> str:
    title = f"<h2>{html.escape(sec['name'])}</h2>"
    if not sec.get("available"):
        return title + f'<p class="absent">{html.escape(sec.get("why", "not recorded"))}</p>'
    name = sec["name"]

    if name.startswith("What this run"):
        commits = ", ".join(f"{k} {v}" for k, v in (sec.get("commits") or {}).items() if v)
        return title + "<table>" + _rows([
            ("Run", sec.get("run_id")), ("Label", sec.get("label")),
            ("Scene", sec.get("scene")), ("O-DU config", sec.get("du_config")),
            ("Started", sec.get("started")),
            ("Duration", f"{sec['duration_s']:.0f} s" if sec.get("duration_s") else None),
            ("State", sec.get("state")),
            ("Stack", commits or None),
            ("Scene fingerprint", sec.get("scene_fingerprint")),
        ]) + "</table>"

    if name.startswith("What the channel"):
        return title + "<table>" + _rows([
            ("Channel updates", sec.get("updates")),
            ("Path gain", sec.get("gain")),
            ("Propagation paths", sec.get("paths")),
        ]) + "</table>"

    if name.startswith("What the radio"):
        return title + "<table>" + _rows([
            ("Uplink RSRP", sec.get("rsrp")),
            ("Uplink SNR", sec.get("snr")),
            ("UE SINR (downlink)", sec.get("ue_sinr")),
        ]) + "</table>"

    if name.startswith("Did the model"):
        parts = [title]
        for c in sec["comparisons"]:
            v = c["verdict"]
            f = c["fit"]
            parts.append(f'<p class="verdict v-{v["verdict"]}">{html.escape(c["label"])} — '
                         f'{html.escape(v["claim"])}</p>')
            parts.append('<div class="wrap"><table>' + _rows([
                ("Samples", f.get("n")),
                ("Slope", None if f.get("slope") is None else round(f["slope"], 3)),
                ("r²", None if f.get("r2") is None else round(f["r2"], 3)),
                ("Distinct traced values", f.get("distinct_x")),
                ("Traced range", None if f.get("x_span") is None
                 else f"{f['x_span']:.1f} dB"),
                ("Lag corrected", f"{c['lag_s']:.0f} s" if c.get("lag_corrected")
                 and c.get("lag_s") else ("no" if not c.get("lag_corrected") else "yes")),
                ("Role", c.get("role")),
            ]) + "</table></div>")
        return "".join(parts)

    if name.startswith("What ended"):
        items = "".join(f"<li>{html.escape(f)}</li>" for f in sec.get("findings", []))
        state = "The link dropped." if sec.get("dropped") else "The link was not released."
        return title + f"<p>{state}</p><ul>{items}</ul>"

    return title


def render_html(report: dict) -> str:
    secs = report["sections"]
    body = "".join(_render_section(secs[k]) for k in
                   ("identity", "channel", "radio", "agreement", "stability"))
    caveats = ""
    if report.get("caveats"):
        items = "".join(f"<li>{html.escape(c)}</li>" for c in report["caveats"])
        caveats = ('<div class="caveats"><h2>Read these numbers with</h2>'
                   f'<ul>{items}</ul></div>')
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Run {html.escape(report['run_id'])}</title><style>{_CSS}</style></head>
<body><main>
<h1>Run report</h1>
<p class="sub"><code>{html.escape(report['run_id'])}</code> · generated {html.escape(report['generated'])}</p>
<p class="headline">{html.escape(report['headline'])}</p>
{caveats}
{body}
</main></body></html>"""
