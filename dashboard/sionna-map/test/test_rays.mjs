import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.resolve(HERE, '..', 'src');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok    ' + name); }
  else { failures++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

function stubMap() {
  const sources = {}, layers = {}, layout = {};
  return {
    _sources: sources, _layers: layers, _layout: layout,
    getSource: (id) => sources[id],
    addSource: (id, def) => {
      sources[id] = { ...def, setData(d) { this.data = d; } };
    },
    addLayer: (def) => { layers[def.id] = def; },
    getLayer: (id) => layers[id],
    setLayoutProperty: (id, k, v) => { layout[id] = { ...(layout[id] || {}), [k]: v }; },
    setPaintProperty: () => {},
    on: () => {}, off: () => {}, once: () => {},
    getCenter: () => ({ lng: 77.224297, lat: 28.613109 }),
    getBounds: () => ({ getWest: () => 77.218, getSouth: () => 28.610,
                        getEast: () => 77.231, getNorth: () => 28.616 }),
    getZoom: () => 16, project: () => ({ x: 0, y: 0 }), unproject: () => ({ lng: 0, lat: 0 }),
    queryRenderedFeatures: () => [], getStyle: () => ({ layers: [] }),
    isStyleLoaded: () => true, addControl: () => {}, easeTo: () => {}, flyTo: () => {}
  };
}

const sandbox = {
  document: {
    getElementById: () => null, createElement: () => ({ style: {}, classList: { add() {}, remove() {} },
      appendChild() {}, addEventListener() {}, setAttribute() {} }),
    addEventListener: () => {}, body: { appendChild() {} }
  },
  console, setTimeout, clearTimeout, Math, JSON, Date,
  navigator: { userAgent: 'node' }, fetch: async () => ({ ok: false }),
  location: { origin: 'http://localhost' },
  maplibregl: { Marker: class { constructor(o) { this.el = (o && o.element) || { style: {} }; }
    setLngLat() { return this; } addTo() { return this; } on() { return this; } remove() {}
    getElement() { return this.el; } setDraggable() { return this; } getLngLat() { return { lng: 0, lat: 0 }; } } }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ['presets.js', 'geo.js', 'sionna.js']) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
}
const SM = sandbox.SM;
let drawn = { paths: [], dots: [] };
SM.makeRays3D = (id) => ({ id, type: 'custom', setData(paths, dots) { drawn = { paths, dots }; } });
check('the module loaded', !!SM && typeof SM.sionna === 'function');
check('geo helpers loaded', !!SM.geo && typeof SM.geo.fromENU === 'function');

const map = stubMap();

const REAL_API = { home: { center: [77.224297, 28.613109] }, loadCoverage: () => null };
const api = new Proxy(REAL_API, {
  get: (t, k) => (k in t ? t[k] : () => undefined),
  has: () => true
});

const RF = SM.sionna(map, api, {});
RF.init();

check('exposes setRays / clearRays / showRays',
      ['setRays', 'clearRays', 'showRays'].every((k) => typeof RF[k] === 'function'));
check('a mast layer was added', !!map.getLayer('node-masts-3d') && !!map.getSource('node-masts'));

const ORIGIN = [77.224297, 28.613109];
const PATHS = [
  { share: 0.7615, gain_db: -125.74, bounces: 2, los: false, delay_s: 0.0,
    kinds: ['refraction', 'refraction'],
    points: [[515.83, -20.0, 43.0], [502.18, -19.29, 40.0], [497.86, -19.06, 39.05],
             [326.92, -10.14, 1.5]] },
  { share: 0.2385, gain_db: -130.78, bounces: 3, los: false, delay_s: 2.218e-9,
    kinds: ['refraction', 'refraction', 'specular'],
    points: [[515.83, -20.0, 43.0], [503.1, -19.33, 40.0], [497.86, -19.06, 38.77],
             [333.29, -10.47, 0.0], [326.92, -10.14, 1.5]] }
];

