import json
import math
import sys

import numpy as np
from shapely.geometry import shape
from shapely import contains_xy
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

d = sys.argv[1]
P = dict(np.load(f"{d}/points.npz"))
F = json.load(open(f"{d}/footprint.json"))
fp = shape(F["footprint"])
mrr = fp.minimum_rotated_rectangle
xy = np.array(mrr.exterior.coords)[:4]
edges = [xy[(i + 1) % 4] - xy[i] for i in range(4)]
long_e = max(edges, key=lambda e: np.hypot(*e))
ang = math.atan2(long_e[1], long_e[0])
print(f"axis angle {math.degrees(ang):.2f} deg (from east, CCW); mrr sides {[round(float(np.hypot(*e)), 1) for e in edges[:2]]}")
c, s = math.cos(-ang), math.sin(-ang)
cx, cy = fp.centroid.x, fp.centroid.y
u = (P["x"] - cx) * c - (P["y"] - cy) * s
v = (P["x"] - cx) * s + (P["y"] - cy) * c
roof = (P["cls"] == 1)
gnd = np.median(P["z"][P["cls"] == 2])
z = P["z"] - gnd
from shapely.affinity import rotate, translate
fpl = rotate(translate(fp, -cx, -cy), -math.degrees(ang), origin=(0, 0))
res = 0.25
u0, v0, u1, v1 = fpl.bounds
W, H = int((u1 - u0) / res) + 3, int((v1 - v0) / res) + 3
img = np.full((H, W), np.nan)
ci = ((u[roof] - u0) / res).astype(int) + 1; ri = ((v1 - v[roof]) / res).astype(int) + 1
ok = (ci >= 0) & (ci < W) & (ri >= 0) & (ri < H)
o = np.argsort(z[roof][ok])
img[ri[ok][o], ci[ok][o]] = z[roof][ok][o]
fig = plt.figure(figsize=(18, 13))
ax = fig.add_axes([0.04, 0.42, 0.9, 0.55])
im = ax.imshow(img, cmap="nipy_spectral", vmin=0, vmax=31, extent=[u0 - res, u1 + 2 * res, v0 - 2 * res, v1 + res])
xs, ys = fpl.exterior.xy
ax.plot(xs, ys, "w-", lw=0.7)
ax.set_xticks(range(int(u0) // 5 * 5, int(u1) + 5, 5)); ax.set_yticks(range(int(v0) // 5 * 5, int(v1) + 5, 5))
ax.grid(alpha=0.25)
plt.colorbar(im, ax=ax, fraction=0.02, label="height above ground (m)")
ax.set_title("roof returns in building axes (u along the long side, v across); m above ground")
stations_u = np.linspace(u0 + 6, u1 - 6, 6)
stations_v = np.linspace(v0 + 6, v1 - 6, 4)
for k, uu in enumerate(stations_u):
    ax.axvline(uu, color="w", lw=0.5, ls="--")
    a2 = fig.add_axes([0.04 + k * 0.155, 0.22, 0.14, 0.16])
    sel = roof & (np.abs(u - uu) < 0.4)
    a2.scatter(v[sel], z[sel], s=1, c="k")
    a2.set_title(f"u = {uu:.0f} m", fontsize=8); a2.set_ylim(-1, 32); a2.grid(alpha=0.3)
for k, vv in enumerate(stations_v):
    ax.axhline(vv, color="w", lw=0.5, ls=":")
    a2 = fig.add_axes([0.04 + k * 0.235, 0.02, 0.22, 0.16])
    sel = roof & (np.abs(v - vv) < 0.4)
    a2.scatter(u[sel], z[sel], s=1, c="k")
    a2.set_title(f"v = {vv:.0f} m", fontsize=8); a2.set_ylim(-1, 32); a2.grid(alpha=0.3)
plt.savefig(f"{d}/sections.png", dpi=80)
json.dump({"angle_deg": math.degrees(ang), "centre_utm": [cx, cy], "ground_m": float(gnd),
           "footprint_local": [list(p) for p in fpl.exterior.coords]}, open(f"{d}/axes.json", "w"))
print("ground", round(float(gnd), 2), "bounds u", round(u0, 1), round(u1, 1), "v", round(v0, 1), round(v1, 1))
