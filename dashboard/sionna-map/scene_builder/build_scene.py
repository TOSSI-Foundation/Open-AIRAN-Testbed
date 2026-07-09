#!/usr/bin/env python3

import argparse
import json
import math
import os
import re
import sys

M_PER_DEG_LAT = 111320.0
VALID_ITU = {"concrete", "brick", "plasterboard", "wood", "glass", "ceiling_board",
             "chipboard", "floorboard", "metal", "very_dry_ground", "medium_dry_ground",
             "wet_ground", "marble"}


def m_per_deg_lon(lat_deg):
    return 111320.0 * math.cos(math.radians(lat_deg))


def to_enu(lon, lat, lon0, lat0):
    return (lon - lon0) * m_per_deg_lon(lat0), (lat - lat0) * M_PER_DEG_LAT


def itu_type(name):
    n = (name or "concrete").lower()
    if n.startswith("itu_"):
        n = n[4:]
    return n if n in VALID_ITU else "concrete"


def safe_id(s):
    return re.sub(r"[^A-Za-z0-9_]+", "_", str(s))[:48] or "b"


def load_input(path):
    with open(path) as f:
        obj = json.load(f)
    if "manifest" in obj and "buildings" in obj:
        m, buildings = obj["manifest"], obj["buildings"]
    else:
        m, buildings = obj, None
    if m.get("version") != 1:
        print(f"warning: manifest version {m.get('version')} != 1", file=sys.stderr)
    return m, buildings


def rings_of(geom):
    t, c = geom.get("type"), geom.get("coordinates", [])
    polys = [c] if t == "Polygon" else c if t == "MultiPolygon" else []
    for poly in polys:
        if poly:
            yield poly[0], poly[1:]


def summarize(m, buildings=None):
    lon0, lat0 = m["crs"]["origin_lonlat"]
    if buildings is not None:
        feats = buildings.get("features", [])
        srcs = {}
        for ft in feats:
            s = (ft.get("properties") or {}).get("source", "?")
            srcs[s] = srcs.get(s, 0) + 1
        print(f"Buildings (inline): {len(feats)}  " + ", ".join(f"{k}={v}" for k, v in srcs.items()))
    print(f"City            : {m.get('city')}")
    print(f"CRS origin      : lon {lon0}, lat {lat0}  ({m['crs']['axes']})")
    if m.get("bbox"):
        w, h = m["bbox"].get("size_m", ["?", "?"])
        print(f"Area            : {w} m x {h} m")
    print(f"Building edits   : {len(m.get('building_edits', []))}   Custom models: {len(m.get('custom_models', []))}")
    txs = [n for n in m.get("nodes", []) if n["type"] in ("gnb", "tower")]
    ues = [n for n in m.get("nodes", []) if n["type"] == "ue"]
    print(f"Transmitters     : {len(txs)} (gNB/tower)   Receivers: {len(ues)} (UE)")
    for n in m.get("nodes", []):
        x, y = to_enu(n["lonlat"][0], n["lonlat"][1], lon0, lat0)
        z = n["height_agl_m"]
        chk = "" if abs(x - n["enu_m"][0]) < 0.5 and abs(y - n["enu_m"][1]) < 0.5 else "  <-- ENU mismatch!"
        print(f"  {n['type']:5s} {n['name']:12s} enu=({x:8.2f},{y:8.2f},{z:6.2f}) on={n['on']}{chk}")


def _building_mesh(rings, base, top, lon0, lat0, min_area=8.0):
    import trimesh
    from shapely.geometry import Polygon
    from trimesh.creation import extrude_polygon
    meshes = []
    height = max(top - base, 0.5)
    for ext, holes in rings:
        try:
            ext_e = [to_enu(p[0], p[1], lon0, lat0) for p in ext]
            holes_e = [[to_enu(p[0], p[1], lon0, lat0) for p in ring] for ring in holes]
            poly = Polygon(ext_e, holes_e)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if poly.is_empty:
                continue
            geoms = [poly] if poly.geom_type == "Polygon" else list(getattr(poly, "geoms", []))
            for g in geoms:
                if g.geom_type != "Polygon" or g.area < min_area:
                    continue
                m = extrude_polygon(g, height=height)
                if base:
                    m.apply_translation([0.0, 0.0, base])
                meshes.append(m)
        except Exception:
            continue
    if not meshes:
        return None
    import trimesh as _t
    return _t.util.concatenate(meshes) if len(meshes) > 1 else meshes[0]


