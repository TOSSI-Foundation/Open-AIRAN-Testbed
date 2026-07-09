#!/usr/bin/env python3
import argparse
import base64
import io
import json
import math
import sys

import numpy as np

import radiomap
import rf as rfmod

_DEFAULT_SCALE = {
    "path_gain": (-140.0, -60.0),
    "rss": (-120.0, -40.0),
    "sinr": (-10.0, 40.0),
}

METRIC_UNIT = {"path_gain": "dB", "rss": "dBm", "sinr": "dB"}


def _to_display_db(name, values):
    return radiomap.to_dbm(values) if name == "rss" else radiomap.to_db(values)

M_PER_DEG_LAT = 111320.0


def fromENU(x, y, lon0, lat0):
    mlon = 111320.0 * math.cos(math.radians(lat0))
    return [float(lon0 + float(x) / mlon), float(lat0 + float(y) / M_PER_DEG_LAT)]


def _colormap():
    try:
        from matplotlib import colormaps
        return colormaps["viridis"]
    except (ImportError, KeyError):
        from matplotlib import cm
        return cm.get_cmap("viridis")


def _png_uri(img) -> str:
    from PIL import Image
    buf = io.BytesIO()
    Image.fromarray(img, "RGBA").save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _render(db, vmin: float, vmax: float) -> str:
    import matplotlib.colors as mcolors
    covered = np.isfinite(db)
    norm = mcolors.Normalize(vmin=vmin, vmax=vmax, clip=True)
    rgba = _colormap()(norm(np.where(covered, db, vmin)))
    rgba[..., 3] = np.where(covered, 0.75, 0.0)
    return _png_uri((rgba * 255).astype(np.uint8))


def _render_bands(contested, sole) -> str:
    c = np.asarray(contested, dtype=bool)
    so = np.asarray(sole, dtype=bool)
    img = np.zeros(c.shape + (4,), dtype=np.uint8)
    img[so & ~c] = (245, 176, 65, 90)
    img[c] = (255, 255, 255, 235)
    return _png_uri(img)


