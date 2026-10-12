#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable
site_dir, names = sys.argv[1], sys.argv[2:]
sj = os.path.join(site_dir, "site.json")
site = json.load(open(sj))
detailed = {d["bid"]: d for d in site.get("detailed", [])}
os.makedirs(os.path.join(site_dir, "models"), exist_ok=True)
for name in names:
    work = os.path.join(os.environ.get("LOD2_WORK", os.path.expanduser("~/realsite/lod2/work")),
                        name.lower().replace(" ", "_").replace("/", "_"))
    for step in (["extract_bldg.py", name, work], ["lod2.py", work]):
        r = subprocess.run([PY, os.path.join(HERE, step[0])] + step[1:], capture_output=True, text=True)
        print(r.stdout.strip().splitlines()[-1] if r.stdout.strip() else "", r.stderr[-800:] if r.returncode else "")
        if r.returncode:
            sys.exit(f"{step[0]} failed for {name}")
    fpj = json.load(open(os.path.join(work, "footprint.json")))
    bids = sorted({p["props"]["bid"] for p in fpj["parts"]})
    mat = fpj["parts"][0]["props"].get("material", "itu_concrete")
    info = json.load(open(os.path.join(work, "mesh.json")))
    key = bids[0]
    for ext in ("bin", "ply"):
        shutil.copyfile(os.path.join(work, f"mesh.{ext}"), os.path.join(site_dir, "models", f"{key}.{ext}"))
    shutil.copyfile(os.path.join(work, "preview.png"), os.path.join(site_dir, "models", f"{key}.png"))
    detailed[key] = {"bid": key, "bids": bids, "name": name, "material": mat,
                     "bin": f"models/{key}.bin", "ply": f"models/{key}.ply",
                     "anchor_lonlat": info["anchor_lonlat"], "base_navd88_m": info["base_navd88_m"],
                     "height_m": info["roof_max_m_above_base"], "triangles": info["triangles"],
                     "fit": info["fit"], "source": info["source"]}
    print(f"installed {name} as {key}: {info['triangles']} triangles, fit {info['fit']}")
site["detailed"] = sorted(detailed.values(), key=lambda d: d["name"])
json.dump(site, open(sj, "w"), indent=1, default=str)
print(f"site.json: {len(site['detailed'])} detailed buildings")
