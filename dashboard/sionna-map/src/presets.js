window.SM = window.SM || {};

SM.OVERTURE_RELEASE = '2026-09-23.0';
SM.OVERTURE_BUILDINGS =
  'pmtiles://https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/' +
  SM.OVERTURE_RELEASE + '/buildings.pmtiles';

SM.BASE_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
SM.TERRAIN_TILES = location.origin + '/api/terrain/{z}/{x}/{y}.png';
SM.TERRAIN_MAXZOOM = 16;
SM.TERRAIN_ON = typeof window.__skTerrain === 'boolean' ? window.__skTerrain : false;

SM.liftView = function (map, view) {
  if (!map || !map.getTerrain || !map.getTerrain() || !map.transform || !map.transform.elevation) return view;
  const dz = -map.transform.elevation * maplibregl.MercatorCoordinate.fromLngLat(map.getCenter(), 1).z;
  const o = new Float64Array(view);
  for (let r = 0; r < 4; r++) o[12 + r] = view[12 + r] + view[8 + r] * dz;
  return o;
};

SM.IMAGERY = {
  tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
  tileSize: 256,
  maxzoom: 19,
  attribution: 'Imagery © <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics'
};

SM.VIEWS = ['roadmap', 'satellite', 'hybrid', 'terrain'];

SM.VIEW_LAYERS = {
  roadmap:   { imagery: false, hillshade: false, ground: true,  road: true,  boundary: true,  label: true,  buildings: 0.94, ramp: 'default' },
  satellite: { imagery: true,  hillshade: false, ground: false, road: false, boundary: false, label: false, buildings: 0.96, ramp: 'imagery' },
  hybrid:    { imagery: true,  hillshade: false, ground: false, road: true,  boundary: true,  label: true,  buildings: 0.96, ramp: 'imagery' },
  terrain:   { imagery: false, hillshade: true,  ground: true,  road: true,  boundary: true,  label: true,  buildings: 0.94, ramp: 'default' }
};

SM.HEIGHT_RAMP = [0, '#8d94a6', 40, '#9aa0ae', 120, '#b3a58c', 300, '#e8b04b'];

SM.EDIT_COLORS = {
  height: '#f5c211',
  replaced: '#2f6fed',
  drawn: '#22c55e',
  model: '#e5342a'
};
SM.EDIT_KIND_TEXT = {
  height: 'Height changed by you',
  replaced: 'Outline redrawn by you, over the original building',
  drawn: 'A new building you drew',
  model: 'A new building from your model'
};
SM.EDITED_COLOR = SM.EDIT_COLORS.height;
SM.NEW_COLOR = SM.EDIT_COLORS.drawn;

SM.modelShapes = {};
SM.modelShape = async function (name, up) {
  const key = name + '|' + (up === 'y' ? 'y' : 'z');
  if (SM.modelShapes[key] !== undefined) return SM.modelShapes[key];
  SM.modelShapes[key] = null;
  try {
    const r = await fetch('/api/map/models/' + encodeURIComponent(name)
      + '/shape?up=' + (up === 'y' ? 'y' : 'z'));
    const j = await r.json();
    SM.modelShapes[key] = (j && j.points && j.points.length >= 3) ? j : null;
  } catch (e) { SM.modelShapes[key] = null; }
  return SM.modelShapes[key];
};

SM.UNIT_SCALES = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };
SM.guessModelUp = function (name) {
  return /\.(glb|gltf)$/i.test(name || '') ? 'y' : 'z';
};
SM.guessModelUnits = function (shape) {
  const big = shape ? Math.max(shape.size[0], shape.size[1], shape.size[2]) : 0;
  if (big > 1000) return big / 1000 < 1000 ? 'mm' : 'mm';
  if (big > 300) return 'cm';
  return 'm';
};

SM.modelError = async function (name, up) {
  try {
    const r = await fetch('/api/map/models/' + encodeURIComponent(name)
      + '/shape?up=' + (up === 'y' ? 'y' : 'z'));
    const j = await r.json();
    return j && j.error ? j.error : '';
  } catch (e) { return ''; }
};

SM.modelRing = function (shape, anchor, deg, scale) {
  const th = ((+deg || 0) * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th);
  const k = +scale > 0 ? +scale : 1;
  const ring = shape.points.map((p) => SM.geo.fromENU(
    (p[0] * cos - p[1] * sin) * k, (p[0] * sin + p[1] * cos) * k, anchor[0], anchor[1]));
  ring.push(ring[0].slice());
  return ring;
};

