"""sw_agent.tools.topology — 面/边索引读回与按索引选择（P123）。

## 为什么

P37/P39/P40/P42（切除方向四轮）、P45/P49/P67/P82/P83/P85/P86/P92/P99（选边十轮）
的共同根因：模型只能用「vertical / top / 坐标」这类描述去猜几何，工具再用启发式去
匹配。三家对标项目全部用同一种解法——**先把面/边列成带索引的表给模型看，再按索引
选**（SolidPilot analyze_model(faces|edges) + get_selection；just1step ListEntities +
SelectEntity）。这里是 Millwright 的版本。

## 索引约定
`i` = GetBodies2(swSolidBody, visible) → 每个 body 的 GetFaces() / GetEdges() 的扁平顺序。
一次重建内稳定；重建后可能改变，所以**列表和选择应在同一轮里完成**。每项还带
`fp`（几何指纹：包围盒 6dp），get_selection 用它把用户点选映射回索引，且不依赖
COM 引用相等（IsSame 在本机不可靠，P90/P94）。

## 单位
输出一律 mm / mm² / 度；`near` 输入 mm。
"""
from __future__ import annotations

import math

from sw_agent import typeinfo
from sw_agent.bridge import (
    DOC_ASSEMBLY,
    DOC_PART,
    Context,
    SWError,
    edge_fingerprint,
    face_fingerprint,
    sw_get,
)
from sw_agent.registry import tool

_MM = 1000.0


def _mm3(p):
    return [round(float(v) * _MM, 3) for v in p[:3]]


def _vec(p):
    return [round(float(v), 6) for v in p[:3]]


def _norm(v):
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def _apply_xform(xf, p):
    """IMathTransform.ArrayData → p' = p·R·scale + t（行向量约定）。xf None → 原样。"""
    if not xf:
        return p
    d = [float(v) for v in xf]
    s = d[12] if len(d) > 12 and d[12] else 1.0
    x, y, z = p
    return [
        (x * d[0] + y * d[3] + z * d[6]) * s + d[9],
        (x * d[1] + y * d[4] + z * d[7]) * s + d[10],
        (x * d[2] + y * d[5] + z * d[8]) * s + d[11],
    ]


def _rot_xform(xf, v):
    if not xf:
        return v
    d = [float(q) for q in xf]
    x, y, z = v
    return [x * d[0] + y * d[3] + z * d[6], x * d[1] + y * d[4] + z * d[7], x * d[2] + y * d[5] + z * d[8]]


# ---- enumeration ----

def _bodies(ctx: Context, component: str = ""):
    """(bodies, transform) — part: all visible solid bodies; assembly: one component's body."""
    m = ctx.model
    dt = sw_get(m, "GetType")
    if dt == DOC_PART:
        return ctx.solid_bodies(), None
    if dt == DOC_ASSEMBLY:
        if not component:
            raise SWError("in an assembly give component= (name from list_components) to enumerate its topology.")
        comp = None
        for c in (m.GetComponents(True) or []):
            if sw_get(c, "Name2") == component:
                comp = c
                break
        if comp is None:
            raise SWError(f"component not found: {component}")
        typeinfo.flag_methods(comp, "IComponent2")
        xf = None
        try:
            xf = comp.Transform2.ArrayData
        except Exception:  # noqa: BLE001
            pass
        body = sw_get(comp, "GetBody")
        if body is None:
            bodies = sw_get(comp, "GetBodies3", 0, None) if hasattr(comp, "GetBodies3") else None
            bodies = list(bodies or [])
        else:
            bodies = [body]
        if not bodies:
            raise SWError(f"component {component} exposes no solid body (lightweight? suppressed?)")
        return bodies, xf
    raise SWError("topology tools need a part or assembly document.")


def enumerate_faces(ctx: Context, component: str = ""):
    bodies, xf = _bodies(ctx, component)
    out = []
    for b in bodies:
        for f in (sw_get(b, "GetFaces") or []):
            typeinfo.flag_members(f, "GetEdges", "GetLoops", "GetSurface", "GetBox", "GetArea")
            out.append(f)
    return out, xf


def enumerate_edges(ctx: Context, component: str = ""):
    bodies, xf = _bodies(ctx, component)
    out = []
    for b in bodies:
        for e in (sw_get(b, "GetEdges") or []):
            typeinfo.flag_members(e, "GetCurve", "GetCurveParams2", "GetTwoAdjacentFaces2", "GetCurveBox",
                                  "GetStartVertex", "GetEndVertex")
            out.append(e)
    return out, xf


# ---- geometry readers ----

