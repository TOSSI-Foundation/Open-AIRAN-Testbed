# Map → Sionna RT integration plan

*How the `sionna-map` module becomes a scene generator for Sionna RT, so any city/area
can play the role Munich plays today — with editable/importable buildings, and gNB / RAN
tower / UE placement feeding your existing ray-traced-channel pipeline.*

Status: **working end-to-end (M0–M6).** The front-end module produces a Scene Package; the
Python scene-builder turns it into a Sionna/Mitsuba scene; Sionna ray-traces it and streams CIR
to the O-DU — and the whole chain is now driven from the TOSSI web app without a terminal.
Validated on Sionna RT 2.0.1 / Mitsuba 3.8.0 (see §7). The one step still to run is #5: a full
CU/DU/UE testbed decoding a map-generated channel.

---

## 0. What already exists (verified in this repo)

Your Sionna integration is already real and this plan slots into it — it does **not** replace it.

- `OCUDU-RAN/utils/sionna/live_channel.py` — loads a scene, places a `Transmitter` and a
  `Receiver`, runs a `PathSolver`, gets the CIR (`paths.cir(...)`) / taps
  (`paths.taps(bandwidth=…)`), and **streams channel updates over ZeroMQ** to the O-DU's
  `sionna` radio driver. Modes: `--route`, `--static`, `--sweep`.
- `render_route.py`, `export_cir.py` — same scene/solver pattern for rendering and CIR export.
- `OCUDU-RAN/configs/du_sionna_n78_40mhz.yaml` — O-DU consuming the channel:
  `ru_sdr.device_driver: sionna`, band n78, DL ARFCN 632628 (3489.42 MHz), 40 MHz, SCS 30.
- The Sionna API in use (Sionna RT 1.x/2.x):
  `load_scene`, `PlanarArray`, `Transmitter`, `Receiver`, `Camera`, `PathSolver`.
  Default scene is `sionna.rt.scene.munich`; **`live_channel.py` already accepts `--scene <xml>`
  and `--tx-position` / `--rx-*` in scene metres.**

**Key consequence:** the integration surface is tiny. We need to produce (a) a **custom scene XML**
to pass to `--scene`, and (b) **node positions in scene metres**. Both come straight from the
map module's Scene Manifest. No change to the RAN side is required for a first cut.

---

## 1. Target architecture

```
┌─────────────────────────────┐     scene_manifest.json      ┌──────────────────────────────┐
│  sionna-map (browser)       │ ───────────────────────────► │  scene_builder (Python)       │
│  • pick city / draw area    │   bbox, CRS origin, nodes,   │  • fetch Overture buildings    │
│  • place gNB / tower / UE    │   building edits, models     │    in bbox (DuckDB/overturemaps)│
│  • edit / import buildings   │                              │  • extrude → triangle meshes   │
│  • export manifest           │ ◄─────────────────────────── │  • apply edits + custom models │
└─────────────────────────────┘   coverage.png / radio_map    │  • assign ITU RadioMaterials   │
                                   (overlaid back on the map)  │  • write Mitsuba XML + .ply    │
                                                               └───────────────┬───────────────┘
                                                                               │ scene.xml
                                                                               ▼
                                                          ┌────────────────────────────────────┐
                                                          │  Sionna RT (existing utils/sionna)   │
                                                          │  load_scene(scene.xml)               │
                                                          │  add Transmitter(s)=gNB/tower @enu_m  │
                                                          │  add Receiver(s)=UE      @enu_m       │
                                                          │  PathSolver  → CIR/taps → ZMQ → O-DU  │
                                                          │  RadioMapSolver → coverage heatmap    │
                                                          └────────────────────────────────────┘
```

The manifest is the **single contract** between the map and Sionna. Everything the map knows
about a scenario is in it; the builder and the solver read only from it.

---

## 2. The Scene Manifest (contract)

Exported today by the module (RF Design tab → **Export manifest**). Schema v1:

