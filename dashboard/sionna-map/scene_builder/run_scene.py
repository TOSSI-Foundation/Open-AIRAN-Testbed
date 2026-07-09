#!/usr/bin/env python3
import argparse
import json
import math
import os
import sys

import batching
import rf as rfmod


PATH_DETAIL_TOP_N = 100


def load_manifest(path):
    with open(path) as f:
        obj = json.load(f)
    return obj["manifest"] if "manifest" in obj and "buildings" in obj else obj


def pick_tx(txs, selector):
    if selector in (None, ""):
        return 0
    for i, t in enumerate(txs):
        if t.get("name") == selector:
            return i
    try:
        i = int(selector)
    except (TypeError, ValueError):
        raise SystemExit(f"unknown --tx '{selector}'; names: {[t.get('name') for t in txs]}")
    if not 0 <= i < len(txs):
        raise SystemExit(f"--tx index {i} out of range (scene has {len(txs)} transmitter(s))")
    return i


def _bool_pair(ap, name, default, help_on):
    g = ap.add_mutually_exclusive_group()
    g.add_argument(f"--{name}", dest=name.replace("-", "_"), action="store_true",
                   default=default, help=help_on)
    g.add_argument(f"--no-{name}", dest=name.replace("-", "_"), action="store_false")


def scene_config(manifest, srate_hz, tx_select=None, sp=None) -> dict:
    nodes = manifest.get("nodes", [])
    txs = [n for n in nodes if n["type"] in ("gnb", "tower")]
    ues = [n for n in nodes if n["type"] == "ue"]
    if not txs or not ues:
        raise SystemExit("Need at least one gNB/tower and one UE in the manifest.")

    serving_idx = pick_tx(txs, tx_select)
    rf = rfmod.tx_rf(manifest)
    arr = rf.get("array", {})
    freq = float(rf.get("freq_hz", 3.48942e9))
    sp = sp or {}
    tinfo = rfmod.taps_info(manifest, srate_hz)
    if sp.get("num_taps"):
        num_taps = int(sp["num_taps"])
        tinfo = dict(tinfo, taps=num_taps, span_m=(num_taps / srate_hz) * rfmod.C,
                     clamped=tinfo["wanted"] > num_taps, pinned=True)
    else:
        num_taps = tinfo["taps"]

    freq = float(sp["freq_hz"]) if sp.get("freq_hz") else freq
    rows = int(sp["array_rows"]) if sp.get("array_rows") else int(arr.get("rows", 1))
    cols = int(sp["array_cols"]) if sp.get("array_cols") else int(arr.get("cols", 4))

    return {
        "txs": txs, "ues": ues, "rf": rf, "arr": arr, "freq": freq,
        "rows": rows, "cols": cols, "nof_tx_ant": rows * cols,
        "num_taps": num_taps, "tinfo": tinfo, "serving_idx": serving_idx,
        "srate_hz": srate_hz,
        "tx_pattern": sp.get("array_pattern") or arr.get("pattern", "tr38901"),
        "tx_pol": sp.get("array_pol") or arr.get("pol", "V"),
        "rx_pattern": sp.get("rx_pattern", "iso"),
        "rx_pol": sp.get("rx_pol", "V"),
        "tx_placements": [{
            "name": t["name"],
            "position": [float(v) for v in t["enu_m"]],
            "orientation": [float(v) for v in rfmod.orientation_rad(t.get("rf") or rf)],
            "power_dbm": float((t.get("rf") or rf).get("tx_power_dbm", 43)),
        } for t in txs],
        "rx_placements": [{
            "name": u["name"],
            "position": [float(v) for v in u["enu_m"]],
        } for u in ues],
    }


