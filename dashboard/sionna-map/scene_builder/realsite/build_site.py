#!/usr/bin/env python3
import argparse
import gzip
import hashlib
import json
import math
import os
import re
import sys
import time

import numpy as np

FT = 0.3048006096
FT_INT = 0.3048
LIDAR_FLOWN_YEAR = 2018

T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:6.1f}s]", *a, flush=True)


def hexcol(rgb):
    r, g, b = [int(max(0, min(255, round(v)))) for v in rgb]
    return f"#{r:02x}{g:02x}{b:02x}"


def jitter(key, amp):
    h = int(hashlib.md5(key.encode()).hexdigest()[:8], 16)
    return ((h % 1000) / 999.0 - 0.5) * 2 * amp


MATERIAL = {
    "stone":        ("itu_marble",       (184, 174, 158)),
    "brick":        ("itu_brick",        (150, 86, 66)),
    "concrete":     ("itu_concrete",     (184, 180, 170)),
    "cement_block": ("itu_concrete",     (176, 172, 162)),
    "glass":        ("itu_glass",        (112, 138, 152)),
    "metal":        ("itu_metal",        (150, 157, 162)),
    "wood":         ("itu_wood",         (196, 178, 150)),
    "vinyl":        ("itu_wood",         (222, 216, 202)),
    "plaster":      ("itu_plasterboard", (226, 220, 206)),
    "stucco":       ("itu_plasterboard", (224, 214, 196)),
}
DEFAULT_MAT = ("itu_concrete", (186, 182, 174))


def material_of(tags, is_vt):
    raw = (tags.get("building:material") or tags.get("building:facade:material") or "").lower()
    for part in re.split(r"[;,]", raw):
        part = part.strip()
        if part in MATERIAL:
            return part, MATERIAL[part], "osm building:material"
    if is_vt:
        return "stone", MATERIAL["stone"], "assumed: Virginia Tech campus building (Hokie Stone)"
    b = tags.get("building", "")
    if b in ("house", "detached", "semidetached_house", "shed", "garage", "garages", "cabin"):
        return "vinyl", MATERIAL["vinyl"], "assumed: house"
    return "concrete", DEFAULT_MAT, "assumed: default"


def polygons_of(g):
    from shapely import make_valid
    if g is None or g.is_empty:
        return []
    if not g.is_valid:
        g = make_valid(g)
    if g.geom_type == "Polygon":
        return [g]
    out = []
    for q in getattr(g, "geoms", []):
        out += polygons_of(q)
    return out


class Grid:

    def __init__(self, box):
        self.x0, self.y0, self.x1, self.y1 = box
        self.W, self.H = self.x1 - self.x0, self.y1 - self.y0
        from rasterio.transform import from_origin
        self.transform = from_origin(self.x0, self.y1, 1.0, 1.0)

    def rc(self, x, y):
        c = np.floor(np.asarray(x) - self.x0).astype(np.int64)
        r = np.floor(self.y1 - np.asarray(y)).astype(np.int64)
        return r, c

    def xy(self, r, c):
        return self.x0 + np.asarray(c) + 0.5, self.y1 - np.asarray(r) - 0.5


def lidar_rasters(paths, G):
    import laspy
    from pyproj import Transformer
    n = G.W * G.H
    dsm1 = np.full(n, -np.inf, np.float32)
    dsmf = np.full(n, -np.inf, np.float32)
    gsum = np.zeros(n, np.float64)
    gcnt = np.zeros(n, np.int32)
    npts = np.zeros(n, np.int32)
    bridge = np.zeros(n, bool)
    tr = Transformer.from_crs(6346, 32617, always_xy=True)
    ident = np.allclose(tr.transform(550000.0, 4120000.0), (550000.0, 4120000.0), atol=1e-3)
    log(f"LiDAR CRS 6346 -> 32617 transform is {'identity (no grid shift available)' if ident else 'a datum shift'}")

    def upd_max(arr, idx, z):
        if idx.size == 0:
            return
        o = np.lexsort((z, idx))
        idx, z = idx[o], z[o]
        last = np.r_[idx[1:] != idx[:-1], True]
        np.maximum.at(arr, idx[last], z[last])

    for p in paths:
        las = laspy.read(p)
        x, y, z = np.asarray(las.x), np.asarray(las.y), np.asarray(las.z, np.float32)
        if not ident:
            x, y = tr.transform(x, y)
        cls = np.asarray(las.classification)
        rn = np.asarray(las.return_number)
        nr = np.asarray(las.number_of_returns)
        wh = (np.asarray(las.withheld).astype(bool) if "withheld" in las.point_format.dimension_names
              else np.zeros(len(z), bool))
        r, c = G.rc(x, y)
        ok = (r >= 0) & (r < G.H) & (c >= 0) & (c < G.W) & (cls != 7) & (cls != 18) & ~wh
        assert ok.dtype == bool
        idx = (r * G.W + c)
        log(f"  {os.path.basename(p)}: {ok.sum():,} of {len(z):,} points inside the site")
        npts += np.bincount(idx[ok], minlength=n).astype(np.int32)
        g = ok & (cls == 2)
        gsum += np.bincount(idx[g], weights=z[g], minlength=n)
        gcnt += np.bincount(idx[g], minlength=n).astype(np.int32)
        bridge[idx[ok & (cls == 17)]] = True
        s = ok & (cls == 1) & (nr == 1)
        upd_max(dsm1, idx[s], z[s])
        f = ok & (rn == 1) & ((cls == 1) | (cls == 2) | (cls == 17))
        upd_max(dsmf, idx[f], z[f])
        del las, x, y, z, cls, rn, nr
    shp = (G.H, G.W)
    gnd = np.where(gcnt > 0, gsum / np.maximum(gcnt, 1), np.nan).astype(np.float32)
    dsm1[~np.isfinite(dsm1)] = np.nan
    dsmf[~np.isfinite(dsmf)] = np.nan
    return {"dsm1": dsm1.reshape(shp), "dsmf": dsmf.reshape(shp), "gnd": gnd.reshape(shp),
            "gcnt": gcnt.reshape(shp), "npts": npts.reshape(shp), "bridge": bridge.reshape(shp)}