```jsonc
{
  "version": 1,
  "city": "New Delhi",
  "crs": { "type": "ENU", "origin_lonlat": [77.229, 28.613], "axes": "x=East(m), y=North(m), z=Up(m)" },
  "bbox": { "min_lon":…, "min_lat":…, "max_lon":…, "max_lat":…, "size_m": [820, 610] },

  "buildings": {                       // how to fetch the base geometry
    "source": "overture", "release": "2026-07-22.0", "layer": "building",
    "height_field": "height", "base_field": "min_height",
    "height_fallback_m": 9, "default_material": "itu_concrete"
  },

  "building_edits": [                  // user corrections, applied after fetch
    { "overture_id": "08b…", "op": "set_height", "height_m": 45 },
    { "overture_id": "08b…", "op": "delete" },
    { "overture_id": "08b…", "op": "replace_with_model",
      "model": "models/mytower.glb", "anchor_lonlat": [77.23,28.61], "rotation_deg": 30, "scale": 1.0 }
  ],

  "custom_models": [                   // user-supplied geometry not tied to any OSM building
    { "id":"m1", "model":"models/gnb_mast.glb", "anchor_lonlat":[77.231,28.614],
      "height_offset_m":0, "rotation_deg":0, "scale":1, "material":"itu_metal" }
  ],

  "nodes": [                           // radios; enu_m is what Sionna consumes directly
    { "type":"gnb",  "name":"gNB-n1", "lonlat":[77.230,28.613], "height_agl_m":28, "on":"building",
      "enu_m":[12.4, -8.1, 28], "rf": { "band":78, "freq_hz":3.48942e9,
      "array":{"rows":1,"cols":4,"pattern":"tr38901","pol":"V"}, "tx_power_dbm":43, "azimuth_deg":0, "downtilt_deg":6 } },
    { "type":"tower","name":"Tower-n2", "lonlat":[…], "height_agl_m":30, "on":"ground", "enu_m":[…], "rf":{…} },
    { "type":"ue",   "name":"UE-n3", "lonlat":[…], "height_agl_m":1.5, "on":"ground", "enu_m":[…], "rf":null }
  ]
}
```

Notes that matter:
- **CRS.** Sionna/Mitsuba scenes are metric with x=East, y=North, z=Up. We anchor the origin at the
  **area centre** and convert every lon/lat with an equirectangular approximation (`src/geo.js`),
  sub-metre accurate over a city tile. `enu_m` is already in the solver's frame — no conversion in Python.
- **z / ground height.** v1 assumes flat ground (z=0). Terrain-aware z (adding a DEM sample under each
  node) is a later milestone; the field is already there.
- **rf block** is a placeholder default (n78, 3.489 GHz to match your DU config, 1×4 TR38901 array).
  Tune per deployment; UEs carry `rf:null` and use the scene's `rx_array`.

---

## 3. Geometry pipeline (Overture → Mitsuba/Sionna scene)

This is the one genuinely new piece of engineering. Two viable routes; **recommend Route A** for
automation (headless, reproducible, no GUI), with Route B as the manual/high-fidelity fallback.

### Route A — programmatic (recommended)
Mirror the community pattern (`manoj-kumar-joshi/sionna_osm_scene`, `OSM_to_Sionna.ipynb`), but source
from Overture instead of raw OSM for cleaner footprints + `num_floors`:

1. **Fetch** buildings in `bbox` — either
   - `overturemaps` CLI: `overturemaps download --bbox=… -f geojson --type=building`, or
   - DuckDB spatial query against the Overture GeoParquet/PMTiles (bbox filter).
2. **Height per building**: `height` → `num_floors × 3` → `height_fallback_m` (same rule as the map, so
   what you see is what you trace).
3. **Extrude** each footprint polygon to a solid (walls + roof) with `shapely` + `trimesh`
   (triangulate footprint, extrude to height, cap). Coordinates → ENU metres via the manifest origin.
