# sionna-map — Open AI-RAN Testbed

A reusable 3D city-map module (MapLibre GL JS + Overture Maps buildings, free / no API key)
with **RF-design tools** that turn a map area into a **Sionna RT scene manifest**: select an
area, drop gNB / RAN-tower / UE nodes on buildings or ground, edit or replace buildings, and
export a manifest the Python scene-builder turns into a Mitsuba/Sionna scene.

See **[SIONNA_INTEGRATION_PLAN.md](SIONNA_INTEGRATION_PLAN.md)** for the full Sionna pipeline.

## Run

**Standalone:**

```bash
python3 -m http.server 8779 --bind 0.0.0.0 --directory sionna-map
# then open http://<host>:8779/index.html      (or ?city=virginia_tech | munich | delhi | dubai | nyc)
```
No build step, no npm, no keys. Needs internet (map tiles + libraries from CDN).

**Inside the testbed (recommended):** the dashboard embeds this module in its **Scenario Builder**
and **Simulation** pages and drives the whole Python pipeline for you — build, ray trace, coverage
and live channel streaming, with a scene library and job console, no terminal needed:

```bash
make dashboard     # http://<host>:8000  → Scenario Builder
```

Embedded, the module opens on the **RF Design** tab and talks to the host over `postMessage`
(same origin only): it announces readiness, mirrors the design state so the host's controls
enable in step, hands over the Scene Package on request, and paints coverage overlays and
reopened scenes the host pushes back. Standalone behaviour is unchanged.

## Layout

```
sionna-map/
  index.html            # shell + styling; loads the scripts below in order
  src/
    presets.js          # cities (incl. Munich = Sionna reference, Virginia Tech site), data sources, materials
    geo.js              # lon/lat <-> local ENU metres, bbox math
    mapcore.js          # the map engine: Overture buildings, site models, sun, terrain, sky, search, fly-to
    sionna.js           # RF tools: area select, node placement (up to 2 gNBs), building edits, manifest export
    meshlayer.js        # uploaded building models drawn as meshes
    sitemesh.js         # a site's detailed building meshes in place of extrusions
    treelayer.js        # site tree inventory drawn in 3D
    arc3d.js            # radio links drawn as arcs above the ground
    main.js             # wires city switch + UI + tools together
  scene_builder/        # Python side: Scene Package -> Sionna/Mitsuba scene  [validated]
    build_scene.py      #   buildings -> extruded PLY + scene.xml; pruning; custom-mesh import; --terrain; --fetch-overture
    run_scene.py        #   load in Sionna at the right carrier + gNB array/power/orientation; ray-trace
    orchestrate.py      #   ONE command: Scene Package + DU YAML -> launch live_channel.py wired correctly
    coverage.py         #   RadioMapSolver coverage -> overlay JSON for the map
    rf.py               #   shared: NR-ARFCN->Hz, orientation, delay-spread taps
    overture_fetch.py   #   optional Overture GeoParquet fetch (duckdb)
    terrain.py          #   optional terrarium DEM sampler / ground mesh
    vegetation.py       #   site trees as foliage + wood for the ray tracer
    radiomap.py, linkkpi.py, cellmix.py, batching.py   # coverage, link KPIs, multi-cell, batched traces
    channel_export.py, bundle.py, doppler.py, enrich.py # .npz export, reproducible bundles, Doppler, run enrichment
    realsite/           #   builds a measured site model (Virginia Tech): footprints, LiDAR, trees, LoD2 meshes
    requirements.txt    #   shapely, trimesh, mapbox_earcut (+ duckdb for --fetch-overture)
    examples/           #   munich_test_package.json (validated end-to-end)
  SIONNA_INTEGRATION_PLAN.md
```

## One-command run (recommended)
```bash
source ~/sionna-rt-env/bin/activate
python sionna-map/scene_builder/orchestrate.py <scene_package.json> \
    --du-config OCUDU-RAN/configs/du_sionna_n78_40mhz.yaml --launch
```
It builds the scene, reads the carrier/srate/taps/ZMQ-port from the manifest + DU YAML, and
launches `live_channel.py`. Drop `--launch` for a dry run that prints the exact command.

