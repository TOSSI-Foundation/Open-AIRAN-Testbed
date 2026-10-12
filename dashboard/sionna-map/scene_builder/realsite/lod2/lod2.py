#!/usr/bin/env python3
import argparse
import json
import math
import os

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("dir")
ap.add_argument("--tol", type=float, default=0.25, help="max vertical roof error, metres")
ap.add_argument("--cell", type=float, default=0.5)
ap.add_argument("--max-verts", type=int, default=6000)
a = ap.parse_args()

from scipy.ndimage import distance_transform_edt, median_filter
from scipy.spatial import Delaunay
from shapely.geometry import shape, Polygon, Point
from shapely import contains_xy
from pyproj import Transformer

P = dict(np.load(os.path.join(a.dir, "points.npz")))
F = json.load(open(os.path.join(a.dir, "footprint.json")))
fp = shape(F["footprint"])
polys = list(fp.geoms) if fp.geom_type == "MultiPolygon" else [fp]

g = P["cls"] == 2
gx, gy, gz = P["x"][g], P["y"][g], P["z"][g]
ring = contains_xy(fp.buffer(3.0), gx, gy) & ~contains_xy(fp.buffer(0.3), gx, gy)
base = float(np.percentile(gz[ring], 2)) if ring.sum() > 20 else float(gz.min())

c = a.cell
x0, y0, x1, y1 = fp.bounds
x0 -= c; y0 -= c; x1 += c; y1 += c
W, H = int(math.ceil((x1 - x0) / c)), int(math.ceil((y1 - y0) / c))
cx = x0 + (np.arange(W) + 0.5) * c
cy = y1 - (np.arange(H) + 0.5) * c
CX, CY = np.meshgrid(cx, cy)
inside = contains_xy(fp, CX.ravel(), CY.ravel()).reshape(H, W)
roof = (P["cls"] == 1) & (P["rn"] == 1)
rx, ry, rz = P["x"][roof], P["y"][roof], P["z"][roof]
ci = ((rx - x0) / c).astype(int); ri = ((y1 - ry) / c).astype(int)
ok = (ci >= 0) & (ci < W) & (ri >= 0) & (ri < H)
dsm = np.full((H, W), -np.inf)
np.maximum.at(dsm, (ri[ok], ci[ok]), rz[ok])
meas = np.isfinite(dsm) & inside
dsm[~np.isfinite(dsm)] = np.nan
med = median_filter(np.nan_to_num(dsm, nan=-1e3), size=5)
spike = meas & (dsm - med > 2.5)
from scipy.ndimage import uniform_filter
nb = uniform_filter(spike.astype(float), size=3) * 9
spike &= nb < 3
dsm[spike] = np.nan
meas &= ~spike
_, (ir, ic) = distance_transform_edt(~meas, return_indices=True)
full = dsm[ir, ic]
sm = median_filter(full, size=3)
surf = np.where(meas, full, sm)
print(f"roof grid {W}x{H} at {c} m: {inside.sum()} cells in the outline, {meas.sum()} measured "
      f"({100 * meas.sum() / max(inside.sum(), 1):.0f}%), {spike.sum()} spikes removed; base {base:.2f} m")


def planarize(Z, mask, dist_tol=0.22, ang_tol_deg=14.0, min_cells=24):
    from collections import deque
    from scipy.ndimage import laplace
    Hh, Ww = Z.shape
    gr, gc = np.gradient(Z)
    nrm = np.dstack([-gc, -gr, np.full_like(Z, c)])
    nrm /= np.linalg.norm(nrm, axis=2, keepdims=True)
    cos_tol = math.cos(math.radians(ang_tol_deg))
    rough = np.abs(laplace(Z))
    label = np.full(Z.shape, -1)
    tried = np.zeros(Z.shape, bool)
    flat = np.flatnonzero(mask.ravel())
    order = flat[np.argsort(rough.ravel()[flat])]
    RR, CC = np.indices(Z.shape)
    planes = []

    def fit(cells_rc):
        rr = np.array([q[0] for q in cells_rc]); cc = np.array([q[1] for q in cells_rc])
        A = np.c_[cc, rr, np.ones(len(rr))]
        sol, *_ = np.linalg.lstsq(A, Z[rr, cc], rcond=None)
        return sol

    for seed in order:
        r0, c0 = divmod(int(seed), Ww)
        if label[r0, c0] >= 0 or tried[r0, c0]:
            continue
        tried[r0, c0] = True
        k = len(planes)
        a_, b_ = gc[r0, c0], gr[r0, c0]
        d_ = Z[r0, c0] - a_ * c0 - b_ * r0
        region = [(r0, c0)]
        label[r0, c0] = k
        q = deque([(r0, c0)])
        since = 0
        while q:
            r, cc_ = q.popleft()
            for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                rn, cn = r + dr, cc_ + dc
                if rn < 0 or rn >= Hh or cn < 0 or cn >= Ww or not mask[rn, cn] or label[rn, cn] >= 0:
                    continue
                if abs(Z[rn, cn] - (a_ * cn + b_ * rn + d_)) > dist_tol:
                    continue
                pn = np.array([-a_, -b_, c]); pn /= np.linalg.norm(pn)
                if float(nrm[rn, cn] @ pn) < cos_tol:
                    continue
                label[rn, cn] = k
                region.append((rn, cn)); q.append((rn, cn))
                since += 1
                if since >= 40:
                    a_, b_, d_ = fit(region); since = 0
        if len(region) < min_cells:
            for (r, cc_) in region:
                label[r, cc_] = -1
            continue
        a_, b_, d_ = fit(region)
        planes.append((a_, b_, d_))
    Zp = Z.copy()
    for k, (a_, b_, d_) in enumerate(planes):
        m_ = label == k
        Zp[m_] = a_ * CC[m_] + b_ * RR[m_] + d_
    cover = float((label >= 0)[mask].mean())
    return Zp, label, len(planes), cover


