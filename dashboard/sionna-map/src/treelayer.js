window.SM = window.SM || {};

SM.createTreeLayer = function (id) {
  let gl = null, program = null, map = null;
  let loc = {};
  const far = { vbo: null, ibo: null, sibo: null, n: 0, ns: 0 };
  const near = { vbo: null, ibo: null, n: 0 };
  let rows = null, local = null, origin = null, visible = true, pending = false;
  let nearKey = null, nearR = 0, nearC = [0, 0];
  const MIN_ZOOM = 13.5;
  const NEAR_ZOOM = 15.6;
  const STRIDE = 28;
  const LIGHT = (function () { const v = [-0.45, -0.35, 0.82], l = Math.hypot(...v); return v.map((x) => x / l); })();

  const VERT = `
    attribute vec3 a_pos;
    attribute vec2 a_ctr;
    attribute vec4 a_norm;
    attribute vec4 a_col;
    uniform mat4 u_matrix;
    uniform vec3 u_hide;
    varying vec3 v_pos;
    varying vec3 v_norm;
    varying vec4 v_col;
    varying float v_flag;
    void main() {
      v_pos = a_pos;
      v_norm = a_norm.xyz;
      v_col = a_col;
      float f = a_norm.w * 127.0;
      v_flag = f > 63.0 ? 1.0 : (f < -63.0 ? -1.0 : 0.0);
      if (u_hide.z > 0.0 && distance(a_ctr, u_hide.xy) < u_hide.z) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
      }
      gl_Position = u_matrix * vec4(a_pos, 1.0);
    }`;
  const FRAG = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    uniform vec3 u_light;
    varying vec3 v_pos;
    varying vec3 v_norm;
    varying vec4 v_col;
    varying float v_flag;
    float hash(vec3 p) {
      p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float vnoise(vec3 x) {
      vec3 i = floor(x);
      vec3 f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(hash(i), hash(i + vec3(1.0, 0.0, 0.0)), f.x),
                     mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
                 mix(mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x),
                     mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
    }
    void main() {
      if (v_flag < -0.5) {

        float a = 0.24;
        gl_FragColor = vec4(vec3(0.03, 0.05, 0.02) * a, a);
        return;
      }
      vec3 n = normalize(v_norm);
      if (!gl_FrontFacing) n = -n;
      vec3 q = mod(v_pos, 512.0);
      if (v_flag > 0.5) {
        float b = vnoise(vec3(q.x * 7.0, q.y * 7.0, q.z * 1.1));
        vec3 c = v_col.rgb * (0.7 + 0.45 * b);
        float k = 0.42 + 0.58 * max(dot(n, u_light), 0.0);
        gl_FragColor = vec4(c * k, 1.0);
        return;
      }

      vec3 p = q * 0.95;
      float n1 = vnoise(p);
      float n2 = vnoise(p * 2.3 + 7.1);
      float clump = 0.65 * n1 + 0.35 * n2;
      vec3 bump = vec3(vnoise(p + vec3(3.1, 0.0, 0.0)), vnoise(p + vec3(0.0, 5.3, 0.0)),
                       vnoise(p + vec3(0.0, 0.0, 9.7))) - 0.5;
      vec3 nb = normalize(n + 0.7 * bump);
      float sun = max(dot(nb, u_light), 0.0);
      float sky = 0.5 + 0.5 * nb.z;
      float ao = v_col.a;
      vec3 c = v_col.rgb * mix(0.76, 1.12, clump);
      vec3 lit = c * (0.28 + 0.26 * sky) * ao + c * 0.78 * sun * mix(0.55, 1.0, ao)
               + vec3(0.05, 0.045, 0.0) * sun * clump;
      lit *= mix(0.84, 1.0, smoothstep(0.25, 0.55, clump));
      gl_FragColor = vec4(lit, 1.0);
    }`;

  function compile(ctx, type, src) {
    const sh = ctx.createShader(type);
    ctx.shaderSource(sh, src);
    ctx.compileShader(sh);
    if (!ctx.getShaderParameter(sh, ctx.COMPILE_STATUS)) console.warn('tree layer shader:', ctx.getShaderInfoLog(sh));
    return sh;
  }

  function mul(a, b) {
    const o = new Float64Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }

  function rnd(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function icosphere(sub) {
    const t = (1 + Math.sqrt(5)) / 2;
    let v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
             [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((p) => { const l = Math.hypot(...p); return p.map((x) => x / l); });
    let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6],
             [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    for (let s = 0; s < sub; s++) {
      const cache = {}, nf = [];
      const mid = (a, b) => {
        const k = a < b ? a + '_' + b : b + '_' + a;
        if (cache[k] === undefined) {
          const p = [(v[a][0] + v[b][0]) / 2, (v[a][1] + v[b][1]) / 2, (v[a][2] + v[b][2]) / 2];
          const l = Math.hypot(...p);
          v.push(p.map((x) => x / l));
          cache[k] = v.length - 1;
        }
        return cache[k];
      };
      f.forEach(([a, b, c]) => {
        const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
        nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
      });
      f = nf;
    }
    return { v: v, f: f };
  }
  const ICO = [icosphere(0), icosphere(1)];

  const BASE = {
    B: [[78, 108, 46], [70, 100, 42], [88, 116, 50], [64, 94, 40], [96, 122, 54]],
    E: [[50, 84, 44], [46, 78, 42]],
    C: [[38, 72, 48], [44, 80, 52], [34, 66, 44]],
    L: [[84, 112, 58], [78, 104, 54]]
  };
  function foliageColour(kind, species, r) {
    const pal = BASE[kind] || BASE.B;
    let c = pal[Math.floor(r() * pal.length)].slice();
    const s = (species || '').toLowerCase();
    const tint = (k) => { c = [c[0] * k[0], c[1] * k[1], c[2] * k[2]]; };
    if (/maple|plane|sycamore|tulip|linden|honeylocust|ginkgo/.test(s)) tint([1.12, 1.1, 0.95]);
    else if (/oak|walnut|hickory|beech|magnolia|holly/.test(s)) tint([0.86, 0.9, 0.9]);
    else if (/spruce|blue|fir/.test(s)) tint([0.85, 0.95, 1.12]);
    else if (/pine|hemlock|cedar|juniper|arborvitae|cypress/.test(s)) tint([0.92, 0.98, 1.04]);
    else if (/cherry|plum|redbud|crabapple|purple/.test(s)) tint([1.05, 0.95, 0.9]);
    const b = 0.9 + 0.2 * r();
    return [Math.min(255, c[0] * b), Math.min(255, c[1] * b), Math.min(255, c[2] * b)];
  }
  const BARK = [92, 74, 60];

  function Builder(sizes) {
    this.n = 0; this.ki = 0; this.ks = 0;
    this.counting = !sizes;
    if (sizes) {
      this.buf = new ArrayBuffer(sizes.n * STRIDE);
      this.f32 = new Float32Array(this.buf); this.i8 = new Int8Array(this.buf); this.u8 = new Uint8Array(this.buf);
      this.ii = new Uint32Array(sizes.ki); this.ss = new Uint32Array(sizes.ks);
    }
  }
  Builder.prototype.put = function (x, y, z, nx, ny, nz, flag, c, a, cx, cy) {
    if (!this.counting) {
      const L = Math.hypot(nx, ny, nz) || 1, b = this.n * STRIDE, f = b / 4;
      this.f32[f] = x; this.f32[f + 1] = y; this.f32[f + 2] = z; this.f32[f + 3] = cx; this.f32[f + 4] = cy;
      this.i8[b + 20] = Math.round(127 * nx / L); this.i8[b + 21] = Math.round(127 * ny / L);
      this.i8[b + 22] = Math.round(127 * nz / L); this.i8[b + 23] = flag;
      this.u8[b + 24] = c[0]; this.u8[b + 25] = c[1]; this.u8[b + 26] = c[2]; this.u8[b + 27] = a;
    }
    return this.n++;
  };
  Builder.prototype.tri = function (a, b, c) {
    if (!this.counting) { this.ii[this.ki] = a; this.ii[this.ki + 1] = b; this.ii[this.ki + 2] = c; }
    this.ki += 3;
  };
  Builder.prototype.stri = function (a, b, c) {
    if (!this.counting) { this.ss[this.ks] = a; this.ss[this.ks + 1] = b; this.ss[this.ks + 2] = c; }
    this.ks += 3;
  };
  function build(fn) {
    const C = new Builder();
    fn(C);
    const B = new Builder({ n: C.n, ki: C.ki, ks: C.ks });
    fn(B);
    return { buf: B.buf, idx: B.ii, sidx: B.ss };
  }

  function lobe(B, ico, cx, cy, cz, rx, ry, rz, col, r, tx, ty, aoTop) {
    const base = B.n;
    ico.v.forEach((p) => {
      const j = 0.84 + 0.32 * r();
      let z = p[2] * j;
      if (z < 0) z *= 0.82;
      const x = p[0] * j, y = p[1] * j;
      const ao = Math.max(0.35, Math.min(1, aoTop * (0.62 + 0.38 * (p[2] + 1) / 2)));
      B.put(cx + rx * x, cy + ry * y, cz + rz * z, x / rx, y / ry, z / rz, 0, col, Math.round(255 * ao), tx, ty);
    });
    ico.f.forEach((t) => B.tri(base + t[0], base + t[1], base + t[2]));
  }

  function trunk(B, x, y, z0, top, rb, tx, ty) {
    const base = B.n, S = 5;
    for (let s = 0; s < S; s++) {
      const a = s / S * 2 * Math.PI, ca = Math.cos(a), sa = Math.sin(a);
      B.put(x + rb * ca, y + rb * sa, z0 - 0.3, ca, sa, 0.15, 127, BARK, 255, tx, ty);
      B.put(x + 0.55 * rb * ca, y + 0.55 * rb * sa, z0 + top, ca, sa, 0.15, 127, BARK, 255, tx, ty);
    }
    for (let s = 0; s < S; s++) {
      const a0 = base + 2 * s, a1 = base + 2 * ((s + 1) % S);
      B.tri(a0, a1, a0 + 1); B.tri(a1, a1 + 1, a0 + 1);
    }
  }

  function shadow(B, x, y, z0, H, R, tx, ty) {
    const S = 12, ox = 0.22 * H, oy = 0.17 * H;
    const cx = x + ox * 0.5, cy = y + oy * 0.5;
    const c0 = B.put(cx, cy, z0 + 0.06, 0, 0, 1, -127, [255, 0, 0], 255, tx, ty);
    for (let s = 0; s < S; s++) {
      const a = s / S * 2 * Math.PI;
      const ex = Math.cos(a) * R * 1.05, ey = Math.sin(a) * R * 1.05;
      const along = (ex * ox + ey * oy) / Math.hypot(ox, oy);
      const k = along > 0 ? 1 + 0.35 * along / R : 1;
      B.put(cx + ex * k, cy + ey * k, z0 + 0.06, Math.cos(a), Math.sin(a), 1, -127, [0, 0, 0], 255, tx, ty);
    }
    for (let s = 0; s < S; s++) B.stri(c0, c0 + 1 + s, c0 + 1 + (s + 1) % S);
  }

  function tree(B, t, detail, withShadow) {
    const x = t.x, y = t.y, z0 = t.z;
    const H = t.h, R = t.r, kind = t.kind;
    const r = rnd(t.seed);
    const col = foliageColour(kind, t.species, r);
    const conifer = kind === 'C' || kind === 'L';
    const cb = conifer ? Math.max(0.4, 0.1 * H) : Math.max(1.5, 0.22 * H);
    const trunkR = Math.max(0.08, Math.min(0.55, 0.028 * H + 0.05));
    if (withShadow) shadow(B, x, y, z0, H, R, x, y);
    if (conifer) {
      trunk(B, x, y, z0, cb + 0.35 * (H - cb), trunkR, x, y);
      const T = detail ? 5 : 2, SEG = detail ? 12 : 7;
      const span = H - cb;
      for (let k = 0; k < T; k++) {
        const f = k / T;
        const zb = z0 + cb + span * f * 0.82;
        const rb = R * (1 - f * 0.78) * (0.92 + 0.16 * r());
        const zt = k === T - 1 ? z0 + H : zb + span * (detail ? 0.36 : 0.62);
        const droop = (zt - zb) * 0.14;
        const base = B.n;
        const ao = 0.55 + 0.45 * (k + 1) / T;
        for (let s = 0; s < SEG; s++) {
          const a = s / SEG * 2 * Math.PI + r() * 0.25;
          const tip = detail && s % 2 === 0 ? 1.0 : 0.8;
          const rr = rb * tip * (0.9 + 0.2 * r());
          const ca = Math.cos(a), sa = Math.sin(a);
          B.put(x + rr * ca, y + rr * sa, zb - droop * tip, ca, sa, rb / Math.max(0.5, zt - zb), 0, col,
                Math.round(255 * ao * 0.8), x, y);
        }
        const apex = B.put(x, y, zt, 0, 0, 1, 0, col, Math.round(255 * ao), x, y);
        for (let s = 0; s < SEG; s++) B.tri(base + s, base + (s + 1) % SEG, apex);
      }
    } else {
      trunk(B, x, y, z0, cb + 0.3 * (H - cb), trunkR, x, y);
      const rz = Math.max(0.6, (H - cb) / 2), zc = z0 + cb + rz;
      lobe(B, ICO[detail ? 1 : 0], x, y, zc, R * 0.92, R * 0.92, rz * 0.95, col, r, x, y, 1.0);
      if (detail) {
        const nl = R > 2.2 ? 4 : 2;
        for (let k = 0; k < nl; k++) {
          const a = (k / nl + r() * 0.3) * 2 * Math.PI;
          const d = R * (0.42 + 0.18 * r());
          const s = 0.5 + 0.18 * r();
          lobe(B, ICO[0], x + d * Math.cos(a), y + d * Math.sin(a), zc + rz * (0.05 + 0.35 * r()),
               R * s, R * s, rz * s * 1.05, col, r, x, y, 1.05);
        }
        lobe(B, ICO[0], x + R * 0.1 * (r() - 0.5), y + R * 0.1 * (r() - 0.5), zc + rz * 0.55,
             R * 0.55, R * 0.55, rz * 0.55, col, r, x, y, 1.1);
      }
    }
  }

  function upload(slot, geom, withShadows) {
    gl.bindBuffer(gl.ARRAY_BUFFER, slot.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, geom.buf, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, slot.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geom.idx, gl.STATIC_DRAW);
    slot.n = geom.idx.length;
    if (withShadows) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, slot.sibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geom.sidx, gl.STATIC_DRAW);
      slot.ns = geom.sidx.length;
    }
  }

  function prepare() {
    if (!rows || !map) { local = null; return; }
    let sx = 0, sy = 0;
    rows.forEach((t) => { sx += t[0]; sy += t[1]; });
    const base = maplibregl.MercatorCoordinate.fromLngLat([sx / rows.length, sy / rows.length], 0);
    const mPer = base.meterInMercatorCoordinateUnits();
    origin = { base: base, mPer: mPer };
    const terrain = map.getTerrain && map.getTerrain();
    local = rows.map((t) => {
      const m = maplibregl.MercatorCoordinate.fromLngLat([t[0], t[1]], 0);
      let z = 0;
      const fixed = terrain && t[6] != null;
      if (fixed) z = +t[6];
      else if (terrain) z = SM.groundAt([t[0], t[1]]) || 0;
      return { x: (m.x - base.x) / mPer, y: -(m.y - base.y) / mPer, z: z, ll: [t[0], t[1]], fixed: fixed,
               h: Math.max(1.5, +t[2] || 6), r: Math.max(0.4, +t[3] || 2), kind: t[4] || 'B',
               species: t[5] || '', seed: (Math.round(t[0] * 1e6) ^ Math.round(t[1] * 1e6)) >>> 0 };
    });
  }

  function buildFar() {
    if (!gl) { pending = true; return; }
    if (!local) { far.n = far.ns = 0; return; }
    upload(far, build((B) => local.forEach((t) => tree(B, t, false, true))), true);
    nearKey = null;
    updateNear(true);
  }

  function updateNear(force) {
    if (!gl || !local || !map || !origin) return;
    const z = map.getZoom();
    if (z < NEAR_ZOOM) { near.n = 0; nearR = 0; return; }
    const R = Math.max(140, Math.min(650, 420 * Math.pow(2, 16.6 - z)));
    const c = map.getCenter();
    const m = maplibregl.MercatorCoordinate.fromLngLat([c.lng, c.lat], 0);
    const cx = (m.x - origin.base.x) / origin.mPer, cy = -(m.y - origin.base.y) / origin.mPer;
    const key = Math.round(z * 2);
    if (!force && nearKey === key && Math.hypot(cx - nearC[0], cy - nearC[1]) < R / 3) return;
    nearKey = key; nearC = [cx, cy]; nearR = R;
    upload(near, build((B) => local.forEach((t) => {
      if (Math.hypot(t.x - cx, t.y - cy) < R) tree(B, t, true, false);
    })), false);
    map.triggerRepaint();
  }

  function onMove() { updateNear(false); }
  function onTerrain() { prepare(); buildFar(); }
  let demTimer = null;
  function restand() {
    if (!local || !map || !map.getTerrain()) return;
    let moved = 0;
    for (const t of local) {
      if (t.fixed) continue;
      const z = SM.groundAt(t.ll);
      if (z == null) continue;
      if (Math.abs(z - t.z) > 0.3) { t.z = z; moved++; }
      t.fixed = true;
    }
    if (moved) buildFar();
  }
  function onData(e) {
    if (!e || e.sourceId !== 'terrain-dem' || !e.tile) return;
    clearTimeout(demTimer);
    demTimer = setTimeout(restand, 700);
  }

  function bind(ctx, slot) {
    ctx.bindBuffer(ctx.ARRAY_BUFFER, slot.vbo);
    ctx.enableVertexAttribArray(loc.pos);
    ctx.vertexAttribPointer(loc.pos, 3, ctx.FLOAT, false, STRIDE, 0);
    ctx.enableVertexAttribArray(loc.ctr);
    ctx.vertexAttribPointer(loc.ctr, 2, ctx.FLOAT, false, STRIDE, 12);
    ctx.enableVertexAttribArray(loc.norm);
    ctx.vertexAttribPointer(loc.norm, 4, ctx.BYTE, true, STRIDE, 20);
    ctx.enableVertexAttribArray(loc.col);
    ctx.vertexAttribPointer(loc.col, 4, ctx.UNSIGNED_BYTE, true, STRIDE, 24);
  }

  const layer = {
    id: id,
    type: 'custom',
    renderingMode: '3d',

    onAdd(m, ctx) {
      map = m; gl = ctx;
      if (!(typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext)) {
        gl.getExtension('OES_element_index_uint');
      }
      program = gl.createProgram();
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) console.warn('tree layer link:', gl.getProgramInfoLog(program));
      loc = {
        pos: gl.getAttribLocation(program, 'a_pos'), ctr: gl.getAttribLocation(program, 'a_ctr'),
        norm: gl.getAttribLocation(program, 'a_norm'), col: gl.getAttribLocation(program, 'a_col'),
        mat: gl.getUniformLocation(program, 'u_matrix'), hide: gl.getUniformLocation(program, 'u_hide'),
        light: gl.getUniformLocation(program, 'u_light')
      };
      far.vbo = gl.createBuffer(); far.ibo = gl.createBuffer(); far.sibo = gl.createBuffer();
      near.vbo = gl.createBuffer(); near.ibo = gl.createBuffer();
      m.on('moveend', onMove);
      m.on('terrain', onTerrain);
      m.on('sourcedata', onData);
      if (pending || rows) { pending = false; prepare(); buildFar(); }
    },

    onRemove() {
      if (map) { map.off('moveend', onMove); map.off('terrain', onTerrain); map.off('sourcedata', onData); }
      clearTimeout(demTimer);
      if (!gl) return;
      [far.vbo, far.ibo, far.sibo, near.vbo, near.ibo].forEach((b) => gl.deleteBuffer(b));
      gl.deleteProgram(program);
      gl = null; far.n = far.ns = near.n = 0;
    },

    render(ctx, matrix) {
      if (!visible || !origin || !map || map.getZoom() < MIN_ZOOM || (!far.n && !near.n)) return;
      const b = origin.base, s = origin.mPer;
      const model = new Float64Array([s, 0, 0, 0, 0, -s, 0, 0, 0, 0, s, 0, b.x, b.y, 0, 1]);
      ctx.useProgram(program);
      ctx.uniformMatrix4fv(loc.mat, false, new Float32Array(mul(SM.liftView(map, matrix), model)));
      ctx.uniform3f(loc.light, LIGHT[0], LIGHT[1], LIGHT[2]);
      ctx.enable(ctx.DEPTH_TEST);
      ctx.depthFunc(ctx.LEQUAL);
      ctx.disable(ctx.CULL_FACE);
      if (far.ns) {
        bind(ctx, far);
        ctx.bindBuffer(ctx.ELEMENT_ARRAY_BUFFER, far.sibo);
        ctx.uniform3f(loc.hide, 0, 0, 0);
        ctx.enable(ctx.BLEND);
        ctx.blendFunc(ctx.ONE, ctx.ONE_MINUS_SRC_ALPHA);
        ctx.depthMask(false);
        ctx.drawElements(ctx.TRIANGLES, far.ns, ctx.UNSIGNED_INT, 0);
      }
      ctx.disable(ctx.BLEND);
      ctx.depthMask(true);
      if (far.n) {
        bind(ctx, far);
        ctx.bindBuffer(ctx.ELEMENT_ARRAY_BUFFER, far.ibo);
        ctx.uniform3f(loc.hide, nearC[0], nearC[1], near.n ? nearR : 0);
        ctx.drawElements(ctx.TRIANGLES, far.n, ctx.UNSIGNED_INT, 0);
      }
      if (near.n) {
        bind(ctx, near);
        ctx.bindBuffer(ctx.ELEMENT_ARRAY_BUFFER, near.ibo);
        ctx.uniform3f(loc.hide, 0, 0, 0);
        ctx.drawElements(ctx.TRIANGLES, near.n, ctx.UNSIGNED_INT, 0);
      }
      [loc.pos, loc.ctr, loc.norm, loc.col].forEach((a) => ctx.disableVertexAttribArray(a));
    },

    setTrees(list) {
      rows = list && list.length ? list : null;
      if (!gl) { pending = !!rows; return; }
      prepare(); buildFar();
      if (map) map.triggerRepaint();
    },
    setVisible(on) { visible = !!on; if (map) map.triggerRepaint(); },
    isVisible() { return visible; },
    count() { return rows ? rows.length : 0; },
    stats() { return { far: far.n, shadows: far.ns, near: near.n, nearR: nearR }; }
  };
  return layer;
};
