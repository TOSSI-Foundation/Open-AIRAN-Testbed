#!/usr/bin/env python3
import json
import math
import os
import struct
import sys

import numpy as np

WORK = os.path.expanduser("~/realsite/lod2/work/burruss_hall")
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
A = json.load(open(f"{WORK}/axes.json"))
ANG = math.radians(A["angle_deg"])
DZ = A["ground_m"] - json.load(open(f"{WORK}/mesh.json"))["base_navd88_m"]

STONE = (190, 188, 182)
LIME = (214, 206, 186)
SLATE = (62, 66, 74)
FLAT = (150, 152, 156)
GLASS = (118, 138, 150)

T = []


def tri(a, b, c, col, out=None):
    if out is not None:
        n = np.cross(np.subtract(b, a), np.subtract(c, a))
        if float(np.dot(n, out)) < 0:
            b, c = c, b
    T.append((a, b, c, col))


def quad(a, b, c, d, col, out=None):
    tri(a, b, c, col, out); tri(a, c, d, col, out)


def ccw(pts2):
    area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts2, pts2[1:] + pts2[:1]))
    return pts2 if area > 0 else pts2[::-1]


def edge_out(pa, pb):
    du, dv = pb[0] - pa[0], pb[1] - pa[1]
    return (dv, -du, 0.0)


def poly_cap(pts2, z_of, col, up=True):
    import mapbox_earcut as earcut
    arr = np.array(pts2, float)
    idx = earcut.triangulate_float64(arr, np.array([len(arr)], np.uint32)).reshape(-1, 3)
    for i, j, k in idx:
        p = [(arr[m][0], arr[m][1], z_of(*arr[m])) for m in (i, j, k)]
        tri(*p, col, out=(0, 0, 1 if up else -1))


def prism(pts2, h, roof=FLAT, wall=STONE, z0=0.0):
    prism_walls(pts2, h, z0=z0, wall=wall)
    poly_cap(pts2, lambda u, v: h, roof)


def rect(u0, u1, v0, v1):
    return [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]


def gable_along_u(u0, u1, v0, v1, eave, ridge, v_ridge=None, front_gable=True, back_gable=True):
    vr = (v0 + v1) / 2 if v_ridge is None else v_ridge
    prism_walls(rect(u0, u1, v0, v1), eave)
    quad((u0, v0, eave), (u1, v0, eave), (u1, vr, ridge), (u0, vr, ridge), SLATE, out=(0, -(ridge - eave), vr - v0))
    quad((u0, vr, ridge), (u1, vr, ridge), (u1, v1, eave), (u0, v1, eave), SLATE, out=(0, ridge - eave, v1 - vr))
    for uu, on, sg in ((u0, front_gable, -1), (u1, back_gable, 1)):
        if on:
            tri((uu, v0, eave), (uu, v1, eave), (uu, vr, ridge), STONE, out=(sg, 0, 0))


def prism_walls(pts2, h, z0=0.0, wall=STONE):
    pts2 = ccw(list(pts2))
    n = len(pts2)
    for k in range(n):
        (ua, va), (ub, vb) = pts2[k], pts2[(k + 1) % n]
        quad((ua, va, z0), (ub, vb, z0), (ub, vb, h), (ua, va, h), wall, out=edge_out((ua, va), (ub, vb)))


def profile_along_v(profile_uz, v0, v1, roof_cols):
    n = len(profile_uz)
    cu = float(np.mean([p[0] for p in profile_uz])); cz = float(np.mean([p[1] for p in profile_uz]))
    for k in range(n):
        (ua, za), (ub, zb) = profile_uz[k], profile_uz[(k + 1) % n]
        col = roof_cols.get(k, STONE)
        nu, nz = (zb - za), -(ub - ua)
        if nu * ((ua + ub) / 2 - cu) + nz * ((za + zb) / 2 - cz) < 0:
            nu, nz = -nu, -nz
        quad((ua, v0, za), (ub, v0, zb), (ub, v1, zb), (ua, v1, za), col, out=(nu, 0, nz))
    for vv, sg in ((v0, -1), (v1, 1)):
        import mapbox_earcut as earcut
        arr = np.array(profile_uz, float)
        idx = earcut.triangulate_float64(arr, np.array([len(arr)], np.uint32)).reshape(-1, 3)
        for i, j, k in idx:
            tri((arr[i][0], vv, arr[i][1]), (arr[j][0], vv, arr[j][1]), (arr[k][0], vv, arr[k][1]), STONE, out=(0, sg, 0))


