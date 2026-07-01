window.SM = window.SM || {};

SM.mapcore = (function () {
  function create(initialCity) {
    let city = initialCity;
    const home = initialCity.home;

    if (!SM._pmRegistered) {
      const p = new pmtiles.Protocol();
      maplibregl.addProtocol('pmtiles', p.tile);
      SM._pmRegistered = true;
    }

    const map = new maplibregl.Map({
      container: 'map',
      style: SM.BASE_STYLE,
      center: home.center, zoom: home.zoom, pitch: home.pitch, bearing: home.bearing,
      maxPitch: 80, antialias: true
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    const geolocate = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true }, trackUserLocation: true
    });
    map.addControl(geolocate, 'bottom-right');
    function scaleBar(maxWidth) {
      let el = null, raf = 0, m = null;
      const round = (x) => {
        const p = Math.pow(10, Math.floor(Math.log10(x))); const d = x / p;
        return p * (d >= 10 ? 10 : d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : d >= 1 ? 1 : d);
      };
      const update = () => {
        raf = 0;
        if (!m || !el) return;
        const mpp = 40075016.686 * Math.cos(m.getCenter().lat * Math.PI / 180) / (512 * Math.pow(2, m.getZoom()));
        const maxM = mpp * maxWidth;
        const km = maxM >= 1000, d = round(km ? maxM / 1000 : maxM);
        el.style.width = (maxWidth * (km ? d * 1000 : d) / maxM) + 'px';
        el.textContent = d + (km ? '\u00a0km' : '\u00a0m');
      };
      const onMove = () => { if (!raf) raf = requestAnimationFrame(update); };
      return {
        onAdd(mm) {
          m = mm; el = document.createElement('div');
          el.className = 'maplibregl-ctrl maplibregl-ctrl-scale';
          m.on('move', onMove); update();
          return el;
        },
        onRemove() { if (m) m.off('move', onMove); cancelAnimationFrame(raf); if (el) el.remove(); el = null; m = null; }
      };
    }
    map.addControl(scaleBar(90), 'bottom-left');

    function heightExpr() {
      return ['case',
        ['==', ['feature-state', 'removed'], true], 0,
        ['coalesce',
          ['feature-state', 'height'],
          ['case',
            ['has', 'height'], ['get', 'height'],
            ['has', 'num_floors'], ['*', ['get', 'num_floors'], SM.FLOOR_HEIGHT_M],
            city.heightFallbackM
          ]
        ]
      ];
    }

    const permEdits = {};
    const tempEdits = {};
    let onHeightOverride = null;
    const FEAT = (id) => ({ source: 'overture', sourceLayer: 'building', id: id });
    const REMOVED_LAYER = 'sm-removed-outline';

    function editOf(id) {
      return tempEdits[id] !== undefined ? tempEdits[id] : permEdits[id];
    }
    function editModeOf(id) {
      if (tempEdits[id] !== undefined) return 'session';
      if (permEdits[id] !== undefined) return 'permanent';
      return null;
    }
    function getBuildingEdits() {
      const out = {};
      Object.keys(permEdits).forEach((id) => { out[id] = permEdits[id]; });
      Object.keys(tempEdits).forEach((id) => { out[id] = tempEdits[id]; });
      return out;
    }
    function getBuildingHeights() {
      const all = getBuildingEdits(), out = {};
      Object.keys(all).forEach((id) => { if (all[id].op === 'set_height') out[id] = all[id].height_m; });
      return out;
    }

    function isGone(edit) {
      return !!edit && (edit.op === 'delete' || edit.op === 'replace_with_model'
        || edit.op === 'replace_with_building');
    }

    function paintEdit(id) {
      const e = editOf(id);
      try {
        if (e && e.op === 'set_height') {
          map.setFeatureState(FEAT(id), { height: e.height_m, removed: false, edited: true });
        } else if (isGone(e)) map.setFeatureState(FEAT(id), { removed: true, edited: false });
        else {
          map.removeFeatureState(FEAT(id), 'height');
          map.removeFeatureState(FEAT(id), 'removed');
          map.removeFeatureState(FEAT(id), 'edited');
        }
      } catch (err) {  }
    }

    function refreshRemovedOutline() {
      if (!map.getLayer(REMOVED_LAYER)) return;
      const all = getBuildingEdits();
      const ids = Object.keys(all).filter((id) => isGone(all[id]));
      map.setFilter(REMOVED_LAYER, ['in', ['get', 'id'], ['literal', ids]]);
    }

    function centroidOf(f) {
      const g = f && f.geometry;
      const ring = !g ? null
        : g.type === 'Polygon' ? g.coordinates[0]
        : g.type === 'MultiPolygon' ? (g.coordinates[0] || [])[0] : null;
      if (!ring || !ring.length) { const c = map.getCenter(); return [c.lng, c.lat]; }
      let x = 0, y = 0;
      ring.forEach((p) => { x += p[0]; y += p[1]; });
      return [SM.geo.round(x / ring.length, 6), SM.geo.round(y / ring.length, 6)];
    }

    function clampHeight(metres) {
      if (metres == null || !isFinite(Number(metres))) return null;
      return Math.max(0.5, Math.min(1000, Number(metres)));
    }

    function setBuildingEdit(id, edit, opts) {
      if (id == null || id === '') return null;
      opts = opts || {};
      const mode = opts.mode || 'session';
      let e = null;
      if (edit && edit.op === 'set_height') {
        const h = clampHeight(edit.height_m);
        e = h == null ? null : { op: 'set_height', height_m: h };
      } else if (edit && (edit.op === 'delete' || edit.op === 'replace_with_model'
                          || edit.op === 'replace_with_building')) {
        e = Object.assign({}, edit);
      }

      if (e == null) {
        delete tempEdits[id];
        const wasSaved = permEdits[id] !== undefined;
        delete permEdits[id];
        if (wasSaved && !opts.silent) SM.editStore.remove(id);
      } else if (mode === 'permanent') {
        delete tempEdits[id];
        permEdits[id] = e;
        if (!opts.silent) SM.editStore.save(id, e);
      } else {
        tempEdits[id] = e;
      }
      paintEdit(id);
      refreshRemovedOutline();
      if (!opts.silent && onHeightOverride) onHeightOverride(getBuildingEdits());
      return e;
    }

    function setBuildingHeight(id, metres, opts) {
      const h = clampHeight(metres);
      return setBuildingEdit(id, h == null ? null : { op: 'set_height', height_m: h }, opts);
    }

    function clearSessionEdit(id) {
      if (tempEdits[id] === undefined) return;
      delete tempEdits[id];
      paintEdit(id);
      refreshRemovedOutline();
      if (onHeightOverride) onHeightOverride(getBuildingEdits());
    }

    function clearBuildingHeights() {
      Object.keys(tempEdits).forEach((id) => { delete tempEdits[id]; paintEdit(id); });
      refreshRemovedOutline();
      if (onHeightOverride) onHeightOverride(getBuildingEdits());
    }

    async function loadSavedHeights() {
      let saved = {};
      try { saved = await SM.editStore.load(); } catch (e) { return 0; }
      let n = 0;
      Object.keys(saved || {}).forEach((id) => {
        const e = saved[id];
        if (!e || !e.op) return;
        if (e.op === 'set_height' && clampHeight(e.height_m) == null) return;
        permEdits[id] = e;
        paintEdit(id);
        n++;
      });
      refreshRemovedOutline();
      if (n && onHeightOverride) onHeightOverride(getBuildingEdits());
      return n;
    }

    const BUILDINGS_MINZOOM = 12;
    const BUILDINGS_FULL_HEIGHT_ZOOM = 14.5;
    function heightRampExpr() {
      return ['interpolate', ['linear'], ['zoom'],
        BUILDINGS_MINZOOM, 0, BUILDINGS_FULL_HEIGHT_ZOOM, heightExpr()];
    }

    let skyOn = true, terrainOn = SM.TERRAIN_ON !== false, onBuildingClick = null;

    const IMAGERY_SRC = 'sm-imagery', IMAGERY_LAYER = 'sm-imagery-layer';
    const DEM_SRC = 'terrain-dem', HILLSHADE_LAYER = 'sm-hillshade';
    let view = 'roadmap';
    let baseKind = null;
    let baseOrder = [];

    function classifyBase(l) {
      if (l['source-layer'] === 'building') return 'suppressed';
      if (l.type === 'background') return 'background';
      if (l.type === 'symbol') return 'label';
      if (l['source-layer'] === 'boundary') return 'boundary';
      if (l['source-layer'] === 'transportation' || l['source-layer'] === 'aeroway') {
        return l.type === 'fill' ? 'ground' : 'road';
      }
      return 'ground';
    }

    function captureBase() {
      if (baseKind) return;
      baseKind = {}; baseOrder = [];
      for (const l of (map.getStyle().layers || [])) {
        baseKind[l.id] = classifyBase(l);
        baseOrder.push(l.id);
      }
    }

    function setVis(id, on) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }

    function firstBase(pred) {
      for (const id of baseOrder) if (map.getLayer(id) && pred(baseKind[id])) return id;
      return undefined;
    }

    function ensureDemSource() {
      if (!map.getSource(DEM_SRC)) {
        map.addSource(DEM_SRC, { type: 'raster-dem', tiles: [SM.TERRAIN_TILES],
                                 encoding: 'terrarium', tileSize: 256, maxzoom: SM.TERRAIN_MAXZOOM || 15 });
      }
    }

    function ensureViewLayers() {
      captureBase();
      if (!map.getLayer(IMAGERY_LAYER)) {
        if (!map.getSource(IMAGERY_SRC)) {
          map.addSource(IMAGERY_SRC, {
            type: 'raster', tiles: SM.IMAGERY.tiles, tileSize: SM.IMAGERY.tileSize,
            maxzoom: SM.IMAGERY.maxzoom, attribution: SM.IMAGERY.attribution
          });
        }
        map.addLayer({ id: IMAGERY_LAYER, type: 'raster', source: IMAGERY_SRC,
                       layout: { visibility: 'none' },
                       paint: Object.assign({ 'raster-fade-duration': 200 }, SM.IMAGERY_PAINT) },
                     firstBase((k) => k !== 'background'));
      }
      if (!map.getLayer(HILLSHADE_LAYER)) {
        ensureDemSource();
        map.addLayer({ id: HILLSHADE_LAYER, type: 'hillshade', source: DEM_SRC,
                       layout: { visibility: 'none' },
                       paint: { 'hillshade-exaggeration': 0.45,
                                'hillshade-shadow-color': '#5b5a4e',
                                'hillshade-highlight-color': '#fffdf5',
                                'hillshade-accent-color': '#93917f' } },
                     firstBase((k) => k === 'road' || k === 'boundary' || k === 'label'));
      }
    }

    let imageryBuildingOpacity = null;

    function getBuildingOpacity() {
      const show = SM.VIEW_LAYERS[view] || SM.VIEW_LAYERS.roadmap;
      return show.ramp === 'imagery' && imageryBuildingOpacity != null
        ? imageryBuildingOpacity : show.buildings;
    }

    function setBuildingOpacity(v) {
      const n = Number(v);
      if (!isFinite(n)) return getBuildingOpacity();
      imageryBuildingOpacity = Math.max(0, Math.min(1, n));
      applyBuildingPaint();
      return imageryBuildingOpacity;
    }

    function buildingColorExpr(ramp) {
      return ['case', ['boolean', ['feature-state', 'edited'], false], SM.EDITED_COLOR,
              ['has', 'facade'], ['get', 'facade'],
              ['interpolate', ['linear'], heightExpr()].concat(ramp)];
    }

    function applyBuildingPaint() {
      if (!map.getLayer('3d-buildings')) return;
      const show = SM.VIEW_LAYERS[view] || SM.VIEW_LAYERS.roadmap;
      const ramp = show.ramp === 'imagery' ? SM.HEIGHT_RAMP_IMAGERY : SM.HEIGHT_RAMP;
      map.setPaintProperty('3d-buildings', 'fill-extrusion-color', buildingColorExpr(ramp));
      map.setPaintProperty('3d-buildings', 'fill-extrusion-opacity', getBuildingOpacity());
      if (map.getLayer(ROOF_LAYER)) {
        map.setPaintProperty(ROOF_LAYER, 'fill-extrusion-opacity', getBuildingOpacity());
      }
    }

    const ROOF_LAYER = 'site-roofs', TREE_LAYER = 'site-trees';
    let site = null;
    let siteSeq = 0;
    let treeLayer = null;
    let treesOn = true;

    function siteFile(s, file) {
      return '/api/map/sites/' + encodeURIComponent(s.id) + '/' + file;
    }
    function buildingsUrl() {
      return site ? 'pmtiles://' + siteFile(site, 'buildings.pmtiles') + (siteSeq ? '?v=' + siteSeq : '')
                  : SM.OVERTURE_BUILDINGS;
    }

    function roofTop(dz) {
      const h = heightExpr();
      return ['interpolate', ['linear'], ['zoom'], BUILDINGS_MINZOOM, 0, BUILDINGS_FULL_HEIGHT_ZOOM,
              ['case', ['==', h, 0], 0, ['+', h, dz]]];
    }
    function addRoofLayer() {
      if (map.getLayer(ROOF_LAYER) || !map.getLayer('3d-buildings')) return;
      map.addLayer({
        id: ROOF_LAYER, source: 'overture', 'source-layer': 'building',
        type: 'fill-extrusion', minzoom: BUILDINGS_MINZOOM, filter: ['has', 'roof'],
        paint: {
          'fill-extrusion-color': ['get', 'roof'],
          'fill-extrusion-base': roofTop(0),
          'fill-extrusion-height': roofTop(0.06),
          'fill-extrusion-opacity': getBuildingOpacity(),
          'fill-extrusion-vertical-gradient': false
        }
      }, map.getLayer(REMOVED_LAYER) ? REMOVED_LAYER : undefined);
    }

    function ensureTreeLayer() {
      if (!SM.createTreeLayer) return null;
      if (!treeLayer) treeLayer = SM.createTreeLayer(TREE_LAYER);
      if (!map.getLayer(TREE_LAYER) && map.getLayer('3d-buildings')) map.addLayer(treeLayer);
      treeLayer.setVisible(treesOn);
      return treeLayer;
    }

    let treeReq = 0;
    async function loadSiteTrees(s) {
      const my = ++treeReq;
      const tl = ensureTreeLayer();
      if (!tl) return 0;
      if (!s) { tl.setTrees(null); return 0; }
      try {
        const r = await fetch(siteFile(s, 'trees.json'));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const t = await r.json();
        if (my !== treeReq) return 0;
        const sp = t.species || [];
        const kinds = t.trees.map((q) => [q[0], q[1], q[2], q[3], q[4], sp[q[6]] || '', q[7] == null ? null : q[7]]);
        tl.setTrees(kinds);
        return kinds.length;
      } catch (err) {
        if (my === treeReq) tl.setTrees(null);
        console.warn('site trees:', err && err.message);
        return 0;
      }
    }

    function rebuildBuildingSource() {
      const style = map.getStyle();
      const order = style.layers.map((l) => l.id);
      const mine = style.layers.filter((l) => l.source === 'overture');
      if (!mine.length && !map.getSource('overture')) return;
      const isMine = {};
      mine.forEach((l) => { isMine[l.id] = true; });
      const before = {};
      mine.forEach((l) => {
        const i = order.indexOf(l.id);
        before[l.id] = order.slice(i + 1).find((id) => !isMine[id]);
      });
      mine.forEach((l) => map.removeLayer(l.id));
      map.removeSource('overture');
      map.addSource('overture', {
        type: 'vector', url: buildingsUrl(), promoteId: { building: 'id' },
        attribution: site ? '' : '© <a href="https://overturemaps.org" target="_blank" rel="noopener">Overture Maps</a>'
      });
      mine.forEach((l) => map.addLayer(l, before[l.id] && map.getLayer(before[l.id]) ? before[l.id] : undefined));
      const kick = (e) => {
        if (e.sourceId !== 'overture' || !e.isSourceLoaded) return;
        map.off('sourcedata', kick);
        const z = map.getZoom();
        map.jumpTo({ zoom: z + 1e-3 });
        map.jumpTo({ zoom: z });
      };
      map.on('sourcedata', kick);
      setTimeout(() => kick({ sourceId: 'overture', isSourceLoaded: true }), 4000);
      Object.keys(getBuildingEdits()).forEach(paintEdit);
      refreshRemovedOutline();
      applyBuildingPaint();
    }

    const MESH_LAYER = 'site-meshes';
    let meshLayer = null, detailReq = 0;
    const DETAIL_HIT_LAYER = 'site-detail-hit';
    function setDetailFilter(bids) {
      const not = bids && bids.length ? ['!', ['in', ['get', 'bid'], ['literal', bids]]] : null;
      if (map.getLayer('3d-buildings')) map.setFilter('3d-buildings', not);
      if (map.getLayer(ROOF_LAYER)) map.setFilter(ROOF_LAYER, not ? ['all', ['has', 'roof'], not] : ['has', 'roof']);
      if (!map.getLayer(DETAIL_HIT_LAYER) && map.getLayer('3d-buildings') && map.getSource('overture')) {
        map.addLayer({
          id: DETAIL_HIT_LAYER, source: 'overture', 'source-layer': 'building',
          type: 'fill-extrusion', minzoom: BUILDINGS_MINZOOM, filter: ['in', ['get', 'id'], ['literal', []]],
          paint: {
            'fill-extrusion-height': heightRampExpr(),
            'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
            'fill-extrusion-opacity': 0
          }
        });
        attachDetailClick();
      }
      if (map.getLayer(DETAIL_HIT_LAYER)) {
        map.setFilter(DETAIL_HIT_LAYER, bids && bids.length ? ['in', ['get', 'bid'], ['literal', bids]]
                                                            : ['in', ['get', 'id'], ['literal', []]]);
      }
    }
    let detailClickBound = false;
    function attachDetailClick() {
      if (detailClickBound || !mayEdit) return;
      detailClickBound = true;
      map.on('mouseenter', DETAIL_HIT_LAYER, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', DETAIL_HIT_LAYER, () => (map.getCanvas().style.cursor = ''));
      map.on('click', DETAIL_HIT_LAYER, (e) => {
        const f = e.features && e.features[0]; if (!f) return;
        if (userBuiltAt(e.point) || addArmed) return;
        if (map.queryRenderedFeatures(e.point, { layers: ['3d-buildings'] }).length) return;
        if (onBuildingClick) { onBuildingClick(f, e); return; }
        const popup = new maplibregl.Popup({ closeButton: true, offset: 12, maxWidth: '320px' });
        popup.setLngLat(e.lngLat).setDOMContent(buildingPopup(f, popup)).addTo(map);
      });
    }
    async function loadSiteDetail(s) {
      const my = ++detailReq;
      if (!meshLayer && SM.createSiteMeshLayer) meshLayer = SM.createSiteMeshLayer(MESH_LAYER);
      if (meshLayer && !map.getLayer(MESH_LAYER) && map.getLayer('3d-buildings')) map.addLayer(meshLayer);
      if (!s) { setDetailFilter(null); if (meshLayer) meshLayer.load([]); return 0; }
      try {
        const r = await fetch(siteFile(s, 'site.json'));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const sj = await r.json();
        if (my !== detailReq) return 0;
        const det = sj.detailed || [];
        setDetailFilter([].concat(...det.map((d) => d.bids || [d.bid])));
        if (meshLayer) await meshLayer.load(det, (d, f) => '/api/map/sites/' + encodeURIComponent(s.id) + '/' + f);
        return det.length;
      } catch (err) {
        console.warn('site detail:', err && err.message);
        setDetailFilter(null);
        return 0;
      }
    }

    function setSite(s, opts) {
      opts = opts || {};
      const want = s && s.id ? s : null;
      const same = (site && site.id) === (want && want.id);
      if (same && !opts.force) return site;
      site = want;
      if (opts.force) siteSeq++;
      if (map.getSource('overture')) rebuildBuildingSource();
      if (map.getLayer('3d-buildings')) {
        addRoofLayer();
        loadSiteTrees(site);
        loadSiteDetail(site);
      }
      return site;
    }
    function setTreesVisible(on) {
      treesOn = !!on;
      if (treeLayer) treeLayer.setVisible(treesOn);
      return treesOn;
    }

    function setView(mode) {
      const want = SM.VIEW_LAYERS[mode] ? mode : 'roadmap';
      ensureViewLayers();
      const show = SM.VIEW_LAYERS[want];
      setVis(IMAGERY_LAYER, show.imagery);
      setVis(HILLSHADE_LAYER, show.hillshade);
      view = want;
      applyBuildingPaint();
      for (const id of baseOrder) {
        const kind = baseKind[id];
        if (kind === 'suppressed') { setVis(id, false); continue; }
        if (kind === 'background') { setVis(id, true); continue; }
        setVis(id, !!show[kind]);
      }
      view = want;
      return view;
    }

    function buildingPieces(id) {
      try {
        return map.querySourceFeatures('overture', { sourceLayer: 'building' })
          .filter((f) => String(f.id) === String(id));
      } catch (e) { return []; }
    }

    function buildingPopup(f, popup) {
      const id = f.properties.edit_id || f.properties.id;
      const synthetic = String(id).indexOf('new-') === 0;
      const box = document.createElement('div');
      box.className = 'bpop';
      let step = 'info';
      let chosenModel = null;

      const el = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
      };
      const button = (label, cls, onClick, title) => {
        const b = el('button', cls, label);
        if (title) b.title = title;
        b.onclick = onClick;
        return b;
      };
      const close = () => { if (popup) popup.remove(); };

      function keepRow(build, hint) {
        const q = el('div', 'bpop-note', hint || 'Keep this change:');
        box.appendChild(q);
        const row = el('div', 'bpop-act2');
        row.appendChild(button('Final', null, () => {
          const e = build(); if (e !== false) { setBuildingEdit(id, e, { mode: 'permanent' }); close(); }
        }, 'Keep it — this comes back every time the place is opened, and every scene built here uses it'));
        row.appendChild(button('Temporary', 'ghost', () => {
          const e = build(); if (e !== false) { setBuildingEdit(id, e, { mode: 'session' }); close(); }
        }, 'Only for this design — the change is built into this scene, but other scenes here open with the original'));
        box.appendChild(row);
      }

      function backRow(to) {
        const row = el('div', 'bpop-act2');
        row.appendChild(button('← Back', 'ghost', () => { step = to; render(); }));
        box.appendChild(row);
      }

      function render() {
        box.textContent = '';
        box.onclick = (ev) => ev.stopPropagation();
        const info = SM.buildingHeight(f.properties, city.heightFallbackM);
        const edit = editOf(id);
        const mode = editModeOf(id);
        const override = edit && edit.op === 'set_height' ? edit.height_m : null;
        const built = edit && edit.op === 'replace_with_building' ? edit : null;
        const modelEdit = edit && edit.op === 'replace_with_model' ? edit : null;
        const shown = built ? built.height_m : (override != null ? override : info.m);

        box.appendChild(el('b', 'bpop-name',
          f.properties.edit_id && synthetic ? 'New building'
            : SM.buildingName(f.properties) || 'Building'));

        if (step === 'info') {
          const round1 = (v) => Math.round(v * 10) / 10;
          const kept = mode === 'permanent' ? ' · saved, returns next time'
            : mode === 'session' ? ' · temporary, until reload' : '';

          const original = synthetic ? null
            : f.properties.edit_id ? SM.buildingHeight(
                (buildingPieces(id)[0] || { properties: {} }).properties, city.heightFallbackM)
            : info;
          const originalText = !original ? ''
            : original.source === 'measured' ? 'measured — the map data states it'
            : original.source === 'floors' ? 'estimated from ' + original.floors + ' floors'
            : 'estimated — the data gives no height or floor count';

          const hLine = el('div', 'bpop-h');
          hLine.appendChild(el('span', null, 'Height: '));
          hLine.appendChild(el('b', null, round1(shown) + ' m'));
          box.appendChild(hLine);

          const changed = original && Math.abs(round1(shown) - round1(original.m)) > 0.05;
          if (original) {
            const o = el('div', 'bpop-note');
            o.textContent = changed
              ? 'Was ' + round1(original.m) + ' m — ' + originalText
              : 'Original height, ' + originalText;
            box.appendChild(o);
          } else if (modelEdit) {
            box.appendChild(el('div', 'bpop-note', 'Height comes from the model itself.'));
          } else {
            box.appendChild(el('div', 'bpop-note', 'Height set by you when you drew it.'));
          }

          const kind = modelEdit ? 'model'
            : built ? (synthetic ? 'drawn' : 'replaced')
            : override != null ? 'height' : null;
          if (edit && edit.op === 'delete') {
            box.appendChild(el('div', 'bpop-note', 'Removed from the scene' + kept));
          } else if (kind) {
            const row = el('div', 'bpop-kind');
            const dot = el('span', 'bpop-dot');
            dot.style.background = SM.EDIT_COLORS[kind];
            row.appendChild(dot);
            let text = SM.EDIT_KIND_TEXT[kind];
            if (kind === 'model') text += ': ' + modelEdit.model;
            if (built && built.rings.length > 1) text += ' · ' + built.rings.length + ' parts';
            row.appendChild(el('span', null, text + kept));
            box.appendChild(row);
          } else {
            box.appendChild(el('div', 'bpop-note', 'Not changed — as the map data has it.'));
          }

          if (!id) return;
          const acts = el('div', 'bpop-stack');
          acts.appendChild(button('Change the height', null, () => { step = 'height'; render(); }));
          acts.appendChild(button('Edit the building', 'ghost', () => { step = 'edit'; render(); }));

          const forgets = mode === 'permanent' ? ' and forget the saved change' : '';
          const undo = () => { setBuildingEdit(id, null); step = 'info'; render(); };

          const rh = button('Reset the height', 'ghost', undo,
            override != null ? 'Back to the original height in the data' + forgets
              : built ? 'You drew this building — it has no original height to go back to'
              : 'The height of this building has not been changed');
          rh.disabled = override == null;
          acts.appendChild(rh);

          const rb = button('Reset the building', 'ghost', undo,
            modelEdit ? 'Take your model out' + forgets
              : built && synthetic ? 'Take out the building you drew here' + forgets
              : isGone(edit) ? 'Bring the original building back' + forgets
              : 'This building has not been removed or replaced');
          rb.disabled = !isGone(edit);
          acts.appendChild(rb);

          box.appendChild(acts);
          return;
        }

        if (step === 'height') {
          box.appendChild(el('div', 'bpop-note', 'New height for this building:'));
          const row = el('div', 'bpop-row');
          const inp = el('input');
          inp.type = 'number'; inp.min = '0.5'; inp.max = '1000'; inp.step = '1';
          inp.value = String(Math.round(shown * 10) / 10);
          inp.title = 'Metres — the scene is built and ray traced at this value';
          row.appendChild(inp);
          row.appendChild(el('span', 'bpop-unit', 'm'));
          box.appendChild(row);
          setTimeout(() => { inp.focus(); inp.select(); }, 0);
          keepRow(() => (built
            ? Object.assign({}, built, { height_m: parseFloat(inp.value) })
            : { op: 'set_height', height_m: parseFloat(inp.value) }),
                  'Save this height as:');
          backRow('info');
          return;
        }

        if (step === 'edit') {
          box.appendChild(el('div', 'bpop-note', 'What would you like to do?'));
          const acts = el('div', 'bpop-stack');
          acts.appendChild(button('Remove the building', null, () => { step = 'remove'; render(); }));
          if (built) {
            acts.appendChild(button('Reshape this building', 'ghost', () => {
              close();
              if (actions.editUserBuilding) actions.editUserBuilding(id, built);
            }, 'Open the outline you drew and change it'));
          } else acts.appendChild(button('Add a replaced building', 'ghost', () => {
            close();
            beginReplacement();
          }, 'Take this building out and draw its replacement in place'));
          acts.appendChild(button('Add a new building', 'ghost', () => {
            close();
            beginNewBuilding();
          }, 'Keep this building and draw another one on the empty plot beside it'));
          box.appendChild(acts);
          backRow('info');
          return;
        }

        if (step === 'remove' && built && synthetic) {
          box.appendChild(el('div', 'bpop-note',
            'This building you drew will be taken out. Nothing stood here before it, so '
            + 'there is nothing to bring back.'));
          const acts = el('div', 'bpop-stack');
          acts.appendChild(button('Remove it', null, () => { setBuildingEdit(id, null); close(); },
            'Takes it out of the scene, and forgets it if it was saved'));
          box.appendChild(acts);
          backRow('edit');
          return;
        }

        if (step === 'remove') {
          box.appendChild(el('div', 'bpop-note',
            'This building will be taken out of the scene. The ray tracer will not see it.'));
          const acts = el('div', 'bpop-stack');
          acts.appendChild(button('Just remove it', null, () => { step = 'removeKeep'; render(); },
            'Leave the plot empty'));
          acts.appendChild(button('Remove, then build here', 'ghost', () => {
            close();
            beginReplacement();
          }, 'Take it out and draw a new building in its place'));
          box.appendChild(acts);
          backRow('edit');
          return;
        }

        function beginNewBuilding() {
          if (!actions.designNewBuilding) return;
          const r = largestRing(f.geometry);
          const c = map.getCenter();
          if (!r || !r.length) { actions.designNewBuilding([c.lng, c.lat]); return; }
          let east = -180, latSum = 0;
          r.forEach((p) => { if (p[0] > east) east = p[0]; latSum += p[1]; });
          const lat = latSum / r.length;
          actions.designNewBuilding([east + 14 / SM.geo.mPerDegLon(lat), lat]);
        }

        function beginReplacement() {
          const priorSession = tempEdits[id];
          setBuildingEdit(id, { op: 'delete' }, { mode: 'session' });
          if (actions.designReplacement) actions.designReplacement(f, id, priorSession || null);
        }

        if (step === 'removeKeep') {
          box.appendChild(el('div', 'bpop-note', 'The plot will be left empty.'));
          keepRow(() => ({ op: 'delete' }), 'Save the map with it removed:');
          backRow('remove');
          return;
        }

      }

      render();
      return box;
    }

    function distM(a, b) {
      const lat = (a[1] + b[1]) / 2;
      return Math.hypot((b[0] - a[0]) * SM.geo.mPerDegLon(lat),
                        (b[1] - a[1]) * SM.geo.M_PER_DEG_LAT);
    }

    function ringOpen(ring) {
      const r = ring.slice();
      if (r.length > 1) {
        const a = r[0], b = r[r.length - 1];
        if (Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12) r.pop();
      }
      return r;
    }

    function ringAreaDeg(r) {
      let a = 0;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        a += (r[j][0] * r[i][1]) - (r[i][0] * r[j][1]);
      }
      return Math.abs(a / 2);
    }

    function bestPiece(rings) {
      let best = null, bestScore = -1;
      rings.forEach((r) => {
        if (!r || r.length < 3) return;
        const score = r.length * 1e6 + ringAreaDeg(r);
        if (score > bestScore) { bestScore = score; best = r; }
      });
      return best;
    }

    function largestRing(geom) {
      if (!geom) return null;
      const polys = geom.type === 'Polygon' ? [geom.coordinates]
        : geom.type === 'MultiPolygon' ? geom.coordinates : [];
      let best = null, bestA = -1;
      polys.forEach((p) => {
        const r = p && p[0];
        if (!r || r.length < 4) return;
        const a = ringAreaDeg(r);
        if (a > bestA) { bestA = a; best = r; }
      });
      return best;
    }

    function simplifyRing(ring, tolM) {
      const pts = ringOpen(ring);
      if (pts.length <= 4) return pts;
      const lat0 = pts[0][1];
      const mx = SM.geo.mPerDegLon(lat0), my = SM.geo.M_PER_DEG_LAT;
      const xy = pts.map((p) => [p[0] * mx, p[1] * my]);

      function seg(i, j, keep) {
        let far = -1, idx = -1;
        const ax = xy[i][0], ay = xy[i][1], bx = xy[j][0], by = xy[j][1];
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        for (let k = i + 1; k < j; k++) {
          const px = xy[k][0] - ax, py = xy[k][1] - ay;
          const t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
          const d = Math.hypot(px - t * dx, py - t * dy);
          if (d > far) { far = d; idx = k; }
        }
        if (far > tolM && idx > 0) { seg(i, idx, keep); keep[idx] = 1; seg(idx, j, keep); }
      }
      const keep = {};
      keep[0] = 1; keep[xy.length - 1] = 1;
      seg(0, xy.length - 1, keep);
      const out = pts.filter((p, i) => keep[i]);
      return out.length >= 3 ? out : pts;
    }

    function buildingOutline(feature, maxPoints, siblings) {
      let r = null;
      if (siblings && siblings.length) {
        r = bestPiece(siblings.map((f) => largestRing(f.geometry)).filter(Boolean));
      }
      if (!r) r = largestRing(feature && feature.geometry);
      if (!r || r.length < 3) return null;
      const cap = maxPoints || 60;
      const tries = [0.3, 0.5, 0.8, 1.2, 2.0];
      let out = simplifyRing(r, tries[0]);
      for (let i = 0; i < tries.length; i++) {
        out = simplifyRing(r, tries[i]);
        if (out.length <= cap) break;
      }
      return out;
    }

    function createFootprintEditor(container, ring, onSize, opts) {
      opts = opts || {};
      const hidden = (opts.hideIds || []).map(String);
      let pts = ringOpen(ring || []).map((p) => [p[0], p[1]]);
      const originalLens = [];
      const hasRing = () => pts.length >= 3;
      const centre = opts.center || [0, 0];
      const cx = pts.length ? pts.reduce((a, p) => a + p[0], 0) / pts.length : centre[0];
      const cy = pts.length ? pts.reduce((a, p) => a + p[1], 0) / pts.length : centre[1];

      const m2 = new maplibregl.Map({
        container: container, style: SM.BASE_STYLE,
        center: [cx, cy], zoom: 17.4, pitch: 0, attributionControl: false
      });
      m2.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
      m2.addControl(new maplibregl.ScaleControl({ maxWidth: 90, unit: 'metric' }), 'bottom-left');

      let vHandles = [], ready = false, snapshot = null;
      let height = 20, tilted = false;

      const EMPTY = { type: 'FeatureCollection', features: [] };
      const polyData = () => (hasRing()
        ? { type: 'Feature', properties: {},
            geometry: { type: 'Polygon', coordinates: [pts.concat([pts[0]])] } }
        : EMPTY);
      const LABEL_OFFSET_M = 4;
      const edgeData = () => {
        if (!hasRing()) return EMPTY;
        const latAvg = pts.reduce((a, p) => a + p[1], 0) / pts.length;
        const mx = SM.geo.mPerDegLon(latAvg), my = SM.geo.M_PER_DEG_LAT;
        const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
        const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
        return { type: 'FeatureCollection', features: pts.map((p, i) => {
          const q = pts[(i + 1) % pts.length];
          const len = distM(p, q);
          const midLon = (p[0] + q[0]) / 2, midLat = (p[1] + q[1]) / 2;
          let nx = -((q[1] - p[1]) * my), ny = ((q[0] - p[0]) * mx);
          const n = Math.hypot(nx, ny) || 1;
          nx /= n; ny /= n;
          if (nx * ((midLon - cx) * mx) + ny * ((midLat - cy) * my) < 0) { nx = -nx; ny = -ny; }
          return { type: 'Feature',
            properties: { label: String(Math.max(0, Math.round(len))) + 'm' },
            geometry: { type: 'Point',
              coordinates: [midLon + (nx * LABEL_OFFSET_M) / mx,
                            midLat + (ny * LABEL_OFFSET_M) / my] } };
        }) };
      };

      function sizeOf() {
        if (!pts.length) return { width: 0, depth: 0 };
        const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
        const midLat = (Math.min.apply(null, lats) + Math.max.apply(null, lats)) / 2;
        return {
          width: (Math.max.apply(null, lons) - Math.min.apply(null, lons)) * SM.geo.mPerDegLon(midLat),
          depth: (Math.max.apply(null, lats) - Math.min.apply(null, lats)) * SM.geo.M_PER_DEG_LAT
        };
      }

      function buildParts() {
        const rings = hasRing() ? [pts.concat([pts[0]])] : [];
        let unusable = 0;
        drawnLines.forEach((l) => {
          if (isClosed(l)) rings.push(l.slice());
          else if (l.length >= 3) rings.push(l.concat([[l[0][0], l[0][1]]]));
          else unusable++;
        });
        return { rings: rings, unusable: unusable };
      }

      function allData() {
        const rings = buildParts().rings;
        if (!rings.length) return EMPTY;
        return { type: 'Feature', properties: {},
                 geometry: { type: 'MultiPolygon', coordinates: rings.map((r) => [r]) } };
      }

      function paint() {
        if (!ready) return;
        m2.getSource('fp').setData(polyData());
        m2.getSource('fp-all').setData(allData());
        m2.getSource('fp-edge').setData(edgeData());
        if (onSize) onSize(sizeOf());
      }

      function clearHandles() {
        vHandles.forEach((h) => h.remove());
        vHandles = [];
      }

      function buildLineHandles() {
        drawnLines.forEach((line, li) => {
          const closed = isClosed(line);
          const last = line.length - 1;
          line.forEach((p, pi) => {
            if (closed && pi === last) return;
            const el = document.createElement('div');
            el.className = 'fp-lhandle';
            el.title = 'Drag to move this corner';
            const mk = new maplibregl.Marker({ element: el, draggable: true })
              .setLngLat(p).addTo(m2);
            let lastSnap = null;
            mk.on('drag', () => {
              const l = mk.getLngLat();
              const snap = snapAt(m2.project([l.lng, l.lat]), line[pi]);
              lastSnap = snap;
              const np = snap ? [snap.point[0], snap.point[1]] : [l.lng, l.lat];
              line[pi] = np;
              if (closed && pi === 0) line[last] = [np[0], np[1]];
              if (snap) mk.setLngLat(np);
              showSnap(snap ? snap.point : null, snap && snap.kind);
              paintDraft();
            });
            mk.on('dragstart', () => { el._moved = true; lastSnap = null; });
            mk.on('dragend', () => {
              showSnap(null);
              if (lastSnap && lastSnap.kind === 'edge'
                  && weldToSegment(lastSnap.seg, lastSnap.point) && opts.onStatus) {
                opts.onStatus('Joined to that wall — it now has a corner here.');
              } else if (lastSnap && lastSnap.kind === 'corner' && opts.onStatus) {
                opts.onStatus('Corners joined.');
              }
              lastSnap = null;
              buildHandles(); paint(); paintDraft();
              setTimeout(() => { el._moved = false; }, 0);
            });
            el.ondblclick = (ev) => {
              ev.preventDefault(); ev.stopPropagation();
              if (el._moved) return;
              askDeleteDrawnCorner(li, pi, line[pi]);
            };
            el.oncontextmenu = (ev) => {
              ev.preventDefault(); ev.stopPropagation();
              addDraftPointAt(line[pi], line[pi]);
            };
            vHandles.push(mk);
          });
        });
      }

      function buildHandles() {
        clearHandles();
        buildLineHandles();
        pts.forEach((p, i) => {
          const el = document.createElement('div');
          el.className = 'fp-handle';
          el.title = 'Drag to move this corner · right-click to remove it';
          const mk = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(p).addTo(m2);
          let lastSnap = null;
          mk.on('drag', () => {
            const l = mk.getLngLat();
            const snap = snapAt(m2.project([l.lng, l.lat]), pts[i]);
            lastSnap = snap;
            if (snap) { pts[i] = [snap.point[0], snap.point[1]]; mk.setLngLat(pts[i]); }
            else pts[i] = [l.lng, l.lat];
            showSnap(snap ? snap.point : null, snap && snap.kind);
            paint();
          });
          mk.on('dragstart', () => { el._moved = true; lastSnap = null; });
          mk.on('dragend', () => {
            showSnap(null);
            let msg = '';
            if (lastSnap && lastSnap.kind === 'edge' && weldToSegment(lastSnap.seg, lastSnap.point)) {
              msg = 'Joined to that wall — it now has a corner here.';
            } else if (lastSnap && lastSnap.kind === 'corner') msg = 'Corners joined.';
            if (mergeCoincident()) msg = 'Corners joined.';
            if (msg && opts.onStatus) opts.onStatus(msg);
            lastSnap = null;
            buildHandles();
            paint();
            setTimeout(() => { el._moved = false; }, 0);
          });
          el.ondblclick = (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            if (el._moved) return;
            askDeleteCorner(i, pts[i]);
          };
          el.oncontextmenu = (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            addDraftPointAt(pts[i], pts[i]);
          };
          vHandles.push(mk);
        });
      }

      function nearestEdge(lonlat) {
        const latAvg = pts.reduce((a, p) => a + p[1], 0) / pts.length;
        const mx = SM.geo.mPerDegLon(latAvg), my = SM.geo.M_PER_DEG_LAT;
        const P = [lonlat[0] * mx, lonlat[1] * my];
        let best = Infinity, at = -1, hit = null;
        pts.forEach((p, i) => {
          const q = pts[(i + 1) % pts.length];
          const A = [p[0] * mx, p[1] * my], B = [q[0] * mx, q[1] * my];
          const dx = B[0] - A[0], dy = B[1] - A[1];
          const l2 = dx * dx + dy * dy;
          const t = l2 ? Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / l2)) : 0;
          const cxp = A[0] + t * dx, cyp = A[1] + t * dy;
          const d = Math.hypot(P[0] - cxp, P[1] - cyp);
          if (d < best) { best = d; at = i; hit = [cxp / mx, cyp / my]; }
        });
        return { index: at, point: hit };
      }

      function deleteEdge(i) {
        if (pts.length <= 3) return false;
        const j = (i + 1) % pts.length;
        const mid = [(pts[i][0] + pts[j][0]) / 2, (pts[i][1] + pts[j][1]) / 2];
        const keep = Math.min(i, j), drop = Math.max(i, j);
        pts[keep] = mid;
        pts.splice(drop, 1);
        buildHandles(); paint();
        return true;
      }

      let drawnLines = (opts.extraRings || []).map((r) => r.map((p) => [p[0], p[1]]));
      let draft = [];
      let cursor = null;
      const SNAP_PX = 14;

      function snapCandidates() {
        const out = pts.slice();
        drawnLines.forEach((l) => l.forEach((p) => out.push(p)));
        if (draft.length) out.push(draft[0]);
        return out;
      }
      function snapAt(screenPt, exclude) {
        let best = null, bestD = SNAP_PX;
        snapCandidates().forEach((c) => {
          if (c === exclude) return;
          const s2 = m2.project(c);
          const d = Math.hypot(s2.x - screenPt.x, s2.y - screenPt.y);
          if (d <= bestD) { bestD = d; best = c; }
        });
        if (best) return { point: best, kind: 'corner', ref: best };

        const segs = [];
        for (let i = 0; i < pts.length; i++) {
          segs.push({ a: pts[i], b: pts[(i + 1) % pts.length], on: { kind: 'outline', i: i } });
        }
        drawnLines.forEach((l, li) => {
          for (let i = 0; i + 1 < l.length; i++) segs.push({ a: l[i], b: l[i + 1], on: { kind: 'drawn', li: li, si: i } });
        });
        let bd = SNAP_PX, bp = null, bseg = null;
        segs.forEach((sg) => {
          if (sg.a === exclude || sg.b === exclude) return;
          const A = m2.project(sg.a), B = m2.project(sg.b);
          const dx = B.x - A.x, dy = B.y - A.y, l2 = dx * dx + dy * dy;
          const t = l2 ? Math.max(0, Math.min(1,
            ((screenPt.x - A.x) * dx + (screenPt.y - A.y) * dy) / l2)) : 0;
          const px = A.x + t * dx, py = A.y + t * dy;
          const d = Math.hypot(screenPt.x - px, screenPt.y - py);
          if (d <= bd) { bd = d; const ll = m2.unproject([px, py]); bp = [ll.lng, ll.lat]; bseg = sg.on; }
        });
        return bp ? { point: bp, kind: 'edge', ref: null, seg: bseg } : null;
      }

      function weldToSegment(seg, p) {
        if (!seg || !p) return false;
        const same = (q) => q && Math.abs(q[0] - p[0]) < 1e-11 && Math.abs(q[1] - p[1]) < 1e-11;
        if (seg.kind === 'outline') {
          if (!hasRing() || seg.i >= pts.length) return false;
          const j = (seg.i + 1) % pts.length;
          if (same(pts[seg.i]) || same(pts[j])) return false;
          pts.splice(seg.i + 1, 0, [p[0], p[1]]);
          originalLens[seg.i] = null;
          originalLens.splice(seg.i + 1, 0, null);
          return true;
        }
        const line = drawnLines[seg.li];
        if (!line || seg.si + 1 >= line.length) return false;
        if (same(line[seg.si]) || same(line[seg.si + 1])) return false;
        line.splice(seg.si + 1, 0, [p[0], p[1]]);
        return true;
      }

      function mergeCoincident() {
        if (pts.length <= 3) return false;
        const key = (p) => p[0].toFixed(8) + ',' + p[1].toFixed(8);
        const seen = {}, out = [];
        let merged = false;
        pts.forEach((p) => {
          const k = key(p);
          if (seen[k]) { merged = true; return; }
          seen[k] = 1; out.push(p);
        });
        if (merged && out.length >= 3) { pts = out; return true; }
        return false;
      }
      function showSnap(c, kind) {
        if (!ready || !m2.getSource('fp-snap')) return;
        m2.getSource('fp-snap').setData(c
          ? { type: 'Feature', properties: { corner: kind === 'corner' ? 1 : 0 },
              geometry: { type: 'Point', coordinates: c } }
          : { type: 'FeatureCollection', features: [] });
      }

      function draftData() {
        const line = cursor && draft.length ? draft.concat([cursor]) : draft.slice();
        const feats = [];
        if (line.length > 1) {
          feats.push({ type: 'Feature', properties: {},
                       geometry: { type: 'LineString', coordinates: line } });
        }
        return { type: 'FeatureCollection', features: feats };
      }
      function draftPointData() {
        return { type: 'FeatureCollection', features: draft.map((p, i) => ({
          type: 'Feature', properties: { first: i === 0 ? 1 : 0 },
          geometry: { type: 'Point', coordinates: p } })) };
      }
      function draftLenData() {
        const line = cursor && draft.length ? draft.concat([cursor]) : draft.slice();
        const feats = [];
        for (let i = 0; i + 1 < line.length; i++) {
          const a = line[i], b = line[i + 1];
          feats.push({ type: 'Feature',
            properties: { label: String(Math.max(0, Math.round(distM(a, b)))) + 'm' },
            geometry: { type: 'Point', coordinates: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] } });
        }
        return { type: 'FeatureCollection', features: feats };
      }
      function linesData() {
        return { type: 'FeatureCollection', features: drawnLines
          .filter((l) => l.length >= 2)
          .map((l) => ({ type: 'Feature', properties: {},
                         geometry: { type: 'LineString', coordinates: l } })) };
      }
      function linesFillData() {
        return { type: 'FeatureCollection', features: drawnLines
          .filter(isClosed)
          .map((l) => ({ type: 'Feature', properties: {},
                         geometry: { type: 'Polygon', coordinates: [l] } })) };
      }
      function linesPtData() {
        const f = [];
        drawnLines.forEach((l) => l.forEach((p) => f.push({
          type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } })));
        return { type: 'FeatureCollection', features: f };
      }
      function linesLenData() {
        const f = [];
        drawnLines.forEach((l) => {
          const latAvg = l.reduce((a, p) => a + p[1], 0) / l.length;
          const mx = SM.geo.mPerDegLon(latAvg), my = SM.geo.M_PER_DEG_LAT;
          for (let i = 0; i + 1 < l.length; i++) {
            const a = l[i], b = l[i + 1];
            let nx = -((b[1] - a[1]) * my), ny = ((b[0] - a[0]) * mx);
            const n = Math.hypot(nx, ny) || 1;
            nx /= n; ny /= n;
            f.push({ type: 'Feature',
              properties: { label: String(Math.max(0, Math.round(distM(a, b)))) + 'm' },
              geometry: { type: 'Point', coordinates: [
                (a[0] + b[0]) / 2 + (nx * LABEL_OFFSET_M) / mx,
                (a[1] + b[1]) / 2 + (ny * LABEL_OFFSET_M) / my] } });
          }
        });
        return { type: 'FeatureCollection', features: f };
      }

      function paintDraft() {
        if (!ready) return;
        m2.getSource('fp-draft').setData(draftData());
        m2.getSource('fp-draft-pt').setData(draftPointData());
        m2.getSource('fp-draft-len').setData(draftLenData());
        m2.getSource('fp-lines').setData(linesData());
        m2.getSource('fp-lines-fill').setData(linesFillData());
        if (m2.getSource('fp-all')) m2.getSource('fp-all').setData(allData());
        m2.getSource('fp-lines-pt').setData(linesPtData());
        m2.getSource('fp-lines-len').setData(linesLenData());
        if (opts.onDraft) opts.onDraft(draft.length, drawnLines.length, drawnLines.filter(isClosed).length);
      }

      let rotDeg = 0;
      function rotateBy(deg) {
        const all = pts.slice();
        drawnLines.forEach((l) => l.forEach((p) => all.push(p)));
        if (!all.length || !deg) return;
        const lon0 = all.reduce((a, p) => a + p[0], 0) / all.length;
        const lat0 = all.reduce((a, p) => a + p[1], 0) / all.length;
        const th = (deg * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th);
        const rot = (p) => {
          const e = SM.geo.toENU(p[0], p[1], lon0, lat0);
          return SM.geo.fromENU(e[0] * cos - e[1] * sin, e[0] * sin + e[1] * cos, lon0, lat0);
        };
        pts = pts.map(rot);
        drawnLines = drawnLines.map((l) => {
          const closed = isClosed(l);
          const out = (closed ? ringOpen(l) : l).map(rot);
          return closed ? out.concat([[out[0][0], out[0][1]]]) : out;
        });
        buildHandles(); paint(); paintDraft();
      }

      let modelMarker = null, modelName = null, modelShape = null, modelRot = 0;
      let modelScale = 1, modelUp = 'z';
      let modelMeshLayer = null;
      function clearModel() {
        if (modelMarker) modelMarker.remove();
        modelMarker = null; modelName = null; modelShape = null; modelRot = 0;
        modelScale = 1; modelUp = 'z';
        if (modelMeshLayer) modelMeshLayer.clear();
        paintModel();
      }

      function modelData() {
        if (!modelMarker || !modelShape) return EMPTY;
        const l = modelMarker.getLngLat();
        return { type: 'Feature',
                 properties: { h: (modelShape.height_m || 3) * modelScale },
                 geometry: { type: 'Polygon', coordinates:
                   [SM.modelRing(modelShape, [l.lng, l.lat], modelRot, modelScale)] } };
      }
      function paintModelMesh() {
        if (!ready || !modelMeshLayer || !modelMarker) return;
        const l = modelMarker.getLngLat();
        modelMeshLayer.setPlacement([l.lng, l.lat], modelRot, modelScale);
        m2.triggerRepaint();
      }

      async function loadModelMesh(name, up) {
        if (!ready || !SM.modelMesh) return false;
        const mesh = await SM.modelMesh(name, up);
        if (!mesh || modelName !== name) return false;
        if (!modelMeshLayer) {
          modelMeshLayer = SM.createMeshLayer('fp-model-mesh');
          modelMeshLayer.setColor([0.13, 0.83, 0.93], 1.0);
          m2.addLayer(modelMeshLayer);
        }
        modelMeshLayer.setMesh(mesh.pos, mesh.norm);
        paintModelMesh();
        paintModel();
        return true;
      }

      function paintModel() {
        if (!ready) return;
        if (!m2.getSource('fp-model')) {
          m2.addSource('fp-model', { type: 'geojson', data: EMPTY });
          m2.addLayer({ id: 'fp-model-3d', type: 'fill-extrusion', source: 'fp-model',
            paint: { 'fill-extrusion-color': SM.NEW_COLOR,
                     'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': 0,
                     'fill-extrusion-opacity': 0.8, 'fill-extrusion-vertical-gradient': true } });
        }
        const showBox = !(modelMeshLayer && modelMeshLayer.hasMesh());
        m2.getSource('fp-model').setData(showBox ? modelData() : EMPTY);
        paintModelMesh();
      }

      function placeModel(name, lonlat, shape, opt) {
        const keep = lonlat || (modelMarker ? modelMarker.getLngLat() : null);
        clearModel();
        modelName = name;
        modelShape = shape || null;
        modelScale = (opt && +opt.scale > 0) ? +opt.scale : 1;
        modelUp = (opt && opt.up === 'y') ? 'y' : 'z';
        modelRot = (opt && +opt.rotation_deg) || 0;
        lonlat = keep;
        const el = document.createElement('div');
        el.className = 'fp-model';
        el.title = name + ' — drag it where the building goes';
        modelMarker = new maplibregl.Marker({ element: el, draggable: true })
          .setLngLat(lonlat || m2.getCenter()).addTo(m2);
        loadModelMesh(name, modelUp);
        modelMarker.on('drag', paintModel);
        modelMarker.on('dragend', () => {
          paintModel();
          if (opts.onStatus) opts.onStatus('Model moved. Save when it is where you want it.');
        });
        paintModel();
      }

      function clearDrawnLines() { drawnLines = []; buildHandles(); paintDraft(); }

      function addDraftPointAt(p, ref) {
        if (draft.length >= 3 && ref && ref === draft[0]) {
          finishDraft();
          showSnap(null);
          return;
        }
        draft.push([p[0], p[1]]);
        cursor = null;
        showSnap(null);
        paintDraft();
        if (opts.onStatus) {
          opts.onStatus(draft.length === 1
            ? 'Wall started. Right-click for the next corner, or Esc to finish.'
            : 'Right-click for the next corner, Esc to finish, or the first corner to close the shape.');
        }
      }
      function clearDraft() {
        draft = []; cursor = null; showSnap(null); paintDraft();
        if (opts.onStatus) opts.onStatus('');
      }
      const isClosed = (l) => l.length >= 4
        && Math.abs(l[0][0] - l[l.length - 1][0]) < 1e-12
        && Math.abs(l[0][1] - l[l.length - 1][1]) < 1e-12;

      function closeDraft() {
        if (draft.length < 3) return false;
        drawnLines.push(draft.concat([draft[0]]));
        clearDraft();
        if (!hasRing()) {
          useAsOutline();
          if (opts.onStatus) opts.onStatus('That is the building outline. Draw more parts, or set the height.');
          return true;
        }
        buildHandles();
        if (opts.onStatus) {
          opts.onStatus('Closed figure kept. It stands on its own — press “Use as outline” '
            + 'to make it this building.');
        }
        return true;
      }

      function useAsOutline() {
        for (let i = drawnLines.length - 1; i >= 0; i--) {
          if (!isClosed(drawnLines[i])) continue;
          pts = ringOpen(drawnLines[i]).map((p) => [p[0], p[1]]);
          drawnLines.splice(i, 1);
          originalLens.length = 0;
          pts.forEach((p, k) => originalLens.push(distM(p, pts[(k + 1) % pts.length])));
          buildHandles(); paint(); paintDraft();
          if (opts.onStatus) opts.onStatus('That figure is now the building outline.');
          return true;
        }
        return false;
      }
      const finishDraft = closeDraft;

      function insertNearest(lonlat) {
        const latAvg = pts.reduce((a, p) => a + p[1], 0) / pts.length;
        const mx = SM.geo.mPerDegLon(latAvg), my = SM.geo.M_PER_DEG_LAT;
        const P = [lonlat[0] * mx, lonlat[1] * my];
        let best = Infinity, at = -1, hit = null;
        pts.forEach((p, i) => {
          const q = pts[(i + 1) % pts.length];
          const A = [p[0] * mx, p[1] * my], B = [q[0] * mx, q[1] * my];
          const dx = B[0] - A[0], dy = B[1] - A[1];
          const l2 = dx * dx + dy * dy;
          const t = l2 ? Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / l2)) : 0;
          const cxp = A[0] + t * dx, cyp = A[1] + t * dy;
          const d = Math.hypot(P[0] - cxp, P[1] - cyp);
          if (d < best) { best = d; at = i; hit = [cxp / mx, cyp / my]; }
        });
        if (at < 0) return;
        pts.splice(at + 1, 0, hit);
        buildHandles(); paint();
      }

      let askPopup = null;
      function highlightEdge(i) {
        if (!ready || !m2.getSource('fp-sel')) return;
        const data = i == null ? { type: 'FeatureCollection', features: [] }
          : { type: 'Feature', properties: {}, geometry: { type: 'LineString',
              coordinates: [pts[i], pts[(i + 1) % pts.length]] } };
        m2.getSource('fp-sel').setData(data);
      }

      function askDeleteEdge(i, lngLat) {
        if (askPopup) { askPopup.remove(); askPopup = null; }
        highlightEdge(i);
        const len = Math.max(0, Math.round(distM(pts[i], pts[(i + 1) % pts.length])));
        const box = document.createElement('div');
        box.className = 'fp-ask';
        const q = document.createElement('div');
        q.className = 'fp-ask-q';
        q.textContent = pts.length <= 3
          ? 'This outline is already a triangle — no wall can be removed.'
          : 'Delete this ' + len + ' m line?';
        box.appendChild(q);
        const row = document.createElement('div');
        row.className = 'fp-ask-row';
        if (pts.length > 3) {
          const del = document.createElement('button');
          del.className = 'danger';
          del.textContent = 'Delete';
          del.onclick = () => { deleteEdge(i); highlightEdge(null); if (askPopup) askPopup.remove(); askPopup = null; };
          row.appendChild(del);
        }
        const no = document.createElement('button');
        no.textContent = pts.length > 3 ? 'Cancel' : 'OK';
        no.onclick = () => { highlightEdge(null); if (askPopup) askPopup.remove(); askPopup = null; };
        row.appendChild(no);
        box.appendChild(row);
        askPopup = new maplibregl.Popup({ closeButton: false, offset: 10, maxWidth: '230px' })
          .setLngLat(lngLat).setDOMContent(box).addTo(m2);
        askPopup.on('close', () => highlightEdge(null));
      }

      function closeAsk() {
        if (askPopup) { askPopup.remove(); askPopup = null; }
        highlightEdge(null);
      }

      function nearestDrawnSegment(lonlat) {
        const latAvg = pts.length ? pts.reduce((a, p) => a + p[1], 0) / pts.length : lonlat[1];
        const mx = SM.geo.mPerDegLon(latAvg), my = SM.geo.M_PER_DEG_LAT;
        const P = [lonlat[0] * mx, lonlat[1] * my];
        let best = Infinity, hit = null;
        drawnLines.forEach((line, li) => {
          for (let si = 0; si + 1 < line.length; si++) {
            const A = [line[si][0] * mx, line[si][1] * my];
            const B = [line[si + 1][0] * mx, line[si + 1][1] * my];
            const dx = B[0] - A[0], dy = B[1] - A[1], l2 = dx * dx + dy * dy;
            const t = l2 ? Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / l2)) : 0;
            const d = Math.hypot(P[0] - (A[0] + t * dx), P[1] - (A[1] + t * dy));
            if (d < best) { best = d; hit = { li: li, si: si }; }
          }
        });
        return hit;
      }

      function highlightDrawn(h) {
        if (!ready || !m2.getSource('fp-sel')) return;
        const line = h && drawnLines[h.li];
        m2.getSource('fp-sel').setData(line
          ? { type: 'Feature', properties: {},
              geometry: { type: 'LineString', coordinates: [line[h.si], line[h.si + 1]] } }
          : { type: 'FeatureCollection', features: [] });
      }

      function deleteDrawnSegment(li, si) {
        const line = drawnLines[li];
        if (!line || si + 1 >= line.length) return false;
        let pieces;
        if (isClosed(line)) {
          const open = ringOpen(line), n = open.length, out = [];
          for (let k = 1; k <= n; k++) out.push(open[(si + k) % n]);
          pieces = [out];
        } else {
          pieces = [line.slice(0, si + 1), line.slice(si + 1)].filter((p) => p.length >= 1);
        }
        drawnLines.splice(li, 1, ...pieces);
        buildHandles(); paintDraft();
        return true;
      }

      function askDeleteDrawn(h, lngLat) {
        closeAsk();
        highlightDrawn(h);
        const line = drawnLines[h.li];
        const len = Math.max(0, Math.round(distM(line[h.si], line[h.si + 1])));
        const box = document.createElement('div');
        box.className = 'fp-ask';
        const q = document.createElement('div');
        q.className = 'fp-ask-q';
        q.textContent = 'Delete this ' + len + ' m line you drew?';
        box.appendChild(q);
        const row = document.createElement('div');
        row.className = 'fp-ask-row';
        const del = document.createElement('button');
        del.className = 'danger'; del.textContent = 'Delete';
        del.onclick = () => { deleteDrawnSegment(h.li, h.si); closeAsk(); };
        const no = document.createElement('button');
        no.textContent = 'Cancel';
        no.onclick = closeAsk;
        row.appendChild(del); row.appendChild(no);
        box.appendChild(row);
        askPopup = new maplibregl.Popup({ closeButton: false, offset: 10, maxWidth: '240px' })
          .setLngLat(lngLat).setDOMContent(box).addTo(m2);
        askPopup.on('close', () => highlightEdge(null));
      }

      function deleteDrawnCorner(li, pi) {
        const line = drawnLines[li];
        if (!line) return false;
        const closed = isClosed(line);
        const open = closed ? ringOpen(line) : line.slice();
        if (pi < 0 || pi >= open.length) return false;
        open.splice(pi, 1);
        if (closed && open.length >= 3) drawnLines[li] = open.concat([open[0]]);
        else if (open.length >= 1) drawnLines[li] = open;
        else drawnLines.splice(li, 1);
        buildHandles(); paintDraft();
        return true;
      }

      function askDeleteDrawnCorner(li, pi, lngLat) {
        closeAsk();
        const box = document.createElement('div');
        box.className = 'fp-ask';
        const q = document.createElement('div');
        q.className = 'fp-ask-q';
        q.textContent = 'Remove this corner from the line you drew?';
        box.appendChild(q);
        const row = document.createElement('div');
        row.className = 'fp-ask-row';
        const del = document.createElement('button');
        del.className = 'danger'; del.textContent = 'Remove';
        del.onclick = () => { deleteDrawnCorner(li, pi); closeAsk(); };
        const no = document.createElement('button');
        no.textContent = 'Cancel'; no.onclick = closeAsk;
        row.appendChild(del); row.appendChild(no);
        box.appendChild(row);
        askPopup = new maplibregl.Popup({ closeButton: false, offset: 12, maxWidth: '240px' })
          .setLngLat(lngLat).setDOMContent(box).addTo(m2);
      }

      function setDrawnLength(li, si, metres) {
        const line = drawnLines[li];
        if (!line || si + 1 >= line.length) return;
        const a = line[si], b = line[si + 1];
        const cur = distM(a, b);
        if (!(cur > 0) || !(metres > 0)) return;
        const k = metres / cur;
        const np = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
        line[si + 1] = np;
        if (isClosed(line)) {
          if (si + 1 === line.length - 1) line[0] = [np[0], np[1]];
          else if (si + 1 === 0) line[line.length - 1] = [np[0], np[1]];
        }
        buildHandles(); paintDraft();
      }

      function askEditDrawnLength(h, lngLat) {
        closeAsk();
        highlightDrawn(h);
        const line = drawnLines[h.li];
        const before = distM(line[h.si], line[h.si + 1]);
        const box = document.createElement('div');
        box.className = 'fp-ask';
        const q = document.createElement('div');
        q.className = 'fp-ask-q';
        q.textContent = 'Length of this line, in metres:';
        box.appendChild(q);
        const r1 = document.createElement('div');
        r1.className = 'fp-ask-row';
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = '0.5'; inp.max = '2000'; inp.step = '1';
        inp.value = String(Math.round(before * 10) / 10);
        inp.className = 'fp-ask-in';
        r1.appendChild(inp); box.appendChild(r1);
        const r2 = document.createElement('div');
        r2.className = 'fp-ask-row';
        const apply = document.createElement('button');
        apply.className = 'go'; apply.textContent = 'Apply';
        apply.onclick = () => { setDrawnLength(h.li, h.si, parseFloat(inp.value)); closeAsk(); };
        inp.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); apply.onclick(); } };
        const rst = document.createElement('button');
        rst.textContent = 'Reset';
        rst.title = 'Back to the length it had before this change';
        rst.onclick = () => { setDrawnLength(h.li, h.si, before); closeAsk(); };
        const no = document.createElement('button');
        no.textContent = 'Cancel'; no.onclick = closeAsk;
        r2.appendChild(apply); r2.appendChild(rst); r2.appendChild(no);
        box.appendChild(r2);
        askPopup = new maplibregl.Popup({ closeButton: false, offset: 12, maxWidth: '250px' })
          .setLngLat(lngLat).setDOMContent(box).addTo(m2);
        setTimeout(() => { inp.focus(); inp.select(); }, 0);
      }

      function askDeleteCorner(i, lngLat) {
        closeAsk();
        const box = document.createElement('div');
        box.className = 'fp-ask';
        const q = document.createElement('div');
        q.className = 'fp-ask-q';
        q.textContent = pts.length <= 3
          ? 'This outline is already a triangle — no corner can be removed.'
          : 'Remove this corner? The two walls either side will join up.';
        box.appendChild(q);
        const row = document.createElement('div');
        row.className = 'fp-ask-row';
        if (pts.length > 3) {
          const del = document.createElement('button');
          del.className = 'danger'; del.textContent = 'Remove';
          del.onclick = () => { pts.splice(i, 1); buildHandles(); paint(); closeAsk(); };
          row.appendChild(del);
        }
        const no = document.createElement('button');
        no.textContent = pts.length > 3 ? 'Cancel' : 'OK';
        no.onclick = closeAsk;
        row.appendChild(no);
        box.appendChild(row);
        askPopup = new maplibregl.Popup({ closeButton: false, offset: 12, maxWidth: '240px' })
          .setLngLat(lngLat).setDOMContent(box).addTo(m2);
      }

      function setEdgeLength(i, metres) {
        const j = (i + 1) % pts.length;
        const cur = distM(pts[i], pts[j]);
        if (!(cur > 0) || !(metres > 0)) return;
        const k = metres / cur;
        pts[j] = [pts[i][0] + (pts[j][0] - pts[i][0]) * k,
                  pts[i][1] + (pts[j][1] - pts[i][1]) * k];
        buildHandles(); paint();
      }

      function askEditLength(i, lngLat) {
        closeAsk();
        highlightEdge(i);
        const cur = distM(pts[i], pts[(i + 1) % pts.length]);
        const box = document.createElement('div');
        box.className = 'fp-ask';
        const q = document.createElement('div');
        q.className = 'fp-ask-q';
        q.textContent = 'Length of this wall, in metres:';
        box.appendChild(q);
        const row = document.createElement('div');
        row.className = 'fp-ask-row';
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = '0.5'; inp.max = '2000'; inp.step = '1';
        inp.value = String(Math.round(cur * 10) / 10);
        inp.className = 'fp-ask-in';
        row.appendChild(inp);
        box.appendChild(row);
        const row2 = document.createElement('div');
        row2.className = 'fp-ask-row';
        const apply = document.createElement('button');
        apply.className = 'go'; apply.textContent = 'Apply';
        apply.onclick = () => { setEdgeLength(i, parseFloat(inp.value)); closeAsk(); };
        inp.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); apply.onclick(); } };
        const rst = document.createElement('button');
        rst.textContent = 'Reset';
        rst.title = 'Back to this wall\u2019s original length';
        rst.disabled = originalLens[i] == null;
        rst.onclick = () => { setEdgeLength(i, originalLens[i]); closeAsk(); };
        const no = document.createElement('button');
        no.textContent = 'Cancel';
        no.onclick = closeAsk;
        row2.appendChild(apply); row2.appendChild(rst); row2.appendChild(no);
        box.appendChild(row2);
        const note = document.createElement('div');
        note.className = 'fp-ask-note';
        note.textContent = 'Kept when you save the building — Final or Temporary.';
        box.appendChild(note);
        askPopup = new maplibregl.Popup({ closeButton: false, offset: 12, maxWidth: '250px' })
          .setLngLat(lngLat).setDOMContent(box).addTo(m2);
        setTimeout(() => { inp.focus(); inp.select(); }, 0);
      }

      function onKey(ev) {
        if (ev.key !== 'Escape' || !draft.length) return;
        ev.preventDefault();
        const n = draft.length;
        drawnLines.push(draft.slice());
        clearDraft();
        buildHandles();
        if (opts.onStatus) {
          opts.onStatus(n === 1
            ? 'Point kept. Draw more, or press “Close shape” once a chain has three corners.'
            : 'Kept ' + (n - 1) + (n === 2 ? ' line.' : ' lines.') +
              ' Draw more, or press “Close shape” to turn a chain into the outline.');
        }
      }
      document.addEventListener('keydown', onKey);

      m2.on('load', () => {
        if (!m2.getSource('overture')) {
          m2.addSource('overture', { type: 'vector', url: SM.OVERTURE_BUILDINGS,
                                     promoteId: { building: 'id' } });
        }
        (m2.getStyle().layers || []).forEach((l) => {
          if (l['source-layer'] === 'building') m2.setLayoutProperty(l.id, 'visibility', 'none');
        });
        m2.addLayer({ id: 'ctx-3d', source: 'overture', 'source-layer': 'building',
          type: 'fill-extrusion', minzoom: 12,
          filter: ['!', ['in', ['get', 'id'], ['literal', hidden]]],
          paint: { 'fill-extrusion-color': '#c3ccd6',
                   'fill-extrusion-height': ['case', ['has', 'height'], ['get', 'height'],
                     ['has', 'num_floors'], ['*', ['get', 'num_floors'], SM.FLOOR_HEIGHT_M], 9],
                   'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
                   'fill-extrusion-opacity': 0.85, 'fill-extrusion-vertical-gradient': true } });
        m2.addSource('fp', { type: 'geojson', data: polyData() });
        m2.addSource('fp-all', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m2.addSource('fp-sel', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m2.addSource('fp-draft', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m2.addSource('fp-draft-pt', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m2.addSource('fp-draft-len', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m2.addSource('fp-lines', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m2.addSource('fp-lines-pt', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m2.addSource('fp-lines-len', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m2.addSource('fp-lines-fill', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m2.addSource('fp-snap', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m2.addSource('fp-edge', { type: 'geojson', data: edgeData() });
        m2.addLayer({ id: 'fp-fill', type: 'fill', source: 'fp',
          paint: { 'fill-color': '#22d3ee', 'fill-opacity': 0.3 } });
        m2.addLayer({ id: 'fp-line', type: 'line', source: 'fp',
          paint: { 'line-color': '#0d7a8c', 'line-width': 2.5 } });
        m2.addLayer({ id: 'fp-3d', type: 'fill-extrusion', source: 'fp-all',
          layout: { visibility: 'none' },
          paint: { 'fill-extrusion-color': '#22d3ee', 'fill-extrusion-height': height,
                   'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.55,
                   'fill-extrusion-vertical-gradient': true } });
        let font = ['Noto Sans Regular'];
        (m2.getStyle().layers || []).some((l) => {
          const f = l.layout && l.layout['text-font'];
          if (f && f.length) { font = f; return true; }
          return false;
        });
        m2.addLayer({ id: 'fp-sel', type: 'line', source: 'fp-sel',
          paint: { 'line-color': '#e5342a', 'line-width': 5, 'line-opacity': 0.95 } });
        m2.addLayer({ id: 'fp-lines-fill', type: 'fill', source: 'fp-lines-fill',
          paint: { 'fill-color': '#e8901b', 'fill-opacity': 0.16 } });
        m2.addLayer({ id: 'fp-lines-line', type: 'line', source: 'fp-lines',
          paint: { 'line-color': '#e8901b', 'line-width': 3 } });
        m2.addLayer({ id: 'fp-lines-dot', type: 'circle', source: 'fp-lines-pt',
          paint: { 'circle-radius': 5, 'circle-color': '#ffffff',
                   'circle-stroke-color': '#e8901b', 'circle-stroke-width': 2.5 } });
        m2.addLayer({ id: 'fp-draft-line', type: 'line', source: 'fp-draft',
          paint: { 'line-color': '#e8901b', 'line-width': 2.5, 'line-dasharray': [2, 1.4] } });
        m2.addLayer({ id: 'fp-draft-dot', type: 'circle', source: 'fp-draft-pt',
          paint: { 'circle-radius': ['case', ['==', ['get', 'first'], 1], 7, 5],
                   'circle-color': '#ffffff', 'circle-stroke-color': '#e8901b',
                   'circle-stroke-width': 2.5 } });
        m2.addLayer({ id: 'fp-lines-len', type: 'symbol', source: 'fp-lines-len',
          layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-font': font,
                    'text-allow-overlap': true, 'text-padding': 4 },
          paint: { 'text-color': '#8a4b00', 'text-halo-color': '#ffffff',
                   'text-halo-width': 2.2 } });
        m2.addLayer({ id: 'fp-draft-len', type: 'symbol', source: 'fp-draft-len',
          layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-font': font,
                    'text-allow-overlap': true, 'text-offset': [0, -1.1] },
          paint: { 'text-color': '#8a4b00', 'text-halo-color': '#ffffff',
                   'text-halo-width': 2.2 } });
        m2.addLayer({ id: 'fp-len', type: 'symbol', source: 'fp-edge',
          layout: {
            'text-field': ['get', 'label'], 'text-size': 12.5, 'text-font': font,
            'text-allow-overlap': true, 'text-ignore-placement': true,
            'text-padding': 3, 'text-anchor': 'center'
          },
          paint: { 'text-color': '#06333c', 'text-halo-color': '#ffffff',
                   'text-halo-width': 2.2, 'text-halo-blur': 0.3 } });
        m2.doubleClickZoom.disable();
        ['fp-fill', 'fp-line'].forEach((id) => {
          m2.on('dblclick', id, (ev) => {
            ev.preventDefault();
            const near = nearestEdge([ev.lngLat.lng, ev.lngLat.lat]);
            if (near.index < 0) return;
            askDeleteEdge(near.index, ev.lngLat);
          });
        });
        ['fp-lines-line', 'fp-lines-fill'].forEach((id) => {
          m2.on('dblclick', id, (ev) => {
            ev.preventDefault();
            const h = nearestDrawnSegment([ev.lngLat.lng, ev.lngLat.lat]);
            if (h) askDeleteDrawn(h, ev.lngLat);
          });
        });
        m2.on('click', 'fp-len', (ev) => {
          ev.preventDefault();
          const near = nearestEdge([ev.lngLat.lng, ev.lngLat.lat]);
          if (near.index >= 0) askEditLength(near.index, ev.lngLat);
        });
        m2.on('click', 'fp-lines-len', (ev) => {
          ev.preventDefault();
          const h = nearestDrawnSegment([ev.lngLat.lng, ev.lngLat.lat]);
          if (h) askEditDrawnLength(h, ev.lngLat);
        });
        m2.on('mouseenter', 'fp-lines-len', () => (m2.getCanvas().style.cursor = 'text'));
        m2.on('mouseleave', 'fp-lines-len', () => (m2.getCanvas().style.cursor = ''));
        m2.on('mouseenter', 'fp-len', () => (m2.getCanvas().style.cursor = 'text'));
        m2.on('mouseleave', 'fp-len', () => (m2.getCanvas().style.cursor = ''));
        m2.on('contextmenu', (ev) => {
          ev.preventDefault();
          const snap = snapAt(ev.point);
          addDraftPointAt(snap ? snap.point : [ev.lngLat.lng, ev.lngLat.lat],
                          snap ? snap.ref : null);
          if (snap && snap.kind === 'edge' && weldToSegment(snap.seg, snap.point)) {
            buildHandles(); paint(); paintDraft();
          }
          if (snap && opts.onStatus && draft.length) {
            opts.onStatus(snap.kind === 'corner'
              ? 'Joined to an existing corner. Right-click for the next one, or Esc to finish.'
              : 'Started on an existing wall. Right-click for the next corner, or Esc to finish.');
          }
          return;
          if (opts.onStatus) {
            opts.onStatus(draft.length === 1
              ? 'Wall started. Right-click where it ends.'
              : 'Right-click for the next corner, or click the first corner to close the shape.');
          }
        });
        m2.on('mousemove', (ev) => {
          const snap = snapAt(ev.point);
          showSnap(snap ? snap.point : null, snap && snap.kind);
          m2.getCanvas().style.cursor = (snap || draft.length) ? 'crosshair' : '';
          if (!draft.length) return;
          cursor = snap ? [snap.point[0], snap.point[1]] : [ev.lngLat.lng, ev.lngLat.lat];
          paintDraft();
        });
        pts.forEach((p, i) => originalLens.push(distM(p, pts[(i + 1) % pts.length])));
        ready = true;
        buildHandles();
        paint();
      });

      return {
        map: m2,
        getRing: () => (hasRing() ? pts.concat([pts[0]]) : null),
        getRings: () => buildParts().rings,
        openCount: () => buildParts().unusable,
        size: sizeOf,
        edges: () => pts.map((p, i) => distM(p, pts[(i + 1) % pts.length])),
        setSize(w, d) {
          const cur = sizeOf();
          if (!(cur.width > 0) || !(cur.depth > 0)) return;
          const ax = pts.reduce((a, p) => a + p[0], 0) / pts.length;
          const ay = pts.reduce((a, p) => a + p[1], 0) / pts.length;
          const sx = w > 0 ? w / cur.width : 1, sy = d > 0 ? d / cur.depth : 1;
          pts = pts.map((p) => [ax + (p[0] - ax) * sx, ay + (p[1] - ay) * sy]);
          buildHandles(); paint();
        },
        setBackdrop(on) {
          if (!ready) return;
          const keep = { 'fp-fill': 1, 'fp-line': 1, 'fp-len': 1, 'fp-3d': 1, 'fp-model-3d': 1 };
          if (!on) {
            if (snapshot) return;
            snapshot = {};
            (m2.getStyle().layers || []).forEach((l) => {
              if (keep[l.id]) return;
              snapshot[l.id] = m2.getLayoutProperty(l.id, 'visibility') || 'visible';
              m2.setLayoutProperty(l.id, 'visibility', 'none');
            });
          } else if (snapshot) {
            Object.keys(snapshot).forEach((id) => {
              if (m2.getLayer(id)) m2.setLayoutProperty(id, 'visibility', snapshot[id]);
            });
            snapshot = null;
          }
        },
        setHeight(h) {
          height = Math.max(0.5, Math.min(1000, +h || 20));
          if (ready && m2.getLayer('fp-3d')) m2.setPaintProperty('fp-3d', 'fill-extrusion-height', height);
        },
        showHeight(on) {
          if (ready && m2.getLayer('fp-3d')) {
            m2.setLayoutProperty('fp-3d', 'visibility', on ? 'visible' : 'none');
          }
        },
        setRotation(deg) {
          const want = Math.max(0, Math.min(360, +deg || 0));
          rotateBy(want - rotDeg);
          rotDeg = want;
        },
        placeModel: placeModel,
        clearModel: clearModel,
        setModelRotation(deg) {
          modelRot = Math.max(0, Math.min(360, +deg || 0));
          paintModel();
        },
        setModelScale(k) {
          modelScale = +k > 0 ? +k : 1;
          paintModel();
        },
        modelSize() {
          if (!modelShape) return null;
          return modelShape.size.map((v) => v * modelScale);
        },
        modelRaw() {
          return modelShape ? modelShape.size.slice() : null;
        },
        getModel() {
          if (!modelMarker || !modelName) return null;
          const l = modelMarker.getLngLat();
          return { model: modelName, rotation_deg: modelRot, scale: modelScale,
                   up_axis: modelUp,
                   anchor_lonlat: [SM.geo.round(l.lng, 7), SM.geo.round(l.lat, 7)] };
        },
        setTilt(on) {
          tilted = !!on;
          m2.easeTo({ pitch: tilted ? 55 : 0, duration: 600 });
        },
        isTilted: () => tilted,
        finishDraft, closeDraft, useAsOutline, clearDraft, clearDrawnLines,
        draftLength: () => draft.length,
        drawnCount: () => drawnLines.length,
        resize: () => m2.resize(),
        destroy() {
          document.removeEventListener('keydown', onKey);
          draft = []; cursor = null; drawnLines = [];
          clearHandles();
          if (askPopup) { askPopup.remove(); askPopup = null; }
          try { m2.remove(); } catch (e) {  }
        }
      };
    }

    let actions = {};

    let addArmed = false;
    function armAddBuilding() {
      addArmed = true;
      map.getCanvas().style.cursor = 'crosshair';
      if (actions.notify) actions.notify('Click the map where the new building should go.');
      map.once('click', (ev) => {
        addArmed = false;
        map.getCanvas().style.cursor = '';
        if (actions.notify) actions.notify('');
        const p = new maplibregl.Popup({ closeButton: true, offset: 12, maxWidth: '300px' });
        p.setLngLat(ev.lngLat).setDOMContent(newBuildingPopup([ev.lngLat.lng, ev.lngLat.lat], p)).addTo(map);
      });
    }

    function newBuildingPopup(lonlat, popup) {
      const box = document.createElement('div');
      box.className = 'bpop';
      const el = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
      };
      let chosenModel = null;

      function render() {
        box.textContent = '';
        box.onclick = (ev) => ev.stopPropagation();
        box.appendChild(el('b', 'bpop-name', 'New building'));
        box.appendChild(el('div', 'bpop-note',
          'At ' + lonlat[0].toFixed(5) + ', ' + lonlat[1].toFixed(5) + '. Give it a size, or drop one of your models here.'));

        const grid = el('div', 'bpop-dims');
        const mk = (label, val, title) => {
          const wrap = el('div', 'bpop-dim');
          wrap.appendChild(el('span', 'bpop-dimlab', label));
          const i = el('input');
          i.type = 'number'; i.min = '0.5'; i.max = '1000'; i.step = '1'; i.value = String(val);
          i.title = title;
          wrap.appendChild(i);
          grid.appendChild(wrap);
          return i;
        };
        const w = mk('Width m', 20, 'east–west size in metres');
        const d = mk('Depth m', 20, 'north–south size in metres');
        const h = mk('Height m', 15, 'height in metres');
        box.appendChild(grid);

        const row = el('div', 'bpop-act2');
        const add = el('button', null, 'Add building');
        add.title = 'Create a building of this size here — it is ray traced like any other';
        add.onclick = () => {
          if (actions.createBuilding) {
            actions.createBuilding(lonlat, { width: +w.value, depth: +d.value, height: +h.value });
          }
          if (popup) popup.remove();
        };
        row.appendChild(add);
        box.appendChild(row);

        const models = (actions.listModels && actions.listModels()) || [];
        box.appendChild(el('div', 'bpop-sep', 'or place one of your models'));
        if (models.length) {
          const sel = el('select');
          models.forEach((m) => { const o = el('option', null, m); o.value = m; sel.appendChild(o); });
          sel.value = chosenModel && models.indexOf(chosenModel) >= 0 ? chosenModel : models[0];
          chosenModel = sel.value;
          sel.onchange = () => { chosenModel = sel.value; };
          const r2 = el('div', 'bpop-row');
          r2.appendChild(sel);
          box.appendChild(r2);
          const r3 = el('div', 'bpop-act2');
          const place = el('button', 'ghost', 'Place model here');
          place.textContent = 'Place model here';
          place.onclick = () => {
            if (actions.placeModel && chosenModel) actions.placeModel(lonlat, chosenModel);
            if (popup) popup.remove();
          };
          r3.appendChild(place);
          box.appendChild(r3);
        }

        if (actions.uploadModel) {
          const lab = el('label', 'bpop-upload', '⭱ Upload a model (.ply .obj .glb .stl)');
          const file = el('input');
          file.type = 'file'; file.accept = '.ply,.obj,.glb,.gltf,.stl'; file.style.display = 'none';
          file.onchange = async (ev) => {
            const chosen = ev.target.files[0];
            ev.target.value = '';
            if (!chosen) return;
            lab.textContent = 'Uploading ' + chosen.name + '…';
            const res = await actions.uploadModel(chosen);
            if (res && res.name) { chosenModel = res.name; render(); }
            else lab.textContent = (res && res.error) || 'Upload failed.';
          };
          lab.appendChild(file);
          box.appendChild(lab);
        }
      }

      render();
      return box;
    }

    function addBuildings() {
      if (map.getLayer('3d-buildings')) return;
      captureBase();
      if (!map.getSource('overture')) {
        map.addSource('overture', {
          type: 'vector', url: buildingsUrl(),
          promoteId: { building: 'id' },
          attribution: '© <a href="https://overturemaps.org" target="_blank" rel="noopener">Overture Maps</a>'
        });
      }
      for (const l of (map.getStyle().layers || [])) {
        if (l['source-layer'] === 'building' && l.source !== 'overture') {
          map.setLayoutProperty(l.id, 'visibility', 'none');
        }
      }

      let labelId;
      for (const l of (map.getStyle().layers || [])) {
        if (l.type === 'symbol' && l.layout && l.layout['text-field']) { labelId = l.id; break; }
      }
      map.addLayer({
        id: '3d-buildings', source: 'overture', 'source-layer': 'building',
        type: 'fill-extrusion', minzoom: BUILDINGS_MINZOOM,
        paint: {
          'fill-extrusion-color': buildingColorExpr(SM.HEIGHT_RAMP),
          'fill-extrusion-height': heightRampExpr(),
          'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
          'fill-extrusion-opacity': 0.94,
          'fill-extrusion-vertical-gradient': true
        }
      }, labelId);

      if (!map.getLayer(REMOVED_LAYER)) {
        map.addLayer({
          id: REMOVED_LAYER, source: 'overture', 'source-layer': 'building',
          type: 'line', minzoom: BUILDINGS_MINZOOM,
          filter: ['in', ['get', 'id'], ['literal', []]],
          paint: { 'line-color': '#e0603f', 'line-width': 1.6, 'line-dasharray': [2, 1.5], 'line-opacity': 0.9 }
        });
        map.on('click', REMOVED_LAYER, (ev) => {
          const g = ev.features && ev.features[0];
          if (!g || onBuildingClick) return;
          const popup = new maplibregl.Popup({ closeButton: true, offset: 12, maxWidth: '300px' });
          popup.setLngLat(ev.lngLat).setDOMContent(buildingPopup(g, popup)).addTo(map);
        });
        map.on('mouseenter', REMOVED_LAYER, () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', REMOVED_LAYER, () => (map.getCanvas().style.cursor = ''));
      }
      refreshRemovedOutline();

      if (site) { addRoofLayer(); loadSiteTrees(site); loadSiteDetail(site); }

      applyBuildingPaint();

      attachAddOnEmptyGround();
      if (mayEdit) {
        map.on('mouseenter', '3d-buildings', () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', '3d-buildings', () => (map.getCanvas().style.cursor = ''));
        map.on('click', '3d-buildings', (e) => {
          const f = e.features && e.features[0]; if (!f) return;
          if (userBuiltAt(e.point)) return;
          if (onBuildingClick) { onBuildingClick(f, e); return; }
          if (addArmed) return;
          const popup = new maplibregl.Popup({ closeButton: true, offset: 12, maxWidth: '320px' });
          popup.setLngLat(e.lngLat).setDOMContent(buildingPopup(f, popup)).addTo(map);
        });
      }
    }

    let lastRight = null, rightPopup = null;
    const mayEdit = new URLSearchParams(location.search).get('chrome') !== 'operate';

    function attachAddOnEmptyGround() {
      if (!mayEdit) return;
      map.on('contextmenu', (e) => {
        const now = e.originalEvent && e.originalEvent.timeStamp || 0;
        const prev = lastRight;
        lastRight = { t: now, x: e.point.x, y: e.point.y };
        if (!prev || now - prev.t > 500
            || Math.hypot(e.point.x - prev.x, e.point.y - prev.y) > 14) return;
        lastRight = null;
        if (addArmed || onBuildingClick) return;
        const on = map.queryRenderedFeatures(e.point,
          { layers: ['3d-buildings', 'custom-buildings-3d'].filter((l) => map.getLayer(l)) });
        if (on.length) return;
        if (rightPopup) { rightPopup.remove(); rightPopup = null; }
        const box = document.createElement('div');
        box.className = 'bpop';
        box.onclick = (ev) => ev.stopPropagation();
        const t = document.createElement('b');
        t.className = 'bpop-name';
        t.textContent = 'Empty ground';
        box.appendChild(t);
        const sub = document.createElement('div');
        sub.className = 'bpop-note';
        sub.textContent = 'Nothing stands here. Draw a building, or place a model of one.';
        box.appendChild(sub);
        const acts = document.createElement('div');
        acts.className = 'bpop-act2';
        const b = document.createElement('button');
        b.textContent = 'Add a new building';
        b.title = 'Opens the same outline editor the building card opens';
        b.onclick = () => {
          if (rightPopup) { rightPopup.remove(); rightPopup = null; }
          if (actions.designNewBuilding) actions.designNewBuilding([e.lngLat.lng, e.lngLat.lat]);
        };
        acts.appendChild(b);
        box.appendChild(acts);
        rightPopup = new maplibregl.Popup({ closeButton: true, offset: 10, maxWidth: '300px' })
          .setLngLat(e.lngLat).setDOMContent(box).addTo(map);
      });
    }

    function userBuiltAt(point) {
      if (!map.getLayer('custom-buildings-3d')) return false;
      try {
        return map.queryRenderedFeatures(point, { layers: ['custom-buildings-3d'] })
          .some((g) => g.properties && g.properties.edit_id);
      } catch (err) { return false; }
    }

    function attachBuildingCard(layerId) {
      if (!mayEdit) return;
      map.on('mouseenter', layerId, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', layerId, () => (map.getCanvas().style.cursor = ''));
      map.on('click', layerId, (e) => {
        const f = e.features && e.features[0];
        if (!f || !f.properties || !f.properties.edit_id) return;
        if (onBuildingClick) { onBuildingClick(f, e); return; }
        if (addArmed) return;
        const popup = new maplibregl.Popup({ closeButton: true, offset: 12, maxWidth: '320px' });
        popup.setLngLat(e.lngLat).setDOMContent(buildingPopup(f, popup)).addTo(map);
      });
    }

    function setTime(hour) {
      const ln = (hour - 6) / 12;
      const elev = 90 * Math.sin(Math.PI * ln);
      const day = elev > 0;
      const polar = 90 - Math.min(Math.max(elev, 12), 75);
      const azimuth = Math.min(Math.max(ln, 0), 1) * 180;
      try { map.setLight({ anchor: 'viewport', color: day ? '#ffffff' : '#aeb8cf', intensity: day ? 0.6 : 0.25, position: [1.15, azimuth, polar] }); } catch (e) {}
      const sky = !day ? '#0b1020' : elev < 15 ? '#f5c07a' : '#8ec5ff';
      if (skyOn && typeof map.setSky === 'function') {
        try { map.setSky({ 'sky-color': sky, 'horizon-color': day ? '#dfeaff' : '#26304a', 'fog-color': day ? '#eef4ff' : '#141a2b', 'sky-horizon-blend': 0.5, 'horizon-fog-blend': 0.6 }); } catch (e) {}
      }
      return String(Math.floor(hour) % 24).padStart(2, '0') + ':' + String(Math.round((hour % 1) * 60)).padStart(2, '0');
    }

    function enableTerrain() {
      if (!terrainOn) return;
      ensureDemSource();
      map.setTerrain({ source: DEM_SRC, exaggeration: 1 });
    }
    map.on('load', enableTerrain);

    map.on('moveend', () => {
      if (map.terrain && map._elevationFreeze && !map.isMoving()) {
        map._elevationFreeze = false;
        map.triggerRepaint();
      }
    });

    SM.groundAt = function (lngLat) {
      if (!map.getTerrain()) return null;
      try {
        const z = map.queryTerrainElevation(lngLat);
        const abs = z == null ? null : z + (map.transform.elevation || 0);
        return abs ? abs : null;
      } catch (e) { return null; }
    };
    function toggleSky(hour) {
      skyOn = !skyOn;
      if (typeof map.setSky === 'function') { try { map.setSky(skyOn ? {} : undefined); } catch (e) {} }
      setTime(hour);
      return skyOn;
    }

    function viewboxFromView() {
      const b = map.getBounds();
      return b.getWest() + ',' + b.getNorth() + ',' + b.getEast() + ',' + b.getSouth();
    }

    async function search(q) {
      const vb = city.searchBias || viewboxFromView();
      const suffix = city.country ? ', ' + city.country : '';
      const hit = async (url) => {
        const r = await fetch(url, { headers: { 'Accept-Language': 'en' } });
        if (!r.ok) return null;
        const d = await r.json();
        return d.length ? d[0] : null;
      };
      const base = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&';
      let found = await hit(base + 'bounded=1&viewbox=' + vb + '&q=' + encodeURIComponent(q + suffix));
      if (!found) found = await hit(base + 'q=' + encodeURIComponent(q + suffix));
      if (!found) found = await hit(base + 'q=' + encodeURIComponent(q));
      if (!found) return null;
      const { lon, lat, display_name } = found;
      goTo({ center: [+lon, +lat], zoom: 16, pitch: 62, duration: 2000 });
      new maplibregl.Marker({ color: '#e8b04b' }).setLngLat([+lon, +lat]).addTo(map);
      return display_name;
    }

    const SETTLEMENT = ['city', 'town', 'village', 'hamlet', 'municipality', 'borough',
                        'suburb', 'neighbourhood', 'quarter', 'locality',
                        'isolated_dwelling', 'city_district'];
    function resultKind(r) {
      const t = r.addresstype || r.type || '';
      const cls = r.class || '';
      if (SETTLEMENT.indexOf(t) >= 0) return 0;
      if (SM.isRegionResult(r)) return 4;
      if (cls === 'highway' || cls === 'railway' || t === 'road' || t === 'railway') return 3;
      if (['building', 'amenity', 'tourism', 'office', 'shop', 'historic', 'leisure'].indexOf(cls) >= 0) return 1;
      return 2;
    }

    function normalise(r) {
      return {
        label: String(r.display_name || '').split(',').slice(0, 2).join(',').trim(),
        display_name: r.display_name, lon: +r.lon, lat: +r.lat, raw: r
      };
    }

    async function fromNominatim(q, bias) {
      let url = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=20&q=' +
        encodeURIComponent(q);
      if (bias) url += '&viewbox=' + [bias.lng - 2, bias.lat + 2, bias.lng + 2, bias.lat - 2].join(',');
      const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      if (!res.ok) {
        const err = new Error(res.status === 429
          ? 'Too many searches too quickly — pause a moment and try again.'
          : 'Search service returned ' + res.status);
        err.status = res.status;
        throw err;
      }
      return (await res.json()).map(normalise);
    }

    async function fromPhoton(q, bias) {
      let url = 'https://photon.komoot.io/api/?limit=15&lang=en&q=' + encodeURIComponent(q);
      if (bias) url += '&lat=' + bias.lat.toFixed(4) + '&lon=' + bias.lng.toFixed(4);
      const res = await fetch(url);
      if (!res.ok) throw new Error('Photon returned ' + res.status);
      return ((await res.json()).features || []).map(SM.fromPhoton).filter(Boolean).map(normalise);
    }

    async function searchPlace(q) {
      let bias = null;
      try { bias = map.getCenter(); } catch (e) {  }

      const settled = await Promise.allSettled([fromNominatim(q, bias), fromPhoton(q, bias)]);
      const lists = settled.map((s) => (s.status === 'fulfilled' ? s.value : []));
      if (!lists[0].length && !lists[1].length) {
        const failed = settled.filter((s) => s.status === 'rejected');
        if (failed.length === settled.length) throw failed[0].reason;
        return [];
      }

      const merged = [];
      const seen = {};
      lists.forEach((list, src) => list.forEach((m, i) => {
        const key = m.lat.toFixed(3) + ',' + m.lon.toFixed(3) + '|' +
          String(m.display_name || '').split(',')[0].trim().toLowerCase();
        if (seen[key]) return;
        seen[key] = 1;
        merged.push({ m: m, kind: resultKind(m.raw), i: i, src: src });
      }));
      merged.sort((a, b) => (a.kind - b.kind) || (a.i - b.i) || (a.src - b.src));
      return merged.slice(0, 12).map((x) => x.m);
    }

    function goTo(opts) {
      const o = Object.assign({ essential: true }, opts);
      if (terrainOn) map.easeTo(o); else map.flyTo(o);
    }

    function flyTo(l) { goTo({ center: l.center, zoom: l.zoom, pitch: l.pitch, bearing: l.bearing, duration: 2000 }); }
    function reset() { goTo(Object.assign({}, city.home, { duration: 1400 })); }

    function setCity(newCity, opts) {
      opts = opts || {};
      city = newCity;
      if (map.getLayer('3d-buildings')) {
        applyBuildingPaint();
        map.setPaintProperty('3d-buildings', 'fill-extrusion-height', heightRampExpr());
      }
      if (map.getLayer(ROOF_LAYER)) {
        map.setPaintProperty(ROOF_LAYER, 'fill-extrusion-base', roofTop(0));
        map.setPaintProperty(ROOF_LAYER, 'fill-extrusion-height', roofTop(0.06));
      }
      if (opts.flyTo !== false) {
        goTo(Object.assign({}, newCity.home, { duration: opts.duration || 2600 }));
      }
      return newCity;
    }

    function coverageImage(obj, metric) {
      if (!obj) return null;
      const imgs = obj.images || {};
      return imgs[metric] || obj.image || null;
    }

    function setCoverageBands(show) {
      if (!map.getLayer('coverage-bands')) return false;
      map.setLayoutProperty('coverage-bands', 'visibility', show ? 'visible' : 'none');
      return true;
    }

    function loadCoverage(obj, metric) {
      for (const id of ['coverage-bands', 'coverage-layer']) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      for (const id of ['coverage', 'coverage-bands-src']) {
        if (map.getSource(id)) map.removeSource(id);
      }
      if (!obj) return null;
      const url = coverageImage(obj, metric || obj.metric);
      if (!url) return null;
      map.addSource('coverage', { type: 'image', url, coordinates: obj.coordinates });
      const belowRays = map.getLayer('rays-3d') ? 'rays-3d' : undefined;
      map.addLayer({ id: 'coverage-layer', type: 'raster', source: 'coverage',
        paint: { 'raster-opacity': 0.45, 'raster-fade-duration': 0,
                 'raster-resampling': 'linear' } }, belowRays);
      if (obj.boundaries) {
        map.addSource('coverage-bands-src',
          { type: 'image', url: obj.boundaries, coordinates: obj.coordinates });
        map.addLayer({ id: 'coverage-bands', type: 'raster', source: 'coverage-bands-src',
          layout: { visibility: 'none' },
          paint: { 'raster-opacity': 0.9, 'raster-fade-duration': 0,
                   'raster-resampling': 'nearest' } }, belowRays);
      }
      if (obj.coordinates && obj.coordinates.length) {
        const lons = obj.coordinates.map((c) => c[0]), lats = obj.coordinates.map((c) => c[1]);
        map.fitBounds([[Math.min.apply(null, lons), Math.min.apply(null, lats)], [Math.max.apply(null, lons), Math.max.apply(null, lats)]], { padding: 60, pitch: 45, duration: 1500 });
      }
      return obj.stats || {};
    }

    const api = {
      home,
      get city() { return city; },
      addBuildings, setTime, toggleSky, search, searchPlace, flyTo, reset,
      setCity, loadCoverage, setCoverageBands,
      setSite, getSite: () => site, setTreesVisible, getTreesVisible: () => treesOn,
      treeCount: () => (treeLayer ? treeLayer.count() : 0),
      coverageMetrics: (obj) => Object.keys((obj && obj.images) || {}),
      setView, getView: () => view,
      setBuildingOpacity, getBuildingOpacity,
      setBuildingHeight, clearBuildingHeights, getBuildingHeights, loadSavedHeights,
      setBuildingEdit, getBuildingEdits, clearSessionEdit,
      attachBuildingCard: attachBuildingCard,
      setBuildingActions: (a) => { actions = a || {}; },
      createFootprintEditor, buildingOutline,
      buildingPieces: buildingPieces,
      armAddBuilding,
      getBuildingHeightMode: editModeOf, getBuildingEditMode: editModeOf,
      setHeightOverrideHandler: (fn) => { onHeightOverride = fn; },
      triggerGeolocate: () => geolocate.trigger(),
      renderedBuildingCount: () => {
        if (!map.getLayer('3d-buildings')) return 0;
        try { return map.queryRenderedFeatures({ layers: ['3d-buildings'] }).length; }
        catch (e) { return 0; }
      },
      getZoom: () => map.getZoom(),
      setPitch: (p) => map.easeTo({ pitch: p, duration: 800 }),
      setBuildingClickHandler: (fn) => { onBuildingClick = fn; },
      buildingHeightAt: (point) => {
        const f = map.queryRenderedFeatures(point, { layers: ['3d-buildings'] })[0];
        return f ? SM.buildingHeight(f.properties, city.heightFallbackM).m : null;
      }
    };
    return { map, api };
  }

  return { create };
})();
