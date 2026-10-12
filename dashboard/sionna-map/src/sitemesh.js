window.SM = window.SM || {};

SM.createSiteMeshLayer = function (id) {
  let gl = null, program = null, map = null, loc = {};
  let items = [];
  let visible = true;

  const VERT = `
    attribute vec3 a_pos;
    attribute vec2 a_uv;
    attribute vec4 a_norm;
    attribute vec4 a_col;
    uniform mat4 u_matrix;
    varying vec3 v_pos;
    varying vec2 v_uv;
    varying vec3 v_norm;
    varying vec3 v_col;
    varying float v_flag;
    void main() {
      v_pos = a_pos;
      v_uv = a_uv;
      v_norm = a_norm.xyz;
      v_col = a_col.rgb;
      v_flag = a_norm.w * 127.0;
      gl_Position = u_matrix * vec4(a_pos, 1.0);
    }`;
  const FRAG = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    uniform vec3 u_light;
    uniform sampler2D u_tex;
    uniform float u_has_tex;
    varying vec3 v_pos;
    varying vec2 v_uv;
    varying vec3 v_norm;
    varying vec3 v_col;
    varying float v_flag;
    float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
    float h2(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    vec3 ashlar(vec3 n) {
      vec2 t = normalize(vec2(-n.y, n.x) + 1e-6);
      float s = dot(v_pos.xy, t), z = v_pos.z;
      float course = floor(z / 0.42);
      float off = h1(course) * 1.7, blen = 0.55 + 0.75 * h1(course + 17.0);
      float k = h2(vec2(course, floor((s + off) / blen)));
      vec3 st = k < 0.45 ? vec3(0.70, 0.71, 0.72) : k < 0.75 ? vec3(0.62, 0.63, 0.65)
              : k < 0.9 ? vec3(0.74, 0.72, 0.68) : vec3(0.55, 0.56, 0.58);
      float fu = fract((s + off) / blen) * blen, fz = fract(z / 0.42) * 0.42;
      return (fu < 0.03 || fz < 0.03) ? vec3(0.80, 0.80, 0.78) : st;
    }
    void main() {

      vec3 n = normalize(v_norm);
      float sun = max(dot(n, u_light), 0.0);
      float sky = 0.5 + 0.5 * n.z;
      vec3 c;
      if (v_flag > 1.5 && v_flag < 2.5 && u_has_tex > 0.5) {
        c = texture2D(u_tex, v_uv).rgb;

        gl_FragColor = vec4(c * (0.78 + 0.22 * sun + 0.08 * sky), 1.0);
        return;
      } else if (v_flag > 2.5) {

        float row = floor(v_pos.z / 0.11);
        vec2 t = normalize(vec2(-n.y, n.x) + 1e-6);
        float s = dot(v_pos.xy, t) + h1(row) * 0.3;
        float k = h2(vec2(row, floor(s / 0.3)));
        c = v_col * (0.85 + 0.3 * k);
        if (fract(v_pos.z / 0.11) < 0.12 || fract(s / 0.3) < 0.05) c *= 0.7;
      } else if (v_flag > 0.5) {
        c = ashlar(n);
      } else {
        c = v_col;
      }
      gl_FragColor = vec4(c * (0.36 + 0.22 * sky) + c * 0.55 * sun, 1.0);
    }`;

  function compile(ctx, type, src) {
    const sh = ctx.createShader(type);
    ctx.shaderSource(sh, src);
    ctx.compileShader(sh);
    if (!ctx.getShaderParameter(sh, ctx.COMPILE_STATUS)) console.warn('site mesh shader:', ctx.getShaderInfoLog(sh));
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

  function upload(it) {
    it.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, it.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, it.data, gl.STATIC_DRAW);
    it.groups.forEach((g) => {
      if (!g.image || g.gltex) return;
      g.gltex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, g.gltex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, g.image);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    });
  }

  function parse(ab) {
    const dv = new DataView(ab);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic === 'SKM2') {
      const hl = dv.getUint32(4, true);
      const head = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 8, hl)));
      const data = ab.slice(8 + hl);
      return { data: data, n: data.byteLength / head.stride, stride: head.stride, uv: 12, norm: 20, col: 24,
               groups: head.groups.map((g) => ({ tex: g.tex, start: g.start, count: g.count })) };
    }
    const n = dv.getUint32(0, true);
    return { data: ab.slice(4, 4 + n * 20), n: n, stride: 20, uv: -1, norm: 12, col: 16,
             groups: [{ tex: null, start: 0, count: n }] };
  }

  async function loadImage(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
    const blob = await r.blob();
    if (window.createImageBitmap) return createImageBitmap(blob);
    return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(blob); });
  }

  const layer = {
    id: id, type: 'custom', renderingMode: '3d',
    onAdd(m, ctx) {
      map = m; gl = ctx;
      program = gl.createProgram();
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(program);
      loc = { pos: gl.getAttribLocation(program, 'a_pos'), uv: gl.getAttribLocation(program, 'a_uv'),
              norm: gl.getAttribLocation(program, 'a_norm'), col: gl.getAttribLocation(program, 'a_col'),
              mat: gl.getUniformLocation(program, 'u_matrix'), light: gl.getUniformLocation(program, 'u_light'),
              tex: gl.getUniformLocation(program, 'u_tex'), hasTex: gl.getUniformLocation(program, 'u_has_tex') };
      items.forEach((it) => { if (!it.vbo) upload(it); });
    },
    onRemove() {
      if (gl) {
        items.forEach((it) => { if (it.vbo) gl.deleteBuffer(it.vbo); it.groups.forEach((g) => g.gltex && gl.deleteTexture(g.gltex)); });
        gl.deleteProgram(program);
      }
      gl = null; items = [];
    },
    render(ctx, matrix) {
      if (!visible || !items.length || !map || map.getZoom() < 13) return;
      ctx.useProgram(program);
      const L = [-0.45, -0.35, 0.82], l = Math.hypot(...L);
      ctx.uniform3f(loc.light, L[0] / l, L[1] / l, L[2] / l);
      ctx.uniform1i(loc.tex, 0);
      ctx.enable(ctx.DEPTH_TEST); ctx.depthFunc(ctx.LEQUAL); ctx.depthMask(true);
      ctx.disable(ctx.BLEND); ctx.disable(ctx.CULL_FACE);
      ctx.activeTexture(ctx.TEXTURE0);
      items.forEach((it) => {
        if (!it.vbo) return;
        const s = it.mPer, b = it.base;
        const onT = map.getTerrain && map.getTerrain();
        const model = new Float64Array([s, 0, 0, 0, 0, -s, 0, 0, 0, 0, s, 0, b.x, b.y, onT ? b.z : 0, 1]);
        ctx.uniformMatrix4fv(loc.mat, false, new Float32Array(mul(onT ? SM.liftView(map, matrix) : matrix, model)));
        ctx.bindBuffer(ctx.ARRAY_BUFFER, it.vbo);
        ctx.enableVertexAttribArray(loc.pos); ctx.vertexAttribPointer(loc.pos, 3, ctx.FLOAT, false, it.stride, 0);
        if (it.uv >= 0) { ctx.enableVertexAttribArray(loc.uv); ctx.vertexAttribPointer(loc.uv, 2, ctx.FLOAT, false, it.stride, it.uv); }
        else { ctx.disableVertexAttribArray(loc.uv); ctx.vertexAttrib2f(loc.uv, 0, 0); }
        ctx.enableVertexAttribArray(loc.norm); ctx.vertexAttribPointer(loc.norm, 4, ctx.BYTE, true, it.stride, it.norm);
        ctx.enableVertexAttribArray(loc.col); ctx.vertexAttribPointer(loc.col, 4, ctx.UNSIGNED_BYTE, true, it.stride, it.col);
        it.groups.forEach((g) => {
          if (g.gltex) { ctx.bindTexture(ctx.TEXTURE_2D, g.gltex); ctx.uniform1f(loc.hasTex, 1); }
          else ctx.uniform1f(loc.hasTex, 0);
          ctx.drawArrays(ctx.TRIANGLES, g.start, g.count);
        });
      });
      [loc.pos, loc.uv, loc.norm, loc.col].forEach((a) => a >= 0 && ctx.disableVertexAttribArray(a));
    },
    async load(entries, fileUrl) {
      if (gl) items.forEach((it) => { if (it.vbo) gl.deleteBuffer(it.vbo); it.groups.forEach((g) => g.gltex && gl.deleteTexture(g.gltex)); });
      items = [];
      for (const e of entries || []) {
        try {
          const r = await fetch(fileUrl(e, (SM.TERRAIN_ON && e.bin_terrain) || e.bin));
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const p = parse(await r.arrayBuffer());
          for (const g of p.groups) {
            if (g.tex) {
              try { g.image = await loadImage(fileUrl(e, 'models/' + g.tex)); } catch (err) { console.warn('site mesh texture:', err && err.message); }
            }
          }
          const base = maplibregl.MercatorCoordinate.fromLngLat(e.anchor_lonlat, +e.base_navd88_m || 0);
          const it = Object.assign(p, { base: base, mPer: base.meterInMercatorCoordinateUnits(), bid: e.bid, vbo: null });
          if (gl) upload(it);
          items.push(it);
          if (map) map.triggerRepaint();
        } catch (err) { console.warn('site mesh ' + e.bid + ':', err && err.message); }
      }
    },
    setVisible(on) { visible = !!on; if (map) map.triggerRepaint(); },
    count() { return items.length; }
  };
  return layer;
};
