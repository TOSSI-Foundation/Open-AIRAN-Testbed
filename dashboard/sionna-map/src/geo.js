window.SM = window.SM || {};

SM.geo = {
  M_PER_DEG_LAT: 111320,

  mPerDegLon(lat) { return 111320 * Math.cos((lat * Math.PI) / 180); },

  toENU(lon, lat, lon0, lat0) {
    return [(lon - lon0) * this.mPerDegLon(lat0), (lat - lat0) * this.M_PER_DEG_LAT];
  },

  fromENU(x, y, lon0, lat0) {
    return [lon0 + x / this.mPerDegLon(lat0), lat0 + y / this.M_PER_DEG_LAT];
  },

  bboxSizeM(b) {
    const latMid = (b.minLat + b.maxLat) / 2;
    return [
      (b.maxLon - b.minLon) * this.mPerDegLon(latMid),
      (b.maxLat - b.minLat) * this.M_PER_DEG_LAT
    ];
  },

  bboxCenter(b) { return [(b.minLon + b.maxLon) / 2, (b.minLat + b.maxLat) / 2]; },

  bboxFromCorners(a, c) {
    return {
      minLon: Math.min(a[0], c[0]), maxLon: Math.max(a[0], c[0]),
      minLat: Math.min(a[1], c[1]), maxLat: Math.max(a[1], c[1])
    };
  },

  bboxPolygon(b) {
    return {
      type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: [[
        [b.minLon, b.minLat], [b.maxLon, b.minLat],
        [b.maxLon, b.maxLat], [b.minLon, b.maxLat], [b.minLon, b.minLat]
      ]] }
    };
  },

  round(n, d = 2) { const p = Math.pow(10, d); return Math.round(n * p) / p; }
};