def prepare_scene(manifest, scene_xml, srate_hz, log=print, tx_select=None, sp=None):
    sp = sp or {}
    cfg = scene_config(manifest, srate_hz, tx_select=tx_select, sp=sp)
    txs, ues, rf, arr = cfg["txs"], cfg["ues"], cfg["rf"], cfg["arr"]
    freq, rows, cols = cfg["freq"], cfg["rows"], cfg["cols"]
    num_taps, tinfo, serving_idx = cfg["num_taps"], cfg["tinfo"], cfg["serving_idx"]
    nof_tx_ant = cfg["nof_tx_ant"]

    from sionna.rt import PlanarArray, Receiver, Transmitter, load_scene

    log(f"Loading scene : {scene_xml}")
    scene = load_scene(scene_xml)

    scene.frequency = freq
    scene.tx_array = PlanarArray(num_rows=rows, num_cols=cols,
                                 pattern=cfg["tx_pattern"], polarization=cfg["tx_pol"])
    scene.rx_array = PlanarArray(num_rows=1, num_cols=1,
                                 pattern=cfg["rx_pattern"], polarization=cfg["rx_pol"])

    log(f"Carrier       : {freq/1e9:.5f} GHz (band n{rf.get('band','?')})")
    log(f"gNB array     : {rows}x{cols} {sp.get('array_pattern') or arr.get('pattern','tr38901')} "
        f"pol={sp.get('array_pol') or arr.get('pol','V')} | power={rf.get('tx_power_dbm',43)} dBm")
    log("Propagation   : " + ", ".join(
        n for n, on in (("LOS", sp.get("los", True)), ("specular", sp.get("specular", True)),
                        ("diffuse", sp.get("diffuse", False)), ("refraction", sp.get("refraction", True)),
                        ("diffraction", sp.get("diffraction", False)),
                        ("edge diffraction", sp.get("edge_diffraction", False))) if on))
    log(f"Sample rate   : {srate_hz/1e6:.2f} Msps | taps: {num_taps} "
        f"(scene diag ~{tinfo['scene_diag_m']:.0f} m, covers {tinfo['span_m']:.0f} m of path)")
    if tinfo["clamped"]:
        log(f"WARNING       : delay spread wants {tinfo['wanted']} taps but the DU wire format "
            f"caps at {tinfo['cap']}. Echoes beyond {tinfo['span_m']:.0f} m are truncated; "
            f"use a smaller area for full fidelity.")

    for t in cfg["tx_placements"]:
        scene.add(Transmitter(name=t["name"], position=t["position"],
                              orientation=t["orientation"], power_dbm=t["power_dbm"]))
    for u in cfg["rx_placements"]:
        scene.add(Receiver(name=u["name"], position=u["position"]))

    log(f"\nTransmitters  : {len(txs)}  Receivers: {len(ues)}  (single solve, full matrix)")

    return scene, cfg


def solve_paths(scene, max_depth, sp=None):
    from sionna.rt import PathSolver
    sp = sp or {}
    return PathSolver()(scene, max_depth=max_depth,
                        los=bool(sp.get("los", True)),
                        specular_reflection=bool(sp.get("specular", True)),
                        diffuse_reflection=bool(sp.get("diffuse", False)),
                        refraction=bool(sp.get("refraction", True)),
                        diffraction=bool(sp.get("diffraction", False)),
                        edge_diffraction=bool(sp.get("edge_diffraction", False)),
                        synthetic_array=bool(sp.get("synthetic_array", True)),
                        samples_per_src=int(sp.get("samples_per_src", 1000000)),
                        max_num_paths_per_src=int(sp.get("max_paths_per_src", 1000000)),
                        seed=int(sp.get("seed", 42)))