def load_manifest(path):
    with open(path) as f:
        obj = json.load(f)
    return obj["manifest"] if "manifest" in obj and "buildings" in obj else obj


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("manifest")
    ap.add_argument("--scene", required=True)
    ap.add_argument("--out", default="coverage.json")
    ap.add_argument("--cell-size", type=float, default=5.0)
    ap.add_argument("--samples", type=int, default=1_000_000)
    ap.add_argument("--max-depth", type=int, default=3)
    ap.add_argument("--vmin", type=float, default=None,
                    help="colour scale floor. Defaults per metric, since -140 dB is a "
                         "reasonable path gain and a meaningless SINR.")
    ap.add_argument("--vmax", type=float, default=None)
    ap.add_argument("--metric", choices=("path_gain", "rss", "sinr"), default="path_gain",
                    help="what the PNG shows. All of them are written to the .npz either way.")
    ap.add_argument("--margin-db", type=float, default=radiomap.DEFAULT_MARGIN_DB,
                    help="how close two transmitters must be for the ground between them to "
                         "count as contested. 3 dB is a factor of two in power and the order "
                         "of a typical A3 offset.")
    ap.add_argument("--grid-out", default=None,
                    help="where to write the queryable grid. Defaults to the overlay path "
                         "with .npz in place of .json; --grid-out= disables it.")
    for name, default in (("los", True), ("specular", True), ("diffuse", False),
                          ("refraction", True), ("diffraction", False),
                          ("edge-diffraction", False), ("synthetic-array", True)):
        g = ap.add_mutually_exclusive_group()
        dest = name.replace("-", "_")
        g.add_argument(f"--{name}", dest=dest, action="store_true", default=default)
        g.add_argument(f"--no-{name}", dest=dest, action="store_false")
    ap.add_argument("--array-pattern", default=None)
    ap.add_argument("--array-pol", default=None)
    ap.add_argument("--array-rows", type=int, default=None)
    ap.add_argument("--array-cols", type=int, default=None)
    ap.add_argument("--rx-pattern", default="iso")
    ap.add_argument("--rx-pol", default="V")
    ap.add_argument("--freq-hz", type=float, default=None)
    ap.add_argument("--num-taps", type=int, default=None)
    ap.add_argument("--samples-per-src", type=int, default=1000000)
    ap.add_argument("--max-paths-per-src", type=int, default=1000000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--rr-depth", type=int, default=-1)
    ap.add_argument("--rr-prob", type=float, default=0.95)
    ap.add_argument("--stop-threshold", type=float, default=None)
    ap.add_argument("--rss-threshold-dbm", type=float, default=-90.0,
                    help="RSS at or above which a cell counts as covered (default -90 dBm)")
    ap.add_argument("--sinr-threshold-db", type=float, default=0.0,
                    help="SINR at or above which a cell counts as usable (default 0 dB)")
    args = ap.parse_args()

    m = load_manifest(args.manifest)
    lon0, lat0 = m["crs"]["origin_lonlat"]
    rf = rfmod.tx_rf(m)
    arr = rf.get("array", {})
    txs = [n for n in m["nodes"] if n["type"] in ("gnb", "tower")]
    if not txs:
        sys.exit("need at least one gNB/tower.")

    import numpy as np
    import matplotlib.cm as cm
    import matplotlib.colors as mcolors
    from sionna.rt import PlanarArray, RadioMapSolver, Transmitter, load_scene

    scene = load_scene(args.scene)
    scene.frequency = float(args.freq_hz or rf.get("freq_hz", 3.48942e9))
    rows = int(args.array_rows or arr.get("rows", 1))
    cols = int(args.array_cols or arr.get("cols", 4))
    scene.tx_array = PlanarArray(num_rows=rows, num_cols=cols,
                                 pattern=args.array_pattern or arr.get("pattern", "tr38901"),
                                 polarization=args.array_pol or arr.get("pol", "V"))
    scene.rx_array = PlanarArray(num_rows=1, num_cols=1,
                                 pattern=args.rx_pattern, polarization=args.rx_pol)
    for t in txs:
        scene.add(Transmitter(name=t["name"], position=[float(v) for v in t["enu_m"]],
                              orientation=rfmod.orientation_rad(t.get("rf", rf)),
                              power_dbm=float((t.get("rf") or rf).get("tx_power_dbm", 43))))

    print(f"[coverage] solving radio map (cell {args.cell_size} m, {args.samples} samples/tx) …", file=sys.stderr)
    rm = RadioMapSolver()(scene, cell_size=[args.cell_size, args.cell_size],
                          samples_per_tx=args.samples, max_depth=args.max_depth,
                          los=args.los, specular_reflection=args.specular,
                          diffuse_reflection=args.diffuse, refraction=args.refraction,
                          diffraction=args.diffraction, edge_diffraction=args.edge_diffraction,
                          seed=args.seed, rr_depth=args.rr_depth, rr_prob=args.rr_prob,
                          stop_threshold=args.stop_threshold)

    cc = np.array(rm.cell_centers)

    metrics = {}
    for name in ("path_gain", "rss", "sinr"):
        try:
            v = np.array(getattr(rm, name))
        except (AttributeError, TypeError, ValueError) as exc:
            print(f"[coverage] {name} unavailable: {exc}", file=sys.stderr)
            continue
        metrics[name] = v

    if "path_gain" not in metrics:
        raise SystemExit("[coverage] the solver returned no path gain")

    serving_on = "rss" if "rss" in metrics else "path_gain"
    served_idx, _ = radiomap.best_server(metrics[serving_on])

    chosen = metrics.get(args.metric)
    if chosen is None:
        print(f"[coverage] {args.metric} unavailable, falling back to path_gain", file=sys.stderr)
        chosen = metrics["path_gain"]
    if args.metric == "sinr":
        db = radiomap.to_db(radiomap.at_serving(chosen, served_idx))
    else:
        _, best = radiomap.best_server(chosen)
        db = _to_display_db(args.metric, np.where(np.isnan(best), 0.0, best))
    covered = np.isfinite(db)

    vmin = args.vmin if args.vmin is not None else _DEFAULT_SCALE[args.metric][0]
    vmax = args.vmax if args.vmax is not None else _DEFAULT_SCALE[args.metric][1]

    data_uri = _render(db, vmin, vmax)

    images, scales = {}, {}
    for name, arr in metrics.items():
        lo, hi = _DEFAULT_SCALE[name]
        if name == args.metric:
            lo, hi = vmin, vmax
        a = np.asarray(arr, dtype=float)
        if name == "sinr":
            grid_db = radiomap.to_db(radiomap.at_serving(a, served_idx))
        else:
            _, b = radiomap.best_server(a)
            grid_db = _to_display_db(name, np.where(np.isnan(b), 0.0, b))
        images[name] = _render(grid_db, lo, hi)
        scales[name] = [lo, hi]

    bands = radiomap.contested(metrics["path_gain"], margin_db=args.margin_db)
    edges = radiomap.association_edges(served_idx)
    multi_tx = len(txs) >= 2
    boundary_uri = (_render_bands(bands["contested"], bands["sole"])
                    if multi_tx and (bands["contested"].any() or bands["sole"].any())
                    else None)

    tl = fromENU(cc[0, 0, 0], cc[0, 0, 1], lon0, lat0)
    tr = fromENU(cc[0, -1, 0], cc[0, -1, 1], lon0, lat0)
    br = fromENU(cc[-1, -1, 0], cc[-1, -1, 1], lon0, lat0)
    bl = fromENU(cc[-1, 0, 0], cc[-1, 0, 1], lon0, lat0)

    cover = {}
    if "rss" in metrics:
        cover["rss"] = {
            **radiomap.coverage_fraction(
                radiomap.to_dbm(radiomap.at_serving(np.asarray(metrics["rss"], dtype=float),
                                                    served_idx)),
                args.rss_threshold_dbm),
            "unit": "dBm"}
    if "sinr" in metrics:
        cover["sinr"] = {
            **radiomap.coverage_fraction(
                radiomap.to_db(radiomap.at_serving(np.asarray(metrics["sinr"], dtype=float),
                                                   served_idx)),
                args.sinr_threshold_db),
            "unit": "dB"}

    stats = {"covered_cells": int(covered.sum()), "total_cells": int(covered.size),
             "cells_reached": int(covered.sum()),
             "coverage": cover,
             "gain_db_min": float(db[covered].min()) if covered.any() else None,
             "gain_db_max": float(db[covered].max()) if covered.any() else None}
    stats.update(radiomap.summarise(db))

    grid_path = args.grid_out
    if grid_path is None:
        grid_path = (args.out[:-5] if args.out.endswith(".json") else args.out) + ".npz"
    if grid_path:
        np.savez_compressed(
            grid_path,
            cell_centers=cc,
            tx_association=served_idx,
            contested=bands["contested"],
            sole_server=bands["sole"],
            margin_db=bands["margin_db"],
            tx_names=np.array([t["name"] for t in txs]),
            displayed_db=db,
            displayed_metric=np.array(args.metric),
            axes=np.array("cell_centers[y,x,enu]; per-metric arrays are [tx,y,x] linear"),
            **{k: np.asarray(v) for k, v in metrics.items()})
        print(f"[coverage] wrote {grid_path}  "
              f"{', '.join(sorted(metrics))}, association, {cc.shape[0]}x{cc.shape[1]} cells")

    out = {"type": "coverage_overlay", "image": data_uri, "metric": args.metric,
           "serving_on": serving_on,
           "images": images, "scales": scales,
           "units": {k: METRIC_UNIT.get(k, "dB") for k in images},
           "boundaries": boundary_uri,
           "contested": {
               "cells": bands["cells_contested"],
               "served": bands["cells_served"],
               "sole": int(bands["sole"].sum()),
               "margin_db": bands["threshold_db"],
               "judgeable_fraction": (1.0 - bands["sole"].sum() / bands["cells_served"])
                                     if bands["cells_served"] else None,
           },
           "argmax_edge_cells": int(edges.sum()),
           "coordinates": [tl, tr, br, bl], "vmin": vmin, "vmax": vmax, "stats": stats,
           "grid": grid_path or None,
           "transmitters": [t["name"] for t in txs]}
    with open(args.out, "w") as f:
        json.dump(out, f)
    print(f"[coverage] wrote {args.out}  reached {stats['covered_cells']}/{stats['total_cells']} cells, "
          f"gain {stats['gain_db_min']:.0f}..{stats['gain_db_max']:.0f} dB")
    for name, c in cover.items():
        thr = c["threshold_db"]
        of_served = (c["cells_above"] / c["cells_served"]) if c["cells_served"] else 0.0
        print(f"[coverage] {name:4s} >= {thr:.0f} {c['unit']}: "
              f"{c['cells_above']}/{c['cells_served']} served cells ({of_served:.1%}), "
              f"{c['cells_above'] / c['cells_total']:.1%} of the grid")


if __name__ == "__main__":
    main()
