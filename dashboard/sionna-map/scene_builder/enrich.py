#!/usr/bin/env python3
import argparse
import json
import sys

import numpy as np

import batching
import linkkpi
import run_scene as rs


def enrich_positions(manifest, scene_xml, positions, srate_hz, max_depth, sp=None,
                     rx_height_m=None, tx_select=None, log=print,
                     batch_size=batching.DEFAULT_BATCH):
    from sionna.rt import Receiver

    sp = sp or {}
    scene, ctx = rs.prepare_scene(manifest, scene_xml, srate_hz, log=log,
                                  tx_select=tx_select, sp=sp)

    if rx_height_m is None:
        rx_height_m = float(ctx["rx_placements"][0]["position"][2])
    rx_name = ctx["rx_placements"][0]["name"]
    tx_pos = ctx["tx_placements"][ctx["serving_idx"]]["position"]

    receiver = scene.receivers[rx_name]
    rx_home = [float(v) for v in np.asarray(receiver.position).ravel()[:3]]

    seen, order = {}, []
    for p in positions:
        key = (round(float(p[0]), 2), round(float(p[1]), 2))
        if key not in seen:
            seen[key] = None
            order.append(key)

    log(f"\nEnriching     : {len(order)} distinct positions from {len(positions)} updates "
        f"(rx height {rx_height_m} m)")

    shape = batching.plan(len(order), batch_size)
    if shape["batched"]:
        log(f"              batched {shape['batch_size']} at a time, "
            f"{shape['batches']} solves")

    if shape["batched"]:
        scene.remove(rx_name)

    out = {}
    i = -1
    for keys in batching.chunks(order, batch_size):
        if shape["batched"]:
            names = batching.batch_names(len(keys))
            for name, key in zip(names, keys):
                scene.add(Receiver(name=name,
                                   position=[float(key[0]), float(key[1]), rx_height_m]))
        else:
            names = [rx_name]
            receiver.position = [float(keys[0][0]), float(keys[0][1]), rx_height_m]

        paths = rs.solve_paths(scene, max_depth,
                               batching.budget_for(sp, len(keys), batched=shape["batched"]))

        a_all, tau_all = paths.cir(out_type="numpy", normalize_delays=False)
        a_all, tau_all = np.asarray(a_all), np.asarray(tau_all)
        inter_all = np.asarray(paths.interactions)

        for slot, key in enumerate(keys):
            i += 1
            a = batching.slice_rx(a_all, slot, "a")
            tau = batching.slice_rx(tau_all, slot, "tau")
            interactions = batching.slice_rx(inter_all, slot, "interactions")

            other = tuple(ax for ax in range(a.ndim) if ax not in (0, 2))
            power = np.sum(np.abs(a) ** 2, axis=other)
            per_tx = {}
            for ti, t in enumerate(ctx["tx_placements"]):
                g = float(10.0 * np.log10(power[0, ti] + 1e-30))
                per_tx[t["name"]] = {
                    "gain_db": round(g, 2),
                    "rss_dbm": round(t["power_dbm"] + g, 2),
                }

            detail = linkkpi.path_detail(interactions, tau, a, rx=0, tx=ctx["serving_idx"],
                                         top_n=5)
            spread = linkkpi.rms_delay_spread(tau, a)
            counts = detail["interaction_counts"]
            strongest = (detail["paths"] or [{}])[0]

            row = {
                "pos": [key[0], key[1], rx_height_m],
                "dist_m": round(float(np.linalg.norm(
                    np.array([key[0], key[1], rx_height_m]) - np.array(tx_pos))), 2),
                "n_paths_traced": detail["num_paths"],
                "los": detail["los"],
                "first_arrival_s": detail["first_arrival_s"],
                "rms_delay_spread_s": spread["rms_delay_spread_s"],
                "mean_delay_s": spread["mean_delay_s"],
                "n_specular": counts.get("specular", 0),
                "n_refraction": counts.get("refraction", 0),
                "n_diffraction": counts.get("diffraction", 0),
                "n_diffuse": counts.get("diffuse", 0),
                "strongest_share": strongest.get("share"),
                "strongest_bounces": strongest.get("bounces"),
                "per_tx": per_tx,
            }
            out[f"{key[0]:.2f},{key[1]:.2f}"] = row
            if (i + 1) % 5 == 0 or i + 1 == len(order):
                log(f"  {i + 1}/{len(order)}  last: {row['n_paths_traced']} paths, "
                    f"{'LOS' if row['los'] else 'NLOS'}, "
                    f"spread {(row['rms_delay_spread_s'] or 0) * 1e9:.1f} ns")

        if shape["batched"]:
            for name in names:
                scene.remove(name)

    if shape["batched"]:
        scene.add(Receiver(name=rx_name, position=rx_home))

    return {
        "positions": out,
        "distinct": len(order),
        "requested": len(positions),
        "rx_height_m": rx_height_m,
        "tx_position": tx_pos,
        "scene_xml": str(scene_xml),
        "max_depth": int(max_depth),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("manifest")
    ap.add_argument("--scene", required=True)
    ap.add_argument("--positions", required=True,
                    help="JSON file holding a list of [x, y] positions in ENU metres")
    ap.add_argument("--out", required=True)
    ap.add_argument("--srate", type=float, default=61.44e6)
    ap.add_argument("--max-depth", type=int, default=5)
    ap.add_argument("--rx-height", type=float, default=None)
    ap.add_argument("--tx", default=None)
    ap.add_argument("--json", action="store_true")
    rs._bool_pair(ap, "los", True, "include the direct path")
    rs._bool_pair(ap, "specular", True, "mirror-like reflections")
    rs._bool_pair(ap, "diffuse", False, "scattering off rough surfaces")
    rs._bool_pair(ap, "refraction", True, "transmission through materials")
    rs._bool_pair(ap, "diffraction", False, "bending around edges")
    rs._bool_pair(ap, "edge-diffraction", False, "wedge diffraction")
    rs._bool_pair(ap, "synthetic-array", True, "one solve for the whole array")
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
    ap.add_argument("--batch", type=int, default=batching.DEFAULT_BATCH,
                    help="how many positions to solve in one call. The solver's setup cost "
                         "does not grow with the number of receivers, so this is most of the "
                         "time: measured 332 ms per position at 1, 33 ms at 64. Pass 1 to "
                         "solve them one at a time.")
    args = ap.parse_args()

    m = rs.load_manifest(args.manifest)
    log = (lambda *a: print(*a, file=sys.stderr, flush=True)) if args.json else print
    sp = {k: getattr(args, k) for k in (
        "los", "specular", "diffuse", "refraction", "diffraction", "edge_diffraction",
        "synthetic_array", "array_pattern", "array_pol", "array_rows", "array_cols",
        "rx_pattern", "rx_pol", "freq_hz", "num_taps", "samples_per_src",
        "max_paths_per_src", "seed")}

    with open(args.positions) as f:
        positions = json.load(f)

    result = enrich_positions(m, args.scene, positions, args.srate, args.max_depth, sp=sp,
                              batch_size=args.batch,
                              rx_height_m=args.rx_height, tx_select=args.tx, log=log)
    with open(args.out, "w") as f:
        json.dump(result, f)

    log(f"\nWrote         : {args.out}  ({result['distinct']} positions)")
    if args.json:
        print(json.dumps({k: v for k, v in result.items() if k != "positions"}))


if __name__ == "__main__":
    main()
