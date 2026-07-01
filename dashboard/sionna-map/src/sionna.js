window.SM = window.SM || {};

const WEAK_SHARE = 0.01;

SM.coverageSummary = function (ov, s, metric) {
  if (!s) return 'Coverage overlay loaded.';
  ov = ov || {};
  const labels = { path_gain: 'Path gain', rss: 'RSS', sinr: 'SINR' };
  const unit = ((ov.units || {})[metric]) || 'dB';
  let txt = (labels[metric] || metric) + ': '
    + (s.covered_cells || 0) + '/' + (s.total_cells || 0) + ' cells reached';

  const band = (s.coverage || {})[metric];
  if (band && band.fraction_of_area != null) {
    txt += ', ' + (100 * band.fraction_of_area).toFixed(1) + '% of area \u2265 '
         + band.threshold_db + ' ' + (band.unit || unit);
  }

  const scale = (ov.scales || {})[metric];
  if (scale) txt += ', scale ' + scale[0] + '..' + scale[1] + ' ' + unit;

  const c = ov.contested;
  if (c && c.served) {
    txt += ' \u2014 contested ' + (100 * c.cells / c.served).toFixed(1) + '% at '
         + c.margin_db + ' dB';
    if (c.judgeable_fraction != null && c.judgeable_fraction < 0.9) {
      txt += ', but only ' + Math.round(100 * c.judgeable_fraction)
           + '% of it has been reached by more than one transmitter';
    }
  }
  return txt;
};

