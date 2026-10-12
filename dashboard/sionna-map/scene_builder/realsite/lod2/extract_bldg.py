import json
import os
import sys
from pathlib import Path

import numpy as np

SITE = str(Path(__file__).resolve().parents[4] / "backend" / "work" / "_sites" / "virginia-tech")
RAW = "/home/master/realsite/vt/raw"
name, out = sys.argv[1], sys.argv[2]
BUF = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0
os.makedirs(out, exist_ok=True)

from pyproj import Transformer
from shapely.geometry import shape, mapping
from shapely.ops import transform as stx, unary_union
from shapely import contains_xy
fwd = Transformer.from_crs(4326, 32617, always_xy=True)
U = lambda g: stx(lambda x, y, z=None: fwd.transform(x, y), g)

parts = []
for f in json.load(open(f"{SITE}/buildings.geojson"))["features"]:
    p = f["properties"]
    n = json.loads(p["names"])["primary"] if p.get("names") else ""
    if n == name:
        parts.append((U(shape(f["geometry"])), p))
if not parts:
    sys.exit(f"no building named {name}")
fp = unary_union([g for g, _ in parts])
print(f"{name}: {len(parts)} parts, footprint {fp.area:.0f} m2, bounds {[round(v, 1) for v in fp.bounds]}")
for g, p in parts:
    print(f"   part {p['id']}: {g.area:7.1f} m2  height {p['height']} m  ground {p['ground_m']}  roof {p['roof_abs_m']}")
json.dump({"footprint": mapping(fp), "parts": [{"geom": mapping(g), "props": p} for g, p in parts]},
          open(f"{out}/footprint.json", "w"))

import laspy
zone = fp.buffer(BUF)
x0, y0, x1, y1 = zone.bounds
keep = {k: [] for k in ("x", "y", "z", "cls", "rn", "nr")}
for t in sorted(os.listdir(f"{RAW}/lidar")):
    if not t.endswith(".laz"):
        continue
    las = laspy.read(f"{RAW}/lidar/{t}")
    x, y = np.asarray(las.x), np.asarray(las.y)
    m = (x >= x0) & (x <= x1) & (y >= y0) & (y <= y1)
    if not m.any():
        continue
    idx = np.flatnonzero(m)
    idx = idx[contains_xy(zone, x[idx], y[idx])]
    keep["x"].append(x[idx]); keep["y"].append(y[idx]); keep["z"].append(np.asarray(las.z)[idx])
    keep["cls"].append(np.asarray(las.classification)[idx])
    keep["rn"].append(np.asarray(las.return_number)[idx]); keep["nr"].append(np.asarray(las.number_of_returns)[idx])
P = {k: np.concatenate(v) for k, v in keep.items()}
np.savez_compressed(f"{out}/points.npz", **P)
inside = contains_xy(fp, P["x"], P["y"])
print(f"points within 3 m: {P['x'].size:,}; inside footprint {inside.sum():,} "
      f"({inside.sum() / fp.area:.1f}/m2); classes inside {dict(zip(*np.unique(P['cls'][inside], return_counts=True)))}")
zi = P["z"][inside & (P["cls"] == 1)]
print("roof z percentiles 1/10/50/90/99/max:", np.percentile(zi, [1, 10, 50, 90, 99, 100]).round(2))
g = P["z"][P["cls"] == 2]
print("ground around it z min/median/max:", g.min().round(2), np.median(g).round(2), g.max().round(2))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
res = 0.5
W, H = int((x1 - x0) / res) + 1, int((y1 - y0) / res) + 1
img = np.full((H, W), np.nan)
c = ((P["x"] - x0) / res).astype(int); r = ((y1 - P["y"]) / res).astype(int)
order = np.argsort(P["z"])
img[r[order], c[order]] = P["z"][order]
fig, ax = plt.subplots(1, 2, figsize=(16, 8))
im = ax[0].imshow(img, cmap="terrain", extent=[x0, x1, y0, y1])
for gg, _ in parts:
    gs = getattr(gg, "geoms", [gg])
    for q in gs:
        xs, ys = q.exterior.xy
        ax[0].plot(xs, ys, "r-", lw=0.8)
plt.colorbar(im, ax=ax[0], label="max z (m NAVD88)")
ax[0].set_title(f"{name}: LiDAR max height, 0.5 m")
cx, cy = fp.centroid.x, fp.centroid.y
sel = np.abs(P["y"] - cy) < 1.0
ax[1].scatter(P["x"][sel] - cx, P["z"][sel], s=2, c=np.where(P["cls"][sel] == 2, "sienna", "navy"), label="E-W slice")
sel = np.abs(P["x"] - cx) < 1.0
ax[1].scatter(P["y"][sel] - cy + 0.0, P["z"][sel] + 0.0, s=2, c="orange", label="N-S slice")
ax[1].set_xlabel("offset from centre (m)"); ax[1].set_ylabel("z (m)"); ax[1].legend(); ax[1].set_aspect("equal")
ax[1].set_title("sections through the centre (2 m wide)")
plt.tight_layout()
plt.savefig(f"{out}/heightmap.png", dpi=90)
print("wrote", out)
