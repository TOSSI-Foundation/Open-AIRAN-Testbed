import json
import sys
import time
import urllib.error
import urllib.request

BASE = "http://localhost:8000"
SCENE = "20260807-064734-f09c51"
RUN = "20260819-064141-fda64d"

results = []


def get(path, timeout=180):
    req = urllib.request.Request(BASE + path)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
        return r.status, body


def delete(path, timeout=60):
    req = urllib.request.Request(BASE + path, method="DELETE")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()


def post(path, payload=None, timeout=600):
    data = json.dumps(payload or {}).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()


def await_job(job_id, tries=180):
    for _ in range(tries):
        s, b = get(f"/api/map/jobs/{job_id}")
        d = json.loads(b)
        if d.get("state") in ("done", "error"):
            return d
        time.sleep(2)
    return {"state": "timeout"}


def check(phase, name, fn):
    t0 = time.time()
    try:
        ok, detail = fn()
    except urllib.error.HTTPError as e:
        ok, detail = False, f"HTTP {e.code}"
    except Exception as e:                                    # noqa: BLE001
        ok, detail = False, f"{type(e).__name__}: {str(e)[:70]}"
    results.append((phase, name, ok, detail, time.time() - t0))
    print(f"  [{'ok ' if ok else 'FAIL'}] {phase:<9} {name:<38} {detail}", flush=True)


def p1_export():
    s, b = post(f"/api/channel/scenes/{SCENE}/export", {"num_taps": 32, "scratch": True})
    d = await_job(json.loads(b)["job_id"])
    if d.get("state") != "done":
        return False, f"job {d.get('state')}: {str(d.get('error'))[:60]}"
    r = d.get("result") or {}
    arrays = r.get("arrays") or list((r.get("shapes") or {}))
    if arrays:
        _delete_export(r.get("name"))
    return bool(arrays), f"{r.get('name') or ''} arrays={arrays}"


def _delete_export(name):
    if not name:
        return
    try:
        delete(f"/api/channel/exports/{name}")
    except Exception:
        pass


def p1_linkkpi():
    s, b = post(f"/api/channel/scenes/{SCENE}/linkkpi", {})
    d = await_job(json.loads(b)["job_id"])
    if d.get("state") != "done":
        return False, f"job {d.get('state')}: {str(d.get('error'))[:60]}"
    r = d.get("result") or {}
    kpis = r.get("kpis") or []
    if not kpis:
        return False, "no per-link KPIs"
    k = kpis[0]
    th = k.get("throughput_mbps") or {}
    return len(kpis) > 0 and len(th) > 1,         f"{len(kpis)} link(s), rank {k.get('effective_rank')}, mrt {th.get('mrt', 0):.0f} vs uniform {th.get('uniform_beam', 0):.0f} Mbps"


def p1_bundle():
    s, b = post(f"/api/channel/scenes/{SCENE}/bundle", {})
    d = json.loads(b)
    if d.get("job_id"):
        d = await_job(d["job_id"])
        if d.get("state") != "done":
            return False, f"job {d.get('state')}"
        d = d.get("result") or {}
    return bool(d.get("name") or d.get("bytes")), f"{d.get('name')} {d.get('bytes') or ''} bytes"


def p1_provenance():
    s, b = get(f"/api/provenance/scenes/{SCENE}")
    d = json.loads(b)
    fp = d.get("fingerprint") or {}
    sha = fp.get("geometry_sha256") or fp.get("sha256")
    return bool(sha) and d.get("matches") is not False, \
        f"sha {str(sha)[:10]} sealed={d.get('sealed')} matches={d.get('matches')}"


def p2_calibration():
    s, b = get(f"/api/recordings/{RUN}/calibration?plot=false")
    d = json.loads(b)
    best = None
    for c in d.get("comparisons", []):
        f = c.get("aligned_fit") or c.get("fit") or {}
        if f.get("r2") is not None and (best is None or f["r2"] > best[1]):
            best = (c["label"], f["r2"], f.get("slope"), f.get("n"))
    if not best:
        return False, "no usable comparison"
    return best[1] > 0.9, f"{best[0]}: r2={best[1]:.3f} slope={best[2]:.3f} n={best[3]}"


