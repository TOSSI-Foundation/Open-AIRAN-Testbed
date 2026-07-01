(function (SM) {
  'use strict';

  const VERT = [
    'attribute vec3 a_pos;',
    'attribute vec3 a_next;',
    'attribute float a_side;',
    'attribute float a_t;',
    'uniform mat4 u_matrix;',
    'uniform vec2 u_viewport;',
    'uniform float u_width_px;',
    'varying float v_side;',
    'void main() {',
    '  v_side = a_side;',
    '  vec4 cur = u_matrix * vec4(a_pos, 1.0);',
    '  vec4 nxt = u_matrix * vec4(a_next, 1.0);',
    '  vec2 curPx = (cur.xy / max(cur.w, 1e-6)) * u_viewport;',
    '  vec2 nxtPx = (nxt.xy / max(nxt.w, 1e-6)) * u_viewport;',
    '  vec2 dir = nxtPx - curPx;',
    '  float len = length(dir);',
    '  dir = len > 1e-6 ? dir / len : vec2(1.0, 0.0);',
    '  vec2 normal = vec2(-dir.y, dir.x);',
    '  vec2 offset = normal * (u_width_px * a_side) / u_viewport;',
    '  gl_Position = vec4(cur.xy + offset * cur.w, cur.zw);',
    '}'
  ].join('\n');

  const FRAG = [
    'precision mediump float;',
    'uniform vec3 u_color;',
    'uniform float u_opacity;',
    'varying float v_side;',
    'void main() {',
    '  float d = abs(v_side);',
    '  if (d > 1.0) discard;',
    '  gl_FragColor = vec4(u_color, u_opacity * smoothstep(1.0, 0.6, d));',
    '}'
  ].join('\n');

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  }

  SM.makeArc3D = function makeArc3D(id) {
    let gl = null, program = null, count = 0;
    let theMap = null;
    let posBuf = null, nextBuf = null, sideBuf = null, tBuf = null;
    let aPos = 0, aNext = 0, aSide = 0, aT = 0;
    let uMat = null, uColor = null, uOpacity = null, uViewport = null, uWidth = null;
    let color = [0.710, 0.514, 0.573];
    let opacity = 0.95;
    let widthPx = 5.5;
    let pending = null;
    let ends = null;

    function build(a, b, opts) {
      const o = opts || {};
      const steps = o.steps || 128;

      const A = maplibregl.MercatorCoordinate.fromLngLat(a, (SM.groundAt && SM.groundAt(a)) || 0);
      const B = maplibregl.MercatorCoordinate.fromLngLat(b, (SM.groundAt && SM.groundAt(b)) || 0);
      const mpu = A.meterInMercatorCoordinateUnits();

      const spanM = Math.hypot(B.x - A.x, B.y - A.y) / mpu;
      const peak = (o.height_m == null ? Math.max(60, spanM * 0.45) : o.height_m) * mpu;

      const pts = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        pts.push([
          A.x + (B.x - A.x) * t,
          A.y + (B.y - A.y) * t,
          A.z + (B.z - A.z) * t + peak * 4 * t * (1 - t)
        ]);
      }

      const pos = [], nxt = [], side = [], tt = [];
      const push = (p, q, sd, t) => {
        pos.push(p[0], p[1], p[2]);
        nxt.push(q[0], q[1], q[2]);
        side.push(sd);
        tt.push(t);
      };
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1];
        const t0 = i / (pts.length - 1), t1 = (i + 1) / (pts.length - 1);
        push(p, q, -1, t0); push(q, p, +1, t1); push(p, q, +1, t0);
        push(p, q, -1, t0); push(q, p, -1, t1); push(q, p, +1, t1);
      }
      return {
        pos: new Float32Array(pos), next: new Float32Array(nxt),
        side: new Float32Array(side), t: new Float32Array(tt),
        ends: [pts[0], pts[pts.length - 1]]
      };
    }

    const layer = {
      id: id,
      type: 'custom',
      renderingMode: '3d',

      onAdd(map, ctx) {
        theMap = map;
        gl = ctx;
        program = gl.createProgram();
        gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
        gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(program);
        aPos = gl.getAttribLocation(program, 'a_pos');
        aNext = gl.getAttribLocation(program, 'a_next');
        aSide = gl.getAttribLocation(program, 'a_side');
        aT = gl.getAttribLocation(program, 'a_t');
        uMat = gl.getUniformLocation(program, 'u_matrix');
        uColor = gl.getUniformLocation(program, 'u_color');
        uOpacity = gl.getUniformLocation(program, 'u_opacity');
        uViewport = gl.getUniformLocation(program, 'u_viewport');
        uWidth = gl.getUniformLocation(program, 'u_width_px');
        posBuf = gl.createBuffer(); nextBuf = gl.createBuffer();
        sideBuf = gl.createBuffer(); tBuf = gl.createBuffer();
        if (pending) { layer.setArc(pending.a, pending.b, pending.o); pending = null; }
      },

      onRemove() {
        if (!gl) return;
        [posBuf, nextBuf, sideBuf, tBuf].forEach((b) => gl.deleteBuffer(b));
        gl.deleteProgram(program);
        gl = null; program = null; count = 0;
      },

      setArc(a, b, opts) {
        if (!a || !b) { count = 0; pending = null; ends = null; return; }
        if (!gl) { pending = { a: a, b: b, o: opts }; return; }
        if (opts && opts.width_px) widthPx = opts.width_px;
        const m = build(a, b, opts);
        const put = (buf, arr) => {
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
        };
        put(posBuf, m.pos); put(nextBuf, m.next); put(sideBuf, m.side); put(tBuf, m.t);
        ends = m.ends;
        count = m.pos.length / 3;
      },

      clear() { count = 0; pending = null; ends = null; },

      setColor(rgb, alpha) {
        if (rgb) color = rgb;
        if (alpha != null) opacity = alpha;
      },

      render(ctx, args) {
        if (!count || !program) return;
        const view = (args && args.defaultProjectionData && args.defaultProjectionData.mainMatrix)
          || (args && args.length === 16 ? args : null);
        if (!view) return;

        gl.useProgram(program);
        gl.uniformMatrix4fv(uMat, false, new Float32Array(SM.liftView(theMap, view)));
        gl.uniform3fv(uColor, color);
        gl.uniform1f(uOpacity, opacity);
        gl.uniform2f(uViewport, gl.drawingBufferWidth * 0.5, gl.drawingBufferHeight * 0.5);
        gl.uniform1f(uWidth, widthPx);

        const bind = (buf, loc, size) => {
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
        };
        bind(posBuf, aPos, 3); bind(nextBuf, aNext, 3);
        bind(sideBuf, aSide, 1); bind(tBuf, aT, 1);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.drawArrays(gl.TRIANGLES, 0, count);
        gl.depthMask(true);
      }
    };

    return layer;
  };

  const RAY_VERT = [
    'attribute vec3 a_pos;', 'attribute vec3 a_next;', 'attribute float a_side;',
    'attribute vec4 a_col;', 'attribute vec2 a_w;', 'attribute float a_ca;',
    'uniform mat4 u_matrix;', 'uniform vec2 u_viewport;', 'uniform float u_casing;', 'uniform float u_dpr;',
    'varying float v_side;', 'varying vec4 v_col;',
    'void main() {',
    '  v_side = a_side;',
    '  v_col = u_casing > 0.5 ? vec4(0.043, 0.078, 0.102, a_ca) : a_col;',
    '  float w = 0.5 * u_dpr * (u_casing > 0.5 ? a_w.y : a_w.x);',
    '  vec4 cur = u_matrix * vec4(a_pos, 1.0);',
    '  vec4 nxt = u_matrix * vec4(a_next, 1.0);',
    '  vec2 dir = (nxt.xy / max(nxt.w, 1e-6) - cur.xy / max(cur.w, 1e-6)) * u_viewport;',
    '  float len = length(dir);',
    '  dir = len > 1e-6 ? dir / len : vec2(1.0, 0.0);',
    '  vec2 offset = vec2(-dir.y, dir.x) * (w * a_side) / u_viewport;',
    '  gl_Position = vec4(cur.xy + offset * cur.w, cur.zw);',
    '}'
  ].join('\n');
  const RAY_FRAG = [
    'precision mediump float;', 'varying float v_side;', 'varying vec4 v_col;',
    'void main() {',
    '  float d = abs(v_side);',
    '  if (d > 1.0) discard;',
    '  gl_FragColor = vec4(v_col.rgb, v_col.a * smoothstep(1.0, 0.6, d));',
    '}'
  ].join('\n');
  const DOT_VERT = [
    'attribute vec3 a_pos;', 'attribute vec3 a_col;',
    'uniform mat4 u_matrix;', 'uniform float u_size;', 'varying vec3 v_col;',
    'void main() { v_col = a_col; gl_Position = u_matrix * vec4(a_pos, 1.0); gl_PointSize = u_size; }'
  ].join('\n');
  const DOT_FRAG = [
    'precision mediump float;', 'varying vec3 v_col;',
    'void main() {',
    '  float r = length(gl_PointCoord - vec2(0.5)) * 2.0;',
    '  if (r > 1.0) discard;',
    '  gl_FragColor = r > 0.72 ? vec4(0.043, 0.078, 0.102, 0.9) : vec4(v_col, 0.9);',
    '}'
  ].join('\n');

  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    return p;
  }

  SM.makeRays3D = function makeRays3D(id) {
    let gl = null, theMap = null, ribbon = null, dotProg = null, n = 0, nd = 0, origin = [0, 0, 0];
    const bufs = {};
    let pending = null;

    function merc(ll, alt) {
      const m = maplibregl.MercatorCoordinate.fromLngLat(ll, alt);
      return [m.x - origin[0], m.y - origin[1], m.z - origin[2]];
    }
    function upload(name, arr) {
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs[name]);
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    }
    function attr(prog, name, buf, size) {
      const loc = gl.getAttribLocation(prog, name);
      if (loc < 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs[buf]);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    }
    function build(paths, dots) {
      const first = (paths[0] && paths[0].pts[0]) || (dots[0] && dots[0].ll.concat([dots[0].alt_m]));
      if (!first) { n = 0; nd = 0; return; }
      const o = maplibregl.MercatorCoordinate.fromLngLat([first[0], first[1]], first[2] || 0);
      origin = [o.x, o.y, o.z];
      const pos = [], nxt = [], side = [], col = [], w = [], ca = [];
      paths.forEach((p) => {
        const q = p.pts.map((v) => merc([v[0], v[1]], v[2]));
        for (let i = 0; i < q.length - 1; i++) {
          const a = q[i], b = q[i + 1];
          [[a, b, -1], [b, a, 1], [a, b, 1], [a, b, -1], [b, a, -1], [b, a, 1]].forEach((v) => {
            pos.push(v[0][0], v[0][1], v[0][2]); nxt.push(v[1][0], v[1][1], v[1][2]);
            side.push(v[2]);
            col.push(p.color[0], p.color[1], p.color[2], p.color[3]);
            w.push(p.width_px, p.casing_px); ca.push(p.casing_alpha);
          });
        }
      });
      upload('pos', new Float32Array(pos)); upload('next', new Float32Array(nxt));
      upload('side', new Float32Array(side)); upload('col', new Float32Array(col));
      upload('w', new Float32Array(w)); upload('ca', new Float32Array(ca));
      n = pos.length / 3;
      const dp = [], dc = [];
      dots.forEach((d) => { const m = merc(d.ll, d.alt_m); dp.push(m[0], m[1], m[2]); dc.push(d.color[0], d.color[1], d.color[2]); });
      upload('dpos', new Float32Array(dp)); upload('dcol', new Float32Array(dc));
      nd = dp.length / 3;
    }
    function shifted(view) {
      const v = SM.liftView(theMap, view), o = new Float64Array(v);
      for (let r = 0; r < 4; r++) o[12 + r] = v[r] * origin[0] + v[4 + r] * origin[1] + v[8 + r] * origin[2] + v[12 + r];
      return new Float32Array(o);
    }

    const layer = {
      id: id, type: 'custom', renderingMode: '3d',
      onAdd(map, ctx) {
        theMap = map; gl = ctx;
        ribbon = program(gl, RAY_VERT, RAY_FRAG);
        dotProg = program(gl, DOT_VERT, DOT_FRAG);
        ['pos', 'next', 'side', 'col', 'w', 'ca', 'dpos', 'dcol'].forEach((k) => { bufs[k] = gl.createBuffer(); });
        if (pending) { build(pending.paths, pending.dots); pending = null; }
      },
      onRemove() {
        if (!gl) return;
        Object.keys(bufs).forEach((k) => gl.deleteBuffer(bufs[k]));
        gl.deleteProgram(ribbon); gl.deleteProgram(dotProg);
        gl = null; n = 0; nd = 0;
      },
      setData(paths, dots) {
        if (!gl) { pending = { paths: paths || [], dots: dots || [] }; return; }
        build(paths || [], dots || []);
        if (theMap) theMap.triggerRepaint();
      },
      render(ctx, args) {
        if ((!n && !nd) || !ribbon) return;
        const view = (args && args.defaultProjectionData && args.defaultProjectionData.mainMatrix)
          || (args && args.length === 16 ? args : null);
        if (!view) return;
        const mat = shifted(view), dpr = window.devicePixelRatio || 1;
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(false);
        if (n) {
          gl.useProgram(ribbon);
          gl.uniformMatrix4fv(gl.getUniformLocation(ribbon, 'u_matrix'), false, mat);
          gl.uniform2f(gl.getUniformLocation(ribbon, 'u_viewport'), gl.drawingBufferWidth * 0.5, gl.drawingBufferHeight * 0.5);
          gl.uniform1f(gl.getUniformLocation(ribbon, 'u_dpr'), dpr);
          attr(ribbon, 'a_pos', 'pos', 3); attr(ribbon, 'a_next', 'next', 3); attr(ribbon, 'a_side', 'side', 1);
          attr(ribbon, 'a_col', 'col', 4); attr(ribbon, 'a_w', 'w', 2); attr(ribbon, 'a_ca', 'ca', 1);
          [1, 0].forEach((casing) => {
            gl.uniform1f(gl.getUniformLocation(ribbon, 'u_casing'), casing);
            gl.drawArrays(gl.TRIANGLES, 0, n);
          });
        }
        if (nd) {
          gl.useProgram(dotProg);
          gl.uniformMatrix4fv(gl.getUniformLocation(dotProg, 'u_matrix'), false, mat);
          gl.uniform1f(gl.getUniformLocation(dotProg, 'u_size'), 9 * dpr);
          attr(dotProg, 'a_pos', 'dpos', 3); attr(dotProg, 'a_col', 'dcol', 3);
          gl.drawArrays(gl.POINTS, 0, nd);
        }
        gl.depthMask(true);
      }
    };
    return layer;
  };
}(window.SM = window.SM || {}));
