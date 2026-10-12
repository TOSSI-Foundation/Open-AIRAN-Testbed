from __future__ import annotations

import io
import math
import os
import threading
import urllib.request
from pathlib import Path

import numpy as np
from fastapi import APIRouter, Response

from .sionna_bridge import SITES_DIR, WORK

router = APIRouter(prefix="/api/terrain", tags=["terrain"])

UPSTREAM = os.environ.get("TOSSI_TERRAIN_UPSTREAM",
                          "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png")
UP_MAXZ = 15
MAXZ = 18
SIZE = 256
FEATHER_M = 40.0
CACHE = WORK / "_terrain_cache"
_lock = threading.Lock()
_sites: dict[str, tuple] = {}


def _decode(png: bytes) -> np.ndarray:
    from PIL import Image
    a = np.asarray(Image.open(io.BytesIO(png)).convert("RGB"), dtype=np.float64)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768


def _encode(elev: np.ndarray) -> bytes:
    from PIL import Image
    v = np.clip(elev, -32768, 32767) + 32768
    r = np.floor(v / 256); g = np.floor(v - r * 256); b = np.floor((v - r * 256 - g) * 256)
    rgb = np.stack([r, g, b], -1).astype(np.uint8)
    buf = io.BytesIO(); Image.fromarray(rgb, "RGB").save(buf, "PNG", compress_level=6)
    return buf.getvalue()


def _upstream(z: int, x: int, y: int):
    p = CACHE / str(z) / str(x) / f"{y}.png"
    if not p.is_file():
        try:
            with urllib.request.urlopen(UPSTREAM.format(z=z, x=x, y=y), timeout=10) as r:
                data = r.read()
        except Exception:
            return None
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp"); tmp.write_bytes(data); tmp.replace(p)
    try:
        return _decode(p.read_bytes())
    except Exception:
        p.unlink(missing_ok=True)
        return None


def _pixel_lonlat(z: int, x: int, y: int):
    n = 2 ** z
    f = (np.arange(SIZE) + 0.5) / SIZE
    lon = (x + f) / n * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * (y + f) / n))))
    return lon, lat


def _upstream_at(z: int, x: int, y: int):
    if z <= UP_MAXZ:
        return _upstream(z, x, y)
    k = 2 ** (z - UP_MAXZ)
    parent = _upstream(UP_MAXZ, x // k, y // k)
    if parent is None:
        return None
    f = ((np.arange(SIZE) + 0.5) / SIZE)
    px = ((x % k) + f) / k * SIZE - 0.5
    py = ((y % k) + f) / k * SIZE - 0.5
    i0 = np.clip(np.floor(px).astype(int), 0, SIZE - 2); j0 = np.clip(np.floor(py).astype(int), 0, SIZE - 2)
    fx = np.clip(px - i0, 0, 1); fy = np.clip(py - j0, 0, 1)
    a = parent[np.ix_(j0, i0)]; b = parent[np.ix_(j0, i0 + 1)]
    c = parent[np.ix_(j0 + 1, i0)]; d = parent[np.ix_(j0 + 1, i0 + 1)]
    FX, FY = np.meshgrid(fx, fy)
    return a * (1 - FX) * (1 - FY) + b * FX * (1 - FY) + c * (1 - FX) * FY + d * FX * FY


def _site_dems():
    out = []
    if not SITES_DIR.is_dir():
        return out
    for d in sorted(SITES_DIR.iterdir()):
        p = d / "dem.npz"
        if not p.is_file():
            continue
        mt = p.stat().st_mtime
        with _lock:
            hit = _sites.get(d.name)
            if not hit or hit[0] != mt:
                f = np.load(p)
                hit = (mt, np.asarray(f["lons"], float), np.asarray(f["lats"], float), np.asarray(f["z"], float))
                _sites[d.name] = hit
        out.append(hit[1:])
    return out


def _overlay(elev, lon, lat, lons, lats, zz):
    if lon[-1] < lons[0] or lon[0] > lons[-1] or lat.min() > lats[-1] or lat.max() < lats[0]:
        return elev
    LON, LAT = np.meshgrid(lon, lat)
    inside = (LON >= lons[0]) & (LON <= lons[-1]) & (LAT >= lats[0]) & (LAT <= lats[-1])
    fx = np.clip((LON - lons[0]) / (lons[1] - lons[0]), 0, lons.size - 1.000001)
    fy = np.clip((LAT - lats[0]) / (lats[1] - lats[0]), 0, lats.size - 1.000001)
    i = fx.astype(int); j = fy.astype(int); u = fx - i; v = fy - j
    i1 = np.minimum(i + 1, lons.size - 1); j1 = np.minimum(j + 1, lats.size - 1)
    s = (zz[j, i] * (1 - u) * (1 - v) + zz[j, i1] * u * (1 - v) + zz[j1, i] * (1 - u) * v + zz[j1, i1] * u * v)
    ok = inside & np.isfinite(s)
    if not ok.any():
        return elev
    if elev is None:
        out = np.where(ok, s, np.nanmedian(s[ok]))
        return out
    mlat = 111320.0; mlon = 111320.0 * np.cos(np.radians(LAT))
    dist = np.minimum.reduce([(LON - lons[0]) * mlon, (lons[-1] - LON) * mlon,
                              (LAT - lats[0]) * mlat, (lats[-1] - LAT) * mlat])
    w = np.where(ok, np.clip(dist / FEATHER_M, 0, 1), 0)
    return np.where(ok, elev * (1 - w) + np.nan_to_num(s) * w, elev)


@router.get("/{z}/{x}/{y}.png")
def terrain_tile(z: int, x: int, y: int):
    if not (0 <= z <= MAXZ and 0 <= x < 2 ** z and 0 <= y < 2 ** z):
        return Response(status_code=404)
    lon, lat = _pixel_lonlat(z, x, y)
    elev = _upstream_at(z, x, y)
    for lons, lats, zz in _site_dems():
        elev = _overlay(elev, lon, lat, lons, lats, zz)
    if elev is None:
        return Response(status_code=404)
    return Response(content=_encode(elev), media_type="image/png",
                    headers={"Cache-Control": "public, max-age=3600"})