def p2_dataset():
    s, b = get(f"/api/recordings/{RUN}/dataset?fmt=json")
    d = json.loads(b)
    n = d.get("rows") or 0
    data = d.get("data") or []
    schema = d.get("schema") or {}
    return n > 0 and len(data) == n, \
        f"{n} rows, {len(schema.get('columns') or schema)} cols, lag {d.get('lag_s')}s"


def p2_policy():
    s, b = get(f"/api/recordings/{RUN}/policy?policy=seek_coverage")
    d = json.loads(b)
    track = d.get("track") or []
    cmp_ = d.get("compared_to_patrol") or {}
    return len(track) > 0, f"{len(track)} steps, same_as_patrol={cmp_.get('same_as_patrol')}"


def p2_enrich():
    s, b = post(f"/api/recordings/{RUN}/enrich")
    d = json.loads(b)
    r = d.get("result") or {}
    batched = any("batched" in ln for ln in (d.get("log") or []))
    return d.get("state") == "done" and r.get("distinct", 0) > 0, \
        f"{r.get('distinct')} positions in {d.get('elapsed_s')}s, batched={batched}"


def p3_stability():
    s, b = get(f"/api/recordings/{RUN}/stability")
    d = json.loads(b)
    return d.get("ok") and d.get("dropped") is not None, \
        f"dropped={d.get('dropped')}, {len(d.get('findings') or [])} findings"


def p3_coverage():
    s, b = post("/api/map/coverage", {"scene_id": SCENE, "samples": 500000, "cell_size": 10})
    job = json.loads(b).get("job_id")
    for _ in range(120):
        s, b = get(f"/api/map/jobs/{job}")
        d = json.loads(b)
        if d.get("state") in ("done", "error"):
            break
        time.sleep(2)
    if d.get("state") != "done":
        return False, f"job {d.get('state')}: {str(d.get('error'))[:50]}"
    o = (d.get("result") or {}).get("overlay") or {}
    imgs = sorted(o.get("images") or {})
    c = o.get("contested") or {}
    return len(imgs) == 3, f"metrics {imgs}, contested {c.get('cells')}/{c.get('served')}"


def p4_report_json():
    s, b = get(f"/api/recordings/{RUN}/report?fmt=json")
    d = json.loads(b)
    head = d.get("headline") or ""
    return d.get("ok") and "r²" in head, head[:60]


def p4_report_html():
    s, b = get(f"/api/recordings/{RUN}/report")
    html = b.decode()
    bad = [x for x in ("<script", "src=", "http://", "https://") if x in html]
    return s == 200 and not bad, f"{len(html)} bytes, external refs: {bad or 'none'}"


def p4_recordings_list():
    s, b = get("/api/recordings?limit=100")
    d = json.loads(b)
    runs = d.get("runs") or []
    return len(runs) > 0, f"{len(runs)} runs listed"


CHECKS = [
    ("phase 1", "channel export (.npz)", p1_export),
    ("phase 1", "link KPIs", p1_linkkpi),
    ("phase 1", "standalone scene bundle", p1_bundle),
    ("phase 1", "scene provenance", p1_provenance),
    ("phase 2", "calibration vs real modem", p2_calibration),
    ("phase 2", "ML dataset export", p2_dataset),
    ("phase 2", "mobility policy replay", p2_policy),
    ("phase 2", "run enrichment (batched)", p2_enrich),
    ("phase 3", "drop diagnosis", p3_stability),
    ("phase 3", "radio map, 3 metrics", p3_coverage),
    ("phase 4", "run report (json)", p4_report_json),
    ("phase 4", "run report (html)", p4_report_html),
    ("phase 4", "recordings list", p4_recordings_list),
]

print("=" * 78)
for phase, name, fn in CHECKS:
    check(phase, name, fn)

print("=" * 78)
bad = [r for r in results if not r[2]]
print(f"  {len(results) - len(bad)}/{len(results)} passed")
for phase, name, ok, detail, _ in bad:
    print(f"    FAILED  {phase} {name}: {detail}")
sys.exit(1 if bad else 0)