SM.sionna = function (map, api, hooks) {
  hooks = hooks || {};
  const NODE_STYLE = {
    gnb:   { color: '#ff4d4f', label: 'gNB',   defAGL: 25 },
    tower: { color: '#e8b04b', label: 'Tower', defAGL: 30 },
    ue:    { color: '#22d3ee', label: 'UE',    defAGL: 1.5 }
  };
  const ROUTE_COLOR = '#a78bfa';

  const state = {
    bbox: null, nodes: [], routes: [], edits: [], models: [], customBuildings: [], mode: null,
    pendingModel: null,
    site: null,
    rf: { band: 78, freq_hz: 3.48942e9, array: { rows: 1, cols: 4, pattern: 'tr38901', pol: 'V' }, tx_power_dbm: 43 },
    rayBand: 'all', rayTx: ''
  };
  const markers = {};
  const modelMarkers = {};
  let nid = 1, rid = 1, dragging = false, dragStart = null;
  let routeDraft = [], routeCursor = null, snapPoint = null;

  function init() {
    if (!map.getSource('sel')) {
      map.addSource('sel', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'sel-fill', type: 'fill', source: 'sel',
        paint: { 'fill-color': '#0EA5C6', 'fill-opacity': 0.16 } });
      map.addLayer({ id: 'sel-halo', type: 'line', source: 'sel',
        paint: { 'line-color': '#0B141A', 'line-width': 5, 'line-opacity': 0.18, 'line-blur': 2 } });
      map.addLayer({ id: 'sel-line', type: 'line', source: 'sel',
        paint: { 'line-color': '#0B8FA8', 'line-width': 3, 'line-opacity': 1 } });
    }

    if (!map.getSource('ho-arc')) {
      map.addSource('ho-arc', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'ho-arc-casing', source: 'ho-arc', type: 'line',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#0B141A', 'line-width': 7, 'line-opacity': 0.35, 'line-blur': 2 }
      });
      map.addLayer({
        id: 'ho-arc-line', source: 'ho-arc', type: 'line',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#d4836d',
          'line-width': 3,
          'line-opacity': 0.95,
          'line-dasharray': [2, 2]
        }
      });
    }

    if (!map.getSource('node-masts')) {
      map.addSource('node-masts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'node-masts-3d', source: 'node-masts', type: 'fill-extrusion',
        paint: { 'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-base': ['get', 'base'],
                 'fill-extrusion-height': ['get', 'top'], 'fill-extrusion-opacity': 1 }
      });
    }
    if (!map.getSource('custom-buildings')) {
      map.addSource('custom-buildings', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'custom-buildings-3d', source: 'custom-buildings', type: 'fill-extrusion',
        paint: {
          'fill-extrusion-color': ['match', ['get', 'kind'],
                                   'replaced', SM.EDIT_COLORS.replaced,
                                   'model', SM.EDIT_COLORS.model,
                                   SM.EDIT_COLORS.drawn],
          'fill-extrusion-height': ['coalesce', ['get', 'height'], 9],
          'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
          'fill-extrusion-opacity': 0.85, 'fill-extrusion-vertical-gradient': true
        },
        filter: ['!=', ['get', 'mesh'], 1]
      });
      map.addLayer({
        id: 'custom-buildings-mesh', source: 'custom-buildings', type: 'fill-extrusion',
        filter: ['==', ['get', 'mesh'], 1],
        paint: {
          'fill-extrusion-color': SM.EDIT_COLORS.model,
          'fill-extrusion-height': ['coalesce', ['get', 'height'], 9],
          'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
          'fill-extrusion-opacity': 0.02
        }
      });
      if (api.attachBuildingCard) {
        api.attachBuildingCard('custom-buildings-3d');
        api.attachBuildingCard('custom-buildings-mesh');
      }
    }
    if (!map.getSource('routes')) {
      map.addSource('routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'routes-line', type: 'line', source: 'routes',
        filter: ['all', ['!=', ['geometry-type'], 'Point'], ['!=', ['get', 'draft'], 1]],
        paint: { 'line-color': ROUTE_COLOR, 'line-width': 3 } });
      map.addLayer({ id: 'routes-draft', type: 'line', source: 'routes',
        filter: ['all', ['!=', ['geometry-type'], 'Point'], ['==', ['get', 'draft'], 1]],
        paint: { 'line-color': ROUTE_COLOR, 'line-width': 2.5, 'line-dasharray': [2, 1.4] } });
      map.addLayer({ id: 'routes-snap', type: 'circle', source: 'routes',
        filter: ['==', ['get', 'snap'], 1],
        paint: { 'circle-radius': 11, 'circle-color': ROUTE_COLOR, 'circle-opacity': 0.28,
                 'circle-stroke-color': ROUTE_COLOR, 'circle-stroke-width': 2 } });
      map.addLayer({ id: 'routes-dot', type: 'circle', source: 'routes',
        filter: ['all', ['==', ['geometry-type'], 'Point'], ['!=', ['get', 'snap'], 1]],
        paint: { 'circle-radius': ['case', ['==', ['get', 'end'], 1], 6.5, 5.5],
                 'circle-color': ['case', ['==', ['get', 'end'], 1], ROUTE_COLOR, '#ffffff'],
                 'circle-stroke-color': ROUTE_COLOR, 'circle-stroke-width': 2.5 } });
    }
    api.setHeightOverrideHandler((all) => {
      const MINE = { set_height: 1, delete: 1, replace_with_model: 1, replace_with_building: 1 };
      state.edits = state.edits.filter((e) => !MINE[e.op]).concat(
        Object.keys(all).map((id) => Object.assign({ overture_id: id }, all[id])));
      renderReplacementMarkers();
      updateCustomSource();
      emit();
    });

  map.on('mousemove', (e) => {
    if (state.mode !== 'route' || !routeDraft.length) return;
    routeCursor = [e.lngLat.lng, e.lngLat.lat];
    renderRoutes();
  });
  document.addEventListener('keydown', (e) => {
    if (state.mode !== 'route' || !routeDraft.length) return;
    if (e.key === 'Escape') { e.preventDefault(); finishRoute(); }
  });

  map.on('mousedown', onDown);
    map.on('mousemove', onMove);
    map.on('mouseup', onUp);
    map.on('click', onClick);
  }

  const replaceMarkers = {};
  function renderReplacementMarkers() {
    const want = {};
    state.edits.forEach((e) => {
      if (e.op === 'replace_with_model' && e.anchor_lonlat) want[e.overture_id] = e;
    });
    Object.keys(replaceMarkers).forEach((id) => {
      if (!want[id]) { replaceMarkers[id].remove(); delete replaceMarkers[id]; }
    });
    Object.keys(want).forEach((id) => {
      if (replaceMarkers[id]) { replaceMarkers[id].setLngLat(want[id].anchor_lonlat); return; }
      const el = document.createElement('div');
      el.style.cssText = 'width:15px;height:15px;border:2px solid #fff;background:#a78bfa;' +
        'transform:rotate(45deg);box-shadow:0 0 0 2px rgba(0,0,0,.4)';
      el.title = 'replaced by ' + want[id].model;
      replaceMarkers[id] = new maplibregl.Marker({ element: el })
        .setLngLat(want[id].anchor_lonlat).addTo(map);
    });
  }

  function replacementFeatures() {
    const out = [];
    state.edits.forEach((e) => {
      if (e.op === 'replace_with_model' && e.anchor_lonlat) {
        const up = e.up_axis === 'y' ? 'y' : 'z';
        const key = e.model + '|' + up;
        if (SM.modelShapes[key] === undefined) {
          SM.modelShape(e.model, up).then(() => updateCustomSource());
          return;
        }
        const sh = SM.modelShapes[key];
        if (!sh) return;
        out.push({
          type: 'Feature',
          properties: { id: 'model-' + e.overture_id, edit_id: e.overture_id, kind: 'model',
                        mesh: modelLayers[e.overture_id] ? 1 : 0,
                        height: (sh.height_m || 3) * (+e.scale > 0 ? +e.scale : 1),
                        min_height: 0, source: 'custom',
                        material: SM.MATERIALS.default },
          geometry: { type: 'Polygon',
                      coordinates: [SM.modelRing(sh, e.anchor_lonlat, e.rotation_deg, e.scale)] }
        });
        return;
      }
      if (e.op !== 'replace_with_building') return;
      const rings = Array.isArray(e.rings) && e.rings.length ? e.rings
        : (Array.isArray(e.ring) ? [e.ring] : []);
      rings.forEach((ring, k) => {
        if (!Array.isArray(ring) || ring.length < 3) return;
        out.push({
          type: 'Feature',
          properties: { id: 'repl-' + e.overture_id + (k ? '-' + k : ''),
                        edit_id: e.overture_id, part: k,
                        kind: String(e.overture_id).indexOf('new-') === 0 ? 'drawn' : 'replaced',
                        height: SM.geo.round(+e.height_m || 15, 1),
                        min_height: 0, source: 'custom', material: SM.MATERIALS.default },
          geometry: { type: 'Polygon', coordinates: [ring] }
        });
      });
    });
    return out;
  }

  const modelLayers = {};
  function syncModelMeshes() {
    const want = {};
    state.edits.forEach((e) => {
      if (e.op === 'replace_with_model' && e.anchor_lonlat) want[e.overture_id] = e;
    });
    Object.keys(modelLayers).forEach((id) => {
      if (want[id]) return;
      try { map.removeLayer(modelLayers[id].id); } catch (err) {}
      delete modelLayers[id];
    });
    Object.keys(want).forEach((id) => {
      const e = want[id];
      const up = e.up_axis === 'y' ? 'y' : 'z';
      const key = e.model + '|' + up;
      if (SM.modelMeshes[key] === undefined) {
        SM.modelMesh(e.model, up).then(() => { syncModelMeshes(); updateCustomSource(); });
        return;
      }
      const mesh = SM.modelMeshes[key];
      if (!mesh) return;
      let layer = modelLayers[id];
      if (!layer) {
        layer = SM.createMeshLayer('model-mesh-' + id);
        layer.setColor([0.90, 0.21, 0.16], 1.0);
        map.addLayer(layer);
        layer.setMesh(mesh.pos, mesh.norm);
        modelLayers[id] = layer;
      }
      layer.setPlacement(e.anchor_lonlat, e.rotation_deg || 0, e.scale || 1);
    });
    map.triggerRepaint();
  }

  function updateCustomSource() {
    syncModelMeshes();
    const s = map.getSource('custom-buildings');
    if (s) s.setData({ type: 'FeatureCollection',
                       features: state.customBuildings.concat(replacementFeatures()) });
  }

  function setSel(feature) {
    map.getSource('sel').setData(feature ? { type: 'FeatureCollection', features: [feature] } : { type: 'FeatureCollection', features: [] });
  }

  function onDown(e) {
    if (state.mode !== 'area') return;
    dragging = true; dragStart = [e.lngLat.lng, e.lngLat.lat];
    map.dragPan.disable();
    e.preventDefault();
  }
  function onMove(e) {
    if (!dragging) return;
    const b = SM.geo.bboxFromCorners(dragStart, [e.lngLat.lng, e.lngLat.lat]);
    setSel(SM.geo.bboxPolygon(b));
  }
  function onUp(e) {
    if (!dragging) return;
    dragging = false; map.dragPan.enable();
    state.bbox = SM.geo.bboxFromCorners(dragStart, [e.lngLat.lng, e.lngLat.lat]);
    setMode(null);
    emit();
  }

  function onClick(e) {
    const m = state.mode;
    if (m === 'route') { onRouteClick(e); return; }
    if (m === 'model') {
      if (state.pendingModel) {
        addModel(state.pendingModel, [e.lngLat.lng, e.lngLat.lat], {});
        setMode(null);
      }
      return;
    }
    if (m === 'building') {
      addBuildingAt([e.lngLat.lng, e.lngLat.lat], hooks.newBuilding ? hooks.newBuilding() : {});
      return;
    }
    if (m !== 'gnb' && m !== 'tower' && m !== 'ue') return;
    if (m === 'ue') {
      const hit = routeNear(e.point);
      if (hit) {
        addNode({ type: 'ue', lonlat: [hit.p[0], hit.p[1]], heightAGL: 1.5,
                  on: 'ground', routeId: hit.route.id });
        return;
      }
    }
    if (m === 'gnb' && gnbFull()) { refuseGnb(); return; }
    const roof = api.buildingHeightAt(e.point);
    const st = NODE_STYLE[m];
    const onWhat = roof != null ? 'building' : 'ground';
    let agl = st.defAGL;
    if (roof != null && m !== 'tower') agl = SM.geo.round(roof + (m === 'gnb' ? 3 : 1.5), 1);
    addNode({ type: m, lonlat: [e.lngLat.lng, e.lngLat.lat], heightAGL: agl, on: onWhat });
    if (m === 'gnb' && gnbFull()) setMode(null);
  }

  function onRouteClick(e) {
    const p = [e.lngLat.lng, e.lngLat.lat];
    const last = routeDraft[routeDraft.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-9 && Math.abs(last[1] - p[1]) < 1e-9) {
      finishRoute();
      return;
    }
    if (last) {
      const a = map.project(last), b = map.project(p);
      if (Math.hypot(a.x - b.x, a.y - b.y) < 10) { finishRoute(); return; }
    }
    routeDraft.push(p);
    renderRoutes();
  }

  function finishRoute() {
    const pts = routeDraft.slice();
    routeDraft = []; routeCursor = null;
    if (pts.length < 2) { renderRoutes(); return; }
    state.routes.push({ id: 'r' + rid++, points: pts });
    renderRoutes();
    setMode(null);
    emit();
  }

  function removeRoute(id) {
    state.routes = state.routes.filter((r) => r.id !== id);
    state.nodes.forEach((n) => { if (n.routeId === id) n.routeId = null; });
    renderRoutes(); emit();
  }

  function cancelRoute() { routeDraft = []; routeCursor = null; renderRoutes(); }

  const SNAP_PX = 16;
  function routeNear(screenPt) {
    let best = null, bestD = SNAP_PX;
    state.routes.forEach((r) => {
      const pts = r.points || [];
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = map.project(pts[i]), b = map.project(pts[i + 1]);
        const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((screenPt.x - a.x) * dx + (screenPt.y - a.y) * dy) / l2)) : 0;
        const px = a.x + t * dx, py = a.y + t * dy;
        const d = Math.hypot(screenPt.x - px, screenPt.y - py);
        if (d <= bestD) {
          bestD = d;
          const ll = map.unproject([px, py]);
          best = { route: r, p: [ll.lng, ll.lat] };
        }
      }
    });
    return best;
  }

  function showRouteSnap(p) { snapPoint = p || null; renderRoutes(); }

  function renderRoutes() {
    const feats = [];
    state.routes.forEach((r) => {
      const pts = r.points || [];
      if (pts.length < 2) return;
      feats.push({ type: 'Feature', properties: { id: r.id },
                   geometry: { type: 'LineString', coordinates: pts } });
      feats.push({ type: 'Feature', properties: { end: 0 },
                   geometry: { type: 'Point', coordinates: pts[0] } });
      feats.push({ type: 'Feature', properties: { end: 1 },
                   geometry: { type: 'Point', coordinates: pts[pts.length - 1] } });
    });
    if (routeDraft.length) {
      const live = routeCursor ? routeDraft.concat([routeCursor]) : routeDraft;
      if (live.length >= 2) {
        feats.push({ type: 'Feature', properties: { draft: 1 },
                     geometry: { type: 'LineString', coordinates: live } });
      }
      routeDraft.forEach((p, i) => feats.push({
        type: 'Feature', properties: { end: i === routeDraft.length - 1 && routeDraft.length > 1 ? 1 : 0 },
        geometry: { type: 'Point', coordinates: p } }));
    }
    if (snapPoint) {
      feats.push({ type: 'Feature', properties: { snap: 1 },
                   geometry: { type: 'Point', coordinates: snapPoint } });
    }
    if (map.getSource('routes')) map.getSource('routes').setData({ type: 'FeatureCollection', features: feats });
  }

  const MAX_GNB = 2;
  function gnbCount() { return state.nodes.filter((n) => n.type === 'gnb').length; }
  function gnbFull() { return gnbCount() >= MAX_GNB; }
  function refuseGnb() {
    if (hooks.notify) {
      hooks.notify(MAX_GNB + ' gNBs at most — remove one to place it somewhere else.');
    }
    return null;
  }

  function addNode(n) {
    n.id = 'n' + nid++;
    n.name = (NODE_STYLE[n.type].label + '-' + n.id);
    if (n.type !== 'ue') {
      n.rf = { band: state.rf.band, freq_hz: state.rf.freq_hz,
        array: Object.assign({}, state.rf.array), pol: state.rf.array.pol,
        tx_power_dbm: state.rf.tx_power_dbm, azimuth_deg: 0, downtilt_deg: 6 };
    }
    state.nodes.push(n);
    const el = document.createElement('div');
    el.style.cssText = 'width:18px;height:18px;border-radius:50%;border:3px solid #fff;'
      + 'box-shadow:0 2px 6px rgba(9,26,34,.45);background:' + NODE_STYLE[n.type].color;
    const mk = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(n.lonlat).addTo(map);
    mk.getElement().title = n.name;
    if (n.type === 'ue') {
      mk.on('drag', () => {
        const l = mk.getLngLat();
        const hit = routeNear(map.project([l.lng, l.lat]));
        if (hit) mk.setLngLat(hit.p);
        showRouteSnap(hit ? hit.p : null);
      });
      mk.on('dragend', () => {
        const l = mk.getLngLat();
        const hit = routeNear(map.project([l.lng, l.lat]));
        const p = hit ? hit.p : [l.lng, l.lat];
        if (hit) { mk.setLngLat(p); n.on = 'ground'; }
        n.lonlat = [p[0], p[1]];
        n.routeId = hit ? hit.route.id : null;
        showRouteSnap(null);
        renderRoutes(); emit();
      });
    } else {
      mk.on('dragend', () => { const p = mk.getLngLat(); n.lonlat = [p.lng, p.lat]; renderRoutes(); emit(); });
    }
    markers[n.id] = mk;
    renderRoutes();
    emit();
  }
  let liveMk = null;
  const liveTrail = [];
  function setLiveUE(enu, opts) {
    const o = opts || {};
    if (map.style && typeof map.isStyleLoaded === 'function' && !map.isStyleLoaded()) return null;
    if (!enu) {
      if (liveMk) { liveMk.remove(); liveMk = null; }
      clearLiveLink();
      liveTrail.length = 0;
      if (map.getSource('livetrail')) {
        map.getSource('livetrail').setData({ type: 'FeatureCollection', features: [] });
      }
      return null;
    }
    const org = state.origin || (state.bbox ? SM.geo.bboxCenter(state.bbox) : api.home.center);
    const ll = SM.geo.fromENU(enu[0], enu[1], org[0], org[1]);
    if (!liveMk) {
      const el = document.createElement('div');
      el.className = 'live-rx';
      el.title = 'Where the channel is being traced';
      const tag = document.createElement('span');
      tag.className = 'live-rx-tag';
      el.appendChild(tag);
      liveMk = new maplibregl.Marker({ element: el }).setLngLat(ll).addTo(map);
    } else {
      liveMk.setLngLat(ll);
    }
    liveTrail.push(ll);
    while (liveTrail.length > (o.trail || 40)) liveTrail.shift();
    if (!map.getSource('livetrail')) {
      map.addSource('livetrail', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'livetrail-line', type: 'line', source: 'livetrail',
        paint: { 'line-color': '#5FD3A6', 'line-width': 3, 'line-opacity': 0.75 } });
    }
    map.getSource('livetrail').setData({
      type: 'FeatureCollection',
      features: liveTrail.length > 1
        ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: liveTrail.slice() } }]
        : []
    });
    drawLiveLink(ll, o);
    return ll;
  }

  const LINK_SRC = 'livelink';
  const LINK_COLOUR = '#b58392';

  let linkEnabled = false;

  let arcLayer = null;
  function ensureArcLayer() {
    if (arcLayer || !window.SM || !SM.makeArc3D) return arcLayer;
    arcLayer = SM.makeArc3D('livelink-arc');
    arcLayer.setColor([0.710, 0.514, 0.573], 0.95);
    try { map.addLayer(arcLayer); } catch (e) { arcLayer = null; }
    return arcLayer;
  }
  function drawLiveLink(rxLL, o) {
    const tag = liveMk && liveMk.getElement().querySelector('.live-rx-tag');
    if (!linkEnabled) {
      if (tag) { tag.textContent = ''; tag.style.display = 'none'; }
      clearLiveLink();
      return;
    }
    const tx = servingTxNode();
    const el = tag;
    if (el) {
      el.textContent = o.gain_db != null
        ? Math.round(o.gain_db) + ' dB' + (o.paths != null ? ' · ' + o.paths + ' paths' : '')
        : '';
      el.style.display = o.gain_db != null ? 'block' : 'none';
    }
    if (!tx) return;
    const drop = o.applied_db != null ? o.applied_db : 0;
    const weak = drop >= 25 || (o.paths != null && o.paths <= 4);
    const arc = ensureArcLayer();
    if (arc) arc.setArc(rxLL, tx.lonlat, { width_px: weak ? 4 : 5.5 });
    const data = { type: 'Feature', properties: {},
                   geometry: { type: 'LineString', coordinates: [rxLL, tx.lonlat] } };
    if (!map.getSource(LINK_SRC)) {
      map.addSource(LINK_SRC, { type: 'geojson', data: data });
      map.addLayer({ id: 'livelink-solid', type: 'line', source: LINK_SRC,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': LINK_COLOUR, 'line-width': 2.5, 'line-opacity': 0.95 } });
      map.addLayer({ id: 'livelink-weak', type: 'line', source: LINK_SRC,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': LINK_COLOUR, 'line-width': 1.6, 'line-opacity': 0.6 } });
    } else {
      map.getSource(LINK_SRC).setData(data);
    }
    const haveArc = !!arc;
    ['livelink-solid', 'livelink-weak'].forEach((id) => {
      if (!map.getLayer(id)) return;
      const wanted = !haveArc && ((id === 'livelink-weak') === weak);
      map.setLayoutProperty(id, 'visibility', wanted ? 'visible' : 'none');
    });
  }

  function clearLiveLink() {
    if (arcLayer) arcLayer.clear();
    ['livelink-solid', 'livelink-weak'].forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
    if (map.getSource(LINK_SRC)) map.removeSource(LINK_SRC);
  }

  function removeNode(id) {
    state.nodes = state.nodes.filter((n) => n.id !== id);
    if (markers[id]) { markers[id].remove(); delete markers[id]; }
    renderRoutes();
    emit();
  }
  function setNodeHeight(id, h) { const n = state.nodes.find((x) => x.id === id); if (n) { n.heightAGL = +h; emit(); } }
  function setNodeRF(id, key, val) {
    const n = state.nodes.find((x) => x.id === id);
    if (n && n.rf) { n.rf[key] = +val; emit(); }
  }
  function setRF(key, val) {
    if (key === 'freq_ghz') state.rf.freq_hz = +val * 1e9;
    else if (key === 'cols') state.rf.array.cols = Math.max(1, Math.round(+val));
    else if (key === 'power') state.rf.tx_power_dbm = +val;
    emit();
  }

  function onBuildingEdit(f) {
    const id = f.properties.id;
    const cur = f.properties.height != null ? Math.round(f.properties.height) : '(none)';
    const name = SM.buildingName(f.properties);
    if (hooks.onBuildingEdit) hooks.onBuildingEdit({ id, name, currentHeight: cur }, {
      setHeight: (h) => api.setBuildingEdit(id, { op: 'set_height', height_m: parseFloat(h) }),
      remove: () => api.setBuildingEdit(id, { op: 'delete' }),
      replaceModel: (model, rot, scale) => api.setBuildingEdit(id, {
        op: 'replace_with_model', model: model,
        anchor_lonlat: centroid(f), rotation_deg: +rot || 0, scale: +scale || 1
      })
    });
  }
  function pushEdit(ed) { state.edits = state.edits.filter((e) => !(e.overture_id === ed.overture_id && e.op === ed.op)); state.edits.push(ed); emit(); }
  function centroid(f) {
    const r = f.geometry.coordinates[0] || [[0, 0]];
    let x = 0, y = 0; r.forEach((p) => { x += p[0]; y += p[1]; });
    return [SM.geo.round(x / r.length, 6), SM.geo.round(y / r.length, 6)];
  }

  function addModel(model, lonlat, opts) {
    opts = opts || {};
    const entry = {
      id: 'm' + (state.models.length + 1), model: model, anchor_lonlat: lonlat,
      height_offset_m: +opts.z || 0, rotation_deg: +opts.rot || 0, scale: +opts.scale || 1,
      material: opts.material || SM.MATERIALS.default
    };
    state.models.push(entry);
    const el = document.createElement('div');
    el.style.cssText = 'width:14px;height:14px;border:2px solid #fff;background:#a78bfa;' +
      'transform:rotate(45deg);box-shadow:0 0 0 2px rgba(0,0,0,.4)';
    const mk = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(lonlat).addTo(map);
    mk.getElement().title = entry.id + ' · ' + model;
    mk.on('dragend', () => { const p = mk.getLngLat(); entry.anchor_lonlat = [p.lng, p.lat]; emit(); });
    modelMarkers[entry.id] = mk;
    emit();
    return entry;
  }
  function removeModel(id) {
    state.models = state.models.filter((m) => m.id !== id);
    if (modelMarkers[id]) { modelMarkers[id].remove(); delete modelMarkers[id]; }
    emit();
  }
  function setPendingModel(path) { state.pendingModel = path || null; emit(); }

  function effectiveBbox() {
    if (state.bbox) return state.bbox;
    try {
      const b = map.getBounds();
      return { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() };
    } catch (e) { return null; }
  }
  function origin() { const b = effectiveBbox(); return b ? SM.geo.bboxCenter(b) : api.home.center; }
  function manifest() {
    const eb = effectiveBbox();
    const [lon0, lat0] = eb ? SM.geo.bboxCenter(eb) : api.home.center;
    const size = eb ? SM.geo.bboxSizeM(eb).map((v) => SM.geo.round(v, 1)) : null;
    return {
      version: 1,
      generator: 'sionna-map',
      city: (state.site && state.site.name) || api.city.label,
      crs: { type: 'ENU', origin_lonlat: [SM.geo.round(lon0, 6), SM.geo.round(lat0, 6)], axes: 'x=East(m), y=North(m), z=Up(m)' },
      bbox: eb ? {
        min_lon: SM.geo.round(eb.minLon, 6), min_lat: SM.geo.round(eb.minLat, 6),
        max_lon: SM.geo.round(eb.maxLon, 6), max_lat: SM.geo.round(eb.maxLat, 6), size_m: size
      } : null,
      buildings: state.site ? {
        source: 'site', site: state.site.id, layer: 'building',
        height_field: 'height', base_field: 'min_height', height_fallback_m: api.city.heightFallbackM,
        default_material: SM.MATERIALS.default
      } : {
        source: 'overture', release: SM.OVERTURE_RELEASE, layer: 'building',
        height_field: 'height', base_field: 'min_height', height_fallback_m: api.city.heightFallbackM,
        default_material: SM.MATERIALS.default
      },
      site: state.site ? Object.assign({}, state.site) : null,
      building_edits: state.edits,
      custom_buildings: state.customBuildings,
      custom_models: state.models,
      routes: state.routes.map((r) => ({
        id: r.id,
        points: (r.points || []).map((q) => [SM.geo.round(q[0], 6), SM.geo.round(q[1], 6)])
      })),
      nodes: state.nodes.map((n) => {
        const enu = SM.geo.toENU(n.lonlat[0], n.lonlat[1], lon0, lat0);
        const out = {
          id: n.id, type: n.type, name: n.name,
          lonlat: [SM.geo.round(n.lonlat[0], 6), SM.geo.round(n.lonlat[1], 6)],
          height_agl_m: n.heightAGL, on: n.on,
          enu_m: [SM.geo.round(enu[0], 2), SM.geo.round(enu[1], 2), n.heightAGL],
          route_id: n.routeId || null,
          rf: n.rf ? {
            band: n.rf.band, freq_hz: n.rf.freq_hz,
            array: { rows: n.rf.array.rows, cols: n.rf.array.cols, pattern: n.rf.array.pattern, pol: n.rf.array.pol },
            tx_power_dbm: n.rf.tx_power_dbm, azimuth_deg: n.rf.azimuth_deg, downtilt_deg: n.rf.downtilt_deg
          } : null
        };
        const onRoute = n.routeId ? state.routes.find((r) => r.id === n.routeId) : null;
        if (onRoute) {
          const pts = onRoute.points;
          const s = SM.geo.toENU(pts[0][0], pts[0][1], lon0, lat0);
          const e = SM.geo.toENU(pts[pts.length - 1][0], pts[pts.length - 1][1], lon0, lat0);
          out.route_points_enu = pts.map((p) => {
            const q = SM.geo.toENU(p[0], p[1], lon0, lat0);
            return [SM.geo.round(q[0], 2), SM.geo.round(q[1], 2), n.heightAGL];
          });
          out.route_enu = { start: [SM.geo.round(s[0], 2), SM.geo.round(s[1], 2), n.heightAGL],
                            end: [SM.geo.round(e[0], 2), SM.geo.round(e[1], 2), n.heightAGL] };
        }
        return out;
      })
    };
  }
  function exportManifest() {
    const blob = new Blob([JSON.stringify(manifest(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'scene_manifest_' + (api.city.label.toLowerCase().replace(/[^a-z]+/g, '_')) + '.json';
    a.click(); URL.revokeObjectURL(a.href);
  }
  function importManifest(obj) {
    clearAll();
    setSite(obj.site || null);
    state.origin = (obj.crs && obj.crs.origin_lonlat) || null;
    if (obj.bbox) { state.bbox = { minLon: obj.bbox.min_lon, minLat: obj.bbox.min_lat, maxLon: obj.bbox.max_lon, maxLat: obj.bbox.max_lat }; setSel(SM.geo.bboxPolygon(state.bbox)); }
    state.edits = obj.building_edits || [];
    state.edits.forEach((e) => {
      if (e.op === 'set_height' || e.op === 'delete' || e.op === 'replace_with_model'
          || e.op === 'replace_with_building') {
        api.setBuildingEdit(e.overture_id, e, { silent: true });
      }
    });
    renderReplacementMarkers();
    state.customBuildings = obj.custom_buildings || [];
    updateCustomSource();
    state.models = obj.custom_models || [];
    const byOldId = {};
    (obj.routes || []).forEach((r) => {
      if (!Array.isArray(r.points) || r.points.length < 2) return;
      const route = { id: 'r' + rid++, points: r.points.map((q) => [q[0], q[1]]) };
      state.routes.push(route);
      if (r.id) byOldId[r.id] = route.id;
    });
    (obj.nodes || []).forEach((n) => {
      const node = { type: n.type, lonlat: n.lonlat, heightAGL: n.height_agl_m, on: n.on || 'ground' };
      if (n.route_id && byOldId[n.route_id]) {
        node.routeId = byOldId[n.route_id];
      } else if (n.route_enu) {
        const enu = (Array.isArray(n.route_points_enu) && n.route_points_enu.length >= 2)
          ? n.route_points_enu : [n.route_enu.start, n.route_enu.end];
        const pts = enu.map((q) => SM.geo.fromENU(q[0], q[1], obj.crs.origin_lonlat[0], obj.crs.origin_lonlat[1]));
        const r = { id: 'r' + rid++, points: pts };
        state.routes.push(r);
        node.routeId = r.id;
      }
      addNode(node);
      if (n.rf) { const added = state.nodes[state.nodes.length - 1]; added.rf = Object.assign(added.rf || {}, { freq_hz: n.rf.freq_hz, tx_power_dbm: n.rf.tx_power_dbm, azimuth_deg: n.rf.azimuth_deg, downtilt_deg: n.rf.downtilt_deg }); if (n.rf.array) added.rf.array = Object.assign(added.rf.array || {}, n.rf.array); }
    });
    renderRoutes();
    emit();
  }

  function resolveHeight(p) { return SM.buildingHeight(p, api.city.heightFallbackM).m; }
  function inBbox(pt, b) { return pt[0] >= b.minLon && pt[0] <= b.maxLon && pt[1] >= b.minLat && pt[1] <= b.maxLat; }

  let siteFeatures = null, siteFeaturesFor = null;
  async function loadSiteFeatures(s) {
    siteFeatures = null; siteFeaturesFor = s ? s.id : null;
    if (!s) return;
    try {
      const r = await fetch('/api/map/sites/' + encodeURIComponent(s.id) + '/buildings.geojson');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const fc = await r.json();
      if (siteFeaturesFor === s.id) siteFeatures = fc.features || [];
    } catch (err) {
      console.warn('site buildings:', err && err.message);
    }
  }
  function setSite(s, opts) {
    const want = s && s.id ? { id: String(s.id), name: s.name || String(s.id) } : null;
    const changed = (state.site && state.site.id) !== (want && want.id);
    state.site = want;
    api.setSite(want, opts);
    if (changed || (opts && opts.force) || (want && !siteFeatures)) loadSiteFeatures(want);
    if (changed) emit();
    return want;
  }

  function areaBuildings() {
    const bbox = effectiveBbox();
    if (!bbox) return null;
    const editById = {}; state.edits.forEach((e) => (editById[e.overture_id] = e));
    const seen = {}, out = [];
    let raw = [];
    const fromSite = !!(state.site && siteFeatures && siteFeaturesFor === state.site.id);
    if (fromSite) raw = siteFeatures;
    else {
      if (state.site) console.warn('site footprints not loaded yet; exporting the map tiles instead');
      try { raw = map.querySourceFeatures('overture', { sourceLayer: 'building' }); } catch (e) { raw = []; }
    }
    raw.forEach((f) => {
      const id = f.properties && f.properties.id; if (id == null || seen[id]) return;
      if (!inBbox(centroid(f), bbox)) return;
      const ed = editById[id];
      seen[id] = 1;
      if (ed && ed.op === 'delete') return;
      let h = resolveHeight(f.properties);
      if (ed && ed.op === 'set_height') h = +ed.height_m;
      const p = f.properties || {};
      out.push({
        type: 'Feature',
        properties: {
          id: id, height: SM.geo.round(h, 1),
          min_height: p.min_height != null ? +p.min_height : 0,
          source: ed ? 'edited' : (state.site ? 'site' : 'overture'),
          material: (state.site && p.material) || SM.MATERIALS.default
        },
        geometry: f.geometry
      });
    });
    state.customBuildings.forEach((cf) => out.push(cf));
    replacementFeatures().forEach((cf) => out.push(cf));
    return { type: 'FeatureCollection', features: out };
  }

  function rectAround(lonlat, w, d) {
    const lon = lonlat[0], lat = lonlat[1];
    const dLon = (w / 2) / SM.geo.mPerDegLon(lat);
    const dLat = (d / 2) / SM.geo.M_PER_DEG_LAT;
    return [[[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat],
             [lon - dLon, lat + dLat], [lon - dLon, lat - dLat]]];
  }

  let addedSeq = 0;
  function addBuildingAt(lonlat, opts) {
    opts = opts || {};
    const w = Math.max(1, Math.min(1000, +opts.width || 20));
    const d = Math.max(1, Math.min(1000, +opts.depth || 20));
    const h = Math.max(0.5, Math.min(1000, +opts.height || 15));
    const feat = {
      type: 'Feature',
      properties: {
        id: 'added-' + (++addedSeq) + '-' + Math.round(lonlat[0] * 1e4) + '_' + Math.round(lonlat[1] * 1e4),
        height: SM.geo.round(h, 1), min_height: 0, source: 'custom',
        material: (opts.material || SM.MATERIALS.default),
        width_m: w, depth_m: d
      },
      geometry: { type: 'Polygon', coordinates: rectAround(lonlat, w, d) }
    };
    state.customBuildings.push(feat);
    updateCustomSource();
    emit();
    return feat;
  }

  function removeCustomBuilding(id) {
    state.customBuildings = state.customBuildings.filter((f) => (f.properties || {}).id !== id);
    updateCustomSource();
    emit();
  }

  function importBuildings(gj) {
    const feats = gj.type === 'FeatureCollection' ? gj.features : gj.type === 'Feature' ? [gj] : [];
    let n = state.customBuildings.length, added = 0;
    feats.forEach((f) => {
      if (!f.geometry || (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon')) return;
      const p = f.properties || {};
      state.customBuildings.push({
        type: 'Feature',
        properties: { id: 'custom-' + (++n), height: SM.geo.round(resolveHeight(p), 1), min_height: p.min_height || 0, source: 'custom', material: p.material || SM.MATERIALS.default },
        geometry: f.geometry
      });
      added++;
    });
    updateCustomSource(); emit();
    return added;
  }

  function download(text, name, mime) {
    const b = new Blob([text], { type: mime }); const a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = name; a.click(); URL.revokeObjectURL(a.href);
  }
  function slug() { return api.city.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }

  function exportManifest() { download(JSON.stringify(manifest(), null, 2), 'scene_manifest_' + slug() + '.json', 'application/json'); }
  function exportBuildings() {
    const fc = areaBuildings();
    if (!fc) { alert('Select an area first (RF Design → Select area).'); return; }
    download(JSON.stringify(fc), 'buildings_' + slug() + '.geojson', 'application/geo+json');
    return fc.features.length;
  }
  function exportPackage() {
    const fc = areaBuildings();
    download(JSON.stringify({ manifest: manifest(), buildings: fc || { type: 'FeatureCollection', features: [] } }, null, 2),
      'scene_package_' + slug() + '.json', 'application/json');
  }

  function clearAll() {
    Object.values(markers).forEach((m) => m.remove());
    for (const k in markers) delete markers[k];
    Object.values(modelMarkers).forEach((m) => m.remove());
    for (const k in modelMarkers) delete modelMarkers[k];
    state.nodes = []; state.edits = []; state.models = []; state.customBuildings = [];
    state.bbox = null; state.routes = []; routeDraft = []; routeCursor = null; state.pendingModel = null;
    api.clearBuildingHeights();
    Object.keys(replaceMarkers).forEach((k) => { replaceMarkers[k].remove(); delete replaceMarkers[k]; });
    clearRays(); showRays(false); clearHandover(); clearServingLink();
    setSel(null); updateCustomSource(); renderRoutes(); emit();
  }

  function setMode(m) {
    if (m === 'gnb' && m !== state.mode && gnbFull()) { refuseGnb(); return; }
    state.mode = m === state.mode ? null : m;
    const placing = state.mode === 'gnb' || state.mode === 'tower' || state.mode === 'ue' ||
                    state.mode === 'model' || state.mode === 'building' || state.mode === 'route';
    api.setBuildingClickHandler(state.mode === 'edit' && hooks.onBuildingEdit
      ? onBuildingEdit : (placing ? function () {} : null));
    map.getCanvas().style.cursor = state.mode ? 'crosshair' : '';
    if (hooks.onMode) hooks.onMode(state.mode);
  }
  let mastKey = '';
  function updateMasts() {
    const src = map.getSource('node-masts');
    if (!src) return;
    const sq = (n, half, base, top, color) => {
      const c = [[-half, -half], [half, -half], [half, half], [-half, half], [-half, -half]]
        .map((d) => SM.geo.fromENU(d[0], d[1], n.lonlat[0], n.lonlat[1]));
      return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [c] },
               properties: { base: Math.max(0, base), top: top, color: color } };
    };
    const feats = [];
    state.nodes.forEach((n) => {
      const h = +n.heightAGL;
      if ((n.type !== 'gnb' && n.type !== 'tower') || !(h > 0)) return;
      feats.push(sq(n, 0.6, 0, h - 1.5, '#5B6770'));
      feats.push(sq(n, 1.8, h - 1.5, h + 1.5, NODE_STYLE[n.type].color));
    });
    const key = JSON.stringify(feats);
    if (key === mastKey) return;
    mastKey = key;
    src.setData({ type: 'FeatureCollection', features: feats });
  }
  function emit() { updateMasts(); if (hooks.onState) hooks.onState(state); }

  function addNodeAt(type, lonlat, opts) {
    opts = opts || {};
    const st = NODE_STYLE[type];
    if (!st) return null;
    if (type === 'gnb' && gnbFull()) return refuseGnb();
    let ll = lonlat;
    if (!ll) {
      const b = effectiveBbox();
      const c = b ? SM.geo.bboxCenter(b) : map.getCenter();
      ll = Array.isArray(c) ? c : [c.lng, c.lat];
    }
    addNode({ type: type, lonlat: ll, heightAGL: opts.heightAGL != null ? +opts.heightAGL : st.defAGL,
              on: opts.on || 'ground' });
    return state.nodes[state.nodes.length - 1];
  }

  let rays3d = null, rayData = [];
  const BOUNCE_COLOR = { specular: '#f59e0b', refraction: '#a855f7', diffraction: '#22c55e', diffuse: '#ec4899' };
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const mixRgb = (x, y, t) => x.map((v, i) => v + (y[i] - v) * t);
  function rayStyle(r) {
    const weak = r.share < WEAK_SHARE, sh = Math.max(0, Math.min(1, r.share));
    const c = r.bg ? rgb('#7C8FA0') : r.los ? rgb('#22d3ee') : weak ? rgb('#ff2bd6')
      : sh < 0.5 ? mixRgb(rgb('#e08b3a'), rgb('#f59e0b'), sh / 0.5) : mixRgb(rgb('#f59e0b'), rgb('#fbbf24'), (sh - 0.5) / 0.5);
    return { color: c.concat([weak ? 0.85 : 0.8 + 0.2 * sh]),
             width_px: weak ? 1.6 : 2.4 + 3.1 * sh,
             casing_px: weak ? 3 : 4.5 + 4.5 * sh, casing_alpha: r.bg ? 0.10 : 0.45 };
  }
  function rayShown(r) {
    const band = state.rayBand || 'all';
    if (band === 'strong' && r.share < WEAK_SHARE) return false;
    if (band === 'weak' && r.share >= WEAK_SHARE) return false;
    if (band === 'direct' && !r.los) return false;
    return !state.rayTx || r.tx === state.rayTx;
  }
  function drawRays3D() {
    if (!rays3d && SM.makeRays3D) {
      rays3d = SM.makeRays3D('rays-3d');
      try { map.addLayer(rays3d); } catch (e) { rays3d = null; return; }
    } else if (rays3d) {
      try { map.moveLayer('rays-3d'); } catch (e) {  }
    }
    if (!rays3d) return;
    const vis = state.raysVisible === false ? [] : rayData.filter(rayShown);
    rays3d.setData(vis.map((r) => Object.assign({ pts: r.pts }, rayStyle(r))),
                   [].concat(...vis.map((r) => r.dots)));
  }
  function setRays(paths, originLonLat) {
    if (!map.getSource('sel')) return 0;
    const org = originLonLat || origin();
    rayData = [];
    (paths || []).forEach(function (p) {
      const pts = p.points || [];
      if (pts.length < 2) return;
      const g = Array.isArray(p.ground_m) && p.ground_m.length === pts.length ? p.ground_m : null;
      const p3 = pts.map(function (q, k) {
        const ll = SM.geo.fromENU(+q[0], +q[1], org[0], org[1]);
        return [ll[0], ll[1], ((SM.groundAt && SM.groundAt(ll)) || 0) + (+q[2] || 0) - (g ? +g[k] : 0)];
      });
      rayData.push({
        pts: p3, share: p.share != null ? +p.share : 0, los: !!p.los, bg: !!p.bg, tx: p.tx || '',
        dots: (p.kinds || []).map(function (kind, b) {
          const q = p3[b + 1];
          return q ? { ll: [q[0], q[1]], alt_m: q[2], color: rgb(BOUNCE_COLOR[kind] || '#94a3b8') } : null;
        }).filter(Boolean)
      });
    });
    drawRays3D();
    state.rays = rayData.length;
    emit();
    return rayData.length;
  }

  let hoState = null;

  let servingPci = null;

  function servingTxNode() {
    const txs = state.nodes.filter((n) => n.type === 'gnb' || n.type === 'tower');
    if (!txs.length) return null;
    if (servingPci == null) return txs[0];
    const want = String(servingPci);
    const byRf = txs.find((n) => n.rf && String(n.rf.pci) === want);
    if (byRf) return byRf;
    const idx = parseInt(want, 10) - 1;
    return txs[idx >= 0 && idx < txs.length ? idx : 0];
  }

  function arcPoints(a, b, bow, steps) {
    const k = Math.cos((a[1] + b[1]) * 0.5 * Math.PI / 180) || 1;
    const ax = a[0] * k, bx = b[0] * k;
    const mx = (ax + bx) / 2, my = (a[1] + b[1]) / 2;
    const dx = bx - ax, dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1e-9;
    const cx = mx + (-dy / len) * len * bow;
    const cy = my + (dx / len) * len * bow;
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      out.push([(u * u * ax + 2 * u * t * cx + t * t * bx) / k,
                u * u * a[1] + 2 * u * t * cy + t * t * b[1]]);
    }
    return out;
  }

  function hoMarkerEl() {
    const el = document.createElement('div');
    el.className = 'sk-ho-ue';
    el.innerHTML = [
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="none">',
      '<rect x="7" y="2" width="10" height="20" rx="2.5" fill="#0B141A" stroke="#d4836d" stroke-width="1.6"/>',
      '<rect x="8.6" y="4.4" width="6.8" height="13" rx="1" fill="#d4836d" opacity="0.28"/>',
      '<circle cx="12" cy="19.6" r="1" fill="#d4836d"/>',
      '</svg>'
    ].join('');
    el.style.cssText = 'width:26px;height:26px;pointer-events:none;'
                     + 'filter:drop-shadow(0 0 6px rgba(212,131,109,.9))';
    return el;
  }

  function setHandover(opts) {
    const o = opts || {};
    const txs = state.nodes.filter((n) => n.type === 'gnb' || n.type === 'tower');
    const a = o.from ? state.nodes.find((n) => n.id === o.from) : txs[0];
    const b = o.to ? state.nodes.find((n) => n.id === o.to) : txs[1];
    if (!a || !b || !a.lonlat || !b.lonlat) return false;

    clearHandover();
    const pts = arcPoints(a.lonlat, b.lonlat, o.bow == null ? 0.2 : o.bow, 96);
    map.getSource('ho-arc').setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { from: a.id, to: b.id },
        geometry: { type: 'LineString', coordinates: pts }
      }]
    });

    const marker = new maplibregl.Marker({ element: hoMarkerEl() })
      .setLngLat(pts[0]).addTo(map);
    hoState = {
      from: a.id, to: b.id, pts, marker, raf: 0, t0: 0, dash: 0,
      period: Math.max(1000, o.period_ms || 6000),
      loop: o.loop !== false
    };
    animateHandover();
    return true;
  }

  function animateHandover() {
    if (!hoState) return;
    const step = (ts) => {
      if (!hoState) return;
      if (!hoState.t0) hoState.t0 = ts;
      const elapsed = ts - hoState.t0;
      if (!hoState.loop && elapsed >= hoState.period) {
        hoState.marker.setLngLat(hoState.pts[hoState.pts.length - 1]);
        return;
      }
      const frac = (elapsed % hoState.period) / hoState.period;
      const i = Math.min(hoState.pts.length - 1, Math.floor(frac * (hoState.pts.length - 1)));
      hoState.marker.setLngLat(hoState.pts[i]);
      hoState.dash = (hoState.dash + 0.06) % 2;
      if (map.getLayer('ho-arc-line')) {
        const d = hoState.dash;
        map.setPaintProperty('ho-arc-line', 'line-dasharray',
          [Math.max(0.1, 2 - d), 2, d, 0]);
      }
      hoState.raf = requestAnimationFrame(step);
    };
    hoState.raf = requestAnimationFrame(step);
  }

  function setServingLink(opts) {
    const o = opts || {};
    servingPci = o.pci == null ? null : o.pci;
    linkEnabled = servingPci != null;
    if (!linkEnabled) { clearLiveLink(); return true; }

    const ue = state.nodes.find((n) => n.type === 'ue');
    if (!ue || !ue.lonlat) { clearLiveLink(); return false; }
    drawLiveLink(ue.lonlat, {});
    return true;
  }

  function clearServingLink() { servingPci = null; linkEnabled = false; clearLiveLink(); }

  function clearHandover() {
    if (hoState) {
      if (hoState.raf) cancelAnimationFrame(hoState.raf);
      if (hoState.marker) hoState.marker.remove();
      hoState = null;
    }
    if (map.getSource('ho-arc')) {
      map.getSource('ho-arc').setData({ type: 'FeatureCollection', features: [] });
    }
  }

  function clearRays() { return setRays([], null); }

  function applyRayFilter() { drawRays3D(); }

  function setRayBand(band) {
    state.rayBand = band || 'all';
    applyRayFilter();
    emit();
  }

  function setRayTx(tx) {
    state.rayTx = tx || '';
    applyRayFilter();
    emit();
  }

  function showRays(on) {
    state.raysVisible = !!on;
    drawRays3D();
    emit();
  }

  return {
    init, setMode, addNode, addNodeAt, removeNode, removeRoute, setNodeHeight, setNodeRF, setRF,
    setLiveUE, gnbFull, MAX_GNB,
    setRays, clearRays, showRays, setRayBand, setRayTx,
    setHandover, clearHandover,
    setServingLink, clearServingLink,
    addModel, removeModel, setPendingModel,
    addBuildingAt, removeCustomBuilding,
    exportManifest, importManifest, manifest, clearAll,
    setSite, getSite: () => state.site,
    importBuildings, exportBuildings, exportPackage, areaBuildings,
    effectiveBbox,
    getState: () => state, NODE_STYLE
  };
};