def route_manifest(manifest, step_m, scene_xml):
    import copy
    import numpy as np
    m = copy.deepcopy(manifest)
    try:
        import terrain
        grid = terrain.GroundGrid.from_scene_xml(scene_xml)
    except Exception:
        grid = None
    out, route = [], None
    for n in m.get("nodes", []):
        pts = n.get("route_points_enu") if n.get("type") == "ue" else None
        if route is not None or not isinstance(pts, list) or len(pts) < 2:
            out.append(n)
            continue
        a = np.asarray([[float(q[0]), float(q[1])] for q in pts])
        seg = np.hypot(*np.diff(a, axis=0).T)
        cum = np.concatenate([[0.0], np.cumsum(seg)])
        s = np.arange(0.0, cum[-1] + 1e-9, float(step_m))
        xy = np.stack([np.interp(s, cum, a[:, 0]), np.interp(s, cum, a[:, 1])], axis=1)
        agl = float(n.get("height_agl_m") or 1.5)
        if grid is not None:
            z = grid.height(xy[:, 0], xy[:, 1]) + agl
        else:
            z = np.interp(s, cum, [float(q[2]) for q in pts]) if len(pts[0]) > 2 else np.full(len(s), agl)
        for k, (x, y) in enumerate(xy):
            u = dict(n, name=f"{n['name']}@{k}", enu_m=[round(float(x), 2), round(float(y), 2), round(float(z[k]), 2)])
            u.pop("route_points_enu", None); u.pop("route_enu", None)
            out.append(u)
        route = {"ue": n["name"], "step_m": float(step_m), "length_m": round(float(cum[-1]), 1),
                 "points": [[round(float(x), 2), round(float(y), 2), round(float(zz), 2)] for (x, y), zz in zip(xy, z)],
                 "s_m": [round(float(v), 1) for v in s]}
    m["nodes"] = out
    return m, route


def _stamp_ground(paths, grid):
    if grid is None:
        return paths
    import numpy as np
    for p in paths:
        pts = p.get("points") or []
        if pts:
            a = np.asarray(pts, float)
            p["ground_m"] = [round(float(g), 2) for g in grid.height(a[:, 0], a[:, 1])]
    return paths


