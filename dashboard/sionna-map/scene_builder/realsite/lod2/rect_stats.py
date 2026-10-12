import json, math, sys
import numpy as np
d = sys.argv[1]
rects = json.loads(sys.argv[2])
P = dict(np.load(f"{d}/points.npz")); A = json.load(open(f"{d}/axes.json"))
ang = math.radians(A["angle_deg"]); cx, cy = A["centre_utm"]
c, s = math.cos(-ang), math.sin(-ang)
u = (P["x"] - cx) * c - (P["y"] - cy) * s; v = (P["x"] - cx) * s + (P["y"] - cy) * c
z = P["z"] - A["ground_m"]; roof = (P["cls"] == 1) & (P["rn"] == 1)
for name, (u0, u1, v0, v1) in rects.items():
    m = roof & (u > u0) & (u < u1) & (v > v0) & (v < v1)
    if m.sum() < 3:
        print(f"{name:22s} n={m.sum()}"); continue
    q = np.percentile(z[m], [10, 25, 50, 75, 90])
    print(f"{name:22s} n={m.sum():5d}  p10 {q[0]:6.2f}  p25 {q[1]:6.2f}  median {q[2]:6.2f}  p75 {q[3]:6.2f}  p90 {q[4]:6.2f}")