surf_raw = surf.copy()
surf, plabel, nplanes, pcover = planarize(surf, inside)
print(f"roof planes: {nplanes}, covering {100 * pcover:.0f}% of the roof; "
      f"planarised vs measured: RMS {np.sqrt(np.mean((surf - surf_raw)[meas] ** 2)):.3f} m")


def surf_at(x, y):
    j = np.clip(((np.asarray(x) - x0) / c).astype(int), 0, W - 1)
    i = np.clip(((y1 - np.asarray(y)) / c).astype(int), 0, H - 1)
    return surf[i, j]


def densify(coords, step=1.0):
    out = []
    for (xa, ya), (xb, yb) in zip(coords[:-1], coords[1:]):
        n = max(1, int(math.ceil(math.hypot(xb - xa, yb - ya) / step)))
        for k in range(n):
            out.append((xa + (xb - xa) * k / n, ya + (yb - ya) * k / n))
    return out


rings = []
for p in polys:
    rings.append((densify(list(p.exterior.coords)), False))
    for h in p.interiors:
        rings.append((densify(list(h.coords)), True))
bxy = np.array([q for r, _ in rings for q in r])
bz = []
for (x, y) in bxy:
    pt = Point(x, y)
    nearest = fp.exterior.interpolate(fp.exterior.project(pt)) if fp.geom_type == "Polygon" else pt
    vx, vy = (fp.centroid.x - x), (fp.centroid.y - y)
    L = math.hypot(vx, vy) or 1
    bz.append(float(surf_at(x + 0.6 * vx / L, y + 0.6 * vy / L)))
bz = np.array(bz)
cells = np.c_[CX[inside], CY[inside]]
cz = surf[inside]
cmeas = meas[inside]
V = np.c_[bxy, bz]
used = np.zeros(len(cells), bool)
for it in range(400):
    tri = Delaunay(V[:, :2])
    s = tri.find_simplex(cells)
    okc = s >= 0
    T = tri.transform[s[okc]]
    b2 = np.einsum("nij,nj->ni", T[:, :2, :], cells[okc] - T[:, 2, :])
    bc = np.c_[b2, 1 - b2.sum(1)]
    zt = np.einsum("ni,ni->n", bc, V[tri.simplices[s[okc]]][:, :, 2])
    err = np.full(len(cells), 0.0)
    err[okc] = np.abs(zt - cz[okc])
    err[used] = 0.0
    if err.max() <= a.tol or len(V) >= a.max_verts:
        break
    sidx = np.where(okc, s, -1)
    bad = np.flatnonzero(err > a.tol)
    order = bad[np.argsort(-err[bad])]
    taken, add = set(), []
    for k in order:
        if sidx[k] in taken:
            continue
        taken.add(sidx[k]); add.append(k)
    used[add] = True
    V = np.vstack([V, np.c_[cells[add], cz[add]]])
tri = Delaunay(V[:, :2])
cent = V[tri.simplices][:, :, :2].mean(1)
keep = contains_xy(fp, cent[:, 0], cent[:, 1])
roof_f = tri.simplices[keep]
print(f"roof TIN: {len(V)} vertices, {len(roof_f)} triangles after {it + 1} rounds")

