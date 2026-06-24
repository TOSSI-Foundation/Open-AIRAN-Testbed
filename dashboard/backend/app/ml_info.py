from __future__ import annotations

import os
import re
import time
from pathlib import Path

import yaml

FEATURES = {
    "bsr_ml": {
        "label": "ML-BSR periodicity", "algo": "SVR (random Fourier features)",
        "model": "ml/models/bsr_periodicity.model", "glob": "bsr_ml_dataset_*.csv",
        "train": "python3 ml/training/train_bsr_periodicity.py {csv} "
                 "--inc-out lib/scheduler/support/bsr_periodicity_model.inc --model-out ml/models/bsr_periodicity.model",
    },
    "ml_mcs": {
        "label": "ML UL MCS", "algo": "gradient-boosted classifier",
        "model": "ml/models/mcs_ml_seed.model", "glob": "ul_mcs_dataset_*.csv",
        "train": "python3 ml/training/train_export_mcs.py {csv} "
                 "--out lib/scheduler/support/mcs_ml_model.inc --model-out ml/models/site_a.model",
    },
    "csi_ml": {
        "label": "Predictive CSI", "algo": "GRU / Wiener predictor",
        "model": "ml/models/csi_gru_seed.model", "glob": "csi_ml_*.csv",
        "train": "python3 ml/training/train_export_csi_gru.py {csv} "
                 "--model-out ml/models/csi_gru_seed.model --inc-out lib/scheduler/support/csi_ml_gru_model.inc",
    },
    "slice_ml": {
        "label": "Slice-ML", "algo": "actor-critic + attention schedulers",
        "model": "ml/slicemanager/slicemanager_actor.model", "glob": "slice_ml_*.csv",
        "train": "python3 ml/training/train_slicemanager_actor.py {csv} "
                 "--model-out ml/slicemanager/slicemanager_actor.model --d-hidden 256 --d-fc 512 --epochs 200",
    },
}


def _merge(a: dict, b: dict) -> dict:
    out = dict(a)
    for k, v in b.items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def merged_config(src: Path, cfgs: str) -> dict:
    cfg: dict = {}
    for c in cfgs.split():
        p = Path(c) if c.startswith("/") else src / "configs" / c
        try:
            cfg = _merge(cfg, yaml.safe_load(p.read_text()) or {})
        except (OSError, yaml.YAMLError):
            continue
    return cfg


def _on(d: dict, *path: str) -> bool:
    for k in path:
        d = d.get(k) if isinstance(d, dict) else None
    return bool(d)


def feature_state(name: str, block: dict) -> dict:
    inf = block.get("inference") or {}
    logging = _on(block, "dataset_logging", "enabled")
    infer = bool(inf.get("enabled"))
    applied = {
        "bsr_ml": _on(block, "actuation", "enabled"),
        "slice_ml": bool(inf.get("apply")),
        "csi_ml": bool(inf.get("apply_to_mcs")),
        "ml_mcs": infer,
    }.get(name, False)
    mode = "closed loop" if infer and applied else "shadow" if infer else "collect" if logging else "off"
    model = inf.get("model_path") or ""
    if name == "csi_ml":
        model = inf.get(f"{inf.get('model_type', 'gru')}_model_path") or model
    return {"feature": name, "label": FEATURES[name]["label"], "algo": FEATURES[name]["algo"], "mode": mode,
            "dataset_logging": logging, "inference": infer, "applied": applied,
            "model": model or FEATURES[name]["model"], "model_source": "config" if model else "default"}


def model_file(src: Path, rel: str) -> dict:
    p = Path(rel) if rel.startswith("/") else src / rel
    try:
        st = p.stat()
        return {"path": rel, "exists": True, "bytes": st.st_size, "modified": st.st_mtime}
    except OSError:
        return {"path": rel, "exists": False, "note": "not on disk -- the DU uses its compiled-in seed"}


_RATE = re.compile(r"([\d.]+)\s*(G|M|k)?bps")


def _bps(text: str) -> float | None:
    m = _RATE.search(text)
    if not m:
        return None
    return float(m.group(1)) * {"G": 1e9, "M": 1e6, "k": 1e3}.get(m.group(2) or "", 1.0)


def _fields(line: str) -> dict:
    return {k: v.strip() for k, v in re.findall(r"(\w+)=\s*([^\s\[]+)", line)}


def parse_metrics(text: str) -> dict:
    cell, ues, ts = None, {}, None
    for line in text.splitlines():
        if "[METRICS ]" not in line:
            continue
        if "Scheduler cell" in line:
            cell, ts = line, line[:26]
        elif "Scheduler UE ue=" in line:
            f = _fields(line)
            ues[f.get("rnti", f.get("ue", "?"))] = f
    if not cell:
        return {}
    f = _fields(cell)
    out = {"time": ts, "dl_bps": _bps(cell.split("total_dl_brate=")[1]) if "total_dl_brate=" in cell else None,
           "ul_bps": _bps(cell.split("total_ul_brate=")[1]) if "total_ul_brate=" in cell else None,
           "ues": int(f["nof_ues"]) if f.get("nof_ues", "").isdigit() else None,
           "pusch_rbs_per_slot": f.get("pusch_rbs_per_slot"), "pdsch_rbs_per_slot": f.get("pdsch_rbs_per_slot"),
           "failed_uci": f.get("failed_uci"), "msg3_ok": f.get("msg3_ok"), "prbs": f.get("nof_prbs")}
    out["per_ue"] = [{"rnti": r, "cqi": u.get("cqi"), "dl_mcs": u.get("dl_mcs"), "ul_mcs": u.get("ul_mcs"),
                      "dl_bler": u.get("dl_error_rate"), "ul_bler": u.get("ul_error_rate"),
                      "snr_db": u.get("pusch_snr_db"), "bsr": u.get("bsr"), "sr_count": u.get("sr_count"),
                      "ul_brate": u.get("ul_brate")} for r, u in ues.items()]
    return out


