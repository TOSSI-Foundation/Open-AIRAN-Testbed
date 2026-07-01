let SK_TOKEN = '';

if (!window.__skFetchWrapped) {
  window.__skFetchWrapped = true;
  const _skFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!SK_TOKEN || !url.startsWith('/api/')) return _skFetch(input, init);
    const h = new Headers((init && init.headers) || (input && input.headers) || undefined);
    if (!h.has('Authorization')) h.set('Authorization', 'Bearer ' + SK_TOKEN);
    return _skFetch(input, { ...(init || {}), headers: h });
  };
}
(function () {
  const params = new URLSearchParams(location.search);

  let city;
  let cityKey = null;
  const placeParam = params.get('place');
  if (placeParam) {
    const [lon, lat, zoom] = placeParam.split(',').map(Number);
    if (isFinite(lon) && isFinite(lat)) {
      city = SM.cityFromParams(lon, lat, zoom, params.get('label'));
    }
  }
  if (!city) {
    cityKey = SM.CITIES[params.get('city')] ? params.get('city') : 'munich';
    city = SM.CITIES[cityKey];
  }

  const cityInput = document.getElementById('cityInput');
  const cityResults = document.getElementById('cityResults');
  cityInput.value = city.label;
  let cityHi = -1;
  let cityRows = [];
  let citySearchToken = 0;
  let cityDebounce = null;
  let citySearchError = '';

  function closeCityResults() { cityResults.classList.remove('open'); cityHi = -1; }

  const PIN_SVG = '<svg class="pin" viewBox="0 0 16 16">'
    + '<path d="M8 14s4.5-4.2 4.5-7.5A4.5 4.5 0 0 0 3.5 6.5C3.5 9.8 8 14 8 14Z"/>'
    + '<circle cx="8" cy="6.4" r="1.6"/></svg>';
  const GLOBE_SVG = '<svg class="pin" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/>'
    + '<path d="M2.5 8h11M8 2.5c1.6 1.6 2.4 3.5 2.4 5.5S9.6 12 8 13.5C6.4 12 5.6 10 5.6 8S6.4 4.1 8 2.5Z"/></svg>';
  function placeRow(mark) {
    const row = document.createElement('div');
    row.className = 'item';
    row.insertAdjacentHTML('beforeend', mark);
    const t = document.createElement('span');
    t.className = 't';
    row.appendChild(t);
    const go = document.createElement('span');
    go.className = 'go';
    row.appendChild(go);
    return { row: row, body: t };
  }

  function renderCityRows(query, searchState, matches) {
    cityResults.innerHTML = '';
    cityRows = [];
    const q = (query || '').trim().toLowerCase();

    const presetGrp = document.createElement('div');
    presetGrp.className = 'grp'; presetGrp.textContent = 'Quick jump';
    const presetKeys = Object.keys(SM.CITIES).filter((k) => !q || SM.CITIES[k].label.toLowerCase().includes(q));
    if (presetKeys.length) {
      cityResults.appendChild(presetGrp);
      presetKeys.forEach((k) => {
        const c = SM.CITIES[k];
        const built = placeRow(GLOBE_SVG);
        const row = built.row;
        const n = document.createElement('div'); n.className = 'n';
        const nm = document.createElement('span'); nm.textContent = c.label; n.appendChild(nm);
        const d = document.createElement('div'); d.className = 'd'; d.textContent = c.country;
        built.body.appendChild(n); built.body.appendChild(d);
        row.onclick = () => pickPreset(k);
        cityResults.appendChild(row);
        cityRows.push({ kind: 'preset', key: k, el: row });
      });
    }

    if (q.length >= 3 && searchState) {
      const searchGrp = document.createElement('div');
      searchGrp.className = 'grp'; searchGrp.textContent = 'Search results';
      cityResults.appendChild(searchGrp);
      if (searchState === 'loading') {
        const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'Searching…';
        cityResults.appendChild(e);
      } else if (searchState === 'error') {
        const e = document.createElement('div'); e.className = 'empty';
        e.textContent = citySearchError || 'Search failed (network / rate limit).';
        cityResults.appendChild(e);
      } else if (!matches || !matches.length) {
        const e = document.createElement('div'); e.className = 'empty';
        e.textContent = 'No match. Try adding the district, state or country ' +
                        '— e.g. "Rampur, Uttar Pradesh".';
        cityResults.appendChild(e);
      } else {
        matches.forEach((m) => {
          const built = placeRow(PIN_SVG);
          const row = built.row;
          const n = document.createElement('div'); n.className = 'n';
          const nameEl = document.createElement('span');
          nameEl.textContent = m.label || m.display_name;
          n.appendChild(nameEl);
          const ty = (m.raw && (m.raw.addresstype || m.raw.type)) || '';
          if (ty) {
            const chip = document.createElement('span');
            chip.className = 'ty';
            chip.textContent = ty.replace(/_/g, ' ');
            if (SM.isRegionResult(m.raw)) chip.title = 'A large area — the map will frame all of it';
            n.appendChild(chip);
          }
          const d = document.createElement('div'); d.className = 'd'; d.textContent = m.display_name;
          built.body.appendChild(n); built.body.appendChild(d);
          row.onclick = () => pickSearchResult(m);
          cityResults.appendChild(row);
          cityRows.push({ kind: 'place', item: m, el: row });
        });
      }
    }
    cityHi = -1;
    cityResults.classList.toggle('open', cityRows.length > 0 || (!!searchState && q.length >= 3));
  }

  function highlightRow(i) {
    cityRows.forEach((r, idx) => r.el.classList.toggle('hi', idx === i));
    cityHi = i;
  }

  function pickPreset(key) {
    switchToCity(SM.CITIES[key], key);
    rf.setSite(SM.CITIES[key].site || siteAt(SM.CITIES[key].home.center));
    cityInput.value = SM.CITIES[key].label;
    closeCityResults();
    cityInput.blur();
  }

  let pickGeneration = 0;

  async function pickSearchResult(m) {
    const raw = m.raw;
    const myPick = ++pickGeneration;
    closeCityResults();
    cityInput.blur();

    const newCity = SM.cityFromPlace(raw);
    switchToCity(newCity, null);
    rf.setSite(siteAt(newCity.home.center));
    cityInput.value = newCity.label;
    setMapNote('');

    if (SM.isRegionResult(raw)) {
      const regionLabel = String(raw.display_name || '').split(',')[0].trim();
      setMapNote(regionLabel + ' is a large area — showing all of it. Zoom in to a ' +
                 'built-up part, or jump to its largest city.');
      let settlement = null;
      try {
        settlement = await SM.largestSettlementIn(raw.boundingbox);
      } catch (e) {  }
      if (myPick !== pickGeneration) return;
      if (settlement) {
        setMapNote(regionLabel + ' is a large area — showing all of it.',
                   'Go to ' + settlement.display_name, () => {
                     const c = SM.cityFromPlace(settlement);
                     c.label = settlement.display_name + ', ' + regionLabel;
                     switchToCity(c, null);
                     cityInput.value = c.label;
                     setMapNote('');
                     checkBuildingsPresent();
                   });
      }
      return;
    }

    checkBuildingsPresent();
  }

  function checkBuildingsPresent() {
    let tries = 0;
    const myPick = pickGeneration;
    const poll = setInterval(() => {
      if (myPick !== pickGeneration) { clearInterval(poll); return; }
      tries++;
      const n = api.renderedBuildingCount();
      if (n > 0) {
        clearInterval(poll);
        setMapNote('');
        return;
      }
      if (tries >= 12) {
        clearInterval(poll);
        setMapNote('No buildings here — this looks like open country, or Overture has no ' +
                   'footprints for this spot. Pan or zoom to a built-up area, or search a ' +
                   'city or street address.');
      }
    }, 500);
  }

  function setMapNote(text, actionLabel, onAction) {
    const el = document.getElementById('cityNote');
    if (!el) return;
    el.textContent = '';
    if (!text) { el.style.display = 'none'; return; }
    const line = document.createElement('div');
    line.textContent = text;
    el.appendChild(line);
    if (actionLabel && onAction) {
      const b = document.createElement('button');
      b.className = 'b';
      b.style.cssText = 'margin-top:7px;width:100%';
      b.textContent = actionLabel;
      b.onclick = onAction;
      el.appendChild(b);
    }
    el.style.display = 'block';
  }

  cityInput.addEventListener('focus', () => {
    cityInput.select();
    renderCityRows('', null, []);
  });
  cityInput.addEventListener('input', () => {
    const q = cityInput.value;
    renderCityRows(q, q.trim().length >= 3 ? 'loading' : null, []);
    clearTimeout(cityDebounce);
    if (q.trim().length < 3) return;
    cityDebounce = setTimeout(async () => {
      const token = ++citySearchToken;
      try {
        const matches = await api.searchPlace(q.trim());
        citySearchError = '';
        if (token === citySearchToken) renderCityRows(q, 'done', matches);
      } catch (e) {
        citySearchError = (e && e.message) || '';
        if (token === citySearchToken) renderCityRows(q, 'error', []);
      }
    }, 650);
  });
  cityInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeCityResults(); cityInput.blur(); return; }
    if (!cityRows.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlightRow(Math.min(cityHi + 1, cityRows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlightRow(Math.max(cityHi - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const row = cityHi >= 0 ? cityRows[cityHi]
        : (cityRows.filter((r) => r.kind === 'place')[0] || cityRows[0]);
      if (!row) return;
      if (row.kind === 'preset') pickPreset(row.key); else pickSearchResult(row.item);
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.citybox')) closeCityResults();
  });

  setSearchPlaceholder(city.label);

  function setSearchPlaceholder(label) {
    const el = document.getElementById('searchInput');
    const place = String(label || '').split(' —')[0];
    el.placeholder = 'Search an address';
    el.title = place ? 'Search an address in ' + place : 'Search an address';
  }

  const { map, api } = SM.mapcore.create(city);
  const rf = SM.sionna(map, api, {
    onMode: renderModes,
    notify: (text) => setMapNote(text),
    newBuilding: () => ({ width: 20, depth: 20, height: 15 }),
    onState: (st) => { renderState(st); reportState(); saveDraft(); }
  });

  let siteList = [];
  async function refreshSites() {
    try {
      const r = await fetch('/api/map/sites');
      if (!r.ok) return;
      const j = await r.json();
      siteList = Array.isArray(j.sites) ? j.sites : [];
    } catch (err) {  }
  }
  function siteAt(lonlat) {
    if (!lonlat) return null;
    const s = siteList.find((q) => q.bbox && lonlat[0] >= q.bbox.min_lon && lonlat[0] <= q.bbox.max_lon
                                   && lonlat[1] >= q.bbox.min_lat && lonlat[1] <= q.bbox.max_lat);
    return s ? { id: s.id, name: s.name } : null;
  }

  function switchToCity(newCity, presetKeyOrNull, opts) {
    city = newCity;
    cityKey = presetKeyOrNull;
    api.setCity(newCity, opts);
    cityInput.value = newCity.label;
    setSearchPlaceholder(newCity.label);
    renderLandmarks();
    const p = new URLSearchParams(location.search);
    if (presetKeyOrNull) {
      p.set('city', presetKeyOrNull); p.delete('place'); p.delete('label');
    } else {
      p.delete('city');
      const c = newCity.home.center;
      p.set('place', [c[0], c[1], newCity.home.zoom].map((v) => Math.round(v * 1e5) / 1e5).join(','));
      p.set('label', newCity.label);
    }
    history.replaceState(null, '', location.pathname + '?' + p.toString());
    reportState();
  }

  function adoptScenePlace(m, opts) {
    if (!m) return null;
    const bb = m.bbox;
    const centre = bb ? [(bb.min_lon + bb.max_lon) / 2, (bb.min_lat + bb.max_lat) / 2]
      : (m.crs && m.crs.origin_lonlat) || null;
    if (!centre) return null;
    const near = (function nearestCuratedCity(c) {
      const all = (window.SM && SM.CITIES) || {};
      for (const k of Object.keys(all)) {
        const home = all[k].home && all[k].home.center;
        if (!home || !(all[k].landmarks || []).length) continue;
        if (Math.abs(home[0] - c[0]) < 1 && Math.abs(home[1] - c[1]) < 1) return all[k];
      }
      return null;
    })(centre);

    const place = {
      label: (m.site && m.site.name) || m.city || city.label,
      country: '', custom: true,
      home: { center: centre, zoom: 15.4, pitch: 55, bearing: 0 },
      searchBias: null,
      heightFallbackM: (m.buildings && m.buildings.height_fallback_m) || city.heightFallbackM,
      landmarks: near ? near.landmarks : []
    };
    switchToCity(place, null, Object.assign({ flyTo: false }, opts || {}));
    return place;
  }

  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      document.getElementById('panel-' + t.dataset.tab).classList.add('active');
    };
  });

  const lm = document.getElementById('landmarks');
  function renderLandmarks() {
    lm.innerHTML = '';
    const hint = document.getElementById('exploreHint');
    if (hint) {
      hint.textContent = city.landmarks.length
        ? city.landmarks.length + ' · fly there in 3D'
        : 'none here';
    }
    if (!city.landmarks.length) {
      const e = document.createElement('div');
      e.className = 'info';
      e.textContent = 'No curated landmarks here yet — this is a searched location. ' +
        'Use the address search (top right) to jump around, or pick a quick-jump city above.';
      lm.appendChild(e);
      return;
    }
    city.landmarks.forEach((l) => {
      const b = document.createElement('button');
      b.className = 'landmark';
      b.title = 'Fly to ' + l.name;
      b.innerHTML =
        '<svg class="pin" viewBox="0 0 16 16"><path d="M8 14s4.5-4.2 4.5-7.5A4.5 4.5 0 0 0 3.5 6.5C3.5 9.8 8 14 8 14Z"/>'
        + '<circle cx="8" cy="6.4" r="1.6"/></svg>'
        + '<span class="t"><span class="n">' + l.name + '</span>'
        + '<span class="d">' + l.desc + '</span></span><span class="go"></span>';
      b.onclick = () => api.flyTo(l);
      lm.appendChild(b);
    });
  }
  renderLandmarks();

  let is3D = true;
  const timeEl = document.getElementById('time');
  const clockEl = document.getElementById('clock');
  const viewBtns = Array.from(document.querySelectorAll('#viewSwitch .vw'));
  const bopBox = document.getElementById('bopBox');
  const bopRange = document.getElementById('bopRange');
  const bopVal = document.getElementById('bopVal');

  function renderView(mode) {
    viewBtns.forEach((b) => b.classList.toggle('on', b.dataset.view === mode));
    const overImagery = mode === 'satellite' || mode === 'hybrid';
    if (bopBox) bopBox.classList.toggle('show', overImagery);
    if (overImagery) renderOpacity(api.getBuildingOpacity());
  }
  function renderOpacity(v) {
    const pct = Math.round(v * 100);
    if (bopRange) bopRange.value = pct;
    if (bopVal) bopVal.textContent = pct + '%';
  }
  function applyView(mode) {
    renderView(api.setView(mode));
    reportState();
  }
  const FOCUS_SRC = 'sk-focus', FOCUS_FILL = 'sk-focus-fill', FOCUS_EDGE = 'sk-focus-edge';
  let framed = null;
  function frameScene(bbox, km, pitch) {
    if (!bbox) return false;
    framed = { bbox: bbox, km: km, pitch: pitch };
    const mLon = (bbox.max_lon - bbox.min_lon) * 0.12;
    const mLat = (bbox.max_lat - bbox.min_lat) * 0.12;
    const w = bbox.min_lon - mLon, e = bbox.max_lon + mLon;
    const s = bbox.min_lat - mLat, n = bbox.max_lat + mLat;
    const cw = map.getCanvas().clientWidth || 800;
    const want = Math.max(0, Math.min(600, +SM._insetRight || 0));
    const inset = Math.max(0, Math.min(want, cw * 0.45, cw - 240));
    map.fitBounds([[w, s], [e, n]],
                  { padding: { top: 60, bottom: 60, left: 60, right: 60 + inset },
                    pitch: pitch != null ? pitch : 55, duration: 1200 });
    return true;
  }
  function padBounds(bbox, km) {
    const dLat = km / 111.32;
    const mid = (bbox.min_lat + bbox.max_lat) / 2;
    const dLon = km / (111.32 * Math.max(0.05, Math.cos((mid * Math.PI) / 180)));
    return [bbox.min_lon - dLon, bbox.min_lat - dLat, bbox.max_lon + dLon, bbox.max_lat + dLat];
  }
  function applyFocus(bbox, km) {
    if (!bbox) {
      if (map.getLayer(FOCUS_FILL)) map.removeLayer(FOCUS_FILL);
      if (map.getLayer(FOCUS_EDGE)) map.removeLayer(FOCUS_EDGE);
      if (map.getSource(FOCUS_SRC)) map.removeSource(FOCUS_SRC);
      map.setMaxBounds(null); map.setMinZoom(0);
      return;
    }
    const [w, s, e, n] = padBounds(bbox, km);
    const data = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [
      [[-179.9, -85], [179.9, -85], [179.9, 85], [-179.9, 85], [-179.9, -85]],
      [[w, s], [w, n], [e, n], [e, s], [w, s]]
    ] } };
    if (map.getSource(FOCUS_SRC)) map.getSource(FOCUS_SRC).setData(data);
    else {
      map.addSource(FOCUS_SRC, { type: 'geojson', data: data });
      map.addLayer({ id: FOCUS_FILL, type: 'fill', source: FOCUS_SRC,
        paint: { 'fill-color': '#0B141A', 'fill-opacity': 0.88 } });
      map.addLayer({ id: FOCUS_EDGE, type: 'line', source: FOCUS_SRC,
        paint: { 'line-color': '#12A0B5', 'line-width': 1.5, 'line-opacity': 0.7 } });
    }
    const [fw, fs, fe, fn] = padBounds(bbox, km + Math.max(km, 1));
    map.setMaxBounds([[fw, fs], [fe, fn]]);
    map.once('moveend', () => map.setMinZoom(Math.max(0, map.getZoom() - 0.3)));
  }

  function applyBuildingOpacity(v) {
    renderOpacity(api.setBuildingOpacity(v));
    reportState();
  }
  viewBtns.forEach((b) => { b.onclick = () => applyView(b.dataset.view); });
  if (bopRange) bopRange.addEventListener('input', () => applyBuildingOpacity(+bopRange.value / 100));

  document.getElementById('btnReset').onclick = () => api.reset();
  document.getElementById('btnDim').onclick = () => {
    is3D = !is3D; api.setPitch(is3D ? city.home.pitch : 0);
    document.getElementById('btnDim').classList.toggle('active', !is3D);
    document.getElementById('dimLabel').textContent = is3D ? '2D view' : '3D view';
  };
  document.getElementById('btnSky').onclick = () => {
    const on = api.toggleSky(parseFloat(timeEl.value));
    document.getElementById('btnSky').classList.toggle('active', on);
    document.getElementById('skyLabel').textContent = on ? 'Sky: on' : 'Sky: off';
  };
  document.getElementById('btnLoc').onclick = () => api.triggerGeolocate();
  const paintTime = () => timeEl.style.setProperty('--fill', ((+timeEl.value / 24) * 100).toFixed(1) + '%');
  timeEl.oninput = () => { clockEl.textContent = api.setTime(parseFloat(timeEl.value)); paintTime(); };
  paintTime();

  const msg = document.getElementById('searchMsg');
  async function doSearch() {
    const q = document.getElementById('searchInput').value.trim(); if (!q) return;
    msg.textContent = 'Searching…';
    try { const r = await api.search(q); msg.textContent = r ? r.split(',').slice(0, 3).join(',') : 'No result found.'; }
    catch (e) { msg.textContent = 'Search failed (network / rate limit).'; }
  }
  document.getElementById('searchBtn').onclick = doSearch;
  document.getElementById('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  const modeBtns = { area: 'mArea', gnb: 'mGnb', tower: 'mTower', ue: 'mUe', route: 'mRoute' };
  Object.entries(modeBtns).forEach(([mode, id]) => { document.getElementById(id).onclick = () => rf.setMode(mode); });

  const modelHintEl = document.getElementById('modelHint');
  const say = (t) => { if (modelHintEl) modelHintEl.textContent = t; };

  async function refreshModels(note) {
    try {
      const r = await fetch('/api/map/models', { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const list = await r.json();
      SM.availableModels = (list || []).map((m) => m.name);
      if (!rf.getState().pendingModel && SM.availableModels.length) rf.setPendingModel(SM.availableModels[0]);
      if (note) say(note);
      toHost({ type: 'sk-models-changed' });
    } catch (e) {
      say('Model storage needs the TOSSI backend — open the map through '
        + 'the dashboard to upload meshes.');
    }
  }

  async function uploadModel(file, relPath) {
    try {
      const fd = new FormData();
      fd.append('file', file, relPath || file.name);
      const r = await fetch('/api/map/models', { method: 'POST', body: fd });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) return { error: body.error || ('Upload failed (HTTP ' + r.status + ').') };
      await refreshModels('Uploaded ' + body.name + '. Click a building → Edit → Add replaced model.');
      rf.setPendingModel(body.name);
      return { name: body.name, warning: body.warning };
    } catch (err) {
      return { error: 'Upload failed — is the TOSSI backend running?' };
    }
  }

  const fpModal = document.getElementById('fpModal');
  let fpSession = null;

  function restore(id, prior) {
    if (prior) api.setBuildingEdit(id, prior, { mode: 'session' });
    else api.clearSessionEdit(id);
  }

  function closeFootprint() {
    if (fpSession) {
      if (!fpSession.saved && fpSession.replacing) restore(fpSession.buildingId, fpSession.prior);
      fpSession.ctl.destroy();
      fpSession = null;
    }
    fpModal.classList.remove('open');
    toHost({ type: 'sk-modal', open: false });
    document.getElementById('fpMap').checked = true;
  }

  function fpShowStep(n) {
    document.getElementById('fpStep1').style.display = n === 1 ? '' : 'none';
    document.getElementById('fpStep2').style.display = n === 2 ? '' : 'none';
    document.getElementById('fpActions1').style.display = n === 1 ? '' : 'none';
    document.getElementById('fpActions2').style.display = n === 2 ? '' : 'none';
    document.getElementById('fpStepTab1').classList.toggle('on', n === 1);
    document.getElementById('fpStepTab2').classList.toggle('on', n === 2);
    if (!fpSession) return;
    fpSession.ctl.showHeight(n === 2);
    if (n === 2) {
      fpSession.ctl.setHeight(+document.getElementById('fpH').value);
      const parts = fpSession.ctl.getRings().length;
      const stray = fpSession.ctl.openCount();
      const model = fpSession.ctl.getModel();
      const note = document.getElementById('fpParts');
      if (note && !parts && model) {
        note.textContent = model.model + ' will be placed where you dragged it, at its own '
          + 'size — the height below is not used for a model.';
      } else if (note) {
        note.textContent = parts === 1
          ? 'This height applies to everything you drew.'
          : 'This height applies to all ' + parts + ' parts you drew — they are built as one building.';
        if (stray) {
          note.textContent += ' ' + stray + (stray === 1 ? ' stray point or line encloses'
            : ' stray points or lines enclose') + ' no area, so nothing can be built from '
            + (stray === 1 ? 'it.' : 'them.');
        }
        if (model) note.textContent += ' ' + model.model + ' is placed here too.';
      }
    }
  }

  function openNewBuilding(lonlat) {
    startFootprint({
      ring: [], center: lonlat,
      id: 'new-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e4),
      title: 'New building', height: 15, prior: null, replacing: false,
      hint: 'Empty plot. Right-click to place the first corner, right-click for each '
          + 'corner after it, then right-click the first corner again to close the building.'
    });
  }

  function openFootprint(feature, buildingId, priorSession) {
    const siblings = api.buildingPieces(buildingId);
    const ring = api.buildingOutline(feature, 60, siblings);
    if (!ring || ring.length < 3) {
      setMapNote('That building has no outline to edit.');
      restore(buildingId, priorSession);
      return;
    }

    const cur = SM.buildingHeight(feature.properties, api.city.heightFallbackM);
    startFootprint({
      ring: ring, id: buildingId, prior: priorSession || null, replacing: true,
      title: 'Replacing ' + (SM.buildingName(feature.properties) || 'this building'),
      height: Math.round(cur.m)
    });
  }

  function startFootprint(cfg) {
    const ring = cfg.ring, buildingId = cfg.id;
    document.getElementById('fpTitle').textContent = cfg.title;
    document.getElementById('fpH').value = String(cfg.height);

    fpModal.classList.add('open');
    toHost({ type: 'sk-modal', open: true });

    const edits = api.getBuildingEdits();
    const gone = Object.keys(edits).filter((k) => edits[k].op !== 'set_height');
    if (cfg.replacing && gone.indexOf(buildingId) < 0) gone.push(buildingId);

    const status1 = document.getElementById('fpStatus1');
    const ctl = api.createFootprintEditor(document.getElementById('fpMapBox'), ring, null,
      { hideIds: gone, center: cfg.center, extraRings: cfg.extraRings,
        onStatus: (t) => {
          if (!status1) return;
          status1.textContent = t || '';
          status1.classList.toggle('show', !!t);
        },
        onDraft: (n, kept, closed) => {
          const bar = document.getElementById('fpDraftBar');
          const info = document.getElementById('fpDraftInfo');
          const done = document.getElementById('fpDraftDone');
          const clr = document.getElementById('fpDraftClear');
          if (!bar) return;
          bar.style.display = (n || kept) ? 'flex' : 'none';
          if (info) {
            info.textContent = n
              ? n + (n === 1 ? ' corner drawn' : ' corners drawn')
              : kept + (kept === 1 ? ' line kept' : ' lines kept');
          }
          if (done) done.disabled = n < 3;
          if (clr) clr.style.display = kept ? '' : 'none';
          const use = document.getElementById('fpDraftUse');
          if (use) use.style.display = closed ? '' : 'none';
        } });
    document.getElementById('fpDraftUse').onclick = () => {
      if (fpSession) fpSession.ctl.useAsOutline();
    };
    document.getElementById('fpDraftClear').onclick = () => {
      if (fpSession) fpSession.ctl.clearDrawnLines();
    };
    document.getElementById('fpDraftDone').onclick = () => {
      if (fpSession) fpSession.ctl.finishDraft();
    };
    document.getElementById('fpDraftCancel').onclick = () => {
      if (fpSession) fpSession.ctl.clearDraft();
    };
    fpSession = { ctl: ctl, buildingId: buildingId, prior: cfg.prior, saved: false,
                  replacing: cfg.replacing };
    if (status1 && cfg.hint) { status1.textContent = cfg.hint; status1.classList.add('show'); }

    const hIn = document.getElementById('fpH');
    hIn.oninput = () => ctl.setHeight(+hIn.value);
    const t3d = document.getElementById('fp3d');
    t3d.checked = false;
    t3d.onchange = () => ctl.setTilt(t3d.checked);

    const rot = document.getElementById('fpRot');
    const rotVal = document.getElementById('fpRotVal');
    rot.value = '0'; rotVal.textContent = '0°';
    const applyRot = (deg) => {
      rot.value = String(deg);
      rotVal.textContent = deg + '°';
      ctl.setRotation(deg);
    };
    rot.oninput = () => applyRot(+rot.value);
    document.getElementById('fpRotZero').onclick = () => applyRot(0);

    const mrow = document.getElementById('fpModelRow');
    const mname = document.getElementById('fpModelName');
    const mhint = document.getElementById('fpModelHint');
    const mhint0 = mhint.textContent;
    const mfix = document.getElementById('fpModelFix');
    const munits = document.getElementById('fpModelUnits');
    const mup = document.getElementById('fpModelUp');
    const msize = document.getElementById('fpModelSize');
    const mheight = document.getElementById('fpModelH');
    const mraw = document.getElementById('fpModelRaw');
    const mfind = document.getElementById('fpModelFind');
    const mfindText = document.getElementById('fpModelFindText');
    const mrotBox = document.getElementById('fpModelRotBox');
    const mrot = document.getElementById('fpModelRot');
    const mrotVal = document.getElementById('fpModelRotVal');
    const turnModel = (deg) => {
      mrot.value = String(deg);
      mrotVal.textContent = deg + '°';
      if (fpSession) fpSession.ctl.setModelRotation(deg);
    };
    mrot.oninput = () => turnModel(+mrot.value);
    document.getElementById('fpModelRotZero').onclick = () => turnModel(0);
    mrow.style.display = 'none';
    mrotBox.style.display = 'none';
    mfix.style.display = 'none';

    function showModelSize() {
      const sz = fpSession && fpSession.ctl.modelSize();
      if (!sz) { msize.textContent = ''; mraw.textContent = ''; return; }
      const r = (v) => Math.round(v * 10) / 10;
      msize.textContent = 'On the map: ' + r(sz[0]) + ' × ' + r(sz[1]) + ' × ' + r(sz[2]) + ' m';
      mname.textContent = fpSession.ctl.getModel().model + ' · ' + r(sz[2]) + ' m tall';
      if (document.activeElement !== mheight) mheight.value = String(r(sz[2]));
      const raw = fpSession.ctl.modelRaw();
      mraw.textContent = raw
        ? 'The file itself measures ' + r(raw[0]) + ' × ' + r(raw[1]) + ' × ' + r(raw[2])
          + ' in its own units.'
        : '';
    }
    mheight.oninput = () => {
      const raw = fpSession && fpSession.ctl.modelRaw();
      const want = parseFloat(mheight.value);
      if (!raw || !(raw[2] > 0) || !(want > 0)) return;
      fpSession.ctl.setModelScale(want / raw[2]);
      const sz = fpSession.ctl.modelSize();
      const r = (v) => Math.round(v * 10) / 10;
      msize.textContent = 'On the map: ' + r(sz[0]) + ' × ' + r(sz[1]) + ' × ' + r(sz[2]) + ' m';
      mname.textContent = fpSession.ctl.getModel().model + ' · ' + r(sz[2]) + ' m tall';
    };
    munits.onchange = () => {
      if (!fpSession) return;
      fpSession.ctl.setModelScale(SM.UNIT_SCALES[munits.value] || 1);
      showModelSize();
    };
    mup.onchange = async () => {
      if (!fpSession) return;
      const cur = fpSession.ctl.getModel();
      if (!cur) return;
      msize.textContent = 'Re-reading the model…';
      const shape = await SM.modelShape(cur.model, mup.value);
      if (!fpSession) return;
      fpSession.ctl.placeModel(cur.model, null, shape,
        { scale: SM.UNIT_SCALES[munits.value] || 1, up: mup.value, rotation_deg: cur.rotation_deg });
      showModelSize();
    };
    const relOf = (f) => {
      const p = f.webkitRelativePath || '';
      if (!p) return f.name;
      const parts = p.split('/');
      return parts.length > 1 ? parts.slice(1).join('/') : f.name;
    };

    async function missingCompanions(file, chosen) {
      if (!/\.gltf$/i.test(file.name)) return [];
      let doc;
      try { doc = JSON.parse(await file.text()); } catch (e) { return []; }
      const have = {};
      chosen.forEach((f) => { have[(f.name || '').split('/').pop().toLowerCase()] = 1; });
      const want = [];
      (doc.buffers || []).concat(doc.images || []).forEach((b) => {
        const uri = (b && b.uri) || '';
        if (!uri || uri.indexOf('data:') === 0) return;
        const base = decodeURIComponent(uri.split('/').pop());
        if (!have[base.toLowerCase()] && want.indexOf(base) < 0) want.push(base);
      });
      return want;
    }

    let pendingFiles = [];

    const takeFiles = async (ev) => {
      const picked = Array.from(ev.target.files || []);
      ev.target.value = '';
      if (!picked.length || !fpSession) return;
      const files = pendingFiles.concat(picked);
      pendingFiles = [];
      const MODEL_ORDER = ['.gltf', '.glb', '.ifc', '.obj', '.ply', '.stl', '.dae', '.zae',
                           '.off', '.3mf', '.step', '.stp'];
      const COMPANION = /\.(bin|png|jpe?g|webp|ktx2)$/i;
      const extOf = (f) => (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
      const models = files.filter((f) => MODEL_ORDER.indexOf(extOf(f)) >= 0)
        .sort((a, b) => MODEL_ORDER.indexOf(extOf(a)) - MODEL_ORDER.indexOf(extOf(b)));
      const model = models[0];
      if (!model) {
        mhint.className = 'fp-note fp-bad';
        mhint.textContent = files.length === 1 && COMPANION.test(files[0].name)
          ? 'That is only a data file. Choose the .gltf itself as well.'
          : 'No building model in that selection — expected one of '
            + MODEL_ORDER.join(' ') + '.';
        return;
      }
      const isCompanion = (f) => f !== model && COMPANION.test(f.name);
      const extras = files.filter(isCompanion);
      const missing = await missingCompanions(model, files);
      if (missing.length) {
        fpSession.ctl.clearModel();
        mrow.style.display = 'none';
        mfix.style.display = 'none';
        mrotBox.style.display = 'none';
        mhint.className = 'fp-note fp-bad';
        mhint.textContent = model.name + ' keeps its geometry in ' + missing.join(', ')
          + '. Choose ' + (missing.length === 1 ? 'that file' : 'those files')
          + ' as well — or pick the whole exported folder, or export as .glb, which is one file.';
        pendingFiles = files;
        mfind.style.display = '';
        mfindText.textContent = 'Add ' + missing.join(', ');
        if (status1) { status1.textContent = 'Waiting for ' + missing.join(', ') + '.'; status1.classList.add('show'); }
        return;
      }
      mfind.style.display = 'none';
      mhint.className = 'fp-note';
      mhint.textContent = extras.length
        ? 'Uploading ' + model.name + ' and ' + extras.length
          + (extras.length === 1 ? ' file it needs…' : ' files it needs…')
        : 'Uploading ' + model.name + '…';
      for (const c of extras) {
        const r = await uploadModel(c, relOf(c));
        if (r.error) { mhint.textContent = c.name + ': ' + r.error; return; }
      }
      const file = model;
      const res = await uploadModel(file, relOf(file));
      if (res.error) { mhint.textContent = res.error; return; }
      mhint.textContent = 'Reading ' + res.name + '…';
      const up = SM.guessModelUp(res.name);
      const shape = await SM.modelShape(res.name, up);
      if (!fpSession) return;
      if (!shape) {
        const why = await SM.modelError(res.name, up);
        fpSession.ctl.clearModel();
        mhint.className = 'fp-note fp-bad';
        mhint.textContent = why || 'That file could not be read as a building.';
        mrow.style.display = 'none';
        mfix.style.display = 'none';
        mrotBox.style.display = 'none';
        if (status1) { status1.textContent = 'That model could not be read.'; status1.classList.add('show'); }
        return;
      }
      const units = SM.guessModelUnits(shape);
      mup.value = up;
      munits.value = units;
      fpSession.ctl.placeModel(res.name, null, shape,
        { scale: SM.UNIT_SCALES[units] || 1, up: up });
      mname.textContent = res.name;
      mrow.style.display = 'flex';
      mfix.style.display = shape ? '' : 'none';
      mrotBox.style.display = shape ? '' : 'none';
      turnModel(0);
      showModelSize();
      if (shape && extras.length) {
        mhint.textContent = 'Read ' + res.name + ' with ' + extras.length
          + (extras.length === 1 ? ' companion file.' : ' companion files.');
      }
      if (shape && units !== 'm') {
        mhint.textContent = 'That file measures ' + Math.round(shape.size[0]) + ' × '
          + Math.round(shape.size[1]) + ' × ' + Math.round(shape.size[2])
          + ' in its own units — too large for metres, so it is being read as '
          + units + '. Change it below if that is wrong.';
        if (status1) { status1.textContent = 'Model placed, read as ' + units + '.'; status1.classList.add('show'); }
        return;
      }
      mhint.textContent = res.warning
        || (shape ? 'Drag the model on the map to position it.'
                  : 'Placed, but its shape could not be read — it shows as a marker.');
      if (status1) { status1.textContent = 'Model placed. Drag it where the building goes.'; status1.classList.add('show'); }
    };
    document.getElementById('fpModelFile').onchange = takeFiles;
    document.getElementById('fpModelDir').onchange = takeFiles;
    document.getElementById('fpModelFindFile').onchange = takeFiles;

    document.getElementById('fpModelClear').onclick = () => {
      if (fpSession) fpSession.ctl.clearModel();
      mrow.style.display = 'none';
      mrotBox.style.display = 'none';
      mfix.style.display = 'none';
      mfind.style.display = 'none';
      pendingFiles = [];
      mhint.className = 'fp-note';
      mhint.textContent = mhint0;
    };

    fpShowStep(1);
    setTimeout(() => ctl.resize(), 60);
  }

  document.getElementById('fpNext').onclick = () => {
    if (fpSession && !fpSession.ctl.getRings().length && !fpSession.ctl.getModel()) {
      document.getElementById('fpStatus1').textContent =
        'Nothing to build yet — close at least one shape, or upload a model, first.';
      return;
    }
    const t3d = document.getElementById('fp3d');
    if (!t3d.checked) { t3d.checked = true; if (fpSession) fpSession.ctl.setTilt(true); }
    fpShowStep(2);
  };
  document.getElementById('fpBack').onclick = () => fpShowStep(1);

  document.getElementById('fpMap').onchange = (e) => {
    if (fpSession) fpSession.ctl.setBackdrop(e.target.checked);
  };
  document.getElementById('fpCancel').onclick = () => closeFootprint();
  document.getElementById('fpCancel2').onclick = () => closeFootprint();
  document.getElementById('fpClose').onclick = () => closeFootprint();

  function commitFootprint(mode) {
    if (!fpSession) return;
    const rings = fpSession.ctl.getRings();
    const model = fpSession.ctl.getModel();
    if (!rings.length && !model) { fpShowStep(1); return; }
    const height = Math.max(0.5, Math.min(1000, +document.getElementById('fpH').value || 20));
    if (rings.length) {
      api.setBuildingEdit(fpSession.buildingId,
        { op: 'replace_with_building', rings: rings, ring: rings[0], height_m: height },
        { mode: mode });
    }
    if (model) {
      api.setBuildingEdit(rings.length ? fpSession.buildingId + '-m' : fpSession.buildingId,
        { op: 'replace_with_model', model: model.model, anchor_lonlat: model.anchor_lonlat,
          rotation_deg: model.rotation_deg || 0, scale: model.scale || 1,
          up_axis: model.up_axis || 'z' },
        { mode: mode });
    }
    fpSession.saved = true;
    closeFootprint();
    setMapNote('');
  }
  document.getElementById('fpFinal').onclick = () => commitFootprint('permanent');
  document.getElementById('fpTemp').onclick = () => commitFootprint('session');

  api.setBuildingActions({
    listModels: () => SM.availableModels || [],
    uploadModel: uploadModel,
    createBuilding: (lonlat, dims) => rf.addBuildingAt(lonlat, dims),
    placeModel: (lonlat, model) => rf.addModel(model, lonlat, {}),
    notify: (text) => setMapNote(text),
    designReplacement: (feature, id, prior) => openFootprint(feature, id, prior),
    designNewBuilding: (lonlat) => openNewBuilding(lonlat),
    editUserBuilding: (id, edit) => {
      const rings = (edit.rings && edit.rings.length ? edit.rings : [edit.ring]).filter(Boolean);
      startFootprint({
        ring: rings[0] || [], extraRings: rings.slice(1),
        center: rings[0] && rings[0][0], id: id, prior: null, replacing: false,
        title: 'Your building', height: Math.round(edit.height_m || 15),
        hint: 'Change any part of it, then set the height again.'
      });
    }
  });

  const rayShowBind = document.getElementById('rayShow');
  if (rayShowBind) {
    rayShowBind.onchange = () => {
      rf.showRays(rayShowBind.checked);
      const ri = document.getElementById('rayInfo');
      if (ri && !rayShowBind.checked) ri.textContent = 'Ray paths hidden.';
      toHost({ type: 'sk-rays-toggled', on: rayShowBind.checked });
    };
  }

  let lastCoverage = null;
  let covMetric = 'path_gain';

  const METRIC_LABEL = { path_gain: 'Path gain', rss: 'RSS', sinr: 'SINR' };

  function coverageSummary(ov, s) { return SM.coverageSummary(ov, s, covMetric); }

  function renderCoverageControls(ov) {
    const metrics = document.getElementById('covMetrics');
    const bandsRow = document.getElementById('covBandsRow');
    const have = ov && ov.images ? Object.keys(ov.images) : [];
    if (metrics) {
      metrics.hidden = have.length < 2;
      metrics.querySelectorAll('input[name="covMetric"]').forEach((el) => {
        el.disabled = have.length ? have.indexOf(el.value) < 0 : false;
        el.checked = covMetric != null && el.value === covMetric;
      });
    }
    if (bandsRow) {
      bandsRow.hidden = !(ov && ov.boundaries);
    }
  }

  function applyCoverage(ov) {
    const info = document.getElementById('covInfo');
    if (!ov) {
      api.loadCoverage(null);
      renderCoverageControls(null);
      if (info) info.textContent = lastCoverage ? 'Coverage hidden — Show coverage puts it back.'
                                                : 'Coverage hidden.';
      return;
    }
    lastCoverage = ov;
    if (covMetric == null || !(ov.images || {})[covMetric]) covMetric = ov.metric || 'path_gain';
    const s = api.loadCoverage(ov, covMetric);
    renderCoverageControls(ov);
    const bands = document.getElementById('covBands');
    if (bands) api.setCoverageBands(bands.checked);
    if (info) info.textContent = coverageSummary(ov, s);
  }
  function showCoverage() {
    if (lastCoverage) applyCoverage(lastCoverage);
  }
  function hasCoverage() { return !!lastCoverage; }

  let lastRayCount = 0;
  function hasRays() { return lastRayCount > 0; }

  const covFile = document.getElementById('mCoverage');
  if (covFile) covFile.onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try { applyCoverage(JSON.parse(rd.result)); }
      catch (err) { alert('Invalid coverage JSON.'); }
    };
    rd.readAsText(f);
    e.target.value = '';
  };
  const offBtn = document.getElementById('mCoverageOff');
  if (offBtn) offBtn.onclick = () => applyCoverage(null);

  (function wireMetrics() {
    const radios = Array.from(document.querySelectorAll('input[name="covMetric"]'));
    let wasChecked = null;
    radios.forEach((el) => {
      el.addEventListener('mousedown', () => { wasChecked = el.checked; });
      el.addEventListener('keydown', (e) => { if (e.key === ' ') wasChecked = el.checked; });
      el.addEventListener('click', () => {
        if (wasChecked) {
          el.checked = false;
          covMetric = null;
          api.loadCoverage(null);
          const info = document.getElementById('covInfo');
          if (info) info.textContent = 'Overlay off — pick a metric to draw it again.';
        } else {
          covMetric = el.value;
          if (lastCoverage) applyCoverage(lastCoverage);
        }
        wasChecked = null;
      });
    });
  })();

  const covBandsEl = document.getElementById('covBands');
  if (covBandsEl) {
    covBandsEl.addEventListener('change', () => {
      const ok = api.setCoverageBands(covBandsEl.checked);
      if (!ok) {
        covBandsEl.checked = !covBandsEl.checked;
        const info = document.getElementById('covInfo');
        if (info) {
          info.textContent = lastCoverage
            ? 'Pick a metric first — the contested band is drawn on the overlay.'
            : 'Load a coverage overlay first — the contested band is drawn on it.';
        }
      }
    });
  }

  function renderModes(mode) {
    Object.entries(modeBtns).forEach(([m, id]) => document.getElementById(id).classList.toggle('on', m === mode));
    map.getCanvas().style.cursor = mode ? 'crosshair' : '';
  }

  function renderState(st) {
    const bb = document.getElementById('bbInfo');
    if (st.bbox) { const s = SM.geo.bboxSizeM(st.bbox); bb.textContent = 'Area: ' + Math.round(s[0]) + ' m × ' + Math.round(s[1]) + ' m  (' + (s[0] * s[1] / 1e6).toFixed(2) + ' km²)'; }
    else bb.textContent = 'No box drawn — Build will use the current map view. Zoom in / draw a box for a smaller, faster scene.';
    const nl = document.getElementById('nodeList'); nl.innerHTML = '';
    st.nodes.forEach((n) => {
      const row = document.createElement('div'); row.className = 'nrow';
      const sub = n.route ? 'route' : n.on;
      const rfField = (cls, val, name, unit, title) =>
        '<label title="' + title + '">' + name +
        '<span class="unit"><input class="rfin ' + cls + '" type="number" value="' + val +
        '"><i>' + unit + '</i></span></label>';
      let rfHtml = '';
      if (n.rf) rfHtml = '<div class="rf">' +
        rfField('naz', n.rf.azimuth_deg, 'az', '°', 'which way the antenna faces, clockwise from north') +
        rfField('ntilt', n.rf.downtilt_deg, 'tilt', '°', 'how far the antenna is aimed downward') +
        rfField('npwr', n.rf.tx_power_dbm, 'power', 'dBm', 'transmit power') +
        '</div>';
      row.innerHTML =
        '<span class="dot" style="background:' + rf.NODE_STYLE[n.type].color + '"></span>' +
        '<span class="nm">' + n.name + '<span class="sub">' + sub + '</span></span>' +
        '<span class="unit" title="height above ground">' +
        '<input class="nh" type="number" value="' + n.heightAGL + '"><i>m</i></span>' +
        '<span class="x" title="remove"><svg class="ico" viewBox="0 0 16 16" aria-hidden><path d="M3 4.5h10"/><path d="M6.5 4.5V3.2h3v1.3"/><path d="M4.4 4.5 5 13h6l.6-8.5"/><path d="M6.8 6.8v3.9M9.2 6.8v3.9"/></svg></span>' + rfHtml;
      row.querySelector('.nh').onchange = (e) => rf.setNodeHeight(n.id, e.target.value);
      row.querySelector('.x').onclick = () => rf.removeNode(n.id);
      if (n.rf) {
        row.querySelector('.naz').onchange = (e) => rf.setNodeRF(n.id, 'azimuth_deg', e.target.value);
        row.querySelector('.ntilt').onchange = (e) => rf.setNodeRF(n.id, 'downtilt_deg', e.target.value);
        row.querySelector('.npwr').onchange = (e) => rf.setNodeRF(n.id, 'tx_power_dbm', e.target.value);
      }
      nl.appendChild(row);
    });
    const rl = document.getElementById('routeList');
    if (rl) {
      rl.innerHTML = '';
      (st.routes || []).forEach((r, i) => {
        const row = document.createElement('div');
        row.className = 'nrow';
        const dot = document.createElement('span');
        dot.className = 'dot route';
        const nm = document.createElement('span');
        nm.className = 'nm';
        const walking = st.nodes.filter((n) => n.routeId === r.id).length;
        const corners = (r.points || []).length;
        const detail = [corners + (corners === 1 ? ' corner' : ' corners')]
          .concat(walking ? [walking + (walking === 1 ? ' UE walking it' : ' UEs walking it')] : [])
          .join(' · ');
        nm.textContent = 'Path ' + (i + 1);
        const sub = document.createElement('span');
        sub.className = 'sub';
        sub.textContent = detail;
        nm.appendChild(sub);
        const x = document.createElement('span');
        x.className = 'x'; x.title = 'remove this path'; x.innerHTML = '<svg class="ico" viewBox="0 0 16 16" aria-hidden><path d="M3 4.5h10"/><path d="M6.5 4.5V3.2h3v1.3"/><path d="M4.4 4.5 5 13h6l.6-8.5"/><path d="M6.8 6.8v3.9M9.2 6.8v3.9"/></svg>';
        x.onclick = () => rf.removeRoute(r.id);
        row.appendChild(dot); row.appendChild(nm); row.appendChild(x);
        rl.appendChild(row);
      });
    }

    const al = document.getElementById('addedList');
    if (al) {
      al.innerHTML = '';
      st.customBuildings.forEach((f, i) => {
        const p = f.properties || {};
        const row = document.createElement('div');
        row.className = 'nrow';
        const dot = document.createElement('span');
        dot.className = 'dot'; dot.style.background = '#22d3ee';
        const nm = document.createElement('span');
        nm.className = 'nm';
        const bits = [];
        if (p.width_m) bits.push(p.width_m + ' × ' + p.depth_m + ' m');
        bits.push(p.height ? p.height + ' m tall' : 'height unknown');
        nm.textContent = 'Building ' + (i + 1);
        const bsub = document.createElement('span');
        bsub.className = 'sub';
        bsub.textContent = bits.join(' · ');
        nm.appendChild(bsub);
        const x = document.createElement('span');
        x.className = 'x'; x.title = 'remove'; x.innerHTML = '<svg class="ico" viewBox="0 0 16 16" aria-hidden><path d="M3 4.5h10"/><path d="M6.5 4.5V3.2h3v1.3"/><path d="M4.4 4.5 5 13h6l.6-8.5"/><path d="M6.8 6.8v3.9M9.2 6.8v3.9"/></svg>';
        x.onclick = () => rf.removeCustomBuilding(p.id);
        row.appendChild(dot); row.appendChild(nm); row.appendChild(x);
        al.appendChild(row);
      });
    }

    const gnbBtn = document.getElementById('mGnb');
    if (gnbBtn) {
      const full = rf.gnbFull();
      gnbBtn.classList.toggle('disabled', full);
      gnbBtn.title = full
        ? rf.MAX_GNB + ' gNBs at most — remove one to place it somewhere else'
        : 'Place a gNB';
    }

    const counts = st.nodes.reduce((a, n) => (a[n.type] = (a[n.type] || 0) + 1, a), {});
    const parts = [];
    if (st.edits.length) parts.push(st.edits.length + ' edit(s)');
    if (st.customBuildings.length) parts.push(st.customBuildings.length + ' added building(s)');
    if (counts.gnb) parts.push(counts.gnb + ' gNB');
    if (counts.tower) parts.push(counts.tower + ' tower');
    if (counts.ue) parts.push(counts.ue + ' UE');
    const hint = document.getElementById('editHint');
    if (hint) hint.textContent = parts.join(' · ');
  }

  const embedded = window.parent && window.parent !== window;
  function toHost(msg) {
    if (embedded) window.parent.postMessage(msg, window.location.origin);
  }

  if (embedded) {
    const rfTab = document.querySelector('.tab[data-tab="rf"]');
    if (rfTab) rfTab.click();
  }

  if (new URLSearchParams(location.search).get('chrome') === 'operate') {
    document.documentElement.setAttribute('data-chrome', 'operate');
    const resetBtn = document.getElementById('btnReset');
    if (resetBtn) {
      resetBtn.title = 'Frame the scene again';
      resetBtn.onclick = () => {
        if (!(framed && frameScene(framed.bbox, framed.km, framed.pitch))) api.reset();
      };
    }

    const group = document.querySelector('.ctlgroup');
    if (group) {
      const add = (svg, text, title, onClick) => {
        const row = document.createElement('div');
        row.className = 'ctl';
        row.title = title;
        row.innerHTML = svg + '<span>' + text + '</span>';
        row.onclick = onClick;
        group.appendChild(row);
        return row;
      };
      const showRow = add(
        '<svg class="ico" viewBox="0 0 16 16"><path d="M2 8s2.4-4 6-4 6 4 6 4-2.4 4-6 4-6-4-6-4Z"/>'
        + '<circle cx="8" cy="8" r="1.6"/></svg>', 'Show coverage',
        'Put the scene\'s coverage back on the map', () => { showCoverage(); markCoverage(true); });
      const hideRow = add(
        '<svg class="ico" viewBox="0 0 16 16"><path d="M2 8s2.4-4 6-4 6 4 6 4-2.4 4-6 4-6-4-6-4Z"/>'
        + '<circle cx="8" cy="8" r="1.6"/><path d="M3 13 13 3"/></svg>', 'Hide coverage',
        'Take the coverage overlay off the map', () => { applyCoverage(null); markCoverage(false); });
      function markCoverage(on) {
        showRow.classList.toggle('active', on);
        hideRow.classList.toggle('active', !on);
        showRow.title = hasCoverage() ? 'Put the scene\'s coverage back on the map'
                                      : 'This scene has no solved coverage yet';
      }
      markCoverage(false);
      const rayShowRow = add(
        '<svg class="ico" viewBox="0 0 16 16"><path d="M2 13 8 3l6 10"/><path d="M5 9h6"/></svg>',
        'Show rays', 'Put the traced ray paths back on the map',
        () => { rf.showRays(true); markRays(true);
                 toHost({ type: 'sk-rays-toggled', on: true }); });
      const rayHideRow = add(
        '<svg class="ico" viewBox="0 0 16 16"><path d="M2 13 8 3l6 10"/><path d="M5 9h6"/>'
        + '<path d="M3 13 13 3"/></svg>',
        'Hide rays', 'Take the ray paths off the map',
        () => { rf.showRays(false); markRays(false);
                 toHost({ type: 'sk-rays-toggled', on: false }); });
      function markRays(on) {
        rayShowRow.classList.toggle('active', on);
        rayHideRow.classList.toggle('active', !on);
        rayShowRow.title = hasRays() ? 'Put the traced ray paths back on the map'
                                     : 'Trace a link first — there are no ray paths yet';
      }
      markRays(false);
      SM._markRays = markRays;

      window.addEventListener('message', (e) => {
        if (e.origin !== window.location.origin) return;
        const t = (e.data || {}).type;
        if (t === 'sk-load-coverage') markCoverage(true);
        else if (t === 'sk-hide-coverage') markCoverage(false);
      });
    }
  }

  (function wireRail() {
    const rail = document.getElementById('rail');
    const panels = {
      design: document.querySelector('.sidebar'),
      nav: document.querySelector('.controls'),
    };
    if (!rail || !panels.design || !panels.nav) return;

    function show(which) {
      Object.entries(panels).forEach(([k, el]) => {
        if (el) el.classList.toggle('folded', k !== which);
      });
      rail.querySelectorAll('.rtab').forEach((t) => {
        t.classList.toggle('on', t.dataset.panel === which);
      });
      document.documentElement.setAttribute(
        'data-sidebar', which === 'design' ? 'open' : 'folded');
    }

    rail.querySelectorAll('.rtab').forEach((tab) => {
      tab.onclick = () => {
        show(tab.classList.contains('on') ? null : tab.dataset.panel);
      };
    });

    window.SK_closePanels = () => show(null);

    show(null);
  })();

  const DRAFT_KEY = 'tossi.map.draft';
  const draftsOn = new URLSearchParams(location.search).get('draft') === '1';
  let draftScene = null;
  let draftWarned = false;

  function saveDraft() {
    if (!draftsOn) return;
    try {
      const st = rf.getState();
      if (!st.bbox && !st.nodes.length && !st.edits.length && !st.customBuildings.length) {
        localStorage.removeItem(DRAFT_KEY);
        return;
      }
      const m = rf.manifest();
      if (!st.bbox) m.bbox = null;
      const body = JSON.stringify({ v: 1, sceneId: draftScene, at: Date.now(), manifest: m });
      if (body.length > 3e6) throw new Error('draft too large');
      localStorage.setItem(DRAFT_KEY, body);
    } catch (err) {
      if (!draftWarned) {
        draftWarned = true;
        console.warn('could not save the design draft:', err && err.message);
      }
    }
  }

  function restoreDraft() {
    if (!draftsOn) return undefined;
    let d = null;
    try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { d = null; }
    if (!d || d.v !== 1 || !d.manifest) return undefined;
    if (!d.sceneId) {
      try { localStorage.removeItem(DRAFT_KEY); } catch (e) {  }
      return undefined;
    }
    try {
      rf.importManifest(d.manifest);
      draftScene = d.sceneId || null;
      adoptScenePlace(d.manifest);
      const bb = d.manifest.bbox;
      if (bb) frameScene(bb, 0);
      else api.reset();
      if (draftScene) {
        const manifest = d.manifest;
        window.__skFixDraftLabel = function fixDraftLabel() {
          if (!draftScene) return;
          fetch('/api/map/scenes').then((r) => (r.ok ? r.json() : null)).then((list) => {
            const s = Array.isArray(list) && list.find((x) => x.scene_id === draftScene);
            if (s && s.city && s.city !== city.label) {
              adoptScenePlace(Object.assign({}, manifest, { city: s.city }));
              saveDraft();
            }
          }).catch(() => {  });
        };
        window.__skFixDraftLabel();
      }
      return draftScene || null;
    } catch (err) {
      localStorage.removeItem(DRAFT_KEY);
      return undefined;
    }
  }

  function reportState() {
    const st = rf.getState();
    const counts = st.nodes.reduce((a, n) => ((a[n.type] = (a[n.type] || 0) + 1), a), {});
    const size = st.bbox ? SM.geo.bboxSizeM(st.bbox).map((v) => SM.geo.round(v, 1)) : null;
    toHost({
      type: 'sk-state',
      hasArea: !!st.bbox,
      areaSizeM: size,
      nodes: { gnb: counts.gnb || 0, tower: counts.tower || 0, ue: counts.ue || 0 },
      nodeList: st.nodes.map((n) => ({
        id: n.id, name: n.name, type: n.type, lonlat: n.lonlat,
        heightAGL: n.heightAGL, on: n.on, hasRoute: !!n.routeId,
        rf: n.rf ? {
          freq_hz: n.rf.freq_hz, tx_power_dbm: n.rf.tx_power_dbm,
          azimuth_deg: n.rf.azimuth_deg, downtilt_deg: n.rf.downtilt_deg,
          cols: n.rf.array ? n.rf.array.cols : null, rows: n.rf.array ? n.rf.array.rows : null
        } : null
      })),
      models: st.models.map((m) => ({ id: m.id, model: m.model, scale: m.scale,
                                      rotation_deg: m.rotation_deg, material: m.material })),
      pendingModel: st.pendingModel,
      hasRoute: (st.routes || []).length > 0,
      routes: (st.routes || []).map((r) => ({ id: r.id, corners: (r.points || []).length })),
      edits: st.edits.length,
      addedBuildings: st.customBuildings.length,
      mode: st.mode,
      rf: { freq_hz: st.rf.freq_hz, cols: st.rf.array.cols, tx_power_dbm: st.rf.tx_power_dbm },
      city: api.city.label,
      view: api.getView(),
      buildingOpacity: api.getBuildingOpacity(),
      site: st.site || null,
      trees: { count: api.treeCount(), visible: api.getTreesVisible() }
    });
  }

  SM._diagCount = () => api.renderedBuildingCount();
  SM._diagZoom = () => api.getZoom();

  map.on('load', () => {
    api.addBuildings();
    rf.init();
    if (city.site) rf.setSite(city.site);
    refreshSites();
    api.loadSavedHeights();
    refreshModels();
    clockEl.textContent = api.setTime(parseFloat(timeEl.value));
    const restored = restoreDraft();
    toHost({ type: 'sk-ready', city: api.city.label,
             restored: restored !== undefined, restoredScene: restored || null });
    map.once('idle', () => toHost({ type: 'sk-tiles-ready' }));
    reportState();
  });

  if (embedded) {
    window.addEventListener('message', (e) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data || {};
      if (d.type === 'sk-request-package') {
        const fc = rf.areaBuildings() || { type: 'FeatureCollection', features: [] };
        toHost({
          type: 'sk-package',
          requestId: d.requestId || null,
          package: { manifest: rf.manifest(), buildings: fc }
        });
      } else if (d.type === 'sk-load-coverage' && d.overlay) {
        applyCoverage(d.overlay);
      } else if (d.type === 'sk-load-rays' && d.paths) {
        const n = rf.setRays(d.paths, d.origin_lonlat || null);
        try {
          const paths = d.paths || [];
          const org = d.origin_lonlat;
          if (paths.length && org) {
            const now = Date.now();
            let lo = 180, la = 90, hi = -180, ha = -90;
            for (const p of paths) {
              for (const q of (p.points || [])) {
                const ll = SM.geo.fromENU(+q[0], +q[1], org[0], org[1]);
                if (ll[0] < lo) lo = ll[0];
                if (ll[0] > hi) hi = ll[0];
                if (ll[1] < la) la = ll[1];
                if (ll[1] > ha) ha = ll[1];
              }
            }
            const key = [lo, la, hi, ha].map((v) => v.toFixed(4)).join(',');
            const firstFit = !SM._lastLinkFit;
            if (firstFit && key !== SM._lastLinkBox) {
              SM._lastLinkFit = now;
              SM._lastLinkBox = key;
              if (framed) frameScene(framed.bbox, framed.km, framed.pitch);
            }
          }
        } catch (e) {  }
        lastRayCount = n;
        rf.showRays(true);
        if (SM._markRays) SM._markRays(true);
        const box = document.getElementById('rayShow');
        if (box) box.checked = true;
        const ri = document.getElementById('rayInfo');
        if (ri) {
          const los = (d.paths || []).filter((q) => q.los).length;
          ri.textContent = n
            ? n + ' path' + (n === 1 ? '' : 's') + ' drawn, ' +
              (los ? los + ' line-of-sight' : 'none line-of-sight') +
              ' - the track is on the ground; bounce heights are in the data, not the line.'
            : 'The solve reported no paths to draw.';
        }
        toHost({ type: 'sk-rays', count: n });
      } else if (d.type === 'sk-show-rays') {
        rf.showRays(true);
        if (SM._markRays) SM._markRays(true);
        const box3 = document.getElementById('rayShow');
        if (box3) box3.checked = true;
      } else if (d.type === 'sk-ray-tx') {
        rf.setRayTx(d.tx || '');
      } else if (d.type === 'sk-ray-band') {
        rf.setRayBand(d.band || 'all');
      } else if (d.type === 'sk-serving') {
        rf.setServingLink({ pci: d.pci == null ? null : d.pci });
      } else if (d.type === 'sk-handover') {
        const ok = rf.setHandover({
          from: d.from || null,
          to: d.to || null,
          bow: d.bow,
          period_ms: d.period_ms,
          loop: d.loop
        });
        toHost({ type: 'sk-handover-shown', ok: !!ok });
      } else if (d.type === 'sk-hide-handover') {
        rf.clearHandover();
      } else if (d.type === 'sk-hide-rays') {
        rf.showRays(false);
        if (SM._markRays) SM._markRays(false);
        const box2 = document.getElementById('rayShow');
        if (box2) box2.checked = false;
      } else if (d.type === 'sk-hide-coverage') {
        applyCoverage(null);
      } else if (d.type === 'sk-load-manifest' && d.manifest) {
        try {
          draftScene = d.sceneId || null;
          rf.importManifest(d.manifest);
          const b = d.manifest.bbox;
          if (b) {
            applyFocus(null);
            adoptScenePlace(d.manifest);
            const km = Math.max(0, Math.min(20, +d.padKm || 0));
            frameScene(b, km, d.pitch);
            if (d.lock) applyFocus(b, km);
          }
          toHost({ type: 'sk-manifest-loaded' });
        } catch (err) {
          toHost({ type: 'sk-error', error: 'could not load that scene manifest' });
        }
      } else if (d.type === 'sk-clear') {
        draftScene = null;
        try { localStorage.removeItem(DRAFT_KEY); } catch (e) {  }
        rf.clearAll();
      } else if (d.type === 'sk-models') {
        SM.availableModels = Array.isArray(d.models) ? d.models : [];
        rf.setPendingModel(SM.availableModels[0] || null);
      } else if (d.type === 'sk-auth') {
        SK_TOKEN = typeof d.token === 'string' ? d.token : '';
        if (typeof window.__skFixDraftLabel === 'function') {
          setTimeout(() => window.__skFixDraftLabel(), 0);
        }
        refreshSites().then(() => {
          const s = rf.getSite();
          if (s) rf.setSite(s, { force: true });
          else if (city && city.site) rf.setSite(city.site, { force: true });
        });
      } else if (d.type === 'sk-inset') {
        const px = Math.max(0, Math.min(600, +d.right || 0));
        document.documentElement.style.setProperty('--inset-right', px + 'px');
        const changed = SM._insetRight !== px;
        SM._insetRight = px;
        if (changed && framed) frameScene(framed.bbox, framed.km, framed.pitch);
      } else if (d.type === 'sk-set-view') {
        applyView(d.view);
      } else if (d.type === 'sk-set-building-opacity') {
        applyBuildingOpacity(d.value);
      } else if (d.type === 'sk-set-mode') {
        rf.setMode(d.mode || null);
      } else if (d.type === 'sk-add-node') {
        rf.addNodeAt(d.nodeType, d.lonlat || null, d);
      } else if (d.type === 'sk-remove-node') {
        rf.removeNode(d.id);
      } else if (d.type === 'sk-set-node-height') {
        rf.setNodeHeight(d.id, d.value);
      } else if (d.type === 'sk-set-node-rf') {
        rf.setNodeRF(d.id, d.key, d.value);
      } else if (d.type === 'sk-set-rf') {
        rf.setRF(d.key, d.value);
      } else if (d.type === 'sk-set-pending-model') {
        rf.setPendingModel(d.model);
      } else if (d.type === 'sk-fold-controls') {
        if (typeof window.SK_closePanels === 'function') window.SK_closePanels();
      } else if (d.type === 'sk-capture') {
        const shoot = () => {
          map.once('render', () => {
            let url = null;
            try {
              const cv = map.getCanvas();
              const SIDE = 900;
              const off = document.createElement('canvas');
              off.width = SIDE; off.height = SIDE;
              const ctx = off.getContext('2d');
              const side = Math.min(cv.width, cv.height);
              ctx.drawImage(cv, (cv.width - side) / 2, (cv.height - side) / 2, side, side,
                            0, 0, SIDE, SIDE);
              url = off.toDataURL('image/jpeg', d.quality || 0.72);
            } catch (err) {
              try { url = map.getCanvas().toDataURL('image/jpeg', d.quality || 0.72); }
              catch (err2) { url = null; }
            }
            toHost({ type: 'sk-frame', requestId: d.requestId || null, image: url });
          });
          map.triggerRepaint();
        };

        if (d.frame) {
          const was = { center: map.getCenter(), zoom: map.getZoom(),
                        pitch: map.getPitch(), bearing: map.getBearing() };
          let bb = null;
          try { bb = rf.effectiveBbox && rf.effectiveBbox(); } catch (e) { bb = null; }
          map.jumpTo({ pitch: 0, bearing: 0 });
          if (bb && isFinite(bb.minLon) && isFinite(bb.minLat)) {
            try {
              map.fitBounds([[bb.minLon, bb.minLat], [bb.maxLon, bb.maxLat]],
                            { padding: 36, animate: false, duration: 0 });
            } catch (e) {  }
          }
          map.once('idle', () => {
            shoot();
            map.once('render', () => { try { map.jumpTo(was); } catch (e) {  } });
          });
          map.triggerRepaint();
        } else {
          shoot();
        }
      } else if (d.type === 'sk-live-ue') {
        try {
          rf.setLiveUE(d.enu || null, { trail: d.trail, gain_db: d.gain_db,
                                        applied_db: d.applied_db, paths: d.paths });
        } catch (e) {  }
      } else if (d.type === 'sk-remove-model') {
        rf.removeModel(d.id);
      }
    });
  }
})();