SM.HEIGHT_RAMP_IMAGERY = [0, '#aeb9cc', 40, '#c2ccdb', 120, '#d8d2be', 300, '#f0c368'];

SM.IMAGERY_PAINT = {
  'raster-brightness-max': 0.86,
  'raster-saturation': -0.12,
  'raster-contrast': 0.05
};

SM.MATERIALS = {
  default: 'itu_concrete',
  byFacadeMaterial: {
    glass: 'itu_glass', brick: 'itu_brick', concrete: 'itu_concrete',
    stone: 'itu_marble', metal: 'itu_metal', wood: 'itu_wood', plaster: 'itu_plasterboard'
  },
  bySubtype: { residential: 'itu_brick', commercial: 'itu_concrete', industrial: 'itu_metal' },
  choices: ['itu_concrete', 'itu_glass', 'itu_brick', 'itu_marble', 'itu_metal', 'itu_wood', 'itu_plasterboard', 'itu_very_dry_ground']
};

SM.NAME_LANG = 'en';

SM.buildingName = function buildingName(props) {
  if (!props) return null;
  const lang = SM.NAME_LANG;
  const wanted = (code) => typeof code === 'string' &&
    (code === lang || code.indexOf(lang + '-') === 0);
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

  let names = props.names;
  if (typeof names === 'string') {
    const s = names.trim();
    names = null;
    if (s.charAt(0) === '{') { try { names = JSON.parse(s); } catch (e) { names = null; } }
  }

  if (names && typeof names === 'object') {
    const common = names.common;
    if (common && typeof common === 'object') {
      const key = Object.keys(common).filter(wanted)[0];
      const hit = key ? clean(common[key]) : null;
      if (hit) return hit;
    }
    const rules = Array.isArray(names.rules) ? names.rules : [];
    const en = rules.filter((r) => r && wanted(r.language) && clean(r.value));
    if (en.length) return clean((en.filter((r) => r.variant !== 'alternate')[0] || en[0]).value);
    const primary = clean(names.primary);
    if (primary) return primary;
  }
  return clean(props['@name']);
};

SM.DEFAULT_HEIGHT_FALLBACK_M = 9;

SM.FLOOR_HEIGHT_M = 3;

SM.buildingHeight = function buildingHeight(props, fallbackM) {
  const p = props || {};
  const pos = (v) => { const n = parseFloat(v); return isFinite(n) && n > 0 ? n : null; };
  const h = pos(p.height) || pos(p.render_height);
  if (h) return { m: h, source: 'measured' };
  const floors = pos(p.num_floors);
  if (floors) return { m: floors * SM.FLOOR_HEIGHT_M, source: 'floors', floors: floors };
  return { m: pos(fallbackM) || SM.DEFAULT_HEIGHT_FALLBACK_M, source: 'estimated' };
};

SM.cityFromPlace = function cityFromPlace(r) {
  const lon = +r.lon, lat = +r.lat;
  const bb = Array.isArray(r.boundingbox) ? r.boundingbox.map(Number) : null;
  let spanDeg = 0.08;
  if (bb && bb.length === 4) {
    const [south, north, west, east] = bb;
    spanDeg = Math.max(north - south, east - west, 0.01);
  }
  let zoom;
  if (SM.isRegionResult(r) && spanDeg > 0.05) {
    zoom = Math.max(3, Math.min(12, Math.log2(1687.5 / spanDeg)));
  } else {
    zoom = spanDeg > 0.5 ? 15.8 : spanDeg > 0.05 ? 16.0 : 16.4;
  }
  const segs = String(r.display_name || r.name || 'Custom location').split(',').map((s) => s.trim());
  return {
    label: segs.slice(0, 2).join(', ') || segs[0] || 'Custom location',
    country: segs[segs.length - 1] || '',
    custom: true,
    home: { center: [lon, lat], zoom, pitch: 62, bearing: -20 },
    searchBias: null,
    heightFallbackM: SM.DEFAULT_HEIGHT_FALLBACK_M,
    landmarks: []
  };
};

SM.REGION_TYPES = new Set(['country', 'state', 'province', 'territory']);

SM.REGION_SPAN_DEG = 1.5;

