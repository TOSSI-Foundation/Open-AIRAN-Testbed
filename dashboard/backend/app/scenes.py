from __future__ import annotations

import json
from pathlib import Path

WORK = Path(__file__).resolve().parents[1] / "work"

_OK = {"bg": "#E1F1F4", "fg": "#0D7A8C"}
_WARN = {"bg": "#FDF1DF", "fg": "#A56C08"}
_NEUTRAL = {"bg": "#EEF3F4", "fg": "#3B4C54"}


def _area_km2(size_m) -> str:
    try:
        w, h = float(size_m[0]), float(size_m[1])
        km2 = (w * h) / 1_000_000.0
        return f"{km2:.2f} km²" if km2 >= 0.01 else f"{int(w * h)} m²"
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

    scene_id = dir_path.name
    city = m.get("city") or "Untitled scene"

    saved_name = ""
    meta_path = dir_path / "meta.json"
    if meta_path.exists():
        try:
            saved_name = (json.loads(meta_path.read_text()).get("name") or "").strip()
        except (OSError, ValueError):
            saved_name = ""
    display_name = saved_name or city
    bbox = m.get("bbox") or {}
    nodes = m.get("nodes") or []
    n_gnb = sum(1 for n in nodes if n.get("type") == "gnb")
    n_ue = sum(1 for n in nodes if n.get("type") == "ue")
    buildings = m.get("buildings") or {}
    source = buildings.get("source", "unknown")
    source_label = "OpenStreetMap" if source == "osm" else (
        "Overture" if source == "overture" else source.title()
    )

    built = (dir_path / "scene" / "scene.xml").exists()
    has_cov = (dir_path / "coverage.json").exists()

    if has_cov:
        badge, tone = "Coverage ready", _OK
    elif built:
        badge, tone = "Scene built", _OK
    else:
        badge, tone = "Package only", _WARN

    ts = scene_id.split("-")[0:2]
    sort_key = "".join(ts)

    return {
        "id": scene_id,
        "name": display_name,
        "city": city,
        "source": f"{source_label} · {m.get('generator', 'sionna-map')}",
        "area": _area_km2(bbox.get("size_m")),
        "buildings": f"{n_gnb} gNB · {n_ue} UE",
        "updated": f"{n_gnb + n_ue} nodes",
        "badge": badge,
        "badgeBg": tone["bg"],
        "badgeFg": tone["fg"],
        "slot": scene_id,
        "built": built,
        "coverage": has_cov,
        "bbox": bbox,
        "nodes": {"gnb": n_gnb, "ue": n_ue},
        "_sort": sort_key,
    }


def list_scenes() -> list[dict]:
    if not WORK.exists():
        return []
    out: list[dict] = []
    for d in WORK.iterdir():
        if d.is_dir():
            item = _one(d)
            if item:
                out.append(item)
    out.sort(key=lambda s: s.get("_sort", ""), reverse=True)
    for s in out:
        s.pop("_sort", None)
    return out