def fill_holes(Z, scales=(1, 2, 4, 8, 16, 32, 64, 128)):
    from scipy.ndimage import gaussian_filter
    Z = Z.astype(np.float64).copy()
    for s in scales:
        miss = ~np.isfinite(Z)
        if not miss.any():
            break
        w = (~miss).astype(np.float64)
        num = gaussian_filter(np.where(miss, 0.0, Z), s, mode="nearest")
        den = gaussian_filter(w, s, mode="nearest")
        put = miss & (den > 1e-4)
        Z[put] = num[put] / den[put]
    if (~np.isfinite(Z)).any():
        Z[~np.isfinite(Z)] = np.nanmedian(Z)
    return Z.astype(np.float32)


def osm_polygons(elements, to_utm):
    from shapely.geometry import LineString, Polygon
    from shapely.ops import linemerge, polygonize, unary_union
    out = []

    def ring(geom):
        pts = [to_utm(p["lon"], p["lat"]) for p in geom]
        return pts

    for e in elements:
        t = e.get("tags", {})
        if "building" not in t:
            continue
        try:
            if e["type"] == "way" and e.get("geometry") and len(e["geometry"]) >= 4:
                p = Polygon(ring(e["geometry"]))
                if not p.is_valid:
                    p = p.buffer(0)
                out.append((f"w{e['id']}", t, p))
            elif e["type"] == "relation":
                outers, inners = [], []
                for m in e.get("members", []):
                    if m.get("type") != "way" or not m.get("geometry"):
                        continue
                    (inners if m.get("role") == "inner" else outers).append(LineString(ring(m["geometry"])))
                if not outers:
                    continue
                po = list(polygonize(linemerge(outers)))
                pi = list(polygonize(linemerge(inners))) if inners else []
                if not po:
                    continue
                p = unary_union(po)
                if pi:
                    p = p.difference(unary_union(pi))
                out.append((f"r{e['id']}", t, p if p.is_valid else p.buffer(0)))
        except Exception as ex:
            log(f"  skip {e['type']} {e['id']}: {ex}")
    return out


def parse_len(v):
    if v is None:
        return None
    s = str(v).strip().lower()
    m = re.match(r"^([0-9]+(?:\.[0-9]+)?)\s*(m|ft|')?$", s)
    if not m:
        return None
    x = float(m.group(1))
    return x * FT_INT if m.group(2) in ("ft", "'") else x


OVERRIDES = {
    "Holden Hall": {"levels": 4, "source": "Virginia Tech Facilities: rebuilt north wing is four storeys, 2021"},
}


def floor_height(tags):
    b = tags.get("building", "")
    if b in ("house", "detached", "semidetached_house", "residential", "apartments", "terrace",
             "dormitory", "garage", "garages", "shed", "cabin"):
        return 3.1
    return 4.0


def segment_roofs(lab, nd, B, tol=1.2, min_part_m2=30.0, max_parts=12):
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    H, W = lab.shape
    idx = np.arange(H * W).reshape(H, W)
    rows, cols = [], []
    for a, b, la, lb, ha, hb in (
            (idx[:, :-1], idx[:, 1:], lab[:, :-1], lab[:, 1:], nd[:, :-1], nd[:, 1:]),
            (idx[:-1, :], idx[1:, :], lab[:-1, :], lab[1:, :], nd[:-1, :], nd[1:, :])):
        m = (la > 0) & (la == lb) & (np.abs(ha - hb) <= tol)
        rows.append(a[m]); cols.append(b[m])
    rows, cols = np.concatenate(rows), np.concatenate(cols)
    inb = np.flatnonzero(lab.ravel() > 0)
    remap = -np.ones(H * W, np.int64)
    remap[inb] = np.arange(inb.size)
    A = coo_matrix((np.ones(rows.size, np.int8), (remap[rows], remap[cols])), shape=(inb.size, inb.size))
    ncomp, comp = connected_components(A, directed=False)
    part = np.zeros(H * W, np.int64)
    part[inb] = comp + 1
    part = part.reshape(H, W)
    log(f"  roof graph: {inb.size:,} cells -> {ncomp:,} raw parts")
    return part


