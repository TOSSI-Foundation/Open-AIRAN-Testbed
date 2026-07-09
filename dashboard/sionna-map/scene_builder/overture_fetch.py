import json
import sys

DEFAULT_RELEASE = "2026-09-23.0"


def _release_exists(release):
    import urllib.error
    import urllib.request
    url = ("https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/"
           "?list-type=2&max-keys=1&prefix=release/%s/" % release)
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            body = r.read(4096).decode("utf-8", "replace")
        return "<Key>" in body or "<Contents>" in body
    except (urllib.error.URLError, OSError):
        return True


def fetch(bbox, release=None):
    import duckdb
    release = release or DEFAULT_RELEASE
    if not _release_exists(release):
        print("[overture] release %s is no longer on S3 (Overture keeps only the most recent "
              "few); using %s instead. The footprints may differ from the ones this scene was "
              "first built with." % (release, DEFAULT_RELEASE), file=sys.stderr)
        release = DEFAULT_RELEASE
    path = (f"s3://overturemaps-us-west-2/release/{release}/theme=buildings/type=building/*")
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs;")
    con.execute("SET s3_region='us-west-2';")
    q = f"""
      SELECT id, height, num_floors,
             ST_AsGeoJSON(geometry) AS geojson,
             (facade_material) AS facade_material
      FROM read_parquet('{path}', filename=false, hive_partitioning=1)
      WHERE bbox.xmin <= {bbox['max_lon']} AND bbox.xmax >= {bbox['min_lon']}
        AND bbox.ymin <= {bbox['max_lat']} AND bbox.ymax >= {bbox['min_lat']}
    """
    print(f"[overture] querying {release} for bbox {bbox} …", file=sys.stderr)
    rows = con.execute(q).fetchall()
    feats = []
    for id_, height, num_floors, gj, facade in rows:
        props = {"id": id_, "source": "overture"}
        if height is not None:
            props["height"] = float(height)
        if num_floors is not None:
            props["num_floors"] = int(num_floors)
        if facade:
            props["facade_material"] = facade
        try:
            feats.append({"type": "Feature", "properties": props, "geometry": json.loads(gj)})
        except Exception:
            continue
    print(f"[overture] {len(feats)} buildings", file=sys.stderr)
    return {"type": "FeatureCollection", "features": feats}
