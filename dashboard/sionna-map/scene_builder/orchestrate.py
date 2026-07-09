#!/usr/bin/env python3
import argparse
import json
import os
import re
import subprocess
import sys

import rf as rfmod

HERE = os.path.dirname(os.path.abspath(__file__))
LIVE_CHANNEL = os.path.normpath(os.path.join(HERE, "..", "..", "OCUDU-RAN", "utils", "sionna", "live_channel.py"))


def load_pkg(path):
    with open(path) as f:
        obj = json.load(f)
    if "manifest" in obj and "buildings" in obj:
        return obj["manifest"], obj["buildings"]
    return obj, None


def parse_du(du_path):
    import yaml
    with open(du_path) as f:
        cfg = yaml.safe_load(f)
    ru = cfg.get("ru_sdr", {})
    cell = cfg.get("cell_cfg", {})
    srate_hz = float(ru.get("srate", 61.44)) * 1e6
    dev = ru.get("device_args", "")
    m = re.search(r"live=([^,]+)", dev)
    live_bind = m.group(1) if m else "tcp://127.0.0.1:5566"
    return {"srate_hz": srate_hz, "dl_arfcn": cell.get("dl_arfcn"), "live_bind": live_bind,
            "bw_mhz": cell.get("channel_bandwidth_MHz")}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("package", nargs="?", help="scene package JSON (manifest + buildings)")
    ap.add_argument("--du-config", required=True, help="O-DU YAML (e.g. du_sionna_n78_40mhz.yaml)")
    ap.add_argument("--out", default="scenes/orchestrated")
    ap.add_argument("--scene", default=None,
                    help="use an already-built scene.xml instead of building one")
    ap.add_argument("--mode", choices=["static", "route"], default="static")
    ap.add_argument("--tx", default=None, help="serving transmitter: name or 0-based index")
    ap.add_argument("--max-depth", type=int, default=5)
    ap.add_argument("--min-area", type=float, default=8.0)
    ap.add_argument("--terrain", action="store_true")
    ap.add_argument("--json", action="store_true", help="emit the derived wiring as JSON on stdout")
    ap.add_argument("--launch", action="store_true", help="actually run live_channel.py (else dry run)")
    args = ap.parse_args()

    du = parse_du(args.du_config)

    if not args.package:
        if not args.json:
            print(f"srate     : {du['srate_hz']/1e6:.2f} Msps")
            print(f"dl_arfcn  : {du['dl_arfcn']} -> {rfmod.nr_arfcn_to_hz(du['dl_arfcn'])/1e9:.5f} GHz"
                  if du["dl_arfcn"] else "dl_arfcn  : (not set)")
            print(f"live bind : {du['live_bind']}")
            print(f"bandwidth : {du['bw_mhz']} MHz")
            return
        out = dict(du)
        out["dl_freq_hz"] = rfmod.nr_arfcn_to_hz(du["dl_arfcn"]) if du["dl_arfcn"] else None
        print(json.dumps(out))
        return

    manifest, buildings = load_pkg(args.package)

    rf = rfmod.tx_rf(manifest)
    freq = float(rf.get("freq_hz", 3.48942e9))
    arfcn_freq = rfmod.nr_arfcn_to_hz(du["dl_arfcn"]) if du["dl_arfcn"] else None
    carrier_mismatch = bool(arfcn_freq and abs(arfcn_freq - freq) > 1e6)
    if carrier_mismatch:
        print(f"warning: manifest carrier {freq/1e9:.5f} GHz != DU dl_arfcn "
              f"{arfcn_freq/1e9:.5f} GHz; using manifest.", file=sys.stderr)
    tinfo = rfmod.taps_info(manifest, du["srate_hz"])
    num_taps = tinfo["taps"]
    if tinfo["clamped"]:
        print(f"warning: this scene's delay spread wants {tinfo['wanted']} taps but the DU wire "
              f"format caps at {tinfo['cap']}; echoes beyond {tinfo['span_m']:.0f} m are truncated.",
              file=sys.stderr)
    arr = rf.get("array", {})
    ntx = int(arr.get("rows", 1)) * int(arr.get("cols", 4))

    txs = [n for n in manifest["nodes"] if n["type"] in ("gnb", "tower")]
    ues = [n for n in manifest["nodes"] if n["type"] == "ue"]
    if not txs or not ues:
        sys.exit("need at least one gNB/tower and one UE in the manifest.")
    import run_scene
    serving_idx = run_scene.pick_tx(txs, args.tx)
    tx, ue = txs[serving_idx], ues[0]

    if args.scene:
        scene_xml = args.scene
    else:
        import build_scene
        scene_xml, grid = build_scene.build(manifest, buildings, args.out,
                                            min_area=args.min_area, models_dir=HERE, use_terrain=args.terrain)
        if grid is not None:
            lon0_, lat0_ = manifest["crs"]["origin_lonlat"]
            build_scene.ground_reference(manifest, grid, lon0_, lat0_)

    cmd = [sys.executable, LIVE_CHANNEL, "--scene", scene_xml,
           "--srate", f"{du['srate_hz']:.0f}", "--num-taps", str(num_taps),
           "--num-tx-ant", str(ntx), "--max-depth", str(args.max_depth),
           "--bind", du["live_bind"],
           "--tx-position", *[str(v) for v in tx["enu_m"]]]
    route = ue.get("route_enu")
    if args.mode == "route" and route:
        cmd += ["--rx-start", *[str(v) for v in route["start"]],
                "--rx-end", *[str(v) for v in route["end"]], "--route"]
    else:
        cmd += ["--rx-start", *[str(v) for v in ue["enu_m"]], "--static"]

    if args.json:
        print(json.dumps({
            "scene": scene_xml, "du": du, "carrier_hz": freq,
            "du_carrier_hz": arfcn_freq, "carrier_mismatch": carrier_mismatch,
            "taps": tinfo, "num_tx_ant": ntx, "mode": args.mode,
            "serving_tx": {"name": tx["name"], "index": serving_idx, "position": list(tx["enu_m"])},
            "ue": {"name": ue["name"], "position": list(ue["enu_m"]),
                   "has_route": bool(ue.get("route_enu"))},
            "command": cmd,
        }))
        return

    print("\n=== orchestration summary ===")
    print(f"scene       : {scene_xml}")
    print(f"carrier     : {freq/1e9:.5f} GHz  (band n{rf.get('band','?')}, DU BW {du['bw_mhz']} MHz)")
    print(f"srate       : {du['srate_hz']/1e6:.2f} Msps   taps: {num_taps}   tx-ant: {ntx}")
    print(f"live bind   : {du['live_bind']}  (DU device_args live=…)")
    print(f"serving TX  : {tx['name']} @ {tx['enu_m']}   UE: {ue['name']} @ {ue['enu_m']}")
    print("\ncommand:\n  " + " ".join(cmd))

    if args.launch:
        print("\n[launching live_channel.py — Ctrl-C to stop]\n")
        os.execv(sys.executable, cmd)
    else:
        print("\n(dry run — add --launch to stream to the O-DU)")


if __name__ == "__main__":
    main()