s = tri.find_simplex(cells)
T = tri.transform[s]
b2 = np.einsum("nij,nj->ni", T[:, :2, :], cells - T[:, 2, :])
bc = np.c_[b2, 1 - b2.sum(1)]
zt = np.einsum("ni,ni->n", bc, V[tri.simplices[s]][:, :, 2])
e_cells = (zt - surf_raw[inside])[cmeas]
rin = contains_xy(fp.buffer(-0.6), rx, ry)
sp = tri.find_simplex(np.c_[rx[rin], ry[rin]])
okp = sp >= 0
Tp = tri.transform[sp[okp]]
bp = np.einsum("nij,nj->ni", Tp[:, :2, :], np.c_[rx[rin], ry[rin]][okp] - Tp[:, 2, :])
bcp = np.c_[bp, 1 - bp.sum(1)]
ztp = np.einsum("ni,ni->n", bcp, V[tri.simplices[sp[okp]]][:, :, 2])
e_pts = ztp - rz[rin][okp]
fit = {"cells_rms_m": round(float(np.sqrt(np.mean(e_cells ** 2))), 3),
       "cells_p95_m": round(float(np.percentile(np.abs(e_cells), 95)), 3),
       "points_n": int(e_pts.size), "points_rms_m": round(float(np.sqrt(np.mean(e_pts ** 2))), 3),
       "points_median_abs_m": round(float(np.median(np.abs(e_pts))), 3),
       "points_p95_abs_m": round(float(np.percentile(np.abs(e_pts), 95)), 3)}
print("fit:", fit)

verts = [list(v) for v in V]
faces = [list(f) for f in roof_f]
nb_ = len(bxy)
start = 0
gbot = base - 0.5
for r, hole in rings:
    n = len(r)
    for k in range(n):
        i0, i1 = start + k, start + (k + 1) % n
        a0 = len(verts)
        verts.append([V[i0, 0], V[i0, 1], gbot]); verts.append([V[i1, 0], V[i1, 1], gbot])
        faces.append([i0, i1, a0 + 1]); faces.append([i0, a0 + 1, a0])
    start += n
verts = np.array(verts, float)
faces = np.array(faces, int)

lon_lat = Transformer.from_crs(32617, 4326, always_xy=True).transform(fp.centroid.x, fp.centroid.y)
loc = verts - [fp.centroid.x, fp.centroid.y, base]
import trimesh
m = trimesh.Trimesh(vertices=loc, faces=faces, process=True)
m.fix_normals()
m.export(os.path.join(a.dir, "mesh.ply"))
info = {"anchor_lonlat": [round(lon_lat[0], 7), round(lon_lat[1], 7)],
        "anchor_utm17n": [round(fp.centroid.x, 3), round(fp.centroid.y, 3)],
        "base_navd88_m": round(base, 3), "roof_max_m_above_base": round(float(loc[:, 2].max()), 2),
        "vertices": int(len(m.vertices)), "triangles": int(len(m.faces)), "watertight": bool(m.is_watertight),
        "roof_grid_cell_m": c, "tolerance_m": a.tol, "roof_cells_measured_fraction": round(float(meas.sum() / inside.sum()), 3),
        "fit": fit,
        "source": "USGS 3DEP LiDAR VA_FEMA-NRCS_SouthCentral_2017 (class 1 first returns), outline from the site model"}
json.dump(info, open(os.path.join(a.dir, "mesh.json"), "w"), indent=1)

import rasterio
naip = rasterio.open("/home/master/realsite/vt/raw/naip.tif")
FV = np.asarray(m.vertices)[np.asarray(m.faces)].reshape(-1, 3)
fnorm = np.repeat(np.asarray(m.face_normals), 3, axis=0)
is_wall = np.abs(fnorm[:, 2]) < 0.35
wx, wy = FV[:, 0] + fp.centroid.x, FV[:, 1] + fp.centroid.y
rows, cols = rasterio.transform.rowcol(naip.transform, wx, wy)
rows = np.clip(np.asarray(rows), 0, naip.height - 1); cols = np.clip(np.asarray(cols), 0, naip.width - 1)
rgb_img = naip.read()
rgb = rgb_img[:, rows, cols].T.astype(float)
from scipy.ndimage import median_filter as _mf
sm_img = np.stack([_mf(rgb_img[k], size=5) for k in range(3)])
rgb = sm_img[:, rows, cols].T.astype(float)
col = np.where(is_wall[:, None], [184, 174, 158], rgb)
n = len(FV)
buf = bytearray(4 + n * 20)
import struct
struct.pack_into("<I", buf, 0, n)
arr = np.zeros(n, dtype=[("p", "<f4", 3), ("n", "i1", 4), ("c", "u1", 4)])
arr["p"] = FV
arr["n"][:, :3] = np.round(fnorm * 127).astype(np.int8)
arr["n"][:, 3] = is_wall.astype(np.int8)
arr["c"][:, :3] = np.clip(col, 0, 255).astype(np.uint8)
arr["c"][:, 3] = 255
buf[4:] = arr.tobytes()
open(os.path.join(a.dir, "mesh.bin"), "wb").write(bytes(buf))
print(f"mesh.bin: {n} vertices, {len(buf)} bytes")
print(json.dumps({k: info[k] for k in ("vertices", "triangles", "watertight", "roof_max_m_above_base")}))