4. **Apply `building_edits`**: `set_height` (re-extrude), `delete` (skip), `replace_with_model`
   (load the referenced mesh, place at anchor).
5. **Add `custom_models`**: load user OBJ/glTF/PLY, transform (anchor→ENU, rotation, scale), append.
6. **Materials**: map each mesh → an ITU `RadioMaterial` (§4). Write one `.ply` per material group
   (or per building) and reference them from a **Mitsuba XML**.
7. **Emit** `scene.xml` (+ `meshes/*.ply`). Optionally add a ground plane.

Libraries: `overturemaps`/`duckdb`, `shapely`, `trimesh`, `numpy`, `mitsuba`. All headless.

### Route B — Blender (manual, highest fidelity)
The official Sionna workflow: **Blender + Blender-OSM add-on** (import buildings for an area) +
**Mitsuba-Blender add-on** (export `scene.xml`). Best when you want to hand-fix geometry or import
detailed CAD. Slower, GUI-driven. Use for hero scenes; not for automation.

### Coordinate & sanity checks
- Validate against Munich: build a scene for the Frauenkirche bbox, compare footprint count and a few
  known heights to `sionna.rt.scene.munich`. Heights within a few metres = pipeline is sound.
- Keep the scene span modest (≤ ~1–2 km) — ray tracing cost and memory grow with geometry.

---

## 4. Radio materials

Sionna `RadioMaterial` = relative permittivity + conductivity + scattering params; ITU presets ship
built-in (`itu_concrete`, `itu_glass`, `itu_brick`, `itu_marble`, `itu_metal`, `itu_wood`, …). Mapping
(implemented as hints in `src/presets.js`, applied in the builder):

| Overture attribute | → RadioMaterial |
|---|---|
| `facade_material = glass` | `itu_glass` |
| `facade_material = brick` | `itu_brick` |
| `facade_material = stone` | `itu_marble` |
| `facade_material = metal` | `itu_metal` |
| `subtype = industrial` | `itu_metal` |
| *(none)* | `itu_concrete` (default) |