def face_json(face, i: int, xf=None) -> dict:
    j: dict = {"i": i, "kind": "other"}
    try:
        surf = sw_get(face, "GetSurface")
        if sw_get(surf, "IsPlane"):
            j["kind"] = "planar"
        elif sw_get(surf, "IsCylinder"):
            j["kind"] = "cylindrical"
            try:
                cp = surf.CylinderParams  # origin(3), axis(3), radius
                j["axis"] = _vec(_norm(_rot_xform(xf, [float(v) for v in cp[3:6]])))
                j["radius_mm"] = round(float(cp[6]) * _MM, 3)
            except Exception:  # noqa: BLE001
                pass
        elif sw_get(surf, "IsCone"):
            j["kind"] = "conical"
        elif sw_get(surf, "IsSphere"):
            j["kind"] = "spherical"
    except Exception:  # noqa: BLE001
        pass
    try:
        j["area_mm2"] = round(float(sw_get(face, "GetArea")) * _MM * _MM, 3)
    except Exception:  # noqa: BLE001
        pass
    box = None
    try:
        box = [float(v) for v in sw_get(face, "GetBox")[:6]]
        lo, hi = _apply_xform(xf, box[:3]), _apply_xform(xf, box[3:6])
        j["box_mm"] = [round(min(lo[k], hi[k]) * _MM, 3) for k in range(3)] + \
                      [round(max(lo[k], hi[k]) * _MM, 3) for k in range(3)]
        c = [(box[k] + box[k + 3]) / 2 for k in range(3)]
    except Exception:  # noqa: BLE001
        c = None
    if j["kind"] == "planar":
        n = None
        try:
            n = [float(v) for v in face.Normal[:3]]
        except Exception:  # noqa: BLE001
            pass
        if n:
            j["normal"] = _vec(_norm(_rot_xform(xf, n)))
            if c is not None:
                # project the box centre onto the plane → a point ON the face plane
                try:
                    pp = surf.PlaneParams  # normal(3), point(3)
                    p0 = [float(v) for v in pp[3:6]]
                    dist = sum(n[k] * (c[k] - p0[k]) for k in range(3))
                    c = [c[k] - n[k] * dist for k in range(3)]
                except Exception:  # noqa: BLE001
                    pass
    if c is not None:
        j["center_mm"] = _mm3(_apply_xform(xf, c))
    j["fp"] = _fp_str(face_fingerprint(face))
    return j


def edge_json(edge, i: int, xf=None) -> dict:
    j: dict = {"i": i, "kind": "other"}
    try:
        curve = sw_get(edge, "GetCurve")
        typeinfo.flag_members(curve, "IsLine", "IsCircle", "IsEllipse", "Evaluate2", "GetLength3")
        params = [float(v) for v in sw_get(edge, "GetCurveParams2")]
        start, end = params[0:3], params[3:6]
        t0, t1 = params[6], params[7]
        j["start_mm"] = _mm3(_apply_xform(xf, start))
        j["end_mm"] = _mm3(_apply_xform(xf, end))
        try:
            mid = [float(v) for v in curve.Evaluate2((t0 + t1) / 2, 0)[:3]]
            j["mid_mm"] = _mm3(_apply_xform(xf, mid))
        except Exception:  # noqa: BLE001
            j["mid_mm"] = _mm3(_apply_xform(xf, [(start[k] + end[k]) / 2 for k in range(3)]))
        try:
            j["length_mm"] = round(float(curve.GetLength3(t0, t1)) * _MM, 3)
        except Exception:  # noqa: BLE001
            pass
        if sw_get(curve, "IsLine"):
            j["kind"] = "line"
            d = [end[k] - start[k] for k in range(3)]
            j["direction"] = _vec(_norm(_rot_xform(xf, d)))
        elif sw_get(curve, "IsCircle"):
            j["kind"] = "circle" if all(abs(start[k] - end[k]) < 1e-9 for k in range(3)) else "arc"
            cp = curve.CircleParams  # center(3), axis(3), radius
            j["center_mm"] = _mm3(_apply_xform(xf, [float(v) for v in cp[0:3]]))
            j["axis"] = _vec(_norm(_rot_xform(xf, [float(v) for v in cp[3:6]])))
            j["radius_mm"] = round(float(cp[6]) * _MM, 3)
        elif sw_get(curve, "IsEllipse"):
            j["kind"] = "ellipse"
    except Exception as e:  # noqa: BLE001
        j["error"] = str(e)[:80]
    j["fp"] = _fp_str(edge_fingerprint(edge))
    return j


def _fp_str(fp) -> str:
    return ",".join(str(v) for v in (fp[1] if fp and len(fp) > 1 and isinstance(fp[1], tuple) else fp))


