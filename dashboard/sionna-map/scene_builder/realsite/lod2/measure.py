import json, math, sys
import numpy as np
from shapely.geometry import Polygon
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

d, specf, outp = sys.argv[1:4]
spec = json.load(open(specf))
P = dict(np.load(f"{d}/points.npz"))
A = json.load(open(f"{d}/axes.json"))
ang = math.radians(A["angle_deg"]); cx, cy = A["centre_utm"]; g0 = A["ground_m"]
c, s = math.cos(-ang), math.sin(-ang)
u = (P["x"] - cx) * c - (P["y"] - cy) * s
v = (P["x"] - cx) * s + (P["y"] - cy) * c
z = P["z"] - g0
cls = P["cls"]
fpl = Polygon(A["footprint_local"])
print("outline corners (u, v):", [(round(p[0], 1), round(p[1], 1)) for p in list(fpl.exterior.coords)[:-1]])
secs = spec["sections"]
n = len(secs) + 1
cols = 3
rows = math.ceil(n / cols)
fig = plt.figure(figsize=(8 * cols, 5.2 * rows))
ax = fig.add_subplot(rows, cols, 1)
pl = spec.get("plan", list(fpl.bounds[:1]) + [fpl.bounds[2]] + [fpl.bounds[1], fpl.bounds[3]])
m = (cls == 1) & (u >= pl[0]) & (u <= pl[1]) & (v >= pl[2]) & (v <= pl[3])
o = np.argsort(z[m])
sc = ax.scatter(u[m][o], v[m][o], c=z[m][o], s=2, cmap="nipy_spectral", vmin=0, vmax=30)
xs, ys = fpl.exterior.xy; ax.plot(xs, ys, "k-", lw=0.6)
for sp in secs:
    if sp["axis"] == "u":
        ax.plot([sp["from"], sp["to"]], [sp["at"], sp["at"]], "m-", lw=0.8)
    else:
        ax.plot([sp["at"], sp["at"]], [sp["from"], sp["to"]], "m-", lw=0.8)
ax.set_xlim(pl[0], pl[1]); ax.set_ylim(pl[2], pl[3]); ax.set_aspect("equal")
ax.set_xticks(np.arange(math.floor(pl[0]), pl[1] + 1, 2)); ax.set_yticks(np.arange(math.floor(pl[2]), pl[3] + 1, 2))
ax.tick_params(labelsize=6); ax.grid(alpha=0.3); plt.colorbar(sc, ax=ax, fraction=0.03)
ax.set_title("plan (u, v), colour = height above ground")
for k, sp in enumerate(secs, start=2):
    ax = fig.add_subplot(rows, cols, k)
    h = sp.get("half", 0.3)
    if sp["axis"] == "u":
        mm = (np.abs(v - sp["at"]) < h) & (u >= sp["from"]) & (u <= sp["to"]); x = u[mm]
    else:
        mm = (np.abs(u - sp["at"]) < h) & (v >= sp["from"]) & (v <= sp["to"]); x = v[mm]
    ax.scatter(x, z[mm], s=4, c=np.where(cls[mm] == 2, "sienna", "navy"))
    ax.set_xlim(sp["from"], sp["to"]); ax.set_ylim(-0.5, 31)
    ax.set_xticks(np.arange(math.floor(sp["from"]), sp["to"] + 1, 1)); ax.set_yticks(range(0, 31, 1))
    ax.tick_params(labelsize=6); ax.grid(alpha=0.35)
    ax.set_title(f"along {sp['axis']} at {'v' if sp['axis'] == 'u' else 'u'} = {sp['at']}", fontsize=9)
plt.tight_layout(); plt.savefig(outp, dpi=62)