### Coverage map
```bash
python sionna-map/scene_builder/coverage.py <scene_package.json> \
    --scene scenes/mine/scene.xml --out coverage_mine.json
# then in the module: RF Design -> "Load coverage overlay" -> pick coverage_mine.json
```

## Map → Sionna pipeline (validated, M1+M2)
The **Scene package** you export (RF Design → Export) becomes a real Sionna scene:
```bash
source ~/sionna-rt-env/bin/activate
pip install -r sionna-map/scene_builder/requirements.txt
python sionna-map/scene_builder/build_scene.py <scene_package.json> --out scenes/mine --build
python sionna-map/scene_builder/run_scene.py   <scene_package.json> --scene scenes/mine/scene.xml
```
Validated on Sionna RT 2.0.1 / Mitsuba 3.8.0: the scene loads, ray tracing runs, and
`OCUDU-RAN/utils/sionna/live_channel.py --scene scenes/mine/scene.xml …` streams CIR to the O-DU.
See [SIONNA_INTEGRATION_PLAN.md](SIONNA_INTEGRATION_PLAN.md) §7 for the full commands.

## Cities — any place in the world, plus curated quick-jumps
Type any city, address or landmark into the search box top-left — it flies there in 3D
and buildings load from Overture exactly as for a preset; there is no fixed list to add
to. Nothing is pre-registered for a searched place: `SM.cityFromPlace()` builds its
camera position, zoom and a generic building-height fallback straight from the geocoder
result, and local address search (top right) derives its own search area from whatever
the map is currently showing rather than a per-city bounding box.

Curated places stay pinned at the top of that same box as **quick jumps** — `virginia_tech`
(a measured site model: surveyed footprints with LiDAR heights and the campus tree inventory),
`munich` (Sionna's own reference scene), `delhi`, `mumbai`, `bengaluru`, `hyderabad`, `chennai`,
`kolkata`, `dubai`, `nyc` — each with curated landmark cards the Explore tab can fly to, which a
freshly searched place won't have yet. A place with a measured site model opens on it however it
is reached, instead of Overture. Reachable directly via `?city=`; add more in `src/presets.js`
(`SM.CITIES`). Picking a place (preset or searched) never reloads the page — the URL
updates in place (`?city=key` for a preset, `?place=lon,lat,zoom&label=…` for a search
result) so reloading or sharing the link lands in the same spot without a fresh geocode.

## RF Design tab (the Sionna-facing part)
1. **Select area** — drag a rectangle; its size in metres/km² is shown. This is the scene extent.
2. **Place nodes** — click to drop a **gNB / Tower / UE**. On a building → mounted at roof height;
   empty ground → pole/handset height. Drag markers to move; edit heights in the list.
3. **Buildings** — toggle **Edit** and click a building to **override its height** or **delete** it;
   or **Add buildings (GeoJSON)** to import your own footprints (with a `height` property) — shown
   extruded in teal and included in the export. This is the "fix/replace a wrong building" workflow.
4. **Export for Sionna** —
   - **Scene package** → `scene_package_<city>.json` = the manifest **plus** the selected area's
     buildings as GeoJSON (heights resolved, your edits applied, added buildings included). One file,
     everything the scene builder needs — no separate Overture fetch required.
   - **Manifest only** → `scene_manifest_<city>.json` (nodes + edits + bbox, no geometry).
   - **Buildings GeoJSON** → just the area's building footprints.
   - **Import manifest** reloads a saved manifest.

   *Building extraction reads the loaded vector tiles, so zoom to the area first; footprints may be
   tile-clipped. For pixel-exact/complete geometry the Python builder can still re-fetch from Overture
   GeoParquet — the in-browser export always carries your edits and added buildings.*

## Non-RF features
Overture 3D buildings colored by height, time-of-day sun slider, terrain + sky toggles,
address search (OpenStreetMap Nominatim), geolocation, landmark fly-tos, 2D/3D toggle.

## Attribution
Buildings © Overture Maps · basemap © OpenFreeMap · © OpenStreetMap contributors.