def _filter(items: list, near, k: int, axis, kind: str, dir_key: str):
    """SolidPilot-style narrowing: nearest-k to a point, direction ~parallel to axis, kind."""
    if kind:
        items = [j for j in items if j.get("kind") == kind]
    if axis:
        a = _norm([float(v) for v in axis])
        keep = []
        for j in items:
            d = j.get(dir_key)
            if d is None:
                continue
            if abs(sum(a[q] * d[q] for q in range(3))) > 0.95:
                keep.append(j)
        items = keep
    if near:
        p = [float(v) for v in near]
        for j in items:
            c = j.get("mid_mm") or j.get("center_mm")
            j["dist_mm"] = round(math.dist(p, c), 3) if c else None
        items = sorted(items, key=lambda j: (j["dist_mm"] is None, j["dist_mm"] or 0))
    if k and k > 0:
        items = items[:k]
    return items


# ---- tools ----

_NEAR = {"type": "array", "desc": "Optional [x,y,z] in mm: return entities nearest this point (with dist_mm)", "default": None}
_K = {"type": "integer", "desc": "Keep only the k nearest / first k (0 = all)", "default": 0}
_AXIS = {"type": "array", "desc": "Optional [x,y,z] direction filter (~parallel)", "default": None}
_COMP = {"type": "string", "desc": "Assembly only: component name (from list_components)", "default": ""}


@tool(
    "list_faces",
    "List every face of the solid with a stable index i, kind (planar/cylindrical/...), normal, center_mm, area_mm2. "
    "Use the index with sketch_on_face / select_entities instead of guessing coordinates.",
    params={"near": _NEAR, "k": _K, "axis": _AXIS,
            "kind": {"type": "string", "desc": "planar | cylindrical | conical | spherical | other", "default": ""},
            "component": _COMP},
    category="query",
)
def list_faces(ctx: Context, near=None, k: int = 0, axis=None, kind: str = "", component: str = ""):
    ctx.ensure_tessellated()
    faces, xf = enumerate_faces(ctx, component)
    items = [face_json(f, i, xf) for i, f in enumerate(faces)]
    total = len(items)
    items = _filter(items, near, k, axis, kind, "normal")
    return {"face_count": total, "returned": len(items), "faces": items}


@tool(
    "list_edges",
    "List every edge of the solid with a stable index i, kind (line/circle/arc), start/end/mid_mm, length_mm, "
    "direction or axis+radius. Use the index with select_entities then fillet_edges(edges='selected') / chamfer.",
    params={"near": _NEAR, "k": _K, "axis": _AXIS,
            "kind": {"type": "string", "desc": "line | circle | arc | ellipse | other", "default": ""},
            "component": _COMP},
    category="query",
)
def list_edges(ctx: Context, near=None, k: int = 0, axis=None, kind: str = "", component: str = ""):
    ctx.ensure_tessellated()
    edges, xf = enumerate_edges(ctx, component)
    items = [edge_json(e, i, xf) for i, e in enumerate(edges)]
    total = len(items)
    items = _filter(items, near, k, axis, kind, "direction")
    return {"edge_count": total, "returned": len(items), "edges": items}


@tool(
    "get_selection",
    "Report what the USER has selected in the SolidWorks window, mapped to the same face/edge indices "
    "list_faces/list_edges use. Call BEFORE any tool that clears the selection. Read-only.",
    params={"component": _COMP},
    category="query",
)
def get_selection(ctx: Context, component: str = ""):
    sel = ctx.sel_mgr
    count = int(sw_get(sel, "GetSelectedObjectCount2", -1))
    faces = edges = None
    out = []
    for s in range(1, count + 1):
        try:
            t = int(sw_get(sel, "GetSelectedObjectType3", s, -1))
        except Exception:  # noqa: BLE001
            t = -1
        obj = sw_get(sel, "GetSelectedObject6", s, -1)
        item: dict
        if t == 2 and obj is not None:  # swSelFACES
            if faces is None:
                try:
                    faces, xf = enumerate_faces(ctx, component)
                    faces = [(face_fingerprint(f), i, f) for i, f in enumerate(faces)]
                except SWError:
                    faces, xf = [], None
            fp = face_fingerprint(obj)
            idx = next((i for f, i, _ in faces if f == fp), -1)
            item = face_json(obj, idx, xf if faces else None)
            item["type"] = "face"
        elif t == 1 and obj is not None:  # swSelEDGES
            if edges is None:
                try:
                    edges, xf = enumerate_edges(ctx, component)
                    edges = [(edge_fingerprint(e), i, e) for i, e in enumerate(edges)]
                except SWError:
                    edges, xf = [], None
            fp = edge_fingerprint(obj)
            idx = next((i for f, i, _ in edges if f == fp), -1)
            item = edge_json(obj, idx, xf if edges else None)
            item["type"] = "edge"
        elif t == 3 and obj is not None:  # swSelVERTICES
            item = {"type": "vertex"}
            try:
                item["point_mm"] = _mm3(sw_get(obj, "GetPoint"))
            except Exception:  # noqa: BLE001
                pass
        elif t == 4:  # swSelDATUMPLANES
            item = {"type": "plane"}
            try:
                item["name"] = sw_get(obj, "Name")
            except Exception:  # noqa: BLE001
                pass
        elif t == 20 or t == 21:  # swSelCOMPONENTS
            item = {"type": "component"}
            try:
                item["name"] = sw_get(obj, "Name2")
            except Exception:  # noqa: BLE001
                pass
        else:
            item = {"type": "other", "sw_type": t}
            try:
                item["name"] = sw_get(obj, "Name")
            except Exception:  # noqa: BLE001
                pass
        out.append(item)
    return {"selected_count": count, "selection": out}