def _load_custom_model(entry, lon0, lat0, default_mat, models_dir):
    import math as _m
    import trimesh
    path = entry.get("model", "")
    cand = path if os.path.isabs(path) else os.path.join(models_dir, path)
    if not os.path.exists(cand):
        print(f"note: model not found, skipping: {path}", file=sys.stderr)
        return None
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from meshload import load_mesh
        mesh = load_mesh(cand)
        if str(entry.get("up_axis", "z")).lower() == "y":
            mesh.apply_transform(trimesh.transformations.rotation_matrix(_m.pi / 2, [1, 0, 0]))
        mesh.apply_scale(float(entry.get("scale", 1.0)))
        rot = _m.radians(float(entry.get("rotation_deg", 0.0)))
        mesh.apply_transform(trimesh.transformations.rotation_matrix(rot, [0, 0, 1]))
        anc = entry.get("anchor_lonlat")
        if anc:
            ax, ay = to_enu(anc[0], anc[1], lon0, lat0)
            mesh.apply_translation([ax, ay, float(entry.get("height_offset_m", 0.0))])
        return mesh, itu_type(entry.get("material") or default_mat)
    except Exception as e:
        print(f"note: failed to load model {path}: {str(e)[:80]}", file=sys.stderr)
        return None


def _ground_mesh(xmin, ymin, xmax, ymax):
    import numpy as np
    import trimesh
    v = np.array([[xmin, ymin, 0], [xmax, ymin, 0], [xmax, ymax, 0], [xmin, ymax, 0]], dtype=float)
    f = np.array([[0, 1, 2], [0, 2, 3]])
    return trimesh.Trimesh(vertices=v, faces=f, process=False)


def _write_xml(out_dir, materials, shapes, custom=None):
    custom = custom or {}
    L = ['<scene version="2.1.0">', '', '<!-- Materials -->']
    for mat in sorted(materials):
        if mat in custom:
            continue
        L.append(f'\t<bsdf type="itu-radio-material" id="{mat}">'
                 f'<string name="type" value="{mat}"/>'
                 f'<float name="thickness" value="0.1"/></bsdf>')
    for mid in sorted(custom):
        c = custom[mid]
        if c.get("type") == "radio":
            L.append(f'\t<bsdf type="radio-material" id="{mid}">'
                     f'<float name="relative_permittivity" value="{c["relative_permittivity"]:.6g}"/>'
                     f'<float name="conductivity" value="{c["conductivity"]:.6g}"/>'
                     f'<float name="thickness" value="{c["thickness"]:.6g}"/></bsdf>')
        else:
            L.append(f'\t<bsdf type="itu-radio-material" id="{mid}">'
                     f'<string name="type" value="{c["itu"]}"/>'
                     f'<float name="thickness" value="{c.get("thickness", 0.1):.6g}"/></bsdf>')
    L += ['', '<!-- Shapes -->']
    for sid, rel, mat in shapes:
        L.append(f'\t<shape type="ply" id="{sid}">'
                 f'<string name="filename" value="{rel}"/>'
                 f'<boolean name="face_normals" value="true"/>'
                 f'<ref id="{mat}" name="bsdf"/></shape>')
    L.append('</scene>')
    with open(os.path.join(out_dir, "scene.xml"), "w") as f:
        f.write("\n".join(L) + "\n")


def _footprint_ground_min(rings, grid, lon0, lat0, step_m=10.0):
    import numpy as np
    from shapely.geometry import Point, Polygon
    pts = []
    polys = []
    for ext, holes in rings:
        e = [to_enu(q[0], q[1], lon0, lat0) for q in ext]
        pts += e
        try:
            polys.append(Polygon(e, [[to_enu(q[0], q[1], lon0, lat0) for q in h] for h in holes]))
        except Exception:
            pass
    for poly in polys:
        if poly.is_empty:
            continue
        x0, y0, x1, y1 = poly.bounds
        for x in np.arange(x0, x1 + step_m, step_m):
            for y in np.arange(y0, y1 + step_m, step_m):
                if poly.contains(Point(x, y)):
                    pts.append((x, y))
    if not pts:
        return 0.0
    a = np.asarray(pts, float)
    return float(np.min(grid.height(a[:, 0], a[:, 1])))


