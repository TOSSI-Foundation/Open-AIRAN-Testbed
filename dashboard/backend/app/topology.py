from __future__ import annotations

COLS = ["core", "cu", "l2", "bridge", "l1", "radio", "ue"]


def _transport(stack: str, env: dict) -> str:
    cm, needs = env.get("CMAKE_OPTS", ""), env.get("NEEDS", "").split()
    if "ENABLE_RFSIM" in cm or "rfsim" in stack:
        return "rfsim TCP"
    if "sionna" in env.get("COMPONENTS", "").split():
        return "ZMQ IQ · Sionna channel"
    if "zmq" in needs or "ZEROMQ" in cm or "ZMQ" in env.get("UE_BUILD_ARGS", ""):
        return "ZMQ IQ"
    return "ZMQ IQ"


def _fapi(mode: str, side: str) -> str:
    l1, l2 = (mode.split("_") + ["", ""])[:2]
    peer = l1 if side == "l1" else l2
    return {"ocudu": "FAPI · xSM shm", "oai": "nFAPI P5/P7", "aerial": "FAPI · nvIPC"}.get(peer, "FAPI")


def build(stack: str, env: dict) -> dict:
    run = env.get("START_ORDER", "").split()
    needs = set(env.get("NEEDS", "").split())
    app = env.get("OCUDU_APP", "gnb") or "gnb"
    nodes: list[dict] = []
    edges: list[dict] = []

    def node(id, label, kind, col=None, comp=None, under=None, **meta):
        if comp:
            h = env.get("HOST_" + comp.upper().replace("-", "_"), "")
            meta["host"] = h if h not in ("", "local", "localhost") else None
        nodes.append({"id": id, "label": label, "kind": kind, "col": col, "under": under,
                      "component": comp, "external": comp is None,
                      "meta": {k: v for k, v in meta.items() if v not in (None, "", [])}})

    def edge(a, b, label, both=True, dashed=False):
        edges.append({"from": a, "to": b, "label": label, "both": both, "dashed": dashed})

    def has(c):
        return c in run

    branch = env.get("OCUDU_BRANCH")
    if has("core5g"):
        kind = env.get("CORE") or "oai-cn5g"
        node("core", {"oai-cn5g": "OAI CN5G", "sd-core": "SD-Core", "external": "External core"}.get(kind, "5G Core"),
             "core", "core", "core5g", nfs="AMF · SMF · UPF", compose=kind)

    l2 = l1 = None
    if has("ocudu-cu"):
        node("cu", "OCUDU CU", "cu", "cu", "ocudu-cu", binary="ocu", repo=f"OCUDU-RAN · {branch}",
             config=env.get("CU_CFG"))
    if has("ocudu"):
        split = "xfapi" in run or has("ocudu-low")
        if app == "gnb":
            node("gnb", "OCUDU gNB", "gnb", "l2", "ocudu", binary="gnb", repo=f"OCUDU-RAN · {branch}",
                 config=env.get("OCUDU_CFG"), targets=env.get("OCUDU_TARGETS"))
            l2 = "gnb"
        else:
            label = "OCUDU DU-high (L2)" if split else "OCUDU DU"
            node("du", label, "du", "l2", "ocudu", binary=app, split=env.get("OCUDU_APP_DIR") or "dynamic",
                 repo=f"OCUDU-RAN · {branch}", config=env.get("OCUDU_CFG"), targets=env.get("OCUDU_TARGETS"))
            l2 = "du"
    if has("ocudu-low"):
        node("l1", "OCUDU DU-low (L1)", "l1", "l1", "ocudu-low", binary="odu_low", config=env.get("OCUDU_LOW_CFG"))
        l1 = "l1"
    if has("oai-gnb"):
        node("l1", "OAI L1 (nFAPI PNF)", "l1", "l1", "oai-gnb", repo=f"OAI-RAN · {env.get('OAI_BRANCH')}",
             config=env.get("GNB_CFG"), args=env.get("OAI_GNB_ARGS"))
        l1 = "l1"
    if has("aerial"):
        node("aerial", "NVIDIA Aerial L1", "gpu", "l1", "aerial", engine="cuBB", config=env.get("AERIAL_CFG"))
        l1 = "aerial"
    if has("xfapi"):
        mode = env.get("XFAPI_MODE", "")
        node("xfapi", "xFAPI bridge", "bridge", "bridge", "xfapi", mode=mode, config=env.get("XFAPI_CFG"))
        if l2:
            edge(l2, "xfapi", _fapi(mode, "l2"))
        if l1:
            edge("xfapi", l1, _fapi(mode, "l1"))

    if "cu" in [n["id"] for n in nodes]:
        if has("core5g"):
            edge("cu", "core", "N2 · N3")
        if l2:
            edge(l2, "cu", "F1-C · F1-U")
    elif l2 and has("core5g"):
        edge(l2, "core", "N2 · N3")

    phy = l1 or l2
    ue = None
    if has("oai-nrue"):
        node("ue", "OAI nrUE", "ue", "ue", "oai-nrue", repo=f"OAI-RAN · {env.get('OAI_BRANCH')}",
             config=env.get("UE_CFG"))
        ue = "ue"
    if has("nue"):
        node("ue", "OAI nrUE (multi_ue_sim)", "ue", "ue", "nue", count=env.get("NUM_UES") or "1",
             via="zmq_proxy.py, one netns per UE", repo=f"OAI-RAN · {env.get('OAI_BRANCH')}")
        ue = "ue"
    if has("rfsim-ue"):
        node("ue", f"OAI nrUE ×{env.get('NUM_UES') or 2}", "ues", "ue", "rfsim-ue",
             harness="rfsim_multi_ue.sh", bandwidth=f"{env.get('RFSIM_BW') or 40} MHz",
             repo=f"OAI-RAN · {env.get('OAI_BRANCH')}")
        ue = "ue"
    if has("ue-sim"):
        node("ue", "OAI nrUEs (ue-sim dashboard)", "ues", "ue", "ue-sim", count=env.get("NUM_UES"))
        ue = "ue"

    if phy:
        if "nic" in needs and "ptp" in needs:
            node("ru", "O-RU", "ru", "radio", fronthaul="Open Fronthaul 7.2 (eCPRI)", interface=env.get("FH_IF"))
            node("handset", "UE (handset)", "phone", "ue", over="NR air interface")
            edge(phy, "ru", "OFH 7.2 · eCPRI")
            edge("ru", "handset", "NR air")
            if has("ptp"):
                node("ptp", "PTP grandmaster", "clock", None, "ptp", under="ru",
                     profile=env.get("PTP_PROFILE"), interface=env.get("FH_IF"))
                edge("ptp", "ru", "PTP sync", both=False, dashed=True)
        elif "usrp" in needs or "uhd" in needs:
            node("usrp", f"USRP {env.get('USRP_TYPE') or ''}".strip(), "sdr", "radio", driver="UHD")
            node("handset", "UE (handset)", "phone", "ue", over="NR air interface")
            edge(phy, "usrp", "UHD · 10GbE")
            edge("usrp", "handset", "NR air")
        else:
            radio = _transport(stack, env)
            if ue:
                edge(phy, ue, radio)
            else:
                node("ue", "UE (not started)", "phone", "ue", note="these stacks need a real UE")
                edge(phy, "ue", radio, dashed=True)

    if phy and "gpu" in needs and not has("aerial"):
        what = "GPUDirect · PRACH/SRS" if "inline" in stack else "CUDA · PRACH DFT"
        node("gpu", "NVIDIA GPU", "gpu", None, under=phy, offload=what)
        edge(phy, "gpu", what)
    if phy and "bbdev" in needs:
        node("acc", "Intel ACC100", "chip", None, under=phy, offload="LDPC encode/decode", api="DPDK bbdev")
        edge(phy, "acc", "bbdev · LDPC")

    if stack.startswith("ocudu-xnap") and l2:
        me = env.get("GNB_ID") or "1"
        peer = "2" if me == "1" else "1"
        nodes[[n["id"] for n in nodes].index(l2)]["label"] = f"OCUDU gNB{me} (this host)"
        node("peer", f"OCUDU gNB{peer} (peer server)", "gnb", None, under=l2, runs="GNB_ID=" + peer)
        edge(l2, "peer", "Xn-C · XnAP")
        edge("peer", "core", "N2 · N3")

    if has("sionna") and phy:
        node("sionna", "Sionna RT publisher", "raytrace", None, "sionna", under=phy,
             script=env.get("SIONNA_PUB"), channel="ray-traced CIR taps")
        edge("sionna", phy, "CIR taps · ZMQ PUB", both=False, dashed=True)
    if has("dataset") and ue:
        node("dataset", "Dataset collector", "dataset", None, "dataset", under=ue,
             output="var/datasets/<stack>/")
        edge("dataset", ue, "uplink traffic", both=False, dashed=True)

    for i, c in enumerate(run):
        for n in nodes:
            if n["component"] == c:
                n["meta"]["start"] = f"{i + 1} of {len(run)}"
    return {"stack": stack, "nodes": nodes, "edges": edges, "cols": COLS}


if __name__ == "__main__":
    t = build("x", {"START_ORDER": "core5g ocudu-cu ocudu", "OCUDU_APP": "odu", "NEEDS": "zmq"})
    assert {(e["from"], e["to"]) for e in t["edges"]} == {("cu", "core"), ("du", "cu"), ("du", "ue")}, t["edges"]
    print("ok")
