from __future__ import annotations

import json
from pathlib import Path

WORK = Path(__file__).resolve().parents[1] / "work"

_OK = {"fg": "#0FA36B", "bg": "#E1F1F4"}
_NEUTRAL = {"fg": "#3B4C54", "bg": "#EEF3F4"}
_WARN = {"fg": "#B07908", "bg": "#FDF1DF"}


def _fmt_ts(scene_id: str) -> str:
    try:
        date, tm = scene_id.split("-")[0], scene_id.split("-")[1]
        y, mo, d = date[0:4], date[4:6], date[6:8]
        hh, mm = tm[0:2], tm[2:4]
        months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        return f"{int(d)} {months[int(mo) - 1]}, {hh}:{mm}"
    except Exception:
        return "—"


def _one(dir_path: Path) -> dict | None:
    pkg = dir_path / "package.json"
    if not pkg.exists():
        return None
    try:
        raw = json.loads(pkg.read_text())
    except Exception:
        return None
    m = raw.get("manifest", raw)

    run_id = dir_path.name
    city = m.get("city") or "Untitled scene"
    bbox = m.get("bbox") or {}
    nodes = m.get("nodes") or []
    n_gnb = sum(1 for n in nodes if n.get("type") == "gnb")
    n_ue = sum(1 for n in nodes if n.get("type") == "ue")

    built = (dir_path / "scene" / "scene.xml").exists()
    cov_path = dir_path / "coverage.json"
    has_cov = cov_path.exists()

    covered_pct = None
    gain_min = gain_max = None
    thumb = None
    if has_cov:
        try:
            cov = json.loads(cov_path.read_text())
            st = cov.get("stats", {}) or {}
            total = st.get("total_cells") or 0
            covered = st.get("covered_cells") or 0
            if total:
                covered_pct = round(100.0 * covered / total, 1)
            gm = st.get("gain_db_min")
            gx = st.get("gain_db_max")
            if gm is not None:
                gain_min = round(float(gm), 1)
            if gx is not None:
                gain_max = round(float(gx), 1)
            img = cov.get("image")
            if img and len(img) < 120_000:
                thumb = img
        except Exception:
            pass

    if has_cov:
        state, tone = "Completed", _OK
    elif built:
        state, tone = "Scene built", _NEUTRAL
    else:
        state, tone = "Package only", _WARN

    size = bbox.get("size_m") or []
    try:
        area = f"{(float(size[0]) * float(size[1]) / 1e6):.2f} km²"
    except Exception:
        area = "—"

    return {
        "id": run_id,
        "scene": city,
        "city": city,
        "state": state,
        "color": tone["fg"],
        "bg": tone["bg"],
        "started": _fmt_ts(run_id),
        "area": area,
        "cells": str(n_gnb),
        "ues": str(n_ue),
        "coverage_pct": covered_pct,
        "gain_db_min": gain_min,
        "gain_db_max": gain_max,
        "has_coverage": has_cov,
        "built": built,
        "thumb": thumb,
        "overlay_url": f"/api/runs/{run_id}/overlay" if has_cov else None,
        "_sort": "".join(run_id.split("-")[0:2]),
    }


def list_runs() -> list[dict]:
    if not WORK.exists():
        return []
    out: list[dict] = []
    for d in WORK.iterdir():
        if d.is_dir():
            item = _one(d)
            if item:
                out.append(item)
    out.sort(key=lambda r: r.get("_sort", ""), reverse=True)
    for r in out:
        r.pop("_sort", None)
    return out


def get_run(run_id: str) -> dict | None:
    d = WORK / run_id
    return _one(d) if d.is_dir() else None


def overlay_data_uri(run_id: str) -> str | None:
    cov = WORK / run_id / "coverage.json"
    if not cov.exists():
        return None
    try:
        data = json.loads(cov.read_text())
        return data.get("image")
    except Exception:
        return None