def ground_reference(manifest, grid, lon0, lat0):
    import numpy as np
    from shapely.geometry import Point
    for n in manifest.get("nodes", []):
        agl = float(n.get("height_agl_m") or 0.0)
        if n.get("enu_m"):
            x, y = float(n["enu_m"][0]), float(n["enu_m"][1])
            g = float(grid.height(np.array([x]), np.array([y]))[0])
            if n.get("on") == "building":
                under = [g0 for poly, g0 in getattr(grid, "buildings", []) if poly.contains(Point(x, y))]
                if under:
                    g = float(max(under))
            n["ground_m"] = round(g, 2)
            n["enu_m"] = [x, y, round(g + agl, 2)]
        pts = n.get("route_points_enu")
        if isinstance(pts, list) and pts:
            a = np.asarray([[float(q[0]), float(q[1])] for q in pts])
            gz = grid.height(a[:, 0], a[:, 1])
            n["route_points_enu"] = [[float(q[0]), float(q[1]), round(float(g) + agl, 2)] for q, g in zip(a, gz)]
        r = n.get("route_enu")
        if isinstance(r, dict):
            for k in ("start", "end"):
                if r.get(k):
                    q = r[k]
                    g = float(grid.height(np.array([float(q[0])]), np.array([float(q[1])]))[0])
                    r[k] = [float(q[0]), float(q[1]), round(g + agl, 2)]
    return manifest


def _carrier_hz(manifest):
    for n in manifest.get("nodes", []):
        if n.get("type") in ("gnb", "tower") and (n.get("rf") or {}).get("freq_hz"):
            return float(n["rf"]["freq_hz"])
    return 3.5e9


