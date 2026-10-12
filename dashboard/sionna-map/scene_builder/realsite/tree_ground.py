#!/usr/bin/env python3
import json
import os
import sys

import numpy as np


def add_ground(site_dir):
    tp, dp = os.path.join(site_dir, "trees.json"), os.path.join(site_dir, "dem.npz")
    t = json.load(open(tp))
    d = np.load(dp)
    lons, lats, Z = np.asarray(d["lons"], float), np.asarray(d["lats"], float), np.asarray(d["z"], float)
    rows = t["trees"]
    lo = np.array([r[0] for r in rows]); la = np.array([r[1] for r in rows])
    fx = np.clip((lo - lons[0]) / (lons[1] - lons[0]), 0, lons.size - 1.000001)
    fy = np.clip((la - lats[0]) / (lats[1] - lats[0]), 0, lats.size - 1.000001)
    i = fx.astype(int); j = fy.astype(int); u = fx - i; v = fy - j
    g = (Z[j, i] * (1 - u) * (1 - v) + Z[j, i + 1] * u * (1 - v) + Z[j + 1, i] * (1 - u) * v + Z[j + 1, i + 1] * u * v)
    inside = (lo >= lons[0]) & (lo <= lons[-1]) & (la >= lats[0]) & (la <= lats[-1])
    fields = t["fields"][:7]
    t["fields"] = fields + ["ground_m"]
    t["trees"] = [list(r[:7]) + [round(float(z), 2) if ok else None] for r, z, ok in zip(rows, g, inside)]
    tmp = tp + ".tmp"
    json.dump(t, open(tmp, "w"), separators=(",", ":"))
    os.replace(tmp, tp)
    return int(inside.sum()), len(rows)


if __name__ == "__main__":
    n, tot = add_ground(sys.argv[1])
    print(f"trees.json: ground_m for {n} of {tot} trees")