def trace(manifest, scene_xml, srate_hz, max_depth, log=print, tx_select=None, sp=None):
    import numpy as np

    scene, ctx = prepare_scene(manifest, scene_xml, srate_hz,
                               log=log, tx_select=tx_select, sp=sp)
    txs, ues = ctx["txs"], ctx["ues"]
    rf, arr = ctx["rf"], ctx["arr"]
    serving_idx, nof_tx_ant = ctx["serving_idx"], ctx["nof_tx_ant"]

    paths = solve_paths(scene, max_depth, batching.budget_for(sp, len(ues)))
    a, tau = paths.cir(out_type="numpy")
    a = np.asarray(a)
    tau = np.asarray(tau)
    import linkkpi
    interactions = np.asarray(paths.interactions)
    vertices = np.asarray(paths.vertices)

    def _collapse_ant(arr, rank, axes):
        x = np.asarray(arr)
        if x.ndim != rank:
            return x
        for ax in sorted(axes, reverse=True):
            if x.shape[ax] == 1:
                x = np.squeeze(x, axis=ax)
        return x

    tau = _collapse_ant(tau, 5, (3, 1))
    interactions = _collapse_ant(interactions, 6, (4, 2))
    vertices = _collapse_ant(vertices, 7, (4, 2))
    other = tuple(i for i in range(a.ndim) if i not in (0, 2))
    power = np.sum(np.abs(a) ** 2, axis=other)
    per_path = np.sum(np.abs(a) ** 2, axis=tuple(i for i in range(a.ndim) if i not in (0, 2, 4)))
    counts = np.sum(per_path > 1e-24, axis=-1)
    with np.errstate(divide="ignore"):
        gain_db = 10.0 * np.log10(power + 1e-30)

    log("\nLink budget (every TX -> every UE):")
    log(f"  {'UE':12s} {'TX':12s} {'paths':>6s} {'gain(dB)':>10s} {'sight':>6s} "
        f"{'spread':>9s}  best")
    matrix, links, any_ok = [], [], False
    try:
        import terrain
        grid = terrain.GroundGrid.from_scene_xml(scene_xml)
    except Exception:
        grid = None
    for ri, ue in enumerate(ues):
        best_ti = int(np.argmax(gain_db[ri])) if len(txs) > 1 else 0
        for ti, t in enumerate(txs):
            nof = int(counts[ri, ti])
            g = float(gain_db[ri, ti])
            mark = "  <-- best" if ti == best_ti and nof else ""
            detail = linkkpi.path_detail(
                interactions, tau, a, rx=ri, tx=ti,
                top_n=int(sp.get("path_detail_top_n", PATH_DETAIL_TOP_N)),
                vertices=vertices,
                tx_position=ctx["tx_placements"][ti]["position"],
                rx_position=ctx["rx_placements"][ri]["position"])
            spread = linkkpi.rms_delay_spread(tau[ri:ri + 1, ti:ti + 1, :],
                                              a[ri:ri + 1, :, ti:ti + 1, :, :, :])
            ds = spread["rms_delay_spread_s"]
            ds_s = "-" if ds is None else "{:.1f} ns".format(ds * 1e9)
            log("  {:12s} {:12s} {:6d} {:10.2f} {:>6s} {:>9s}{}".format(
                ue["name"], t["name"], nof, g,
                "LOS" if detail["los"] else "NLOS", ds_s, mark))
            matrix.append({"ue": ue["name"], "tx": t["name"], "paths": nof,
                           "gain_db": round(g, 2), "best": ti == best_ti,
                           "los": detail["los"],
                           "first_arrival_s": detail["first_arrival_s"],
                           "rms_delay_spread_s": spread["rms_delay_spread_s"],
                           "interaction_counts": detail["interaction_counts"],
                           "path_detail": _stamp_ground(detail["paths"], grid)})
            any_ok = any_ok or nof > 0
        serving = linkkpi.path_detail(
            interactions, tau, a, rx=ri, tx=serving_idx,
            top_n=int(sp.get("path_detail_top_n", PATH_DETAIL_TOP_N)),
            vertices=vertices,
            tx_position=ctx["tx_placements"][serving_idx]["position"],
            rx_position=ctx["rx_placements"][ri]["position"])
        serving_spread = linkkpi.rms_delay_spread(
            tau[ri:ri + 1, serving_idx:serving_idx + 1, :],
            a[ri:ri + 1, :, serving_idx:serving_idx + 1, :, :, :])
        links.append({
            "ue": ue["name"], "position": list(ue["enu_m"]),
            "paths": int(counts[ri, serving_idx]),
            "gain_db": round(float(gain_db[ri, serving_idx]), 2),
            "best_tx": txs[best_ti]["name"],
            "best_gain_db": round(float(gain_db[ri, best_ti]), 2),
            "los": serving["los"],
            "first_arrival_s": serving["first_arrival_s"],
            "rms_delay_spread_s": serving_spread["rms_delay_spread_s"],
            "interaction_counts": serving["interaction_counts"],
            "path_detail": _stamp_ground(serving["paths"], grid),
        })

    log("\nOK — scene loaded at the correct carrier and ray tracing ran." if any_ok else
        "\nScene loaded, but 0 paths — check node positions are inside the scene extent.")

    tx = txs[serving_idx]
    srf = tx.get("rf") or rf
    live_cmd = ["python", "OCUDU-RAN/utils/sionna/live_channel.py",
                "--scene", scene_xml,
                "--srate", f"{srate_hz:.0f}", "--num-taps", str(ctx["num_taps"]),
                "--num-tx-ant", str(nof_tx_ant),
                "--tx-position", *[str(v) for v in tx["enu_m"]],
                "--rx-start", *[str(v) for v in ues[0]["enu_m"]], "--static"]

    return {
        "ok": any_ok,
        "scene": scene_xml,
        "carrier_hz": ctx["freq"],
        "band": rf.get("band"),
        "array": {"rows": int(arr.get("rows", 1)), "cols": int(arr.get("cols", 4)),
                  "pattern": arr.get("pattern", "tr38901"), "pol": arr.get("pol", "V"),
                  "nof_tx_ant": nof_tx_ant},
        "tx_power_dbm": rf.get("tx_power_dbm", 43),
        "srate_hz": srate_hz,
        "max_depth": max_depth,
        "taps": ctx["tinfo"],
        "transmitters": [{"name": t["name"], "position": list(t["enu_m"]),
                          "serving": i == serving_idx} for i, t in enumerate(txs)],
        "serving_tx": {"name": tx["name"], "index": serving_idx, "position": list(tx["enu_m"]),
                       "azimuth_deg": srf.get("azimuth_deg", 0),
                       "downtilt_deg": srf.get("downtilt_deg", 0)},
        "links": links,
        "matrix": matrix,
        "live_command": " ".join(live_cmd),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("manifest")
    ap.add_argument("--scene", required=True)
    ap.add_argument("--max-depth", type=int, default=5)
    ap.add_argument("--srate", type=float, default=61.44e6, help="cell sample rate (Hz); matches the DU")
    ap.add_argument("--tx", default=None, help="serving transmitter: name or 0-based index")
    ap.add_argument("--json", action="store_true", help="emit the result as JSON on stdout")
    _bool_pair(ap, "los", True, "include the direct path")
    _bool_pair(ap, "specular", True, "mirror-like reflections")
    _bool_pair(ap, "diffuse", False, "scattering off rough surfaces")
    _bool_pair(ap, "refraction", True, "transmission through materials")
    _bool_pair(ap, "diffraction", False, "bending around edges")
    _bool_pair(ap, "edge-diffraction", False, "wedge diffraction")
    _bool_pair(ap, "synthetic-array", True, "one solve for the whole array")
    ap.add_argument("--array-pattern", default=None)
    ap.add_argument("--array-pol", default=None)
    ap.add_argument("--array-rows", type=int, default=None)
    ap.add_argument("--array-cols", type=int, default=None)
    ap.add_argument("--rx-pattern", default="iso")
    ap.add_argument("--rx-pol", default="V")
    ap.add_argument("--freq-hz", type=float, default=None, help="override the cell's carrier")
    ap.add_argument("--num-taps", type=int, default=None, help="pin the tap count")
    ap.add_argument("--samples-per-src", type=int, default=1000000)
    ap.add_argument("--max-paths-per-src", type=int, default=1000000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--route-step-m", type=float, default=0.0,
                    help="trace the UE's route: one position every this many metres, in one solve")
    ap.add_argument("--route-top-n", type=int, default=15, help="strongest paths kept per link on a route")
    args = ap.parse_args()

    m = load_manifest(args.manifest)
    log = (lambda *a: print(*a, file=sys.stderr, flush=True)) if args.json else print
    sp = {k: getattr(args, k) for k in (
        "los", "specular", "diffuse", "refraction", "diffraction", "edge_diffraction",
        "synthetic_array", "array_pattern", "array_pol", "array_rows", "array_cols",
        "rx_pattern", "rx_pol", "freq_hz", "num_taps", "samples_per_src",
        "max_paths_per_src", "seed")}
    route = None
    if args.route_step_m > 0:
        m, route = route_manifest(m, args.route_step_m, args.scene)
        if route is None:
            raise SystemExit("No UE in this scene walks a route: draw one on the map and stand a UE on it.")
        sp["path_detail_top_n"] = args.route_top_n
        log(f"Route         : {route['ue']} at {len(route['points'])} positions, every "
            f"{route['step_m']:g} m along {route['length_m']} m")
    result = trace(m, args.scene, args.srate, args.max_depth, log=log, tx_select=args.tx, sp=sp)
    if route is not None:
        result["route"] = route

    if args.json:
        print(json.dumps(result))
    else:
        print("\nStream to the O-DU (matched srate + taps):")
        print("  " + result["live_command"].replace(" --scene", " \\\n      --scene")
              .replace(" --srate", " \\\n      --srate")
              .replace(" --num-tx-ant", " \\\n      --num-tx-ant")
              .replace(" --tx-position", " \\\n      --tx-position"))


if __name__ == "__main__":
    main()