def merlons_on(u0, u1, v0, v1, z, h=1.2, w=0.75, gap=0.6, t=0.4, edges="all"):
    sides = {"front": ((u0, v1), (u0, v0)), "right": ((u0, v0), (u1, v0)),
             "back": ((u1, v0), (u1, v1)), "left": ((u1, v1), (u0, v1))}
    for name, (pa, pb) in sides.items():
        if edges != "all" and name not in edges:
            continue
        L = math.hypot(pb[0] - pa[0], pb[1] - pa[1])
        nm = max(1, int((L + gap) // (w + gap)))
        step = L / nm
        du, dv = (pb[0] - pa[0]) / L, (pb[1] - pa[1]) / L
        iu, iv = -dv, du
        for k in range(nm):
            s0 = k * step + (step - w) / 2
            a = (pa[0] + du * s0, pa[1] + dv * s0)
            b = (a[0] + du * w, a[1] + dv * w)
            prism([a, b, (b[0] + iu * t, b[1] + iv * t), (a[0] + iu * t, a[1] + iv * t)], z + h, z0=z)


F_U, R_U = -46.4, 46.5
S_FRONT, N_FRONT = -35.9, 35.3
S_REAR, N_REAR = -31.6, 30.5
S_STEP, N_STEP = -10.3, -5.8

body = [(F_U, S_FRONT), (S_STEP, S_FRONT), (S_STEP, S_REAR), (25.1, S_REAR), (25.1, -33.2), (29.5, -33.2),
        (29.5, S_REAR), (R_U, S_REAR), (R_U, N_REAR), (N_STEP, N_REAR), (N_STEP, N_FRONT), (F_U, N_FRONT)]
def prism_poly(poly, h, roof=FLAT, wall=STONE, z0=0.0):
    from shapely.geometry.polygon import orient
    import mapbox_earcut as earcut
    for pg in getattr(poly, "geoms", [poly]):
        pg = orient(pg, 1.0)
        rings = [list(pg.exterior.coords)[:-1]] + [list(r.coords)[:-1] for r in pg.interiors]
        for ring in rings:
            n = len(ring)
            for k in range(n):
                (ua, va), (ub, vb) = ring[k], ring[(k + 1) % n]
                quad((ua, va, z0), (ub, vb, z0), (ub, vb, h), (ua, va, h), wall, out=edge_out((ua, va), (ub, vb)))
        verts = np.array([q for r in rings for q in r], float)
        ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
        for i, j, k in earcut.triangulate_float64(verts, ends).reshape(-1, 3):
            tri((*verts[i], h), (*verts[j], h), (*verts[k], h), roof, out=(0, 0, 1))


from shapely.geometry import Polygon as _Poly, box as _box
B = _Poly(body)
COURT_N = _box(-36.4, 14.5, 15.4, 20.5)
COURT_S = _box(15.4, -21.6, 26.5, -17.3)
COURT_NS = _box(15.4, 16.0, 25.6, 20.5)
front_part = B.intersection(_box(F_U - 1, -40, -5.8, 40)).difference(COURT_N)
rear_part = B.difference(_box(F_U - 1, -40, -5.8, 40)).difference(COURT_N).difference(COURT_S).difference(COURT_NS)
prism_poly(front_part, 12.3)
prism_poly(rear_part, 11.9)
prism(rect(-36.4, 15.4, 14.5, 20.5), 13.0, roof=GLASS)
prism(rect(15.4, 25.6, 16.0, 20.5), 11.0, roof=GLASS)
prism(rect(15.4, 26.5, -21.6, -17.3), 11.0, roof=GLASS)


def parapet(pts2, z_top, z_base, t=0.5):
    pts2 = ccw(list(pts2))
    n = len(pts2)
    for k in range(n):
        (ua, va), (ub, vb) = pts2[k], pts2[(k + 1) % n]
        L = math.hypot(ub - ua, vb - va)
        if L < 0.3:
            continue
        iu, iv = -(vb - va) / L * t, (ub - ua) / L * t
        prism([(ua, va), (ub, vb), (ub + iu, vb + iv), (ua + iu, va + iv)], z_top, z0=z_base)


parapet(body, 13.2, 11.9)

S_PAV_IN, N_PAV_IN = -29.3, 28.6
prism(rect(-36.4, -33.0, S_PAV_IN, N_PAV_IN), 13.5)
front = [(F_U, 0.0), (-36.4, 0.0), (-36.4, 16.8), (-39.7, 16.8), (-44.5, 12.9), (F_U, 12.9)]
profile_along_v(front, S_PAV_IN, N_PAV_IN, {2: STONE, 3: SLATE, 4: SLATE, 5: FLAT})

def gable_wall(u_a, u_b, v0, v1, eave, apex, v_apex):
    prof = [(v0, 0.0), (v1, 0.0), (v1, eave), (v_apex, apex), (v0, eave)]
    n = len(prof)
    for k in range(n):
        (va, za), (vb, zb) = prof[k], prof[(k + 1) % n]
        nv, nz = (zb - za), -(vb - va)
        cvv = sum(q[0] for q in prof) / n; czz = sum(q[1] for q in prof) / n
        if nv * ((va + vb) / 2 - cvv) + nz * ((za + zb) / 2 - czz) < 0:
            nv, nz = -nv, -nz
        quad((u_a, va, za), (u_b, va, za), (u_b, vb, zb), (u_a, vb, zb), STONE, out=(0, nv, nz))
    import mapbox_earcut as earcut
    arr = np.array(prof, float)
    idx = earcut.triangulate_float64(arr, np.array([len(arr)], np.uint32)).reshape(-1, 3)
    for uu, sg in ((u_a, -1 if u_a < u_b else 1), (u_b, 1 if u_a < u_b else -1)):
        for i, j, k in idx:
            tri((uu, arr[i][0], arr[i][1]), (uu, arr[j][0], arr[j][1]), (uu, arr[k][0], arr[k][1]), STONE, out=(sg, 0, 0))


for (v0_, v1_, vr, ridge) in ((S_FRONT, S_PAV_IN, -32.6, 17.0), (N_PAV_IN, N_FRONT, 32.0, 17.1)):
    gable_along_u(F_U + 0.5, -32.4, v0_, v1_, eave=12.6, ridge=ridge, v_ridge=vr, front_gable=False, back_gable=False)
    gable_wall(F_U, F_U + 0.5, v0_, v1_, 13.2, 18.3, vr)
    gable_wall(-32.4, -31.9, v0_, v1_, 13.2, 18.0, vr)

for v0_, v1_ in ((-11.3, -6.6), (5.9, 11.3)):
    prism(rect(-48.7, -43.8, v0_, v1_), 15.7)
    parapet(rect(-48.7, -43.8, v0_, v1_), 16.3, 15.7)

AU0, AU1, AV0, AV1 = -36.4, 15.6, -15.4, 14.5
prism(rect(AU0, AU1, AV0, AV1), 16.6)
parapet(rect(AU0, AU1, AV0, AV1), 17.3, 16.6)
quad((AU0, -22.9, 12.0), (AU1, -22.9, 12.0), (AU1, AV0, 16.4), (AU0, AV0, 16.4), SLATE, out=(0, -4.4, 7.5))
for uu, sg in ((AU0, -1), (AU1, 1)):
    tri((uu, -22.9, 12.0), (uu, AV0, 12.0), (uu, AV0, 16.4), STONE, out=(sg, 0, 0))
prism(rect(25.6, 27.6, 16.3, 21.0), 14.5)
prism(rect(AU1, 26.6, -17.3, 16.0), 12.8)
prism(rect(26.8, 38.0, -2.9, 5.7), 15.0)
prism(rect(29.5, 35.0, 10.3, 12.3), 13.2)

prism(rect(-32.7, -24.3, 21.0, 26.6), 15.2)
prism(rect(-25.3, -14.6, -30.4, -24.7), 15.2)

prism(rect(R_U, 49.0, 6.5, 25.6), 9.5)

TU0, TU1, TV0, TV1 = -52.5, -41.3, -6.6, 5.9
prism(rect(TU0, TU1, TV0, TV1), 25.0)
TUR_U = ((TU0, -48.3), (-45.0, TU1))
TUR_V = ((TV0, -2.2), (1.4, TV1))
for (a0, a1) in TUR_U:
    for (b0, b1) in TUR_V:
        parapet(rect(a0, a1, b0, b1), 27.9, 25.0, t=0.6)
        merlons_on(a0, a1, b0, b1, 27.9, h=1.2)
merlons_on(TU0, TU1, -2.2, 1.4, 25.0, h=1.2, edges=("front", "back"))
merlons_on(-48.3, -45.0, TV0, TV1, 25.0, h=1.2, edges=("right", "left"))
prism(rect(-53.4, TU0, -4.2, 3.4), 7.5, roof=LIME, wall=LIME)

def to_xy(u, v):
    c, s = math.cos(ANG), math.sin(ANG)
    return u * c - v * s, u * s + v * c


V = np.array([[*to_xy(p[0], p[1]), p[2] + DZ] for t in T for p in t[:3]], np.float64)
F = np.arange(len(V)).reshape(-1, 3)
fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
fn /= np.linalg.norm(fn, axis=1, keepdims=True) + 1e-12
COL = np.array([t[3] for t in T], np.uint8)
FOOT = 2.0
Vp = V.copy()
Vp[np.isclose(Vp[:, 2], DZ, atol=1e-6), 2] = DZ - FOOT
arr = np.zeros(len(V), dtype=[("p", "<f4", 3), ("uv", "<f4", 2), ("n", "i1", 4), ("c", "u1", 4)])
arr["p"] = Vp
arr["n"][:, :3] = np.repeat(np.round(fn * 127).astype(np.int8), 3, axis=0)
arr["c"][:, :3] = np.repeat(COL, 3, axis=0); arr["c"][:, 3] = 255
head = json.dumps({"format": "skm2", "stride": 28, "groups": [{"tex": None, "start": 0, "count": len(V)}]}).encode()
with open(f"{OUT}/burruss.skm", "wb") as fh:
    fh.write(b"SKM2"); fh.write(struct.pack("<I", len(head))); fh.write(head); fh.write(arr.tobytes())
import trimesh
trimesh.Trimesh(vertices=Vp, faces=F, process=True).export(f"{OUT}/burruss.ply")

P = dict(np.load(f"{WORK}/points.npz"))
c, s = math.cos(-ANG), math.sin(-ANG)
cx, cy = A["centre_utm"]
u = (P["x"] - cx) * c - (P["y"] - cy) * s
v = (P["x"] - cx) * s + (P["y"] - cy) * c
zl = P["z"] - A["ground_m"]
roof = (P["cls"] == 1) & (P["rn"] == 1)
Vb = np.array([p for t in T for p in t[:3]])
tm = trimesh.Trimesh(vertices=Vb, faces=F, process=False)
ray = trimesh.ray.ray_triangle.RayMeshIntersector(tm)
pts = np.c_[u[roof], v[roof], np.full(roof.sum(), 60.0)]
loc, idx_ray, _ = ray.intersects_location(pts, np.tile([0, 0, -1.0], (len(pts), 1)), multiple_hits=False)
top = np.full(len(pts), np.nan); top[idx_ray] = loc[:, 2]
hit = np.isfinite(top)
e = top[hit] - zl[roof][hit]
inb = np.abs(e) < 6
stats = {"triangles": int(len(F)), "height_max_m": round(float(V[:, 2].max()), 2),
         "lidar_points_checked": int(inb.sum()),
         "median_abs_m": round(float(np.median(np.abs(e[inb]))), 3),
         "p90_abs_m": round(float(np.percentile(np.abs(e[inb]), 90)), 3),
         "rms_m": round(float(np.sqrt(np.mean(e[inb] ** 2))), 3),
         "points_off_by_over_1m_pct": round(float(100 * (np.abs(e[inb]) > 1.0).mean()), 1)}
json.dump(stats, open(f"{OUT}/burruss.json", "w"), indent=1)
print(json.dumps(stats))
np.savez_compressed(f"{OUT}/check.npz", u=u[roof][hit][inb], v=v[roof][hit][inb], e=e[inb])
