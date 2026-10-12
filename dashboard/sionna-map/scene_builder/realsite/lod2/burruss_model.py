#!/usr/bin/env python3
import json
import math
import os
import shutil
import struct
import sys

import numpy as np

WORK = os.path.expanduser("~/realsite/lod2/work/burruss_hall")
PH = os.path.expanduser("~/realsite/lod2/photos/burruss")
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
ax = json.load(open(f"{WORK}/axes.json"))
ANG = math.radians(ax["angle_deg"])
CX, CY = ax["centre_utm"]
GROUND = ax["ground_m"]
mj = json.load(open(f"{WORK}/mesh.json"))
BASE = mj["base_navd88_m"]
DZ = GROUND - BASE
from shapely.geometry import Polygon, box
FPL = Polygon(ax["footprint_local"])

V, UV, N, FLAG, GROUP = [], [], [], [], []
TEX = ["tower_front", "turret", "wing_bay", "stone", None]


def to_local(u, v, z):
    c, s = math.cos(ANG), math.sin(ANG)
    return (u * c - v * s, u * s + v * c, z + DZ)


def tri(p, uv, n, flag, group):
    for k in range(3):
        V.append(to_local(*p[k])); UV.append(uv[k]); N.append(n); FLAG.append(flag); GROUP.append(group)


def normal_uv(nu, nv, nz):
    c, s = math.cos(ANG), math.sin(ANG)
    return (nu * c - nv * s, nu * s + nv * c, nz)


def quad(a, b, c, d, uva, uvb, uvc, uvd, n, flag, group):
    tri([a, b, c], [uva, uvb, uvc], n, flag, group)
    tri([a, c, d], [uva, uvc, uvd], n, flag, group)


def wall(p0, p1, z0, z1, tex, rep_m=None, v_span=None, flip=False):
    (u0, v0), (u1, v1) = p0, p1
    L = math.hypot(u1 - u0, v1 - v0)
    if L < 0.05:
        return
    nu, nv = (v1 - v0) / L, -(u1 - u0) / L
    if flip:
        nu, nv = -nu, -nv
    n = normal_uv(nu, nv, 0.0)
    zb, zt = v_span or (z0, z1)
    t0, t1 = (z0 - zb) / (zt - zb), (z1 - zb) / (zt - zb)
    s1 = L / rep_m if rep_m else 1.0
    g = TEX.index(tex)
    quad((u0, v0, z0), (u1, v1, z0), (u1, v1, z1), (u0, v0, z1),
         (0, 1 - t0), (s1, 1 - t0), (s1, 1 - t1), (0, 1 - t1), n, 2, g)


def flat_roof(poly, z, flag=0):
    import mapbox_earcut as earcut
    for pg in getattr(poly, "geoms", [poly]):
        ext = np.array(pg.exterior.coords)[:-1]
        rings = [ext] + [np.array(h.coords)[:-1] for h in pg.interiors]
        verts = np.concatenate(rings)
        ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
        idx = earcut.triangulate_float64(verts, ends).reshape(-1, 3)
        for t in idx:
            p = [(verts[k][0], verts[k][1], z) for k in t]
            tri(p, [(0, 0)] * 3, normal_uv(0, 0, 1), flag, len(TEX) - 1)


def outline_walls(poly, z0, z1, tex, rep_m):
    for pg in getattr(poly, "geoms", [poly]):
        ring = pg.exterior
        coords = list(ring.coords)
        ccw = ring.is_ccw
        for a, b in zip(coords[:-1], coords[1:]):
            wall(a, b, z0, z1, tex, rep_m, flip=not ccw)


