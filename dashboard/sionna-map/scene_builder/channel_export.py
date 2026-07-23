#!/usr/bin/env python3
import argparse
import json
import pathlib
import sys

import numpy as np

import batching
import rf as rfmod
import run_scene as rs


def broadcast_tau(tau, num_rx_ant, num_tx_ant):
    if tau.ndim != 3:
        return tau
    num_rx, num_tx, num_paths = tau.shape
    out = tau[:, None, :, None, :]
    return np.broadcast_to(out, (num_rx, num_rx_ant, num_tx, num_tx_ant, num_paths)).copy()


def versions():
    import importlib
    out = {}
    for key, mod in (("sionna_rt", "sionna.rt"), ("mitsuba", "mitsuba"), ("drjit", "drjit")):
        try:
            out[key] = str(getattr(importlib.import_module(mod), "__version__", "?"))
        except Exception:
            out[key] = "?"
    out["numpy"] = np.__version__
    return out


MAX_PATHS_CSV = 200


def export(manifest, scene_xml, out_path, srate_hz, max_depth, sp=None,
           num_subcarriers=0, subcarrier_spacing=30e3, reverse_direction=False,
           normalize_delays=True, tx_select=None, want_kpi=False,
           max_paths_csv=None, noise_figure_db=None, log=print):
    sp = sp or {}
    scene, ctx = rs.prepare_scene(manifest, scene_xml, srate_hz, log=log,
                                  tx_select=tx_select, sp=sp)
    paths = rs.solve_paths(scene, max_depth,
                           batching.budget_for(sp, len(ctx["rx_placements"])))

    direction = "uplink" if reverse_direction else "downlink"
    log(f"\nDirection     : {direction}"
        + ("  (UE -> gNB; the rx/tx axes swap accordingly)" if reverse_direction else ""))

    a, tau = paths.cir(out_type="numpy", normalize_delays=normalize_delays,
                       reverse_direction=reverse_direction)
    a = np.asarray(a)
    tau = np.asarray(tau)

    num_rx, num_rx_ant, num_tx, num_tx_ant = a.shape[0], a.shape[1], a.shape[2], a.shape[3]
    nof_paths = a.shape[4]

    data = {
        "a": a,
        "tau": broadcast_tau(tau, num_rx_ant, num_tx_ant),
        "tau_geometric": tau,
    }

    if num_subcarriers > 0:
        from sionna.rt import subcarrier_frequencies
        freqs = subcarrier_frequencies(num_subcarriers, subcarrier_spacing)
        h = np.asarray(paths.cfr(frequencies=freqs, normalize_delays=normalize_delays,
                                 reverse_direction=reverse_direction, out_type="numpy"))
        data["h_freq"] = h
        data["frequencies"] = np.asarray(freqs)
        log(f"CFR grid      : {num_subcarriers} subcarriers x {subcarrier_spacing/1e3:.0f} kHz "
            f"= {num_subcarriers * subcarrier_spacing / 1e6:.2f} MHz -> {h.shape}")
    else:
        log("CFR grid      : not requested (--subcarriers 0), coefficients and delays only")

    txs, ues = ctx["txs"], ctx["ues"]

    paths_out = None
    paths_found = paths_listed = None
    try:
        import linkkpi as _lk
        _detail = _lk.path_detail(
            np.asarray(paths.interactions), tau, a,
            rx=0, tx=ctx.get("serving_idx", 0), top_n=int(max_paths_csv or MAX_PATHS_CSV),
            vertices=np.asarray(paths.vertices),
            tx_position=ctx["tx_placements"][ctx.get("serving_idx", 0)]["position"],
            rx_position=ctx["rx_placements"][0]["position"])
        _power = float(ctx["tx_placements"][ctx.get("serving_idx", 0)]["power_dbm"])
        paths_out = str(pathlib.Path(out_path).with_suffix("")) + "_paths.csv"
        with open(paths_out, "w", newline="") as fh:
            fh.write(_lk.paths_csv(_detail, tx_power_dbm=_power,
                                   delays_normalized=normalize_delays))
        _found = int(_detail.get("num_paths") or 0)
        _listed = int(_detail.get("num_paths_listed") or 0)
        paths_found, paths_listed = _found, _listed
        _note = (f"{_listed} of {_found} path(s), capped at {int(max_paths_csv or MAX_PATHS_CSV)}"
                 if _listed < _found else f"{_found} path(s)")
        log(f"\nPath CSV      : {_note} -> {paths_out}")
    except Exception as exc:
        log(f"\nPath CSV      : not written ({type(exc).__name__}: {exc})")
        paths_out = None

    kpis = None
    if want_kpi:
        if "h_freq" not in data:
            raise SystemExit("--kpi needs a frequency response; pass --subcarriers as well")
        import linkkpi
        src_nodes = ues if reverse_direction else txs
        dst_nodes = txs if reverse_direction else ues
        default_power = float(ctx["rf"].get("tx_power_dbm", 43))
        kpis = []
        log("\nLink KPIs:")
        log(f"  {'link':26s} {'SNR(dB)':>9s} {'SE':>7s} {'Mbit/s':>9s} {'BF gain':>8s} {'Bc50':>10s}")
        for ri, rx_node in enumerate(dst_nodes):
            for ti, tx_node in enumerate(src_nodes):
                power = float((tx_node.get("rf") or {}).get("tx_power_dbm", default_power))
                others = [(oi, float((o.get("rf") or {}).get("tx_power_dbm", default_power)))
                          for oi, o in enumerate(src_nodes) if oi != ti]
                k = linkkpi.link_kpis(
                    data["h_freq"], tx_power_dbm=power,
                    subcarrier_spacing_hz=subcarrier_spacing, rx=ri, tx=ti,
                    interferers=others,
                    **({} if noise_figure_db is None
                       else {"noise_figure_db": float(noise_figure_db)}))
                k.update(linkkpi.rms_delay_spread(data["tau_geometric"], a))
                k["tx"] = tx_node["name"]
                k["rx"] = rx_node["name"]
                kpis.append(k)
                bc = k.get("bc_50_hz")
                gain = k["beamforming_gain_db"]
                gain_s = "-" if gain is None else "{:.1f} dB".format(gain)
                bc_s = "flat" if not bc else "{:.0f} kHz".format(bc / 1e3)
                name = tx_node["name"] + " -> " + rx_node["name"]
                log("  {:26s} {:9.1f} {:7.2f} {:9.1f} {:>8s} {:>10s}".format(
                    name, k["snr_db"]["mrt"], k["spectral_efficiency_bps_hz"]["mrt"],
                    k["throughput_mbps"]["mrt"], gain_s, bc_s))
    src, dst = (ues, txs) if reverse_direction else (txs, ues)
    meta = {
        "tx_names": np.array([n["name"] for n in src]),
        "rx_names": np.array([n["name"] for n in dst]),
        "tx_positions": np.array([[float(v) for v in n["enu_m"]] for n in src], dtype=np.float64),
        "rx_positions": np.array([[float(v) for v in n["enu_m"]] for n in dst], dtype=np.float64),
        "num_tx": num_tx, "num_rx": num_rx,
        "num_tx_ant": num_tx_ant, "num_rx_ant": num_rx_ant,
        "num_paths": nof_paths,
        "direction": direction,
        "carrier_hz": float(ctx["freq"]),
        "srate_hz": float(srate_hz),
        "max_depth": int(max_depth),
        "normalize_delays": bool(normalize_delays),
        "num_subcarriers": int(num_subcarriers),
        "subcarrier_spacing_hz": float(subcarrier_spacing),
        "array_rows": int(ctx["rows"]), "array_cols": int(ctx["cols"]),
        "array_pattern": str(sp.get("array_pattern") or ctx["arr"].get("pattern", "tr38901")),
        "array_pol": str(sp.get("array_pol") or ctx["arr"].get("pol", "V")),
        "rx_pattern": str(sp.get("rx_pattern", "iso")),
        "rx_pol": str(sp.get("rx_pol", "V")),
        "scene_xml": str(scene_xml),
        "solver": json.dumps({k: sp.get(k) for k in (
            "los", "specular", "diffuse", "refraction", "diffraction", "edge_diffraction",
            "synthetic_array", "samples_per_src", "max_paths_per_src", "seed")}),
        "versions": json.dumps(versions()),
        "axes": ("a: [num_rx, num_rx_ant, num_tx, num_tx_ant, path, time]; "
                 "tau: same minus the time axis; "
                 "tau_geometric: [num_rx, num_tx, path] as Sionna stores it; "
                 "h_freq: [num_rx, num_rx_ant, num_tx, num_tx_ant, time, subcarrier]"),
    }
    data.update(meta)

    np.savez_compressed(out_path, **data)

    import os
    size = os.path.getsize(out_path)
    log(f"\nWrote         : {out_path}  ({size/1024/1024:.2f} MB)")
    log(f"  a           : {a.shape}  {a.dtype}")
    log(f"  tau         : {data['tau'].shape}  (from {tau.shape} native)")
    if "h_freq" in data:
        log(f"  h_freq      : {data['h_freq'].shape}  {data['h_freq'].dtype}")
    if nof_paths == 0:
        log("WARNING       : the solve found no paths - the file is valid but empty. Check "
            "that the devices sit inside the scene extent.")

    return {
        "ok": nof_paths > 0,
        "out": str(out_path),
        "paths_csv": paths_out,
        "paths_found": paths_found,
        "paths_listed": paths_listed,
        "bytes": size,
        "direction": direction,
        "shapes": {"a": list(a.shape), "tau": list(data["tau"].shape),
                   "tau_geometric": list(tau.shape),
                   **({"h_freq": list(data["h_freq"].shape)} if "h_freq" in data else {})},
        "num_tx": num_tx, "num_rx": num_rx,
        "num_tx_ant": num_tx_ant, "num_rx_ant": num_rx_ant,
        "num_paths": nof_paths,
        "carrier_hz": float(ctx["freq"]),
        "num_subcarriers": int(num_subcarriers),
        "subcarrier_spacing_hz": float(subcarrier_spacing),
        "tx_names": [n["name"] for n in src],
        "rx_names": [n["name"] for n in dst],
        "versions": versions(),
        "kpis": kpis,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("manifest")
    ap.add_argument("--scene", required=True)
    ap.add_argument("--out", required=True, help="path to write the .npz to")
    ap.add_argument("--srate", type=float, default=61.44e6)
    ap.add_argument("--max-depth", type=int, default=5)
    ap.add_argument("--tx", default=None)
    ap.add_argument("--json", action="store_true", help="emit the summary as JSON on stdout")
    ap.add_argument("--subcarriers", type=int, default=0,
                    help="OFDM grid width; 0 skips the frequency response entirely")
    ap.add_argument("--subcarrier-spacing", type=float, default=30e3,
                    help="subcarrier spacing in Hz (30 kHz is this cell's numerology)")
    ap.add_argument("--reverse-direction", action="store_true",
                    help="export the uplink (UE -> gNB) instead of the downlink")
    ap.add_argument("--noise-figure-db", type=float, default=None,
                    help="receiver noise figure in dB, which sets the noise floor every KPI "
                         "is measured against (default 7)")
    ap.add_argument("--kpi", action="store_true",
                    help="also reduce the response to link KPIs; needs --subcarriers")
    rs._bool_pair(ap, "normalize-delays", True, "shift the first arrival to tau=0")
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
    ap.add_argument("--max-paths-csv", type=int, default=200,
                    help="how many paths to write to the propagation CSV, strongest first. A dense scene traces far more than anyone reads.")
    args = ap.parse_args()

    if args.subcarriers < 0 or args.subcarriers > 8192:
        raise SystemExit("--subcarriers must be 0..8192")
    if not 0 < args.subcarrier_spacing <= 1e6:
        raise SystemExit("--subcarrier-spacing must be greater than 0 and at most 1 MHz")
    if args.kpi and args.subcarriers <= 0:
        raise SystemExit("--kpi reduces the frequency response, so --subcarriers must be > 0")

    m = rs.load_manifest(args.manifest)
    log = (lambda *a: print(*a, file=sys.stderr, flush=True)) if args.json else print
    sp = {k: getattr(args, k) for k in (
        "los", "specular", "diffuse", "refraction", "diffraction", "edge_diffraction",
        "synthetic_array", "array_pattern", "array_pol", "array_rows", "array_cols",
        "rx_pattern", "rx_pol", "freq_hz", "num_taps", "samples_per_src",
        "max_paths_per_src", "seed")}

    result = export(m, args.scene, args.out, args.srate, args.max_depth, sp=sp,
                    num_subcarriers=args.subcarriers,
                    subcarrier_spacing=args.subcarrier_spacing,
                    reverse_direction=args.reverse_direction,
                    normalize_delays=args.normalize_delays,
                    tx_select=args.tx, want_kpi=args.kpi,
                    max_paths_csv=args.max_paths_csv,
                    noise_figure_db=args.noise_figure_db, log=log)

    if args.json:
        print(json.dumps(result))


if __name__ == "__main__":
    main()