Known gotcha (Sionna #850): when loading a scene of custom `.ply` meshes, assign materials **after**
`load_scene` via `scene.objects[...]` / `set_material` if the XML material binding trips up; the
`holder-material` is auto-added by `process_xml()` — don't hand-write it.

---

## 5. Placing radios (gNB / tower / UE) — already supported downstream

The manifest's `enu_m` is exactly what your code already takes. A thin adapter reuses `live_channel.py`:

```python
scene = load_scene(manifest_scene_xml)                       # our generated scene
scene.tx_array = PlanarArray(num_rows=1, num_cols=4, pattern="tr38901", polarization="V")
scene.rx_array = PlanarArray(num_rows=1, num_cols=1, pattern="iso", polarization="V")
for n in manifest["nodes"]:
    if n["type"] in ("gnb", "tower"):
        scene.add(Transmitter(name=n["name"], position=n["enu_m"]))   # + orientation from azimuth/downtilt
    else:
        scene.add(Receiver(name=n["name"], position=n["enu_m"]))
paths  = PathSolver()(scene, max_depth=5)
taps   = paths.taps(bandwidth=srate, l_min=0, l_max=num_taps-1)        # → ZMQ → O-DU (unchanged)
```

- **gNB vs tower**: both become `Transmitter`s; difference is placement defaults (roof-mounted vs
  freestanding mast) and, later, antenna pattern/height. Orientation comes from `rf.azimuth_deg` /
  `rf.downtilt_deg`.
- **UE**: a `Receiver`; multiple UEs → multiple receivers or a route (reuse `--route`).
- **Coverage map**: instantiate `RadioMapSolver(cell_size=…, samples_per_tx=…, max_depth=…)` per TX to
  render a coverage heatmap; export as a georeferenced PNG and overlay it back on the map (close the loop).

---

## 6. Editable & user-supplied buildings (your explicit requirement)

Fully specified in the manifest; front-end already captures it (RF Design → **Edit / replace building**):

1. **Height wrong** → `set_height` edit; builder re-extrudes that footprint to the corrected height.
2. **Footprint junk / missing** → `delete` edit (remove) and/or a `custom_models` entry to add your own.
3. **Replace with your own model** → `replace_with_model`: builder deletes the OSM box and loads your
   `models/…glb|obj|ply` at the building's anchor (rotation/scale honoured).
4. **Drop a standalone model** (a mast, a stadium, a factory) → `custom_models` entry, georeferenced by
   `anchor_lonlat`, with its own material.

Where user models live: a `scene_builder/models/` folder; the manifest references them by relative path.
(A later milestone adds browser upload → server storage so users never touch the filesystem.)

---

## 7. Milestones

| # | Deliverable | Status |
|---|---|---|
| **M0** | Map module + manifest/package export (`sionna-map/`) | ✅ done |
| **M1** | `build_scene.py`: package → extrude buildings → `scene.xml` + `.ply` in Sionna's format | ✅ done & validated |
| **M2** | `run_scene.py` + `live_channel.py --scene` with manifest `enu_m`; CIR → ZMQ → O-DU | ✅ done & validated |
| **#1–3** | Correct carrier (`scene.frequency`), gNB array/power/orientation, srate+delay-spread taps | ✅ done & validated |
| **#4** | `orchestrate.py`: Scene Package + DU YAML → one command launching `live_channel.py` | ✅ done & validated |
| **#6** | Footprint pruning (`--min-area`) | ✅ done & validated |
| **M3 / #9** | Custom mesh import (`.ply/.obj/.glb`) — replacements + standalone models | ✅ done & validated |
| **M4 / #10** | `coverage.py` (RadioMapSolver) → overlay JSON → **Load coverage** on the map | ✅ done & validated |
| **#7** | Overture GeoParquet fetch in the builder (`--fetch-overture`) | ⚠️ implemented (network-heavy/slow; optional) |
| **M5 / #11** | Terrain-aware ground (`--terrain`, terrarium DEM) | ✅ implemented (DEM sampler validated; needs network) |
| **#8** | UE mobility route tool (module) → `route_enu` → `live_channel --route` | ✅ done (frontend; syntax-checked) |
| **M6 / #12** | **TOSSI integration**: the whole pipeline driven from the web app — build, trace, coverage, live streaming, scene registry | ✅ done & browser-tested |
| **#5** | Full CU/DU/UE testbed decoding the channel | ⏳ **your run** (procedure below) |

### M6 — driven from TOSSI (no terminal)

The `dashboard/` app embeds this module and runs every stage server-side in the Sionna env,
as serialized jobs with streamed logs (`dashboard/backend/app/sionna_bridge.py`):

| Stage | Script | TOSSI endpoint |
|---|---|---|
| Build | `build_scene.py` | `POST /api/map/build` |
| Ray trace | `run_scene.py --json` | `POST /api/map/trace` |
| Coverage | `coverage.py` | `POST /api/map/coverage` |
| Live channel | `live_channel.py` | `POST /api/map/live/start` · `/stop` · `GET /live/status` |

Built scenes are kept under `dashboard/backend/work/<scene_id>/` with their package, metadata
and coverage, so they survive a restart and can be reopened onto the map.

**Tap budget is capped at 64.** The O-DU rejects any channel update declaring more taps —
it discards every update rather than degrading, so the RAN silently keeps its old channel.
`rf.taps_info()` reports what the scene's delay spread actually wanted and whether it was
clamped; `run_scene.py`, `orchestrate.py`, `live_channel.py` and the TOSSI UI all surface
it. At 61.44 Msps, 64 taps covers ~312 m of path length: scenes with a diagonal beyond
~124 m have their longest echoes truncated. Keep the area small for full fidelity.

**M1+M2 validated on Sionna RT 2.0.1 / Mitsuba 3.8.0** (in `~/sionna-rt-env`): the example
package builds 9 buildings + ground into a Munich-format scene, `load_scene` accepts it, and
ray tracing finds ~29 paths at ~−100 dB; `live_channel.py` then streams CIR taps over ZMQ. So
"any city area → live RAN channel" works today.

### How to run (validated commands)

```bash
source ~/sionna-rt-env/bin/activate
pip install -r sionna-map/scene_builder/requirements.txt        # shapely, trimesh, mapbox_earcut

# 1) In the browser module: pick area → place gNB/UE → Export "Scene package"
#    (or use the bundled example: scene_builder/examples/munich_test_package.json)

# 2) M1 — build the Sionna scene
python sionna-map/scene_builder/build_scene.py \
    sionna-map/scene_builder/examples/munich_test_package.json \
    --out scenes/munich_test --build
#    -> scenes/munich_test/scene.xml (+ meshes/*.ply)

# 3) M2 — validate ray tracing + get the streaming command
python sionna-map/scene_builder/run_scene.py \
    sionna-map/scene_builder/examples/munich_test_package.json \
    --scene scenes/munich_test/scene.xml

# 4) Stream the channel into a running O-DU (uses your existing driver)
python OCUDU-RAN/utils/sionna/live_channel.py \
    --scene scenes/munich_test/scene.xml \
    --tx-position 30 -45 58 --rx-start 0 0 1.5 --static
```

### #5 — full-stack decode (the one step to run on your testbed)
Everything above is validated up to the ZMQ publish. To confirm the RAN actually decodes a
map-generated channel:
1. Start the CU/DU as usual (`du_sionna_n78_40mhz.yaml`, `device_driver: sionna`, `live=tcp://127.0.0.1:5566`).
2. In another shell: `python scene_builder/orchestrate.py <package.json> --du-config <du.yaml> --launch`.
3. Attach a UE (nr-ue / RFsim UE) and confirm sync → RRC attach → throughput responds when you
   move the UE (`--mode route`) or edit the scene. That closes the loop end-to-end.

Each milestone is independently demoable; the pipeline already gives "any city → live RAN channel."

---

## 8. Risks / honest limits

- **Height data.** Overture heights are good in dense cores, sparse elsewhere (esp. India). The fallback
  keeps geometry plausible but not accurate — this is exactly why the edit/import feature exists. For
  ground-truth 3D, the upgrade path is local LiDAR/CityGML (e.g. Netherlands 3D BAG, Japan PLATEAU) or
  paid photoreal tiles; those can feed the same builder as meshes.
- **Ray-tracing cost.** Scales with geometry + `max_depth` + samples. Keep tiles ≤ ~1–2 km; prune tiny
  buildings; cache the built scene.
- **Material realism.** ITU presets are approximations; per-building facade data is thin. Fine for
  system-level studies, not for calibrated EM.
- **Scene units / origin.** Every consumer must use the manifest's ENU origin. The builder stamps it into
  the scene; don't mix scenes with different origins.
- **Version pinning.** Sionna RT API moved between 0.x and 1.x/2.x (e.g. `PathSolver`, `RadioMapSolver`).
  Build against the version already in your `sionna-rt-env`; the plan uses the 1.x/2.x names your code uses.

---

## 9. Sources
- Sionna RT — Introduction & scene API: https://nvlabs.github.io/sionna/rt/tutorials/Introduction.html · https://nvlabs.github.io/sionna/rt/api/scene.html
- Custom scene (XML, no Blender): https://github.com/NVlabs/sionna/discussions/942
- Scene creation with Blender + OpenStreetMap (video/discussion): https://github.com/NVlabs/sionna/discussions/386
- OSM → Sionna programmatic pipeline: https://github.com/manoj-kumar-joshi/sionna_osm_scene
- Custom PLY material handling (gotcha): https://github.com/NVlabs/sionna/issues/850
- Overture buildings guide + hosted PMTiles: https://docs.overturemaps.org/guides/buildings/ · https://docs.overturemaps.org/examples/overture-tiles/
