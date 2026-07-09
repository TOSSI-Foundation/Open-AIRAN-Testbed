import os
import sys


def load_ifc(path):
    import multiprocessing
    import numpy as np
    import ifcopenshell
    import ifcopenshell.geom
    import trimesh

    f = ifcopenshell.open(path)
    settings = ifcopenshell.geom.settings()
    for setter in (lambda: settings.set("use-world-coords", True),
                   lambda: settings.set(settings.USE_WORLD_COORDS, True)):
        try:
            setter()
            break
        except Exception:
            continue
    it = ifcopenshell.geom.iterator(settings, f, max(1, multiprocessing.cpu_count() - 1))
    verts, faces, base = [], [], 0
    if it.initialize():
        while True:
            g = it.get().geometry
            v = np.asarray(g.verts, dtype=float).reshape(-1, 3)
            fa = np.asarray(g.faces, dtype=np.int64).reshape(-1, 3)
            if len(v):
                verts.append(v)
                faces.append(fa + base)
                base += len(v)
            if not it.next():
                break
    if not verts:
        raise ValueError("the IFC file has no geometry that could be built "
                         "(no walls, slabs or shapes with a body representation)")
    return trimesh.Trimesh(vertices=np.concatenate(verts),
                           faces=np.concatenate(faces), process=False)


def repair_gltf(path):
    import json
    import shutil

    base = os.path.dirname(os.path.abspath(path))
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            doc = json.load(fh)
    except Exception:
        return []
    fixed = []
    for buf in (doc.get("buffers") or []) + (doc.get("images") or []):
        uri = buf.get("uri") or ""
        if not uri or uri.startswith("data:"):
            continue
        target = os.path.join(base, uri)
        if os.path.exists(target):
            continue
        wanted = os.path.basename(uri)
        found = []
        for dirpath, _dirs, files in os.walk(base):
            if wanted in files:
                found.append(os.path.join(dirpath, wanted))
        if not found:
            continue
        found.sort(key=lambda f: os.path.getmtime(f), reverse=True)
        os.makedirs(os.path.dirname(target) or base, exist_ok=True)
        shutil.copyfile(found[0], target)
        fixed.append(uri)
    return fixed


def load_mesh(path):
    import trimesh
    ext = os.path.splitext(path)[1].lower()
    if ext == ".ifc":
        return load_ifc(path)
    if ext == ".gltf":
        repair_gltf(path)
    try:
        mesh = trimesh.load(path, force="mesh")
    except FileNotFoundError as exc:
        missing = os.path.basename(str(exc).split("'")[-2]) if "'" in str(exc) else "a data file"
        raise ValueError(f"this file refers to {missing}, which was not uploaded with it — "
                         f"upload {missing} as well, or export as .glb, which packs "
                         f"everything into one file") from exc
    if mesh.is_empty or not len(getattr(mesh, "faces", [])):
        raise ValueError("the file has no geometry")
    return mesh


if __name__ == "__main__":
    for p in sys.argv[1:]:
        try:
            m = load_mesh(p)
            ext = m.vertices.max(axis=0) - m.vertices.min(axis=0)
            print(f"{os.path.basename(p):20s} {len(m.faces):7d} faces  extents "
                  f"{[round(float(v), 2) for v in ext]}")
        except Exception as exc:
            print(f"{os.path.basename(p):20s} FAILED: {exc}")