def tail(path: Path, nbytes: int = 4 * 1024 * 1024) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - nbytes))
            return f.read().decode(errors="replace")
    except OSError:
        return ""


def du_log(src: Path, cfg: dict) -> Path | None:
    name = (cfg.get("log") or {}).get("filename")
    if not name or name in ("stdout", "/dev/stdout"):
        return None
    return Path(name) if name.startswith("/") else src / name


def _rows_and_cols(p: Path) -> tuple[int, list[str]]:
    with open(p, "rb") as f:
        head = f.readline().decode(errors="replace").strip()
        rows = sum(1 for _ in f)
    return rows, [c for c in head.split(",") if c]


def datasets(src: Path, var_dir: Path, stack: str, features: list[str]) -> list[dict]:
    found: dict[str, dict] = {}
    roots = [("tree", src / "ml" / "datasets"), ("collected", var_dir / "datasets" / stack)]
    for label, root in roots:
        if not root.is_dir():
            continue
        for f in sorted(root.rglob("*.csv")):
            feat = next((n for n in features if f.match(FEATURES[n]["glob"])), None)
            if label == "tree" and not feat:
                continue
            try:
                rows, cols = _rows_and_cols(f)
                st = f.stat()
            except OSError:
                continue
            rel = f.relative_to(root).as_posix()
            key = f"{label}:{rel}"
            found[key] = {"id": key, "where": label, "name": f.name, "rel": rel, "feature": feat,
                          "rows": rows, "columns": cols, "bytes": st.st_size, "modified": st.st_mtime,
                          "train": FEATURES[feat]["train"].format(csv=f"ml/datasets/{rel}") if feat and label == "tree" else
                                   (FEATURES[feat]["train"].format(csv=str(f)) if feat else "")}
    return sorted(found.values(), key=lambda d: d["modified"], reverse=True)


def dataset_path(src: Path, var_dir: Path, stack: str, key: str) -> Path | None:
    where, _, rel = key.partition(":")
    root = {"tree": src / "ml" / "datasets", "collected": var_dir / "datasets" / stack}.get(where)
    if not root or not rel or ".." in Path(rel).parts:
        return None
    p = (root / rel).resolve()
    return p if p.is_file() and root.resolve() in p.parents and p.suffix == ".csv" else None


def preview(p: Path, n: int = 15) -> dict:
    lines = p.read_bytes()[-4 * 1024 * 1024:].decode(errors="replace").splitlines() if p.stat().st_size > 4 * 1024 * 1024 \
        else p.read_text(errors="replace").splitlines()
    with open(p, "rb") as f:
        header = f.readline().decode(errors="replace").strip().split(",")
    body = [ln.split(",") for ln in lines[1:] if ln and not ln.startswith(header[0] + ",")]
    return {"columns": header, "head": body[:n], "tail": body[-n:] if len(body) > n else []}


def summary(src: Path, var_dir: Path, stack: str, env: dict) -> dict:
    cfg = merged_config(src, env.get("OCUDU_CFG", ""))
    feats = [feature_state(n, cfg[n]) for n in FEATURES if isinstance(cfg.get(n), dict)]
    for f in feats:
        f["model_file"] = model_file(src, f["model"])
    log = du_log(src, cfg)
    kpis = {}
    for mb in (4, 16, 64) if log else ():
        if kpis := parse_metrics(tail(log, mb << 20)):
            break
    if "bsr_ml" in cfg:
        timer = ((cfg.get("cell_cfg") or {}).get("mac_cell_group") or {}).get("bsr_cfg", {}).get("periodic_bsr_timer")
        kpis["bsr_timer_ms"] = timer
    age = None
    if log and log.exists():
        age = round(time.time() - log.stat().st_mtime, 1)
    ds = datasets(src, var_dir, stack, [f["feature"] for f in feats])
    return {"stack": stack, "features": feats, "kpis": kpis, "log": str(log) if log else None, "log_age_s": age,
            "metrics_enabled": _on(cfg, "metrics", "enable_log") or _on(cfg, "metrics", "layers"),
            "datasets": {"files": len(ds), "rows": sum(d["rows"] for d in ds)}}


if __name__ == "__main__":
    line = ("2026-10-11T08:15:23.414006 [METRICS ] Scheduler cell pci=1 metrics: total_dl_brate= 1.5Mbps "
            "total_ul_brate= 820kbps nof_prbs=51 failed_uci=0 nof_ues=1 msg3_ok=1\n"
            "2026-10-11T08:15:23.414100 [METRICS ] Scheduler UE ue=0 pci=1 rnti=0x4601 metrics: cqi=15 dl_mcs=27 "
            "ul_mcs=20 dl_error_rate=0% ul_error_rate=2% pusch_snr_db=31.5 bsr=1200\n")
    k = parse_metrics(line)
    assert k["dl_bps"] == 1.5e6 and k["ul_bps"] == 820e3 and k["ues"] == 1, k
    assert k["per_ue"][0]["cqi"] == "15" and k["per_ue"][0]["ul_bler"] == "2%", k
    s = feature_state("bsr_ml", {"dataset_logging": {"enabled": True}, "inference": {"enabled": False}})
    assert s["mode"] == "collect" and s["model"] == FEATURES["bsr_ml"]["model"], s
    print("ok")