def merge_parts(part, lab, nd, cell_area=1.0, min_part_m2=30.0, low_m=2.5, hole_m2=150.0, max_parts=12,
                same_m=1.5):
    from scipy.ndimage import find_objects
    H, W = part.shape
    flat_p = part.ravel()
    flat_nd = nd.ravel()
    flat_lab = lab.ravel()
    n = int(flat_p.max())
    sel = flat_p > 0
    cnt = np.bincount(flat_p[sel], minlength=n + 1)
    bld = np.zeros(n + 1, np.int64)
    bld[flat_p[sel]] = flat_lab[sel]
    order = np.lexsort((flat_nd[sel], flat_p[sel]))
    ps, hs = flat_p[sel][order], flat_nd[sel][order]
    starts = np.r_[0, np.flatnonzero(ps[1:] != ps[:-1]) + 1]
    med = np.zeros(n + 1, np.float64)
    for s, e in zip(starts, np.r_[starts[1:], ps.size]):
        med[ps[s]] = hs[(s + e - 1) // 2]
    pairs = set()
    for a, b in ((part[:, :-1], part[:, 1:]), (part[:-1, :], part[1:, :])):
        m = (a > 0) & (b > 0) & (a != b)
        for u, v in zip(a[m].tolist(), b[m].tolist()):
            if bld[u] == bld[v]:
                pairs.add((u, v) if u < v else (v, u))
    nb = {}
    for u, v in pairs:
        nb.setdefault(u, set()).add(v)
        nb.setdefault(v, set()).add(u)
    parent = np.arange(n + 1)

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    area = cnt.astype(np.float64) * cell_area
    hsum = med * area

    def union(keep, gone):
        keep, gone = find(keep), find(gone)
        if keep == gone:
            return keep
        parent[gone] = keep
        hsum[keep] += hsum[gone]; area[keep] += area[gone]
        nb[keep] = (nb.get(keep, set()) | nb.get(gone, set())) - {keep, gone}
        for o in nb.pop(gone, set()):
            nb.setdefault(o, set()).discard(gone)
            if o != keep:
                nb[o].add(keep)
        return keep

    def h(i):
        return hsum[i] / max(area[i], 1e-9)

    dropped = set()
    changed = True
    while changed:
        changed = False
        roots = [i for i in range(1, n + 1) if find(i) == i and cnt[i] > 0 and i not in dropped]
        roots.sort(key=lambda i: area[i])
        for i in roots:
            if find(i) != i or i in dropped:
                continue
            ns = [find(o) for o in nb.get(i, ()) if find(o) not in dropped and find(o) != i]
            if h(i) < low_m and area[i] >= hole_m2:
                dropped.add(i); changed = True; continue
            if not ns:
                continue
            best = min(ns, key=lambda o: abs(h(o) - h(i)))
            if area[i] < min_part_m2 or abs(h(best) - h(i)) < same_m or h(i) < low_m:
                if area[best] >= area[i]:
                    union(best, i)
                else:
                    union(i, best)
                changed = True
    by_b = {}
    for i in range(1, n + 1):
        if find(i) == i and cnt[i] > 0 and i not in dropped:
            by_b.setdefault(bld[i], []).append(i)
    for b_, ps_ in by_b.items():
        ps_.sort(key=lambda i: area[i])
        while len(ps_) > max_parts:
            i = ps_.pop(0)
            ns = [find(o) for o in nb.get(i, ()) if find(o) in ps_]
            if ns:
                union(min(ns, key=lambda o: abs(h(o) - h(i))), i)
    lut = np.array([find(i) for i in range(n + 1)])
    lut[[i for i in range(n + 1) if find(i) in dropped]] = 0
    lut[0] = 0
    out = lut[part]
    heights = {int(i): float(h(i)) for i in np.unique(out) if i > 0}
    return out, heights, bld


def build_buildings(G, osm, vtb, R, dem, naip, to_utm, to_ll, report, changed):
    from rasterio.features import rasterize, shapes
    from scipy.ndimage import binary_erosion, distance_transform_edt, median_filter
    from shapely.geometry import shape, mapping, box as sbox
    from shapely.strtree import STRtree
    from shapely.ops import unary_union

    site = sbox(G.x0, G.y0, G.x1, G.y1)
    polys = [(oid, t, p) for oid, t, p in osm if not p.is_empty and p.area >= 8.0 and site.contains(p.centroid)]
    seen, uniq = set(), []
    for oid, t, p in polys:
        k = tuple(np.round(p.bounds, 1))
        if k in seen:
            continue
        seen.add(k); uniq.append((oid, t, p))
    polys = uniq
    log(f"buildings: {len(polys)} OSM footprints in the site")

    vt = []
    for f in vtb["features"]:
        try:
            g = shape(f["geometry"])
            from shapely.ops import transform as stx
            vt.append((stx(lambda x, y, z=None: to_utm(x, y), g), f["properties"]))
        except Exception:
            pass
    tree = STRtree([g for g, _ in vt])

    def vt_match(p):
        best, bo = None, 0.0
        for j in tree.query(p):
            g, pr = vt[int(j)]
            try:
                o = p.intersection(g).area
            except Exception:
                continue
            if o > bo:
                best, bo = pr, o
        return best if best is not None and bo >= 0.3 * min(p.area, 1e12) else None

    lab = rasterize([(mapping(p), i + 1) for i, (_, _, p) in enumerate(polys)],
                    out_shape=(G.H, G.W), transform=G.transform, fill=0, dtype="int32")
    nd = R["dsm1"] - dem
    nd[~np.isfinite(nd)] = np.nan
    er = (lab > 0) & (lab == np.roll(lab, 1, 0)) & (lab == np.roll(lab, -1, 0)) \
        & (lab == np.roll(lab, 1, 1)) & (lab == np.roll(lab, -1, 1))
    use = (lab > 0) & np.isfinite(nd)
    use_er = use & er
    nb_ = len(polys) + 1
    cells = np.bincount(lab.ravel(), minlength=nb_)
    roof = np.bincount(lab.ravel()[(use & (nd > 2.0)).ravel()], minlength=nb_)
    cover = roof / np.maximum(cells, 1)
    cnt_er = np.bincount(lab.ravel()[use_er.ravel()], minlength=nb_)
    known_all = use_er | (use & (cnt_er[lab] < 3))

    from scipy.ndimage import find_objects
    sm = np.full(lab.shape, np.nan, np.float32)
    for i, sl in enumerate(find_objects(lab), start=1):
        if sl is None:
            continue
        sl = (slice(max(0, sl[0].start - 1), min(G.H, sl[0].stop + 1)),
              slice(max(0, sl[1].start - 1), min(G.W, sl[1].stop + 1)))
        mine = lab[sl] == i
        kn = known_all[sl] & mine
        if not kn.any():
            continue
        _, (ir, ic) = distance_transform_edt(~kn, return_indices=True)
        win = nd[sl][ir, ic]
        win = median_filter(win, size=3) if min(win.shape) >= 3 else win
        tgt = sm[sl]
        tgt[mine] = win[mine]
        sm[sl] = tgt

    meas = np.bincount(lab.ravel()[use.ravel()], minlength=nb_) / np.maximum(cells, 1)
    regr = np.bincount(lab.ravel()[changed.ravel()], minlength=nb_) / np.maximum(cells, 1)
    info = []
    lidar_ok = np.zeros(len(polys) + 1, bool)
    why = {}
    for i, (oid, t, p) in enumerate(polys, start=1):
        m = vt_match(p)
        yr = int(m["yrbuilt"]) if m and m.get("yrbuilt") else None
        status = (m or {}).get("status")
        new = (yr is not None and yr >= LIDAR_FLOWN_YEAR) or t.get("building") == "construction" \
            or status in ("Under Construction", "Planning/Permitting") or regr[i] >= 0.3
        above = roof[i] / max(meas[i] * cells[i], 1)
        if new:
            ok, r_, cat = False, "built or re-graded after the LiDAR", "no: newer than the LiDAR"
        elif meas[i] < 0.15:
            ok, r_ = False, f"roof measured over only {100 * meas[i]:.0f}% of the outline"
            cat = "no: roof not measured"
        elif above >= 0.5:
            ok = True
            r_ = "roof above ground" + (f" (measured over {100 * meas[i]:.0f}% of it)" if meas[i] < 0.6 else "")
            cat = "yes: roof above ground"
        elif yr is not None:
            ok, r_ = True, f"low roof, standing since {yr} by the register"
            cat = "yes: low roof, dated before the LiDAR"
        else:
            ok, r_, cat = False, "low roof and no construction date", "no: low roof, undated"
        why[cat] = why.get(cat, 0) + 1
        lidar_ok[i] = ok
        info.append({"i": i, "oid": oid, "tags": t, "poly": p, "vt": m, "yr": yr, "new": new,
                     "cover": float(cover[i]), "lidar": ok, "why": r_})
    report["building_lidar_decisions"] = why
    report["buildings_lidar"] = int(lidar_ok.sum())
    report["buildings_tags"] = int(len(polys) - lidar_ok.sum())

    labL = np.where(lidar_ok[lab], lab, 0)
    ndL = np.where(labL > 0, sm, np.nan)
    ndL = np.where(np.isfinite(ndL), ndL, 0.0)
    raw = segment_roofs(labL, ndL, None)
    part, ph, pbld = merge_parts(raw, labL, ndL)
    log(f"  merged to {len(ph):,} roof parts")

    feats = []
    naip_r, naip_g, naip_b = naip
    dem_min_cache = {}

    def ground_min(poly):
        xs, ys = list(poly.exterior.coords.xy[0]), list(poly.exterior.coords.xy[1])
        minx, miny, maxx, maxy = poly.bounds
        from shapely.geometry import Point
        for x in np.arange(minx, maxx + 5, 5.0):
            for y in np.arange(miny, maxy + 5, 5.0):
                if poly.contains(Point(x, y)):
                    xs.append(x); ys.append(y)
        r, c = G.rc(np.array(xs), np.array(ys))
        r, c = np.clip(r, 0, G.H - 1), np.clip(c, 0, G.W - 1)
        return float(np.min(dem[r, c]))

    def roof_colour(sl, mask):
        mk = mask & np.isfinite(nd[sl])
        if mk.sum() < 3:
            mk = mask
        if mk.sum() == 0:
            return None
        return hexcol((np.median(naip_r[sl][mk]), np.median(naip_g[sl][mk]), np.median(naip_b[sl][mk])))

    from rasterio.features import shapes as rshapes
    from rasterio.transform import from_origin
    windows = find_objects(lab)
    roofz = ndL + dem
    n_parts_b = {}
    for b in info:
        i, t, p = b["i"], b["tags"], b["poly"]
        sl = windows[i - 1]
        if sl is None:
            sl = (slice(0, 1), slice(0, 1))
        r0w, c0w = sl[0].start, sl[1].start
        mine_w = lab[sl] == i
        name = (b["vt"] or {}).get("name") or t.get("name")
        if name:
            name = re.sub(r"\s+", " ", str(name)).strip()
        mat, (itu, rgb), mat_src = material_of(t, b["vt"] is not None)
        j = jitter(b["oid"], 10)
        facade = hexcol((rgb[0] + j, rgb[1] + j * 0.9, rgb[2] + j * 0.8))
        base_props = {"bid": b["oid"], "names": json.dumps({"primary": name}) if name else None,
                      "material": itu, "facade_material": mat, "material_source": mat_src,
                      "facade": facade, "vt_number": (b["vt"] or {}).get("bldg_num"),
                      "year_built": b["yr"], "osm_building": t.get("building"),
                      "lidar_decision": b["why"], "in_vt_register": b["vt"] is not None}
        parts_out = []
        if b["lidar"]:
            partw = part[sl]
            ids = [k for k in np.unique(partw[mine_w]) if k > 0]
            geoms = []
            tf = from_origin(G.x0 + c0w, G.y1 - r0w, 1.0, 1.0)
            for k in ids:
                mk = (partw == k) & mine_w
                sub = mk.astype(np.uint8)
                gs = [shape(g) for g, v in rshapes(sub, mask=mk, transform=tf) if v == 1]
                if not gs:
                    continue
                g = unary_union(gs).buffer(0.5, join_style=2).buffer(-0.5, join_style=2)
                roof_abs = float(np.median(roofz[sl][mk]))
                geoms.append((k, g, roof_abs, mk))
            if geoms:
                geoms.sort(key=lambda q: -q[2])
                big = max(geoms, key=lambda q: q[1].area)[0]
                taken = None
                for k, g, roof_abs, mk in geoms:
                    if k == big:
                        continue
                    gp = p.intersection(g.simplify(1.0).buffer(0.6, join_style=2))
                    if taken is not None:
                        gp = gp.difference(taken)
                    gp = gp.simplify(0.6)
                    if gp.is_empty or gp.area < 6.0:
                        continue
                    taken = gp if taken is None else taken.union(gp)
                    parts_out.append((gp, roof_abs, mk, "lidar-2017"))
                k, g, roof_abs, mk = [q for q in geoms if q[0] == big][0]
                gp = p if taken is None else p.difference(taken)
                gp = gp.simplify(0.4)
                if not gp.is_empty and gp.area >= 4.0:
                    parts_out.append((gp, roof_abs, mk, "lidar-2017"))
            if not parts_out:
                vals = roofz[sl][mine_w]
                if vals.size:
                    parts_out.append((p, float(np.median(vals)), mine_w, "lidar-2017"))
        if not parts_out:
            hgt = parse_len(t.get("height"))
            src = "osm height"
            ov = OVERRIDES.get(name or "")
            if ov:
                hgt = ov["levels"] * floor_height(t) + 1.0
                src = f"{ov['levels']} storeys ({ov['source']})"
            if not hgt:
                lv = parse_len(t.get("building:levels"))
                if lv:
                    rl = parse_len(t.get("roof:levels")) or 0.0
                    hgt = (lv + 0.5 * rl) * floor_height(t) + (1.0 if floor_height(t) > 3.5 else 0.0)
                    src = "osm levels"
            if not hgt:
                hgt = {"house": 7.5, "detached": 7.5, "semidetached_house": 7.5, "shed": 3.0,
                       "garage": 3.0, "garages": 3.0, "roof": 4.0, "apartments": 12.0,
                       "dormitory": 16.0, "university": 15.0}.get(t.get("building", ""), 9.0)
                src = "estimated (no LiDAR, no OSM height)"
            parts_out.append((p, None, mine_w, src, hgt))
        n_parts_b[b["oid"]] = len(parts_out)
        for k, q in enumerate(parts_out):
            gp, roof_abs, mk, src = q[0], q[1], q[2], q[3]
            pg = polygons_of(gp)
            if not pg:
                continue
            gm = ground_min(max(pg, key=lambda x: x.area))
            if roof_abs is not None:
                hgt = max(2.0, roof_abs - gm)
            else:
                hgt = q[4]
                roof_abs = gm + hgt
            rc = roof_colour(sl, mk) or facade
            minh = 0.0
            if t.get("building") == "roof":
                minh = max(0.0, hgt - 1.0)
            for gg in polygons_of(gp):
                if gg.area < 4.0:
                    continue
                props = dict(base_props)
                props.update({"id": f"vt-{b['oid']}-{k}", "part": k, "height": round(hgt, 1),
                              "min_height": round(minh, 1), "roof_abs_m": round(roof_abs, 2),
                              "ground_m": round(gm, 2), "height_source": src, "roof": rc,
                              "lidar_cover": round(b["cover"], 2)})
                from shapely.ops import transform as stx
                ll = stx(lambda x, y, z=None: to_ll(x, y), gg)
                feats.append({"type": "Feature", "properties": props, "geometry": mapping(ll)})
    seen = {}
    for f in feats:
        i0 = f["properties"]["id"]
        if i0 in seen:
            seen[i0] += 1
            f["properties"]["id"] = f"{i0}-{seen[i0]}"
        else:
            seen[i0] = 0
    report["building_parts"] = len(feats)
    report["buildings_multi_part"] = sum(1 for v in n_parts_b.values() if v > 1)
    srcs = {}
    for f in feats:
        s = f["properties"]["height_source"]
        srcs[s] = srcs.get(s, 0) + 1
    report["part_height_sources"] = srcs
    report["named_without_lidar"] = sorted({(json.loads(f["properties"]["names"])["primary"],
                                             f["properties"]["height"], f["properties"]["height_source"])
                                            for f in feats if f["properties"]["names"]
                                            and not f["properties"]["height_source"].startswith("lidar")})
    chk = []
    for b in info:
        hh = parse_len(b["tags"].get("height"))
        if hh and b["lidar"]:
            mine = [f["properties"]["height"] for f in feats if f["properties"]["bid"] == b["oid"]]
            if mine:
                chk.append((b["tags"].get("name"), hh, max(mine)))
    report["check_osm_height_vs_lidar"] = chk
    return feats, lab, polys


CONIFER = ("pine", "spruce", "fir", "hemlock", "cedar", "cypress", "juniper", "arborvitae", "yew",
           "larch", "redwood", "sequoia", "metasequoia", "baldcypress", "cryptomeria", "falsecypress")
BROAD_EVERGREEN = ("holly", "southern magnolia", "boxwood", "rhododendron", "laurel", "live oak", "privet",
                   "photinia", "osmanthus", "camellia", "nandina")


def tree_kind(tt, common):
    tt = (tt or "").strip().upper()
    if len(tt) >= 2:
        if tt[0] == "C":
            return "C" if tt[1] == "E" else "L"
        if tt[0] == "B":
            return "E" if tt[1] == "E" else "B"
    c = (common or "").lower()
    if any(k in c for k in ("larch", "baldcypress", "bald cypress", "dawn redwood", "metasequoia")):
        return "L"
    if any(k in c for k in CONIFER):
        return "C"
    if any(k in c for k in BROAD_EVERGREEN):
        return "E"
    return "B"


def build_trees(G, trees_fc, R, dem, lab_bld, polys, to_utm, to_ll, report, vt_dem_valid, dem_change):
    from scipy.ndimage import gaussian_filter, maximum_filter
    from scipy.spatial import cKDTree
    S = report["site"]
    feats = trees_fc["features"]
    rows = []
    for f in feats:
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"][:2]
        rows.append((lon, lat, (p.get("status") or "").strip(), p.get("height"), p.get("crownradius"),
                     p.get("dbh"), p.get("treetype"), p.get("commonname"), p.get("scientificname")))
    lon = np.array([r[0] for r in rows]); lat = np.array([r[1] for r in rows])
    inside = (lon >= S["min_lon"]) & (lon <= S["max_lon"]) & (lat >= S["min_lat"]) & (lat <= S["max_lat"])
    status = np.array([r[2] for r in rows])
    kinds = np.array([tree_kind(r[6], r[7]) for r in rows])
    hft = np.array([float(r[3]) if r[3] else np.nan for r in rows])
    crft = np.array([float(r[4]) if r[4] else np.nan for r in rows])
    dbh = np.array([float(r[5]) if r[5] else np.nan for r in rows])
    hft[hft <= 0] = np.nan; crft[crft <= 0] = np.nan; dbh[dbh <= 0] = np.nan
    fits = {}
    for k in "CLEB*":
        sel = (kinds == k) if k != "*" else np.ones(len(rows), bool)
        for name, y in (("h", hft), ("cr", crft)):
            m = sel & np.isfinite(y) & np.isfinite(dbh)
            if m.sum() >= 30:
                b_, a_ = np.polyfit(np.log(dbh[m]), np.log(y[m]), 1)
                resid = np.log(y[m]) - (a_ + b_ * np.log(dbh[m]))
                fits[(k, name)] = (float(a_), float(b_), float(np.std(resid)), int(m.sum()))
    report["tree_allometry"] = {f"{k}:{n}": v for (k, n), v in fits.items()}

    def predict(k, name, d):
        a_, b_, _, _ = fits.get((k, name)) or fits[("*", name)]
        return float(np.exp(a_ + b_ * np.log(d)))

    med = {name: {k: float(np.nanmedian(y[(kinds == k) & np.isfinite(y)])) if ((kinds == k) & np.isfinite(y)).any()
                  else float(np.nanmedian(y)) for k in "CLEB"} for name, y in (("h", hft), ("cr", crft))}
    alive = inside & (status == "Alive")
    out = []
    n_est_h = n_est_cr = 0
    for i in np.flatnonzero(alive):
        k = kinds[i]
        h = hft[i]
        if not np.isfinite(h):
            h = predict(k, "h", dbh[i]) if np.isfinite(dbh[i]) else med["h"][k]
            n_est_h += 1
        cr = crft[i]
        if not np.isfinite(cr):
            cr = predict(k, "cr", dbh[i]) if np.isfinite(dbh[i]) else med["cr"][k]
            n_est_cr += 1
        h_m = max(1.5, h * FT_INT)
        cr_m = float(np.clip(cr * FT_INT, 0.4, 0.75 * h_m))
        out.append([round(float(lon[i]), 7), round(float(lat[i]), 7), round(h_m, 1), round(cr_m, 1), k, 0,
                    rows[i][7] or ""])
    report["trees_inventory_alive"] = len(out)
    report["trees_inventory_height_estimated"] = n_est_h
    report["trees_inventory_crown_estimated"] = n_est_cr

    chm = R["dsmf"] - dem
    chm = np.where(np.isfinite(chm), chm, 0.0).astype(np.float32)
    from scipy.ndimage import binary_dilation
    blocked = binary_dilation(lab_bld > 0, iterations=2) | binary_dilation(R["bridge"], iterations=3)
    blocked |= dem_change
    chm_s = gaussian_filter(chm, 1.0)
    chm_s[blocked] = 0.0
    peak = (chm_s == maximum_filter(chm_s, size=5)) & (chm_s >= 4.0)
    pr, pc = np.nonzero(peak)
    ph = chm_s[pr, pc]
    o = np.argsort(-ph)
    pr, pc, ph = pr[o], pc[o], ph[o]
    px, py = G.xy(pr, pc)
    ix, iy = to_utm(lon[inside], lat[inside])
    inv_r = np.where(np.isfinite(crft[inside]), crft[inside] * FT_INT, 3.0)
    kd_inv = cKDTree(np.c_[ix, iy]) if inside.any() else None
    kept = []
    bucket = {}
    ang = np.linspace(0, 2 * np.pi, 16, endpoint=False)
    for x, y, r, c, hh in zip(px, py, pr, pc, ph):
        if kd_inv is not None:
            near = kd_inv.query_ball_point([x, y], r=8.0)
            if any(np.hypot(ix[j] - x, iy[j] - y) <= max(3.0, 0.9 * inv_r[j]) for j in near):
                continue
        rmin = max(2.0, 0.18 * hh)
        bx, by = int(x // 4), int(y // 4)
        k_ = int(math.ceil(rmin / 4))
        clash = False
        for dx in range(-k_, k_ + 1):
            for dy in range(-k_, k_ + 1):
                for (qx, qy) in bucket.get((bx + dx, by + dy), ()):
                    if (qx - x) ** 2 + (qy - y) ** 2 < rmin * rmin:
                        clash = True
                        break
                if clash:
                    break
            if clash:
                break
        if clash:
            continue
        rads = []
        for a in ang:
            for s in range(1, 14):
                rr = int(round(r - s * math.sin(a))); cc = int(round(c + s * math.cos(a)))
                if rr < 0 or rr >= G.H or cc < 0 or cc >= G.W or chm_s[rr, cc] < 0.55 * hh or chm_s[rr, cc] > hh + 0.5:
                    rads.append(s - 0.5)
                    break
            else:
                rads.append(13.0)
        cr = float(np.clip(np.median(rads), 1.0, 12.0))
        r0, r1 = max(0, r - int(cr)), min(G.H, r + int(cr) + 1)
        c0, c1 = max(0, c - int(cr)), min(G.W, c + int(cr) + 1)
        tot = R["npts"][r0:r1, c0:c1].sum(); gn = R["gcnt"][r0:r1, c0:c1].sum()
        open_ = gn / max(tot, 1)
        k = "C" if open_ < 0.12 else "B"
        kept.append((x, y, hh, cr, k, open_))
        bucket.setdefault((bx, by), []).append((x, y))
    lx, ly = to_ll(np.array([q[0] for q in kept]), np.array([q[1] for q in kept])) if kept else ([], [])
    for (x, y, hh, cr, k, op), lo, la in zip(kept, lx, ly):
        out.append([round(float(lo), 7), round(float(la), 7), round(float(hh), 1), round(cr, 1), k, 1, ""])
    report["trees_lidar"] = len(kept)

    m = alive & np.isfinite(hft)
    if m.any():
        ax, ay = to_utm(lon[m], lat[m])
        r_, c_ = G.rc(ax, ay)
        okk = (r_ >= 2) & (r_ < G.H - 2) & (c_ >= 2) & (c_ < G.W - 2)
        lid = np.array([chm[rr - 2:rr + 3, cc - 2:cc + 3].max() for rr, cc in zip(r_[okk], c_[okk])])
        inv = hft[m][okk] * FT_INT
        d = lid - inv
        report["check_tree_height_lidar_minus_inventory_m"] = {
            "n": int(d.size), "median": round(float(np.median(d)), 2),
            "p10": round(float(np.percentile(d, 10)), 2), "p90": round(float(np.percentile(d, 90)), 2),
            "note": "LiDAR is winter 2017-18; inventory heights are field estimates from 2017-18 onward"}
    return out


def write_pmtiles(path, feats, zmin=12, zmax=15, layer="building", attribution=""):
    import mapbox_vector_tile
    from pmtiles.tile import Compression, TileType, zxy_to_tileid
    from pmtiles.writer import Writer
    from shapely.geometry import shape, box as sbox
    from shapely.affinity import affine_transform

    def merc(lon, lat):
        x = (lon + 180.0) / 360.0
        s = math.sin(math.radians(lat))
        y = 0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)
        return x, y

    geoms = []
    for f in feats:
        g = shape(f["geometry"])
        from shapely.ops import transform as stx
        gm = stx(lambda x, y, z=None: merc(np.asarray(x), np.asarray(y)), g)
        for q in polygons_of(gm):
            geoms.append((q, f["properties"]))
    minx = min(g.bounds[0] for g, _ in geoms); maxx = max(g.bounds[2] for g, _ in geoms)
    miny = min(g.bounds[1] for g, _ in geoms); maxy = max(g.bounds[3] for g, _ in geoms)
    keep_props = ("id", "bid", "height", "min_height", "names", "material", "facade", "roof",
                  "height_source", "facade_material", "material_source", "year_built", "vt_number", "part")
    tiles = {}
    EXT, BUF = 4096, 64
    from shapely.strtree import STRtree
    idx = STRtree([g for g, _ in geoms])
    for z in range(zmin, zmax + 1):
        n = 2 ** z
        tx0, tx1 = int(minx * n), int(maxx * n)
        ty0, ty1 = int(miny * n), int(maxy * n)
        for tx in range(tx0, tx1 + 1):
            for ty in range(ty0, ty1 + 1):
                b = sbox((tx - BUF / EXT) / n, (ty - BUF / EXT) / n, (tx + 1 + BUF / EXT) / n, (ty + 1 + BUF / EXT) / n)
                hits = idx.query(b)
                if len(hits) == 0:
                    continue
                fs = []
                for j in hits:
                    g, pr = geoms[int(j)]
                    c = g.intersection(b)
                    if c.is_empty or c.area <= 0:
                        continue
                    c = affine_transform(c, [n * EXT, 0, 0, n * EXT, -tx * EXT, -ty * EXT])
                    props = {k: pr[k] for k in keep_props if pr.get(k) is not None}
                    fs.append({"geometry": c.wkt, "properties": props})
                if not fs:
                    continue
                from mapbox_vector_tile.encoder import on_invalid_geometry_make_valid
                data = mapbox_vector_tile.encode([{"name": layer, "features": fs}],
                                                 default_options={"extents": EXT, "y_coord_down": True,
                                                                  "on_invalid_geometry": on_invalid_geometry_make_valid})
                tiles[zxy_to_tileid(z, tx, ty)] = gzip.compress(data)
    lon0 = minx * 360 - 180; lon1 = maxx * 360 - 180

    def ylat(y):
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y))))
    with open(path, "wb") as fh:
        w = Writer(fh)
        for tid in sorted(tiles):
            w.write_tile(tid, tiles[tid])
        w.finalize(
            {"tile_type": TileType.MVT, "tile_compression": Compression.GZIP,
             "min_zoom": zmin, "max_zoom": zmax,
             "min_lon_e7": int(lon0 * 1e7), "max_lon_e7": int(lon1 * 1e7),
             "min_lat_e7": int(ylat(maxy) * 1e7), "max_lat_e7": int(ylat(miny) * 1e7),
             "center_zoom": zmin + 2, "center_lon_e7": int((lon0 + lon1) / 2 * 1e7),
             "center_lat_e7": int((ylat(maxy) + ylat(miny)) / 2 * 1e7)},
            {"vector_layers": [{"id": layer, "fields": {k: "String" for k in keep_props},
                                "minzoom": zmin, "maxzoom": zmax}],
             "attribution": attribution})
    return len(tiles)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--name", default="Virginia Tech")
    a = ap.parse_args()
    import rasterio
    from pyproj import Transformer
    os.makedirs(a.out, exist_ok=True)
    src = json.load(open(os.path.join(a.raw, "sources.json")))
    G = Grid(src["site"]["utm17n_box"])
    S = src["site"]["lonlat_bbox"]
    report = {"name": a.name, "site": S, "grid": {"crs": "EPSG:32617", "box": src["site"]["utm17n_box"], "cell_m": 1},
              "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    fwd = Transformer.from_crs(4326, 32617, always_xy=True)
    inv = Transformer.from_crs(32617, 4326, always_xy=True)
    to_utm = lambda lon, lat: fwd.transform(lon, lat)
    to_ll = lambda x, y: inv.transform(x, y)

    lpaths = sorted(os.path.join(a.raw, "lidar", f) for f in os.listdir(os.path.join(a.raw, "lidar")) if f.endswith(".laz"))
    log(f"LiDAR: {len(lpaths)} tiles")
    R = lidar_rasters(lpaths, G)
    cov = np.isfinite(R["dsmf"]).mean()
    log(f"LiDAR covers {100 * cov:.1f}% of the site grid")
    report["lidar"] = {"tiles": [os.path.basename(p) for p in lpaths], "grid_coverage": round(float(cov), 4),
                       "project": "USGS 3DEP VA_FEMA-NRCS_SouthCentral_2017_D17 (flown Dec 2017 - Feb 2018)"}

    gl = fill_holes(R["gnd"])
    with rasterio.open(os.path.join(a.raw, "dem_2025_ft.tif")) as ds:
        vt = ds.read(1).astype(np.float64)
        assert ds.width == G.W and ds.height == G.H, "DEM grid differs from the site grid"
    vt_ok = vt > -1000
    vt_m = np.where(vt_ok, vt * FT, np.nan)
    both = vt_ok & (R["gcnt"] > 0)
    d = vt_m[both] - R["gnd"][both]
    off = float(np.median(d))
    report["dem_check"] = {"vt2025_minus_lidar_ground_m": {"median": round(off, 3),
                                                            "mad": round(float(np.median(np.abs(d - off))), 3),
                                                            "n": int(both.sum())}}
    log(f"VT 2025 DEM - LiDAR ground: median {off:+.3f} m, MAD {np.median(np.abs(d - off)):.3f} m over {both.sum():,} cells")
    gl_adj = gl + off
    from scipy.ndimage import distance_transform_edt
    dist = distance_transform_edt(vt_ok)
    wv = np.clip(dist / 20.0, 0.0, 1.0)
    dem = np.where(vt_ok, wv * np.nan_to_num(vt_m) + (1 - wv) * gl_adj, gl_adj).astype(np.float32)
    change = vt_ok & (R["gcnt"] > 0) & (np.abs(vt_m - (R["gnd"] + off)) > 1.5)
    report["dem_check"]["cells_regraded_since_lidar"] = int(change.sum())

    with rasterio.open(os.path.join(a.raw, "naip.tif")) as ds:
        naip = ds.read().astype(np.float32)

    osm = json.load(open(os.path.join(a.raw, "osm.json")))["elements"]
    vtb = json.load(open(os.path.join(a.raw, "vt_buildings.geojson")))
    polys = osm_polygons(osm, to_utm)
    feats, lab, bpolys = build_buildings(G, polys, vtb, R, dem, naip, to_utm, to_ll, report, change)
    json.dump({"type": "FeatureCollection", "features": feats}, open(os.path.join(a.out, "buildings.geojson"), "w"))
    log(f"buildings.geojson: {len(feats)} parts")

    trees_fc = json.load(open(os.path.join(a.raw, "vt_trees.geojson")))
    trees = build_trees(G, trees_fc, R, dem, lab, bpolys, to_utm, to_ll, report, vt_ok, change)
    species = sorted({t[6] for t in trees if t[6]})
    sidx = {s: i + 1 for i, s in enumerate(species)}
    json.dump({"fields": ["lon", "lat", "height_m", "crown_radius_m", "kind", "source", "species"],
               "kinds": {"B": "broadleaf deciduous", "E": "broadleaf evergreen", "C": "conifer evergreen",
                         "L": "conifer deciduous"},
               "sources": ["Virginia Tech campus tree inventory (Alive)", "USGS 3DEP LiDAR 2017-18 canopy"],
               "species": [""] + species,
               "trees": [[t[0], t[1], t[2], t[3], t[4], t[5], sidx.get(t[6], 0)] for t in trees]},
              open(os.path.join(a.out, "trees.json"), "w"), separators=(",", ":"))
    log(f"trees.json: {len(trees)} trees")

    step = 1.5e-5
    lons = np.arange(S["min_lon"], S["max_lon"] + step / 2, step)
    lats = np.arange(S["min_lat"], S["max_lat"] + step / 2, step)
    LO, LA = np.meshgrid(lons, lats)
    X, Y = to_utm(LO.ravel(), LA.ravel())
    from scipy.ndimage import map_coordinates
    rr = (G.y1 - np.asarray(Y)) - 0.5
    cc = (np.asarray(X) - G.x0) - 0.5
    Z = map_coordinates(dem, [rr, cc], order=1, mode="nearest").reshape(LO.shape).astype(np.float32)
    np.savez_compressed(os.path.join(a.out, "dem.npz"), lons=lons, lats=lats, z=Z,
                        datum=np.array("NAVD88 (GEOID12B) metres"))
    report["dem"] = {"lon_step": step, "lat_step": step, "shape": list(Z.shape),
                     "min_m": round(float(Z.min()), 2), "max_m": round(float(Z.max()), 2)}
    log(f"dem.npz: {Z.shape}, {Z.min():.1f}..{Z.max():.1f} m")
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from tree_ground import add_ground
    n_g, n_t = add_ground(a.out)
    log(f"trees.json: ground_m for {n_g} of {n_t} trees")

    attrib = ("Buildings: © OpenStreetMap contributors, heights USGS 3DEP LiDAR; names: Virginia Tech; "
              "roof colour: USDA NAIP")
    nt = write_pmtiles(os.path.join(a.out, "buildings.pmtiles"), feats, attribution=attrib)
    log(f"buildings.pmtiles: {nt} tiles")

    report["sources"] = {k: v for k, v in src.items() if k != "site"}
    report["attribution"] = attrib + "; trees: Virginia Tech Facilities campus tree inventory; " \
                                     "ground: Virginia Tech 2025 campus DEM, USGS 3DEP"
    old = os.path.join(a.out, "site.json")
    if os.path.exists(old):
        try:
            prev = json.load(open(old)).get("detailed")
            if prev:
                report["detailed"] = prev
        except ValueError:
            pass
    report["files"] = {f: os.path.getsize(os.path.join(a.out, f)) for f in os.listdir(a.out)
                       if os.path.isfile(os.path.join(a.out, f))}
    json.dump(report, open(os.path.join(a.out, "site.json"), "w"), indent=1, default=str)
    log("done")


if __name__ == "__main__":
    main()
