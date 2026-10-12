#!/usr/bin/env python3
import argparse
import json
import os
import sys
import time

import requests
from pyproj import Transformer

SITE = {"min_lon": -80.4420, "min_lat": 37.2130, "max_lon": -80.4050, "max_lat": 37.2380}
VT = "https://arcgis-central-prod.aws.gis.cloud.vt.edu/arcgis/rest/services"
UA = {"User-Agent": "tossi-realsite/1.0 (research digital twin)"}


def log(*a):
    print(*a, flush=True)


def get(url, params=None, timeout=180, binary=False, tries=4):
    for k in range(tries):
        try:
            r = requests.get(url, params=params, headers=UA, timeout=timeout)
            r.raise_for_status()
            return r.content if binary else r.json()
        except Exception as e:
            if k == tries - 1:
                raise
            log(f"  retry {k + 1} after: {str(e)[:120]}")
            time.sleep(5 * (k + 1))


def utm_box(b):
    t = Transformer.from_crs(4326, 32617, always_xy=True)
    xs, ys = [], []
    for lon in (b["min_lon"], b["max_lon"]):
        for lat in (b["min_lat"], b["max_lat"]):
            x, y = t.transform(lon, lat)
            xs.append(x); ys.append(y)
    return int(min(xs)) - 1, int(min(ys)) - 1, int(max(xs)) + 2, int(max(ys)) + 2


def fetch_osm(out, b):
    bb = f"({b['min_lat']},{b['min_lon']},{b['max_lat']},{b['max_lon']})"
    q = f"""[out:json][timeout:180];
(
  way["building"]{bb}; relation["building"]{bb};
  way["building:part"]{bb}; relation["building:part"]{bb};
  node["natural"="tree"]{bb};
  way["natural"="wood"]{bb}; relation["natural"="wood"]{bb};
  way["landuse"="forest"]{bb}; relation["landuse"="forest"]{bb};
);
out body geom;"""
    r = requests.post("https://overpass-api.de/api/interpreter", data={"data": q}, headers=UA, timeout=300)
    r.raise_for_status()
    open(os.path.join(out, "osm.json"), "wb").write(r.content)
    n = len(r.json()["elements"])
    log(f"osm.json: {n} elements")
    return {"url": "https://overpass-api.de/api/interpreter", "query": q, "elements": n}


def fetch_arcgis_layer(out, name, layer_url, where="1=1"):
    meta = get(layer_url, {"f": "json"})
    page = int(meta.get("maxRecordCount") or 1000)
    feats, off = [], 0
    while True:
        gj = get(layer_url + "/query", {"where": where, "outFields": "*", "outSR": 4326, "f": "geojson",
                                        "resultOffset": off, "resultRecordCount": page,
                                        "orderByFields": meta.get("objectIdField") or "objectid"})
        got = gj.get("features", [])
        feats += got
        log(f"  {name}: {len(feats)}")
        if len(got) < page:
            break
        off += page
    fc = {"type": "FeatureCollection", "features": feats}
    json.dump(fc, open(os.path.join(out, name), "w"))
    log(f"{name}: {len(feats)} features")
    return {"url": layer_url, "where": where, "features": len(feats)}


def fetch_dem(out, box):
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    url = f"{VT}/facilities/CampusDEM2025/ImageServer/exportImage"
    p = {"bbox": f"{x0},{y0},{x1},{y1}", "bboxSR": 32617, "imageSR": 32617, "size": f"{w},{h}",
         "format": "tiff", "pixelType": "F32", "noData": -9999, "interpolation": "RSP_BilinearInterpolation",
         "f": "image"}
    data = get(url, p, binary=True, timeout=600)
    open(os.path.join(out, "dem_2025_ft.tif"), "wb").write(data)
    log(f"dem_2025_ft.tif: {len(data)} bytes, {w} x {h} px at 1 m")
    return {"url": url, "params": p}


def fetch_naip(out, box):
    import numpy as np
    import rasterio
    from rasterio.io import MemoryFile
    from rasterio.transform import from_origin
    x0, y0, x1, y1 = box
    url = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage"
    W, H = x1 - x0, y1 - y0
    img = np.zeros((3, H, W), np.uint8)
    T = 2000
    for ty in range(y0, y1, T):
        for tx in range(x0, x1, T):
            bx1, by1 = min(tx + T, x1), min(ty + T, y1)
            p = {"bbox": f"{tx},{ty},{bx1},{by1}", "bboxSR": 32617, "imageSR": 32617,
                 "size": f"{bx1 - tx},{by1 - ty}", "format": "tiff", "bandIds": "0,1,2", "f": "image"}
            data = get(url, p, binary=True, timeout=600)
            with MemoryFile(data) as mf, mf.open() as ds:
                a = ds.read()[:3]
            r0 = y1 - by1
            img[:, r0:r0 + a.shape[1], tx - x0:tx - x0 + a.shape[2]] = a
            log(f"  naip tile {tx},{ty} {a.shape}")
    prof = {"driver": "GTiff", "width": W, "height": H, "count": 3, "dtype": "uint8", "crs": "EPSG:32617",
            "transform": from_origin(x0, y1, 1.0, 1.0), "compress": "deflate"}
    with rasterio.open(os.path.join(out, "naip.tif"), "w", **prof) as ds:
        ds.write(img)
    log(f"naip.tif: {W} x {H} px at 1 m")
    return {"url": url, "tile_px": T}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default="osm,vtb,trees,dem,naip")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    srcp = os.path.join(a.out, "sources.json")
    src = json.load(open(srcp)) if os.path.exists(srcp) else {}
    box = utm_box(SITE)
    src["site"] = {"lonlat_bbox": SITE, "utm17n_box": box}
    want = set(a.only.split(","))
    steps = [
        ("osm", lambda: fetch_osm(a.out, SITE)),
        ("vtb", lambda: fetch_arcgis_layer(a.out, "vt_buildings.geojson",
                                           f"{VT}/vtcampusmap/Buildings/FeatureServer/0")),
        ("trees", lambda: fetch_arcgis_layer(a.out, "vt_trees.geojson",
                                             f"{VT}/facilities/Campus_Trees/FeatureServer/0")),
        ("dem", lambda: fetch_dem(a.out, box)),
        ("naip", lambda: fetch_naip(a.out, box)),
    ]
    for key, fn in steps:
        if key not in want:
            continue
        log(f"== {key}")
        try:
            info = fn()
            info["fetched"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            src[key] = info
        except Exception as e:
            log(f"FAILED {key}: {e}")
            src[key] = {"error": str(e)[:300]}
        json.dump(src, open(srcp, "w"), indent=1)


if __name__ == "__main__":
    sys.exit(main())
