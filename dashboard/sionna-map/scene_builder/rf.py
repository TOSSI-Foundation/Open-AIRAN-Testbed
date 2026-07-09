import math

C = 299_792_458.0


def nr_arfcn_to_hz(arfcn):
    if arfcn < 600000:
        return arfcn * 5000.0
    if arfcn < 2016667:
        return (3000e6 + 15000.0 * (arfcn - 600000))
    return (24250.08e6 + 60000.0 * (arfcn - 2016667))


def tx_rf(manifest):
    for n in manifest.get("nodes", []):
        if n["type"] in ("gnb", "tower") and n.get("rf"):
            return n["rf"]
    return {"band": 78, "freq_hz": 3.48942e9,
            "array": {"rows": 1, "cols": 4, "pattern": "tr38901", "pol": "V"},
            "tx_power_dbm": 43, "azimuth_deg": 0, "downtilt_deg": 6}


def orientation_rad(rf):
    az = math.radians(90.0 - rf.get("azimuth_deg", 0.0))
    dt = math.radians(rf.get("downtilt_deg", 0.0))
    return [az, dt, 0.0]


def scene_diag_m(manifest):
    size = (manifest.get("bbox") or {}).get("size_m")
    if size and len(size) == 2:
        return math.hypot(size[0], size[1])
    return 500.0


MAX_TAPS = 64


def taps_info(manifest, srate_hz, mult=2.2, guard=8, cap=MAX_TAPS):
    diag = scene_diag_m(manifest)
    max_path = mult * diag
    wanted = max(16, int(math.ceil((max_path / C) * srate_hz)) + guard)
    taps = min(wanted, cap)
    return {
        "taps": taps,
        "wanted": wanted,
        "clamped": wanted > cap,
        "cap": cap,
        "span_m": (taps / srate_hz) * C,
        "scene_diag_m": diag,
    }


def derive_num_taps(manifest, srate_hz, mult=2.2, guard=8, cap=MAX_TAPS):
    return taps_info(manifest, srate_hz, mult, guard, cap)["taps"]