SM.isRegionResult = function isRegionResult(r) {
  if (!r) return false;
  const t = r.addresstype || r.type || '';
  if (SM.REGION_TYPES.has(t)) return true;
  const bb = Array.isArray(r.boundingbox) ? r.boundingbox.map(Number) : null;
  if (bb && bb.length === 4) {
    return Math.max(bb[1] - bb[0], bb[3] - bb[2]) > SM.REGION_SPAN_DEG;
  }
  return false;
};

SM.editStore = (function () {
  const API = '/api/map/building-edits';
  const LS = 'sionna-map.buildingEdits';
  let useApi = true;

  function local() {
    try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { return {}; }
  }
  function writeLocal(d) {
    try { localStorage.setItem(LS, JSON.stringify(d)); } catch (e) {  }
  }

  return {
    async load() {
      if (useApi) {
        try {
          const r = await fetch(API, { headers: { Accept: 'application/json' } });
          if (r.ok) return (await r.json()) || {};
          useApi = false;
        } catch (e) { useApi = false; }
      }
      return local();
    },
    async save(id, edit) {
      if (useApi) {
        try {
          const r = await fetch(API, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ id: id }, edit))
          });
          if (r.ok) return true;
          useApi = false;
        } catch (e) { useApi = false; }
      }
      const d = local(); d[id] = edit; writeLocal(d);
      return true;
    },
    async remove(id) {
      if (useApi) {
        try {
          const r = await fetch(API + '/' + encodeURIComponent(id), { method: 'DELETE' });
          if (r.ok) return true;
          useApi = false;
        } catch (e) { useApi = false; }
      }
      const d = local(); delete d[id]; writeLocal(d);
      return true;
    }
  };
})();

SM.fromPhoton = function fromPhoton(f) {
  const p = (f && f.properties) || {};
  const c = (f && f.geometry && f.geometry.coordinates) || null;
  if (!c || c.length < 2) return null;
  const parts = [p.name, p.district, p.city, p.county, p.state, p.country].filter(Boolean);
  const e = Array.isArray(p.extent) && p.extent.length === 4 ? p.extent : null;
  return {
    lon: c[0], lat: c[1],
    display_name: parts.join(', ') || String(p.name || 'Unknown place'),
    name: p.name,
    class: p.osm_key,
    type: p.osm_value,
    addresstype: p.osm_value,
    boundingbox: e ? [e[3], e[1], e[0], e[2]] : null,
    importance: 0
  };
};

SM.largestSettlementIn = async function largestSettlementIn(bboxArr, signal) {
  if (!Array.isArray(bboxArr) || bboxArr.length !== 4) return null;
  const [south, north, west, east] = bboxArr.map(Number);
  const q = `[out:json][timeout:25];(
      node["place"="city"](${south},${west},${north},${east});
      node["place"="town"](${south},${west},${north},${east});
    );out tags center 60;`;
  let data;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST', body: 'data=' + encodeURIComponent(q),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal
    });
    if (!res.ok) return null;
    data = await res.json();
  } catch (e) {
    return null;
  }
  const els = (data && data.elements) || [];
  if (!els.length) return null;

  const pop = (e) => {
    const p = parseInt(String((e.tags || {}).population || '').replace(/[^0-9]/g, ''), 10);
    return isFinite(p) ? p : 0;
  };
  els.sort((a, b) => {
    const d = pop(b) - pop(a);
    if (d) return d;
    const rank = (e) => ((e.tags || {}).place === 'city' ? 1 : 0);
    return rank(b) - rank(a);
  });
  const best = els[0];
  const lat = best.lat != null ? best.lat : (best.center && best.center.lat);
  const lon = best.lon != null ? best.lon : (best.center && best.center.lon);
  if (lat == null || lon == null) return null;
  const name = (best.tags || {}).name || 'City';
  return {
    lon, lat,
    display_name: name,
    boundingbox: [lat - 0.05, lat + 0.05, lon - 0.05, lon + 0.05],
    addresstype: (best.tags || {}).place || 'city',
    _population: pop(best)
  };
};

SM.cityFromParams = function cityFromParams(lon, lat, zoom, label) {
  return {
    label: label || 'Custom location', country: '', custom: true,
    home: { center: [lon, lat], zoom: zoom || 15.4, pitch: 62, bearing: -20 },
    searchBias: null,
    heightFallbackM: SM.DEFAULT_HEIGHT_FALLBACK_M,
    landmarks: []
  };
};