const n = RF.setRays(PATHS, ORIGIN);
check('setRays reports both paths', n === 2, 'got ' + n);
check('the 3D layer was added', !!map.getLayer('rays-3d'));
check('two paths drawn', drawn.paths.length === 2, 'got ' + drawn.paths.length);
check('first path has four points', drawn.paths[0].pts.length === 4);
check('second path has five points', drawn.paths[1].pts.length === 5);

const BBOX = { minLon: 77.218016, maxLon: 77.230579, minLat: 28.610310, maxLat: 28.615908 };
const padLon = (BBOX.maxLon - BBOX.minLon) * 0.25;
const padLat = (BBOX.maxLat - BBOX.minLat) * 0.25;
let inside = true, sample = null;
for (const p of drawn.paths) {
  for (const [lon, lat] of p.pts) {
    if (!(lon >= BBOX.minLon - padLon && lon <= BBOX.maxLon + padLon &&
          lat >= BBOX.minLat - padLat && lat <= BBOX.maxLat + padLat)) {
      inside = false; sample = [lon, lat];
    }
  }
}
check('every vertex lands on the scene', inside, sample ? JSON.stringify(sample) : '');

const [lon0, lat0] = ORIGIN;
const mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
const got = drawn.paths[0].pts[0];
check('the transmitter converts to the expected lon/lat',
      Math.abs(got[0] - (lon0 + 515.83 / mPerDegLon)) < 1e-9 && Math.abs(got[1] - (lat0 + -20.0 / 111320)) < 1e-9,
      JSON.stringify(got));
check('on a flat scene the height is the traced z', got[2] === 43 && drawn.paths[0].pts[3][2] === 1.5,
      JSON.stringify(drawn.paths[0].pts.map((q) => q[2])));
check('a strong path is drawn wider than a weak one', drawn.paths[0].width_px > drawn.paths[1].width_px);

check('one dot per bounce, endpoints excluded', drawn.dots.length === 5, 'got ' + drawn.dots.length);
check('the ground reflection kept its zero height', drawn.dots.some((d) => d.alt_m === 0));

RF.setRays([{ share: 1, los: true, kinds: [], points: [[0, 0, 38.13], [10, 0, 6.25]], ground_m: [8.73, 4.75] }], ORIGIN);
check('on terrain the height is above the ground under the point',
      Math.abs(drawn.paths[0].pts[0][2] - 29.4) < 1e-9 && Math.abs(drawn.paths[0].pts[1][2] - 1.5) < 1e-9,
      JSON.stringify(drawn.paths[0].pts.map((q) => q[2])));

RF.setRays(PATHS.map((p, i) => Object.assign({}, p, { tx: 'gNB-n' + (i + 1) })), ORIGIN);
RF.setRayTx('gNB-n2');
check('the cell filter keeps one cell', drawn.paths.length === 1 && drawn.dots.length === 3);
RF.setRayTx('');
RF.showRays(false);
check('hiding draws nothing', drawn.paths.length === 0 && drawn.dots.length === 0);
RF.showRays(true);
check('showing draws them again', drawn.paths.length === 2);
RF.clearRays();
check('clearing empties the layer', drawn.paths.length === 0 && drawn.dots.length === 0);

RF.setRays([{ share: 1, points: [[0, 0, 0]], kinds: [] }], ORIGIN);
check('a single-point path is skipped', drawn.paths.length === 0);

RF.addNode({ type: 'gnb', lonlat: ORIGIN, heightAGL: 29.4, on: 'building' });
RF.addNode({ type: 'ue', lonlat: ORIGIN, heightAGL: 1.5, on: 'ground' });
const masts = map.getSource('node-masts').data.features;
check('a gNB gets a mast and a head, a UE none', masts.length === 2, 'got ' + masts.length);
check('the head is centred on the antenna height',
      masts[1].properties.base === 27.9 && masts[1].properties.top === 30.9, JSON.stringify(masts[1].properties));

console.log('');
console.log(failures ? '  ' + failures + ' FAILED' : '  all checks passed');
process.exit(failures ? 1 : 0);
