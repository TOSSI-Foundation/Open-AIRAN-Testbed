import math
import os
import sys

import numpy as np

P833_TABLE1 = [(105.9, 0.04), (466.475, 0.12), (949.0, 0.17), (1852.2, 0.30), (2117.5, 0.34)]
EPS_R = 1.1
ETA0 = 376.730313668
THICKNESS_BINS = [0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0]


def gamma_db_per_m(f_hz):
    f = np.log([p[0] for p in P833_TABLE1])
    g = np.log([p[1] for p in P833_TABLE1])
    b, ln_a = np.polyfit(f, g, 1)
    a = math.exp(ln_a)
    return a * (f_hz / 1e6) ** b, a, b


def conductivity_for(gamma_db_m, f_hz, eps_r=EPS_R):
    alpha = gamma_db_m / (20.0 / math.log(10.0))
    w = 2 * math.pi * f_hz
    eps = eps_r * 8.8541878128e-12
    mu = 4e-7 * math.pi
    k = (alpha / (w * math.sqrt(mu * eps / 2.0))) ** 2
    x = math.sqrt((k + 1.0) ** 2 - 1.0)
    return x * w * eps


def load_trees(path):
    import json
    t = json.load(open(path))
    return t["trees"], t.get("kinds", {})


def _bin(t):
    return min(THICKNESS_BINS, key=lambda b: abs(b - t))


def _ellipsoid(seg=6, rings=3):
    v = [(0.0, 0.0, 1.0)]
    for i in range(1, rings + 1):
        ph = i / (rings + 1) * math.pi
        for s in range(seg):
            th = s / seg * 2 * math.pi
            v.append((math.sin(ph) * math.cos(th), math.sin(ph) * math.sin(th), math.cos(ph)))
    v.append((0.0, 0.0, -1.0))
    f = []
    ring = lambda i, s: 1 + (i - 1) * seg + (s % seg)
    bot = len(v) - 1
    for s in range(seg):
        f.append((0, ring(1, s), ring(1, s + 1)))
        f.append((bot, ring(rings, s + 1), ring(rings, s)))
    for i in range(1, rings):
        for s in range(seg):
            a, b, c, d = ring(i, s), ring(i, s + 1), ring(i + 1, s + 1), ring(i + 1, s)
            f += [(a, b, c), (a, c, d)]
    return np.array(v), np.array(f)


def _cone(seg=6):
    v = [(math.cos(s / seg * 2 * math.pi), math.sin(s / seg * 2 * math.pi), 0.0) for s in range(seg)]
    v += [(0.0, 0.0, 1.0), (0.0, 0.0, 0.0)]
    apex, base = seg, seg + 1
    f = []
    for s in range(seg):
        f.append((s, (s + 1) % seg, apex))
        f.append((base, (s + 1) % seg, s))
    return np.array(v), np.array(f)


def _prism(seg=5):
    v = []
    for s in range(seg):
        a = s / seg * 2 * math.pi
        v += [(math.cos(a), math.sin(a), 0.0), (math.cos(a), math.sin(a), 1.0)]
    f = []
    for s in range(seg):
        a0, a1 = 2 * s, 2 * ((s + 1) % seg)
        f += [(a0, a1, a1 + 1), (a0, a1 + 1, a0 + 1)]
    return np.array(v), np.array(f)


def _stack(parts):
    V, F, base = [], [], 0
    for v, f in parts:
        V.append(v); F.append(f + base); base += len(v)
    return (np.concatenate(V), np.concatenate(F)) if V else (np.zeros((0, 3)), np.zeros((0, 3), int))


def tree_meshes(trees, to_enu, extent, ground=None, f_hz=3.5e9, with_trunks=True):
    import trimesh  # noqa: F401  (trimesh is what writes the PLYs; fail early if absent)
    gamma, a, b = gamma_db_per_m(f_hz)
    sigma = conductivity_for(gamma, f_hz)
    x0, y0, x1, y1 = extent
    E_v, E_f = _ellipsoid()
    C_v, C_f = _cone()
    P_v, P_f = _prism()
    rows = []
    for t in trees:
        x, y = to_enu(t[0], t[1])
        if x0 <= x <= x1 and y0 <= y <= y1:
            rows.append((x, y, float(t[2]), float(t[3]), t[4]))
    if not rows:
        return {}, {}, {"trees": 0}
    xs = np.array([r[0] for r in rows]); ys = np.array([r[1] for r in rows])
    gz = ground(xs, ys) if ground is not None else np.zeros(len(rows))
    crowns, trunks = {}, []
    for (x, y, H, R, kind), z0 in zip(rows, gz):
        H = max(1.5, H); R = max(0.4, R)
        conifer = kind in ("C", "L")
        cb = max(0.4, 0.12 * H) if conifer else max(1.2, 0.32 * H)
        if conifer:
            v = C_v * [R, R, H - cb] + [x, y, z0 + cb]
            f = C_f
        else:
            rz = max(0.6, (H - cb) / 2.0)
            v = E_v * [R, R, rz] + [x, y, z0 + cb + rz]
            f = E_f
        key = f"foliage_t{_bin(2.0 * R / 3.0):g}"
        crowns.setdefault(key, []).append((v, f))
        if with_trunks and H >= 3.0:
            tr = max(0.08, min(0.6, 0.03 * H + 0.05))
            top = cb + (0.3 if conifer else 0.25) * (H - cb)
            trunks.append((P_v * [tr, tr, top + 0.5] + [x, y, z0 - 0.5], P_f))
    groups, mats = {}, {}
    for key, parts in crowns.items():
        groups[key] = _stack(parts)
        t = float(key.split("_t")[1])
        mats[key] = {"type": "radio", "relative_permittivity": EPS_R, "conductivity": sigma, "thickness": t}
    if trunks:
        groups["trunks"] = _stack(trunks)
        mats["trunks"] = {"type": "itu", "itu": "wood"}
    stats = {"trees": len(rows), "trunks": len(trunks), "crown_groups": len(crowns),
             "gamma_db_per_m": round(gamma, 4), "fit": {"a": a, "b": b}, "carrier_hz": f_hz,
             "eps_r": EPS_R, "conductivity_s_per_m": sigma,
             "triangles": int(sum(len(g[1]) for g in groups.values()))}
    return groups, mats, stats


if __name__ == "__main__":
    f = float(sys.argv[1]) if len(sys.argv) > 1 else 3.48942e9
    g, a, b = gamma_db_per_m(f)
    s = conductivity_for(g, f)
    print(f"P.833-10 Table 1 fit: gamma = {a:.5f} * f_MHz^{b:.4f}  ->  {g:.3f} dB/m at {f / 1e9:.4f} GHz")
    print(f"foliage: eps_r {EPS_R}, sigma {s:.4e} S/m, loss tangent {s / (2 * math.pi * f * EPS_R * 8.8541878128e-12):.2e}")
