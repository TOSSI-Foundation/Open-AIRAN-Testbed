import math
import sys

_TILE = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png"
_Z = 13
_cache = {}

_dem = None


def use_dem(path):
    global _dem
    import numpy as np
    d = np.load(path)
    _dem = (np.asarray(d["lons"], float), np.asarray(d["lats"], float), np.asarray(d["z"], float))
    datum = str(d["datum"]) if "datum" in d.files else "unknown datum"
    lons, lats, z = _dem
    return (f"site DEM {z.shape[1]}x{z.shape[0]} ({(lons[1] - lons[0]) * 1e5:.1f}e-5 deg grid, {datum}), "
            f"{lons[0]:.4f}..{lons[-1]:.4f} E, {lats[0]:.4f}..{lats[-1]:.4f} N")


def _dem_at(lon, lat):
    import numpy as np
    lons, lats, z = _dem
    if not (lons[0] <= lon <= lons[-1] and lats[0] <= lat <= lats[-1]):
        return None
    fx = (lon - lons[0]) / (lons[1] - lons[0])
    fy = (lat - lats[0]) / (lats[1] - lats[0])
    i, j = min(int(fx), lons.size - 2), min(int(fy), lats.size - 2)
    u, v = fx - i, fy - j
    return float(z[j, i] * (1 - u) * (1 - v) + z[j, i + 1] * u * (1 - v)
                 + z[j + 1, i] * (1 - u) * v + z[j + 1, i + 1] * u * v)


def _deg2tile(lon, lat, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    y = (1.0 - math.asinh(math.tan(lat_r)) / math.pi) / 2.0 * n
    return x, y


def _tile_img(z, xt, yt):
    key = (z, xt, yt)
    if key not in _cache:
        import io
        import requests
        from PIL import Image
        r = requests.get(_TILE.format(z=z, x=xt, y=yt), timeout=20)
        r.raise_for_status()
        _cache[key] = Image.open(io.BytesIO(r.content)).convert("RGB")
    return _cache[key]


def _pixel(z, gx, gy):
    xt, yt = gx // 256, gy // 256
    r, g, b = _tile_img(z, xt, yt).getpixel((gx % 256, gy % 256))
    return (r * 256 + g + b / 256.0) - 32768.0


def pixel_size_m(lat, z=_Z):
    return 156543.03392 * math.cos(math.radians(lat)) / (2 ** z)


def elevation(lon, lat, z=_Z):
    if _dem is not None:
        e = _dem_at(lon, lat)
        if e is not None:
            return e
    xf, yf = _deg2tile(lon, lat, z)
    px, py = xf * 256 - 0.5, yf * 256 - 0.5
    x0, y0 = int(math.floor(px)), int(math.floor(py))
    fx, fy = px - x0, py - y0
    e00, e10 = _pixel(z, x0, y0), _pixel(z, x0 + 1, y0)
    e01, e11 = _pixel(z, x0, y0 + 1), _pixel(z, x0 + 1, y0 + 1)
    return (e00 * (1 - fx) * (1 - fy) + e10 * fx * (1 - fy) + e01 * (1 - fx) * fy + e11 * fx * fy)


class GroundGrid:

    def __init__(self, xs, ys, Z):
        import numpy as np
        self.xs, self.ys, self.Z = np.asarray(xs, float), np.asarray(ys, float), np.asarray(Z, float)

    @classmethod
    def from_mesh(cls, mesh):
        g = mesh.metadata.get("grid")
        return cls(*g) if g else None

    @classmethod
    def from_scene_xml(cls, scene_xml):
        import os
        import re
        import numpy as np
        import trimesh
        xml = open(scene_xml).read()
        m = re.search(r'<shape[^>]*id="mesh-ground"[^>]*>.*?name="filename" value="([^"]+)"', xml, re.S)
        if not m:
            return None
        v = trimesh.load(os.path.join(os.path.dirname(scene_xml), m.group(1)), process=False).vertices
        xs, ys = np.unique(np.round(v[:, 0], 6)), np.unique(np.round(v[:, 1], 6))
        if xs.size * ys.size != len(v) or xs.size < 2 or ys.size < 2:
            return None
        return cls(xs, ys, v[:, 2].reshape(ys.size, xs.size))

    def height(self, x, y):
        import numpy as np
        x, y = np.asarray(x, float), np.asarray(y, float)
        xs, ys, Z = self.xs, self.ys, self.Z
        i = np.clip(np.searchsorted(xs, x) - 1, 0, xs.size - 2)
        j = np.clip(np.searchsorted(ys, y) - 1, 0, ys.size - 2)
        u = np.clip((x - xs[i]) / (xs[i + 1] - xs[i]), 0.0, 1.0)
        v = np.clip((y - ys[j]) / (ys[j + 1] - ys[j]), 0.0, 1.0)
        za, zb, zc, zd = Z[j, i], Z[j, i + 1], Z[j + 1, i + 1], Z[j + 1, i]
        lower = v <= u
        return np.where(lower, za + u * (zb - za) + v * (zc - zb), za + v * (zd - za) + u * (zc - zd))


def ground_mesh(bbox, lon0, lat0, n=None):
    import numpy as np
    import trimesh
    mlat = 111320.0
    mlon = 111320.0 * math.cos(math.radians(lat0))
    if n is None:
        span = max((bbox["max_lon"] - bbox["min_lon"]) * mlon, (bbox["max_lat"] - bbox["min_lat"]) * mlat)
        if _dem is not None:
            n = int(min(256, max(8, math.ceil(span / 8.0) + 1)))
        else:
            px = pixel_size_m(lat0)
            n = int(min(160, max(8, math.ceil(span / px) + 1)))
    lons = np.linspace(bbox["min_lon"], bbox["max_lon"], n)
    lats = np.linspace(bbox["min_lat"], bbox["max_lat"], n)
    e0 = elevation(lon0, lat0)
    Z = np.zeros((n, n))
    failed = 0
    for j, la in enumerate(lats):
        for i, lo in enumerate(lons):
            try:
                Z[j, i] = elevation(lo, la) - e0
            except Exception:
                failed += 1
                Z[j, i] = 0.0
    if failed:
        print(f"[terrain] {failed} of {n * n} samples could not be fetched and were set to the origin's height",
              file=sys.stderr)
    xs, ys = (lons - lon0) * mlon, (lats - lat0) * mlat
    verts = [[xs[i], ys[j], Z[j, i]] for j in range(n) for i in range(n)]
    faces = []
    for j in range(n - 1):
        for i in range(n - 1):
            a, b, c, d = j * n + i, j * n + i + 1, (j + 1) * n + i + 1, (j + 1) * n + i
            faces += [[a, b, c], [a, c, d]]
    print(f"[terrain] built {n}x{n} DEM ground (origin elev {e0:.1f} m, relief {Z.min():.1f}..{Z.max():.1f} m)",
          file=sys.stderr)
    mesh = trimesh.Trimesh(vertices=np.array(verts, float), faces=np.array(faces), process=False)
    mesh.metadata["grid"] = (xs, ys, Z)
    return mesh