def build(manifest, buildings, out_dir, ground_material="very_dry_ground",
          min_area=8.0, models_dir=None, use_terrain=False, site_dir=None, vegetation=False):
    if not buildings or not buildings.get("features"):
        raise SystemExit(
            "No inline buildings. Export a 'Scene package' from the module (it bundles the "
            "area's buildings), or fetch from Overture with: build_scene.py --fetch-overture."
        )
    import numpy as np
    import trimesh  # noqa: F401  (ensures deps present before we start)

    lon0, lat0 = manifest["crs"]["origin_lonlat"]
    default_mat = manifest.get("buildings", {}).get("default_material")
    fallback = float(manifest.get("buildings", {}).get("height_fallback_m", 9))
    models_dir = models_dir or os.path.dirname(os.path.abspath(__file__))
    os.makedirs(os.path.join(out_dir, "meshes"), exist_ok=True)

    edits = manifest.get("building_edits", [])
    replaced = {e["overture_id"] for e in edits
                if e.get("op") in ("replace_with_model", "replace_with_building")}
    model_entries = [e for e in edits if e.get("op") == "replace_with_model"] + list(manifest.get("custom_models", []))

    detailed = []
    if site_dir and os.path.exists(os.path.join(site_dir, "site.json")):
        with open(os.path.join(site_dir, "site.json")) as fh:
            detailed = json.load(fh).get("detailed", [])
    det_prefixes = tuple(f"vt-{b}-" for d in detailed for b in (d.get("bids") or [d["bid"]]))

    materials, shapes = set(), []
    n_ok = n_skip = 0
    bounds = [1e18, 1e18, -1e18, -1e18]

    tmesh = grid = None
    if use_terrain and manifest.get("bbox"):
        try:
            import terrain
            tmesh = terrain.ground_mesh(manifest["bbox"], lon0, lat0)
            grid = terrain.GroundGrid.from_mesh(tmesh)
            grid.buildings = []
        except Exception as e:
            print(f"note: terrain fetch failed ({str(e)[:80]}); using flat ground.", file=sys.stderr)
            tmesh = grid = None

    for i, ft in enumerate(buildings["features"]):
        geom, props = ft.get("geometry"), (ft.get("properties") or {})
        if not geom or props.get("id") in replaced or (det_prefixes and str(props.get("id", "")).startswith(det_prefixes)):
            n_skip += 1
            continue
        base = float(props.get("min_height") or 0.0)
        top = props.get("height")
        top = float(top) if top is not None else base + fallback
        mat = itu_type(props.get("material") or default_mat)
        rings = list(rings_of(geom))
        if grid is not None:
            g0 = _footprint_ground_min(rings, grid, lon0, lat0)
            base, top = base + g0, top + g0
            for ext, holes in rings:
                try:
                    from shapely.geometry import Polygon
                    grid.buildings.append((Polygon([to_enu(q[0], q[1], lon0, lat0) for q in ext]), g0))
                except Exception:
                    pass
        mesh = _building_mesh(rings, base, top, lon0, lat0, min_area)
        if mesh is None:
            n_skip += 1
            continue
        bid = safe_id(props.get("id", f"b{i}"))
        rel = f"meshes/{bid}-{mat}.ply"
        mesh.export(os.path.join(out_dir, rel))
        shapes.append((f"mesh-{bid}", rel, mat))
        materials.add(mat)
        bmin, bmax = mesh.bounds[0], mesh.bounds[1]
        bounds = [min(bounds[0], bmin[0]), min(bounds[1], bmin[1]),
                  max(bounds[2], bmax[0]), max(bounds[3], bmax[1])]
        n_ok += 1

    n_models = 0
    for k, entry in enumerate(model_entries):
        loaded = _load_custom_model(entry, lon0, lat0, default_mat, models_dir)
        if not loaded:
            continue
        mesh, mat = loaded
        if grid is not None:
            import numpy as np
            hull = mesh.vertices[:, :2]
            mesh.apply_translation([0.0, 0.0, float(np.min(grid.height(hull[:, 0], hull[:, 1])))])
        rel = f"meshes/model_{k}-{mat}.ply"
        mesh.export(os.path.join(out_dir, rel))
        shapes.append((f"mesh-model_{k}", rel, mat))
        materials.add(mat)
        n_models += 1

    n_det = 0
    if detailed:
        import numpy as np
        import trimesh
        b0 = manifest.get("bbox") or {}
        dem_ref = None
        if grid is not None:
            import terrain
            if terrain._dem is not None:
                dem_ref = terrain._dem_at(lon0, lat0)
        for k, d in enumerate(detailed):
            lo, la = d["anchor_lonlat"]
            if b0 and not (b0["min_lon"] <= lo <= b0["max_lon"] and b0["min_lat"] <= la <= b0["max_lat"]):
                continue
            mp = os.path.join(site_dir, d["ply"])
            if not os.path.exists(mp):
                print(f"note: detailed building {d['name']} has no mesh at {mp}", file=sys.stderr)
                continue
            mesh = trimesh.load(mp, process=False)
            ax, ay = to_enu(lo, la, lon0, lat0)
            mesh.apply_translation([ax, ay, 0.0])
            if grid is not None:
                if d.get("base_navd88_m") is not None and dem_ref is not None:
                    mesh.apply_translation([0.0, 0.0, float(d["base_navd88_m"]) - dem_ref])
                else:
                    hull = mesh.vertices[:, :2]
                    mesh.apply_translation([0.0, 0.0, float(np.min(grid.height(hull[:, 0], hull[:, 1])))])
            mat = itu_type(d.get("material") or default_mat)
            rel = f"meshes/detailed_{safe_id(d['bid'])}-{mat}.ply"
            mesh.export(os.path.join(out_dir, rel))
            shapes.append((f"mesh-detailed_{safe_id(d['bid'])}", rel, mat))
            materials.add(mat)
            n_det += 1

    if manifest.get("bbox"):
        b = manifest["bbox"]
        (x0, y0) = to_enu(b["min_lon"], b["min_lat"], lon0, lat0)
        (x1, y1) = to_enu(b["max_lon"], b["max_lat"], lon0, lat0)
        gx0, gy0, gx1, gy1 = min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)
    else:
        gx0, gy0, gx1, gy1 = bounds
    m_ = 20.0
    gmat = itu_type(ground_material)
    gmesh = tmesh
    if gmesh is None:
        gmesh = _ground_mesh(gx0 - m_, gy0 - m_, gx1 + m_, gy1 + m_)
    gmesh.export(os.path.join(out_dir, f"meshes/ground-{gmat}.ply"))
    shapes.append(("mesh-ground", f"meshes/ground-{gmat}.ply", gmat))
    materials.add(gmat)

    custom, veg = {}, None
    if vegetation and site_dir and os.path.exists(os.path.join(site_dir, "trees.json")):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import vegetation as _veg
        trees, _kinds = _veg.load_trees(os.path.join(site_dir, "trees.json"))
        fc = _carrier_hz(manifest)
        groups, custom, veg = _veg.tree_meshes(
            trees, lambda lo, la: to_enu(lo, la, lon0, lat0), (gx0, gy0, gx1, gy1),
            ground=(grid.height if grid is not None else None), f_hz=fc)
        import trimesh
        for mid, (V, F) in groups.items():
            if not len(F):
                continue
            rel = f"meshes/veg-{mid}.ply"
            trimesh.Trimesh(vertices=V, faces=F, process=False).export(os.path.join(out_dir, rel))
            shapes.append((f"mesh-veg-{mid}", rel, mid))
            materials.add(mid)

    _write_xml(out_dir, materials, shapes, custom)
    print(f"\nBuilt scene: {out_dir}/scene.xml")
    print(f"  buildings extruded : {n_ok}   skipped (tiny/replaced/bad): {n_skip}")
    print(f"  custom models      : {n_models}")
    if detailed:
        print(f"  detailed buildings : {n_det} (LoD2 meshes from the site model)")
    if veg is not None:
        print(f"  trees              : {veg['trees']}")
        if veg["trees"]:
            print(f"  foliage            : {veg['gamma_db_per_m']:.3f} dB/m at {veg['carrier_hz'] / 1e9:.4f} GHz "
                  f"(ITU-R P.833-10 Table 1 power law), eps_r {veg['eps_r']}, "
                  f"sigma {veg['conductivity_s_per_m']:.3e} S/m, {veg['crown_groups']} thickness classes, "
                  f"{veg['trunks']} trunks, {veg['triangles']} triangles")
        with open(os.path.join(out_dir, "vegetation.json"), "w") as fh:
            import json as _json
            _json.dump(veg, fh, indent=1)
    print(f"  materials          : {', '.join(sorted(materials))}")
    print(f"  meshes             : {len(shapes)} ply files (incl. ground)")
    if grid is not None:
        print(f"  terrain            : buildings, models and nodes stand on the DEM ground", file=sys.stderr)
    return os.path.join(out_dir, "scene.xml"), grid


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="scene manifest OR scene package JSON")
    ap.add_argument("--out", default="scenes/out")
    ap.add_argument("--build", action="store_true", help="build scene.xml + meshes")
    ap.add_argument("--ground-material", default="very_dry_ground")
    ap.add_argument("--min-area", type=float, default=8.0, help="#6 drop footprints below this area (m^2)")
    ap.add_argument("--models-dir", default=None, help="#9 base dir for custom model paths")
    ap.add_argument("--fetch-overture", action="store_true",
                    help="#7 fetch buildings from Overture for the manifest bbox (needs duckdb)")
    ap.add_argument("--terrain", action="store_true", help="#11 DEM ground from terrarium tiles (needs network)")
    ap.add_argument("--site-dir", default=None,
                    help="site model the scene was drawn on: its dem.npz is the terrain, trees.json the trees")
    ap.add_argument("--vegetation", action="store_true", help="add the site model's trees (needs --site-dir)")
    args = ap.parse_args()

    m, buildings = load_input(args.input)
    if args.fetch_overture and (not buildings or not buildings.get("features")):
        import overture_fetch
        buildings = overture_fetch.fetch(m["bbox"], m["buildings"].get("release"))
    summarize(m, buildings)
    ground_source = "AWS Terrarium DEM (zoom 13)"
    if args.site_dir and args.terrain and os.path.exists(os.path.join(args.site_dir, "dem.npz")):
        import terrain
        desc = terrain.use_dem(os.path.join(args.site_dir, "dem.npz"))
        ground_source = "site model DEM: " + desc
        print(f"Terrain          : {desc}")
    if args.build:
        _xml, grid = build(m, buildings, args.out, args.ground_material, args.min_area, args.models_dir, args.terrain,
                           site_dir=args.site_dir, vegetation=args.vegetation)
        if grid is not None:
            import json
            lon0, lat0 = m["crs"]["origin_lonlat"]
            ground_reference(m, grid, lon0, lat0)
            m["ground"] = {"source": ground_source, "relative_to": "elevation at the scene origin",
                           "relief_m": [round(float(grid.Z.min()), 1), round(float(grid.Z.max()), 1)],
                           "grid_points": int(grid.Z.size), "nodes_and_buildings_on_ground": True}
            with open(args.input) as f:
                pkg = json.load(f)
            if "manifest" in pkg:
                pkg["manifest"] = m
            else:
                pkg = m
            tmp = args.input + ".tmp"
            with open(tmp, "w") as f:
                json.dump(pkg, f)
            os.replace(tmp, args.input)
            print(f"  nodes              : z = ground + height above ground, written to {args.input}")


if __name__ == "__main__":
    main()