def render(Vt, Ft, az_deg, el_deg, size=700):
    az, el = math.radians(az_deg), math.radians(el_deg)
    d = np.array([math.cos(el) * math.sin(az), math.cos(el) * math.cos(az), -math.sin(el)])
    u = np.cross(d, [0, 0, 1.0]); u /= np.linalg.norm(u)
    v = np.cross(u, d)
    P2 = np.c_[Vt @ u, Vt @ v]
    depth = Vt @ d
    lo, hi = P2.min(0), P2.max(0)
    s_ = (size - 20) / (hi - lo).max()
    px = (P2 - lo) * s_ + 10
    img = np.ones((size, size, 3)); zb = np.full((size, size), np.inf)
    fn = np.cross(Vt[Ft[:, 1]] - Vt[Ft[:, 0]], Vt[Ft[:, 2]] - Vt[Ft[:, 0]])
    fn /= np.linalg.norm(fn, axis=1, keepdims=True) + 1e-12
    fn *= np.sign(-(fn @ d))[:, None] + (fn @ d == 0)[:, None]
    L = np.array([-0.45, -0.35, 0.82]); L /= np.linalg.norm(L)
    sh = 0.38 + 0.62 * np.clip(fn @ L, 0, 1)
    wall = np.abs(fn[:, 2]) < 0.35
    base_c = np.where(wall[:, None], [0.74, 0.69, 0.60], [0.50, 0.53, 0.58])
    for t in range(len(Ft)):
        a2, b2, c2 = px[Ft[t]]
        xmin, xmax = int(max(0, min(a2[0], b2[0], c2[0]))), int(min(size - 1, max(a2[0], b2[0], c2[0])) + 1)
        ymin, ymax = int(max(0, min(a2[1], b2[1], c2[1]))), int(min(size - 1, max(a2[1], b2[1], c2[1])) + 1)
        if xmax <= xmin or ymax <= ymin:
            continue
        X, Y = np.meshgrid(np.arange(xmin, xmax) + 0.5, np.arange(ymin, ymax) + 0.5)
        den = (b2[1] - c2[1]) * (a2[0] - c2[0]) + (c2[0] - b2[0]) * (a2[1] - c2[1])
        if abs(den) < 1e-9:
            continue
        w0 = ((b2[1] - c2[1]) * (X - c2[0]) + (c2[0] - b2[0]) * (Y - c2[1])) / den
        w1 = ((c2[1] - a2[1]) * (X - c2[0]) + (a2[0] - c2[0]) * (Y - c2[1])) / den
        w2 = 1 - w0 - w1
        inn = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        if not inn.any():
            continue
        dz = w0 * depth[Ft[t, 0]] + w1 * depth[Ft[t, 1]] + w2 * depth[Ft[t, 2]]
        yy, xx = (Y[inn] - 0.5).astype(int), (X[inn] - 0.5).astype(int)
        closer = dz[inn] < zb[yy, xx]
        yy, xx = yy[closer], xx[closer]
        zb[yy, xx] = dz[inn][closer]
        img[yy, xx] = base_c[t] * sh[t]
    return img[::-1]


import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
fig = plt.figure(figsize=(17, 8))
ax = fig.add_subplot(1, 2, 1)
ax.imshow(render(np.asarray(m.vertices), np.asarray(m.faces), 45, 32))
ax.set_axis_off()
ax.set_title("LoD2 mesh from LiDAR, seen from the south-west")
ax2 = fig.add_subplot(1, 2, 2)
E = np.full((H, W), np.nan)
E[inside] = zt - surf_raw[inside]
E[inside & ~meas] = np.nan
im = ax2.imshow(E, cmap="coolwarm", vmin=-0.5, vmax=0.5, extent=[x0, x1, y0, y1])
ax2.triplot(V[:, 0], V[:, 1], roof_f, lw=0.15, color="k")
plt.colorbar(im, ax=ax2, label="mesh - LiDAR (m)")
ax2.set_title(f"roof fit: RMS {fit['cells_rms_m']} m over measured cells; {len(roof_f)} roof triangles")
plt.tight_layout()
plt.savefig(os.path.join(a.dir, "preview.png"), dpi=85)
print("wrote", a.dir)