def merlons(x0, x1, y0, y1, z0, h=1.1, w=0.75, gap=0.65, t=0.35):
    def run(pa, pb, inward):
        L = math.hypot(pb[0] - pa[0], pb[1] - pa[1])
        n = max(1, int((L + gap) // (w + gap)))
        step = L / n
        du, dv = (pb[0] - pa[0]) / L, (pb[1] - pa[1]) / L
        iu, iv = inward
        for k in range(n):
            s0 = k * step + (step - w) / 2
            a = (pa[0] + du * s0, pa[1] + dv * s0)
            b = (a[0] + du * w, a[1] + dv * w)
            ai = (a[0] + iu * t, a[1] + iv * t); bi = (b[0] + iu * t, b[1] + iv * t)
            for p, q in ((a, b), (b, bi), (bi, ai), (ai, a)):
                wall(p, q, z0, z0 + h, "stone", rep_m=2.5, v_span=(z0, z0 + 1.0))
            flat_roof(Polygon([a, b, bi, ai]), z0 + h, flag=0)
    run((x0, y0), (x1, y0), (0, 1)); run((x1, y0), (x1, y1), (-1, 0))
    run((x1, y1), (x0, y1), (0, -1)); run((x0, y1), (x0, y0), (1, 0))


EAVE, RIDGE, AUD, TOWER, TURRET = 12.0, 17.0, 16.5, 25.0, 28.0
tower = box(-51.8, -7.2, -39.0, 5.6)
body = FPL.difference(tower)

outline_walls(body, 0.0, EAVE, "wing_bay", 3.6)
flat_roof(body, EAVE)

fu0, fu1, fr = -47.2, -38.0, -42.6
vs = [q for q in np.array(body.exterior.coords) if abs(q[0] - fu0) < 1.5]
v_lo = max(-35.6, min(q[1] for q in vs)) if vs else -35.4
v_hi = min(35.4, max(q[1] for q in vs)) if vs else 35.2
for (ua, ub) in ((fu0, fr), (fr, fu1)):
    za, zb = (EAVE, RIDGE) if ua == fu0 else (RIDGE, EAVE)
    slope_n = normal_uv(-(zb - za), 0, (ub - ua))
    nn = np.array(slope_n) / np.linalg.norm(slope_n)
    quad((ua, v_lo, za), (ua, v_hi, za), (ub, v_hi, zb), (ub, v_lo, zb),
         (0, 0), (1, 0), (1, 1), (0, 1), tuple(nn), 3, len(TEX) - 1)
for v_end, sgn in ((v_lo, -1), (v_hi, 1)):
    n = normal_uv(0, sgn, 0)
    tri([(fu0, v_end, EAVE), (fu1, v_end, EAVE), (fr, v_end, RIDGE)],
        [(0, 1), (9.2 / 2.5, 1), (4.6 / 2.5, 1 - 5.0 / 2.5)], n, 2, TEX.index("stone"))

au0, au1, av0, av1 = -38.0, 15.0, -14.5, 14.5
for a, b in (((au0, av0), (au1, av0)), ((au1, av0), (au1, av1)), ((au1, av1), (au0, av1)), ((au0, av1), (au0, av0))):
    wall(a, b, EAVE, AUD, "stone", rep_m=2.5, v_span=(EAVE, EAVE + 1.0))
flat_roof(box(au0, av0, au1, av1), AUD)
sv0 = -22.0
nn = np.array(normal_uv(0, -(AUD - EAVE), (av0 - sv0))); nn /= np.linalg.norm(nn)
quad((au0, sv0, EAVE), (au1, sv0, EAVE), (au1, av0, AUD), (au0, av0, AUD),
     (0, 0), (1, 0), (1, 1), (0, 1), tuple(nn), 3, len(TEX) - 1)
for uu, sgn in ((au0, -1), (au1, 1)):
    tri([(uu, sv0, EAVE), (uu, av0, EAVE), (uu, av0, AUD)], [(0, 1), (3, 1), (3, 0)],
        normal_uv(sgn, 0, 0), 2, TEX.index("stone"))

tu0, tu1, tv0, tv1 = -51.8, -39.0, -7.2, 5.6
wall((tu0, tv1), (tu0, tv0), 0.0, TOWER, "tower_front")
wall((tu0, tv0), (tu1, tv0), 0.0, TOWER, "stone", rep_m=2.5, v_span=(0, 1.0))
wall((tu1, tv0), (tu1, tv1), 0.0, TOWER, "stone", rep_m=2.5, v_span=(0, 1.0))
wall((tu1, tv1), (tu0, tv1), 0.0, TOWER, "stone", rep_m=2.5, v_span=(0, 1.0))
flat_roof(box(tu0, tv0, tu1, tv1), TOWER)
merlons(tu0 + 5.5, tu1, tv0 + 3.6, tv1 - 3.6, TOWER, h=0.9)
for (v0_, v1_) in ((tv0, tv0 + 3.6), (tv1 - 3.6, tv1)):
    t0u, t1u = tu0, tu0 + 5.5
    wall((t0u, v1_), (t0u, v0_), TOWER, TURRET, "turret")
    wall((t0u, v0_), (t1u, v0_), TOWER, TURRET, "stone", rep_m=2.5, v_span=(TOWER, TOWER + 1.0))
    wall((t1u, v0_), (t1u, v1_), TOWER, TURRET, "stone", rep_m=2.5, v_span=(TOWER, TOWER + 1.0))
    wall((t1u, v1_), (t0u, v1_), TOWER, TURRET, "stone", rep_m=2.5, v_span=(TOWER, TOWER + 1.0))
    flat_roof(box(t0u, v0_, t1u, v1_), TURRET)
    merlons(t0u, t1u, v0_, v1_, TURRET, h=1.1)

V = np.array(V, np.float64); UVa = np.array(UV, np.float32)
N = np.array(N, np.float64); N /= np.linalg.norm(N, axis=1, keepdims=True)
FLAG = np.array(FLAG, np.int8); GROUP = np.array(GROUP)
order = np.argsort(GROUP, kind="stable")
tg = GROUP[0::3]
torder = np.argsort(tg, kind="stable")
idx = (torder[:, None] * 3 + np.arange(3)).ravel()
V, UVa, N, FLAG, GROUP = V[idx], UVa[idx], N[idx], FLAG[idx], GROUP[idx]
groups = []
for g in range(len(TEX)):
    w = np.flatnonzero(GROUP == g)
    if w.size:
        groups.append({"tex": f"burruss_{TEX[g]}.jpg" if TEX[g] else None, "start": int(w[0]), "count": int(w.size)})
arr = np.zeros(len(V), dtype=[("p", "<f4", 3), ("uv", "<f4", 2), ("n", "i1", 4), ("c", "u1", 4)])
arr["p"] = V; arr["uv"] = UVa
arr["n"][:, :3] = np.round(N * 127).astype(np.int8); arr["n"][:, 3] = FLAG
arr["c"] = np.where((FLAG == 3)[:, None], [62, 66, 74, 255], [142, 144, 148, 255])
head = json.dumps({"format": "skm2", "stride": 28, "groups": groups}).encode()
with open(os.path.join(out, "burruss.skm"), "wb") as fh:
    fh.write(b"SKM2"); fh.write(struct.pack("<I", len(head))); fh.write(head); fh.write(arr.tobytes())
import cv2
POT = {"tower_front": (512, 1024), "turret": (256, 128), "wing_bay": (256, 1024), "stone": (512, 256)}
for t in TEX:
    if t:
        im = cv2.imread(os.path.join(PH, f"{t}.jpg"))
        cv2.imwrite(os.path.join(out, f"burruss_{t}.jpg"), cv2.resize(im, POT[t], interpolation=cv2.INTER_AREA),
                    [cv2.IMWRITE_JPEG_QUALITY, 88])
import trimesh
m = trimesh.Trimesh(vertices=V, faces=np.arange(len(V)).reshape(-1, 3), process=True)
m.export(os.path.join(out, "burruss.ply"))
print(f"burruss: {len(V) // 3} triangles in {len(groups)} groups, height {V[:, 2].max():.2f} m above base; "
      f"ply {len(m.faces)} faces")
print(json.dumps(groups))
