#!/usr/bin/env python3
import glob
import json
import os
import shutil
import sys

site_dir, bid, mdir, stem, sources = sys.argv[1:6]
sj = os.path.join(site_dir, "site.json")
site = json.load(open(sj))
ent = next((d for d in site.get("detailed", []) if d["bid"] == bid), None)
if ent is None:
    sys.exit(f"{bid} is not a detailed building of this site yet (run detail_buildings.py first)")
md = os.path.join(site_dir, "models")
shutil.copyfile(os.path.join(mdir, f"{stem}.skm"), os.path.join(md, f"{bid}.skm"))
shutil.copyfile(os.path.join(mdir, f"{stem}.ply"), os.path.join(md, f"{bid}.ply"))
tex = []
for f in sorted(glob.glob(os.path.join(mdir, f"{stem}_*.jpg"))):
    shutil.copyfile(f, os.path.join(md, os.path.basename(f)))
    tex.append(os.path.basename(f))
ent.update({"bin": f"models/{bid}.skm", "ply": f"models/{bid}.ply", "kind": "architectural",
            "textures": tex, "source": sources})
json.dump(site, open(sj, "w"), indent=1, default=str)
print(f"installed {stem} for {bid}: {len(tex)} textures")