SM.CITIES = {
  virginia_tech: {
    label: 'Virginia Tech — Blacksburg',
    country: 'United States',
    home: { center: [-80.4222, 37.2275], zoom: 16.0, pitch: 62, bearing: -28 },
    searchBias: '-80.46,37.25,-80.39,37.20',
    heightFallbackM: 9,
    site: { id: 'virginia-tech', name: 'Virginia Tech' },
    landmarks: [
      { name: 'Burruss Hall',     desc: 'Administration building, 1936, at the head of the Drillfield.', center: [-80.4236, 37.2289], zoom: 17.2, pitch: 64, bearing: -20 },
      { name: 'The Drillfield',   desc: 'The central green, ringed by the Hokie Stone halls.',           center: [-80.4222, 37.2275], zoom: 16.4, pitch: 60, bearing: -30 },
      { name: 'Lane Stadium',     desc: 'Football stadium, 1965, beside Stadium Woods.',                center: [-80.4181, 37.2200], zoom: 16.6, pitch: 62, bearing: 20 },
      { name: 'Newman Library',   desc: 'University library, 1980.',                                    center: [-80.4192, 37.2288], zoom: 17.2, pitch: 62, bearing: 10 },
      { name: 'War Memorial Chapel', desc: 'Chapel and pylons on the Drillfield, 1960.',                center: [-80.4205, 37.2289], zoom: 17.2, pitch: 64, bearing: -40 },
      { name: 'Data and Decision Sciences', desc: 'Opened 2023 - newer than the LiDAR; its height is from OpenStreetMap.', center: [-80.4275, 37.2316], zoom: 17.0, pitch: 62, bearing: 0 }
    ]
  },
  munich: {
    label: 'Munich — Sionna reference',
    country: 'Germany',
    home: { center: [11.5754, 48.1374], zoom: 15.4, pitch: 62, bearing: -20 },
    searchBias: '11.40,48.20,11.70,48.06',
    heightFallbackM: 8,
    landmarks: [
      { name: 'Frauenkirche',   desc: 'The twin-domed cathedral — heart of the Sionna Munich scene.', center: [11.5735, 48.1385], zoom: 16.4, pitch: 64, bearing: -20 },
      { name: 'Marienplatz',    desc: 'Central square and New Town Hall.',                            center: [11.5758, 48.1374], zoom: 16.4, pitch: 62, bearing: 10 },
      { name: 'Hauptbahnhof',   desc: 'Munich central station.',                                     center: [11.5581, 48.1402], zoom: 15.8, pitch: 60, bearing: -30 },
      { name: 'Olympiapark',    desc: '1972 Olympic park and tower.',                                center: [11.5519, 48.1731], zoom: 15.2, pitch: 60, bearing: 25 },
      { name: 'BMW Welt',       desc: 'Iconic double-cone showroom.',                                center: [11.5566, 48.1772], zoom: 16.0, pitch: 62, bearing: 15 }
    ]
  },
  delhi: {
    label: 'New Delhi',
    country: 'India',
    home: { center: [77.2295, 28.6129], zoom: 15.2, pitch: 62, bearing: -20 },
    searchBias: '76.80,28.90,77.40,28.40',
    heightFallbackM: 9,
    landmarks: [
      { name: 'India Gate',      desc: '42 m war memorial arch on Kartavya Path.',       center: [77.2295, 28.6129], zoom: 16.0, pitch: 64, bearing: -20 },
      { name: 'Connaught Place', desc: 'Colonial-era circular business hub.',            center: [77.2167, 28.6315], zoom: 15.8, pitch: 62, bearing: 15 },
      { name: 'Red Fort',        desc: 'Mughal fortress of red sandstone, 1639.',        center: [77.2410, 28.6562], zoom: 15.8, pitch: 62, bearing: 25 },
      { name: 'Qutub Minar',     desc: '73 m victory tower — tallest brick minaret.',    center: [77.1855, 28.5245], zoom: 16.2, pitch: 65, bearing: -30 },
      { name: 'Lotus Temple',    desc: "Bahá'í house of worship shaped like a lotus.",   center: [77.2588, 28.5535], zoom: 16.4, pitch: 62, bearing: 10 }
    ]
  },
  mumbai: {
    label: 'Mumbai',
    country: 'India',
    home: { center: [72.8347, 18.9220], zoom: 15.2, pitch: 62, bearing: -20 },
    searchBias: '72.77,19.28,72.99,18.89',
    heightFallbackM: 15,
    landmarks: [
      { name: 'Gateway of India',  desc: '26 m basalt arch on the Apollo Bunder waterfront.', center: [72.8347, 18.9220], zoom: 16.4, pitch: 64, bearing: -20 },
      { name: 'Bandra-Worli Sea Link', desc: 'Cable-stayed span across Mahim Bay.',           center: [72.8181, 19.0367], zoom: 15.0, pitch: 60, bearing: 30 },
      { name: 'Nariman Point',     desc: 'Reclaimed CBD — the city\'s tower cluster.',        center: [72.8228, 18.9256], zoom: 15.8, pitch: 63, bearing: 15 },
      { name: 'Bandra Kurla Complex', desc: 'Planned business district, wide and glassy.',    center: [72.8686, 19.0662], zoom: 15.6, pitch: 62, bearing: -15 },
      { name: 'Chhatrapati Shivaji Terminus', desc: 'Victorian Gothic railway terminus, 1887.', center: [72.8355, 18.9398], zoom: 16.4, pitch: 64, bearing: 25 }
    ]
  },
  bengaluru: {
    label: 'Bengaluru',
    country: 'India',
    home: { center: [77.5946, 12.9716], zoom: 15.2, pitch: 62, bearing: -20 },
    searchBias: '77.45,13.14,77.78,12.83',
    heightFallbackM: 12,
    landmarks: [
      { name: 'Vidhana Soudha',    desc: 'Granite seat of the state legislature, 1956.',      center: [77.5913, 12.9794], zoom: 16.2, pitch: 64, bearing: -20 },
      { name: 'UB City',           desc: 'Tower cluster over the central business district.', center: [77.5957, 12.9719], zoom: 16.2, pitch: 64, bearing: 20 },
      { name: 'Cubbon Park',       desc: '120 ha of green between the CBD and the courts.',   center: [77.5946, 12.9763], zoom: 15.6, pitch: 60, bearing: 0 },
      { name: 'Manyata Tech Park', desc: 'Low-rise campus sprawl in the north.',              center: [77.6206, 13.0459], zoom: 15.4, pitch: 61, bearing: -25 },
      { name: 'Lalbagh',           desc: 'Botanical garden around a Peninsular Gneiss dome.', center: [77.5848, 12.9507], zoom: 15.8, pitch: 62, bearing: 15 }
    ]
  },
  hyderabad: {
    label: 'Hyderabad',
    country: 'India',
    home: { center: [78.4747, 17.3616], zoom: 15.2, pitch: 62, bearing: -20 },
    searchBias: '78.24,17.56,78.60,17.28',
    heightFallbackM: 12,
    landmarks: [
      { name: 'Charminar',         desc: '56 m mosque and monument, 1591, in the old city.',  center: [78.4747, 17.3616], zoom: 16.6, pitch: 65, bearing: -20 },
      { name: 'HITEC City',        desc: 'Glass-and-steel IT district at Madhapur.',          center: [78.3808, 17.4435], zoom: 15.6, pitch: 62, bearing: 20 },
      { name: 'Golconda Fort',     desc: 'Granite hill fortress with a famed acoustic gate.', center: [78.4011, 17.3833], zoom: 15.8, pitch: 64, bearing: -30 },
      { name: 'Hussain Sagar',     desc: 'Heart-shaped lake with the Buddha monolith.',       center: [78.4747, 17.4239], zoom: 15.2, pitch: 60, bearing: 10 },
      { name: 'Ramoji Film City',  desc: 'Studio complex on the eastern outskirts.',          center: [78.6810, 17.2543], zoom: 15.0, pitch: 60, bearing: 0 }
    ]
  },
  chennai: {
    label: 'Chennai',
    country: 'India',
    home: { center: [80.2707, 13.0827], zoom: 15.2, pitch: 62, bearing: -20 },
    searchBias: '80.12,13.24,80.34,12.90',
    heightFallbackM: 11,
    landmarks: [
      { name: 'Marina Beach',      desc: 'One of the longest urban beaches in the world.',    center: [80.2825, 13.0500], zoom: 15.0, pitch: 60, bearing: 15 },
      { name: 'Fort St. George',   desc: 'First English fortress in India, 1644.',            center: [80.2870, 13.0797], zoom: 16.2, pitch: 63, bearing: -20 },
      { name: 'Kapaleeshwarar Temple', desc: 'Dravidian gopuram over Mylapore.',              center: [80.2697, 13.0337], zoom: 16.4, pitch: 64, bearing: 25 },
      { name: 'Tidel Park',        desc: 'IT tower at the head of the OMR corridor.',         center: [80.2496, 12.9891], zoom: 16.0, pitch: 63, bearing: -15 },
      { name: 'Santhome Basilica', desc: 'Neo-Gothic basilica on the shore, 1523.',           center: [80.2779, 13.0330], zoom: 16.4, pitch: 63, bearing: 10 }
    ]
  },
  kolkata: {
    label: 'Kolkata',
    country: 'India',
    home: { center: [88.3476, 22.5726], zoom: 15.2, pitch: 62, bearing: -20 },
    searchBias: '88.26,22.67,88.45,22.45',
    heightFallbackM: 12,
    landmarks: [
      { name: 'Victoria Memorial', desc: 'White marble hall in 26 ha of gardens, 1921.',      center: [88.3426, 22.5448], zoom: 16.0, pitch: 64, bearing: -20 },
      { name: 'Howrah Bridge',     desc: 'Cantilever span over the Hooghly, no bolts.',       center: [88.3468, 22.5851], zoom: 15.8, pitch: 62, bearing: 30 },
      { name: 'Park Street',       desc: 'Dense colonial-era commercial spine.',              center: [88.3520, 22.5525], zoom: 16.0, pitch: 62, bearing: 15 },
      { name: 'Salt Lake Sector V', desc: 'The IT district east of the city.',                center: [88.4310, 22.5760], zoom: 15.6, pitch: 61, bearing: -25 },
      { name: 'Dakshineswar Temple', desc: 'Nine-spired Kali temple on the river.',           center: [88.3576, 22.6551], zoom: 16.2, pitch: 63, bearing: 20 }
    ]
  },
  dubai: {
    label: 'Dubai',
    country: 'UAE',
    home: { center: [55.2744, 25.1972], zoom: 15.4, pitch: 62, bearing: -20 },
    searchBias: '54.80,25.40,55.60,24.80',
    heightFallbackM: 3,
    landmarks: [
      { name: 'Burj Khalifa',   desc: "World's tallest building — 828 m.",              center: [55.2744, 25.1972], zoom: 16.2, pitch: 66, bearing: -20 },
      { name: 'Dubai Marina',   desc: 'A canyon of towers around a canal.',             center: [55.1400, 25.0805], zoom: 15.6, pitch: 64, bearing: -40 },
      { name: 'Palm Jumeirah',  desc: 'Palm-shaped artificial archipelago.',           center: [55.1385, 25.1124], zoom: 13.6, pitch: 58, bearing: 30 },
      { name: 'Burj Al Arab',   desc: 'Sail-shaped hotel on its own island.',          center: [55.1855, 25.1412], zoom: 16.0, pitch: 62, bearing: 10 },
      { name: 'Business Bay',   desc: 'Dense high-rise district along the canal.',      center: [55.2650, 25.1850], zoom: 15.4, pitch: 64, bearing: 15 }
    ]
  },
  nyc: {
    label: 'New York City',
    country: 'USA',
    home: { center: [-73.9855, 40.758], zoom: 15.5, pitch: 62, bearing: -17.6 },
    searchBias: '-74.03,40.82,-73.90,40.70',
    heightFallbackM: 6,
    landmarks: [
      { name: 'Times Square',        desc: 'Neon crossroads of Broadway & 7th Ave.',   center: [-73.9855, 40.758],  zoom: 16.0, pitch: 64, bearing: -18 },
      { name: 'Empire State Bldg',   desc: 'Art Deco icon, 102 floors.',               center: [-73.9857, 40.7484], zoom: 16.4, pitch: 66, bearing: -20 },
      { name: 'One World Trade',     desc: 'Tallest in the Western Hemisphere.',        center: [-74.0134, 40.7127], zoom: 16.2, pitch: 64, bearing: 10 },
      { name: 'Central Park',        desc: 'Bethesda Terrace and the Lake.',            center: [-73.9712, 40.7739], zoom: 15.4, pitch: 60, bearing: 25 }
    ]
  }
};
