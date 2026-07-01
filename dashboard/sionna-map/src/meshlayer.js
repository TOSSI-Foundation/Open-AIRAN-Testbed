window.SM = window.SM || {};

SM.createMeshLayer = function (id) {
  let gl = null, program = null, posBuf = null, normBuf = null, count = 0;
  let theMap = null;
  let aPos = 0, aNorm = 0, uMat = null, uNorm = null, uColor = null, uOpacity = null;
  let pending = null;
  let place = null;
  let color = [0.90, 0.24, 0.20];
  let opacity = 1.0;

  const VERT = `
    attribute vec3 a_pos;
    attribute vec3 a_norm;
    uniform mat4 u_matrix;
    uniform mat3 u_normal;
    varying vec3 v_norm;
    void main() {
      v_norm = normalize(u_normal * a_norm);
      gl_Position = u_matrix * vec4(a_pos, 1.0);
    }`;
  const FRAG = `
    precision mediump float;
    uniform vec3 u_color;
    uniform float u_opacity;
    varying vec3 v_norm;
    void main() {
      vec3 l = normalize(vec3(0.35, 0.45, 0.82));
      vec3 n = normalize(v_norm);
      if (!gl_FrontFacing) n = -n;
      float d = 0.45 + 0.55 * abs(dot(n, l));
      gl_FragColor = vec4(u_color * d, u_opacity);
    }`;

  function compile(ctx, type, src) {
    const sh = ctx.createShader(type);
    ctx.shaderSource(sh, src);
    ctx.compileShader(sh);
    if (!ctx.getShaderParameter(sh, ctx.COMPILE_STATUS)) {
      console.warn('mesh layer shader:', ctx.getShaderInfoLog(sh));
    }
    return sh;
  }

  function mul(a, b) {
    const o = new Float64Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
                     + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }

  function modelMatrix() {
    if (!place) return null;
    const base = maplibregl.MercatorCoordinate.fromLngLat(place.anchor, (SM.groundAt && SM.groundAt(place.anchor)) || 0);
    const s = base.meterInMercatorCoordinateUnits() * (place.scale > 0 ? place.scale : 1);
    const th = ((place.rotationDeg || 0) * Math.PI) / 180;
    const c = Math.cos(th), sn = Math.sin(th);
    return new Float64Array([
      s * c, -s * sn, 0, 0,
      -s * sn, -s * c, 0, 0,
      0, 0, s, 0,
      base.x, base.y, base.z || 0, 1
    ]);
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
      aNorm = gl.getAttribLocation(program, 'a_norm');
      uMat = gl.getUniformLocation(program, 'u_matrix');
      uNorm = gl.getUniformLocation(program, 'u_normal');
      uColor = gl.getUniformLocation(program, 'u_color');
      uOpacity = gl.getUniformLocation(program, 'u_opacity');
      posBuf = gl.createBuffer();
      normBuf = gl.createBuffer();
      if (pending) { layer.setMesh(pending.pos, pending.norm); pending = null; }
    },

    onRemove() {
      if (!gl) return;
      gl.deleteBuffer(posBuf); gl.deleteBuffer(normBuf); gl.deleteProgram(program);
      gl = null; program = null; count = 0;
    },

    setMesh(pos, norm) {
      if (!gl) { pending = { pos: pos, norm: norm }; return; }
      if (!pos || !pos.length) { count = 0; return; }
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
      gl.bufferData(gl.ARRAY_BUFFER, norm, gl.STATIC_DRAW);
      count = pos.length / 3;
    },

    clear() { count = 0; pending = null; },

    setPlacement(anchor, rotationDeg, scale) {
      place = anchor ? { anchor: anchor, rotationDeg: rotationDeg || 0, scale: scale || 1 } : null;
    },

    setColor(rgb, alpha) {
      if (rgb) color = rgb;
      if (alpha != null) opacity = alpha;
    },

    hasMesh() { return count > 0 || !!pending; },

    render(ctx, args) {
      if (!count || !place || !program) return;
      const model = modelMatrix();
      if (!model) return;
      const view = (args && args.defaultProjectionData && args.defaultProjectionData.mainMatrix)
        || (args && args.length === 16 ? args : null);
      if (!view) return;
      const mvp = mul(SM.liftView(theMap, view), model);
      const n3 = new Float32Array([
        model[0], model[1], model[2],
        model[4], model[5], model[6],
        model[8], model[9], model[10]
      ]);

      if (ctx.bindVertexArray) ctx.bindVertexArray(null);
      ctx.disable(ctx.STENCIL_TEST);
      ctx.disable(ctx.SCISSOR_TEST);
      ctx.depthMask(true);
      ctx.useProgram(program);
      ctx.uniformMatrix4fv(uMat, false, new Float32Array(mvp));
      ctx.uniformMatrix3fv(uNorm, false, n3);
      ctx.uniform3f(uColor, color[0], color[1], color[2]);
      ctx.uniform1f(uOpacity, opacity);

      ctx.bindBuffer(ctx.ARRAY_BUFFER, posBuf);
      ctx.enableVertexAttribArray(aPos);
      ctx.vertexAttribPointer(aPos, 3, ctx.FLOAT, false, 0, 0);
      ctx.bindBuffer(ctx.ARRAY_BUFFER, normBuf);
      ctx.enableVertexAttribArray(aNorm);
      ctx.vertexAttribPointer(aNorm, 3, ctx.FLOAT, false, 0, 0);

      ctx.enable(ctx.DEPTH_TEST);
      ctx.depthFunc(ctx.LEQUAL);
      ctx.clear(ctx.DEPTH_BUFFER_BIT);
      ctx.disable(ctx.CULL_FACE);
      if (opacity >= 0.999) ctx.disable(ctx.BLEND);
      else {
        ctx.enable(ctx.BLEND);
        ctx.blendFunc(ctx.SRC_ALPHA, ctx.ONE_MINUS_SRC_ALPHA);
      }
      if (SM.MESH_DEBUG && !layer._logged) {
        layer._logged = true;
        console.log('meshlayer state', JSON.stringify({
          depthTest: ctx.getParameter(ctx.DEPTH_TEST),
          depthWrite: ctx.getParameter(ctx.DEPTH_WRITEMASK),
          depthFunc: ctx.getParameter(ctx.DEPTH_FUNC),
          clearDepth: ctx.getParameter(ctx.DEPTH_CLEAR_VALUE),
          depthRange: Array.from(ctx.getParameter(ctx.DEPTH_RANGE) || []),
          blend: ctx.getParameter(ctx.BLEND),
          cull: ctx.getParameter(ctx.CULL_FACE),
          stencil: ctx.getParameter(ctx.STENCIL_TEST),
          count: count
        }));
      }
      ctx.drawArrays(ctx.TRIANGLES, 0, count);
    }
  };
  return layer;
};

SM.modelMeshes = {};
SM.modelMesh = async function (name, up) {
  const key = name + '|' + (up === 'y' ? 'y' : 'z');
  if (SM.modelMeshes[key] !== undefined) return SM.modelMeshes[key];
  SM.modelMeshes[key] = null;
  try {
    const r = await fetch('/api/map/models/' + encodeURIComponent(name)
      + '/mesh?up=' + (up === 'y' ? 'y' : 'z'));
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    const head = new Uint32Array(buf, 0, 2);
    if (head[0] !== 0x534d4553 || !head[1]) return null;
    const n = head[1];
    SM.modelMeshes[key] = {
      pos: new Float32Array(buf, 8, n * 3),
      norm: new Float32Array(buf, 8 + n * 12, n * 3)
    };
  } catch (e) { SM.modelMeshes[key] = null; }
  return SM.modelMeshes[key];
};