def _select_indexed(ctx: Context, items, indices, append: bool, mark: int, label: str) -> int:
    n = 0
    for idx in indices:
        try:
            idx = int(idx)
        except (TypeError, ValueError):
            raise SWError(f"{label} index must be an integer, got {idx!r}")
        if idx < 0 or idx >= len(items):
            raise SWError(f"{label} index {idx} out of range 0..{len(items) - 1} (re-run list_{label}s)")
        if ctx._select_entity(items[idx], append or n > 0, mark):
            n += 1
        else:
            raise SWError(f"SolidWorks refused to select {label} #{idx}")
    return n


@tool(
    "select_entities",
    "Select faces and/or edges by index (from list_faces / list_edges). Replaces the current selection unless "
    "append=true. Then call fillet_edges(edges='selected'), chamfer, add_mate, measure_selection, ...",
    params={
        "faces": {"type": "array", "desc": "Face indices", "default": []},
        "edges": {"type": "array", "desc": "Edge indices", "default": []},
        "append": {"type": "boolean", "desc": "Keep the existing selection", "default": False},
        "mark": {"type": "integer", "desc": "Selection mark (0 unless a feature API needs one)", "default": 0},
        "component": _COMP,
    },
    category="query",
)
def select_entities(ctx: Context, faces=None, edges=None, append: bool = False, mark: int = 0, component: str = ""):
    faces, edges = list(faces or []), list(edges or [])
    if not faces and not edges:
        raise SWError("give faces=[...] and/or edges=[...] indices.")
    ctx.ensure_tessellated()
    if not append:
        ctx.clear_selection()
    n = 0
    if faces:
        fl, _ = enumerate_faces(ctx, component)
        n += _select_indexed(ctx, fl, faces, append, mark, "face")
    if edges:
        el, _ = enumerate_edges(ctx, component)
        n += _select_indexed(ctx, el, edges, append or n > 0, mark, "edge")
    got = ctx.selected_count()
    if got < n:
        raise SWError(f"asked for {n} entities but SolidWorks reports {got} selected")
    return {"selected": got, "faces": faces, "edges": edges}


@tool(
    "sketch_on_face",
    "Start a sketch ON a planar face chosen by index (from list_faces). The reliable alternative to "
    "start_sketch(face=top/...) when the part is not a simple box. Exits any active sketch first.",
    params={"face_index": {"type": "integer", "desc": "Planar face index from list_faces"}},
    category="sketch",
)
def sketch_on_face(ctx: Context, face_index: int):
    ctx.require(DOC_PART, "part")
    ctx.ensure_tessellated()
    sm = ctx.sketch_mgr
    if sm.ActiveSketch is not None:
        sm.InsertSketch(True)  # toggles out of the active sketch
    faces, _ = enumerate_faces(ctx)
    if face_index < 0 or face_index >= len(faces):
        raise SWError(f"face index {face_index} out of range 0..{len(faces) - 1}")
    fj = face_json(faces[face_index], face_index)
    if fj.get("kind") != "planar":
        raise SWError(f"face #{face_index} is {fj.get('kind')} — sketches need a planar face")
    ctx.clear_selection()
    if not ctx._select_entity(faces[face_index], False, 0):
        raise SWError(f"could not select face #{face_index}")
    sm.InsertSketch(True)
    if sm.ActiveSketch is None:
        raise SWError("InsertSketch did not open a sketch on that face")
    try:
        name = sw_get(sm.ActiveSketch, "Name")
    except Exception:  # noqa: BLE001
        name = None
    ctx.scratch["last_sketch"] = name
    return {"sketch": name, "face": fj}
