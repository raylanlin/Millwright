"""sw_agent.tools.workflows — 高频多步序列打包成一个工具（P126）。

对标 just1step WorkflowTools.CutFaceByProjectedEdges：选面 → 开草图 → 投影面的边
（SketchUseEdge3）→ 切除。四个单步里任何一步错（残留选择、草图没开在面上、
方向反）都会让 agent 多绕两轮；打包后一步到位，且沿用 cut_extrude 的 _verified。
"""
from __future__ import annotations

from sw_agent import registry
from sw_agent.bridge import DOC_PART, Context, SWError, sw_get
from sw_agent.registry import tool
from sw_agent.tools.topology import enumerate_faces, face_json


@tool(
    "cut_face_outline",
    "One-shot: sketch on a planar face (by index from list_faces), project that face's outline "
    "(optionally inner loops = holes/pockets) into the sketch, and cut-extrude by depth. "
    "Use for pockets/recesses that follow an existing face shape.",
    params={
        "face_index": {"type": "integer", "desc": "Planar face index from list_faces"},
        "depth": {"type": "number", "desc": "Cut depth (mm)"},
        "inner_loops": {"type": "boolean", "desc": "Also project inner loops (holes) so they stay uncut", "default": True},
        "flip": {"type": "boolean", "desc": "Reverse cut direction (into the solid is the default guess)", "default": False},
    },
    category="feature", destructive=True,
)
def cut_face_outline(ctx: Context, face_index: int, depth: float, inner_loops: bool = True, flip: bool = False):
    ctx.require(DOC_PART, "part")
    if depth <= 0:
        raise SWError("depth must be > 0 mm")
    ctx.ensure_tessellated()
    faces, _ = enumerate_faces(ctx)
    if face_index < 0 or face_index >= len(faces):
        raise SWError(f"face index {face_index} out of range 0..{len(faces) - 1}")
    face = faces[face_index]
    fj = face_json(face, face_index)
    if fj.get("kind") != "planar":
        raise SWError(f"face #{face_index} is {fj.get('kind')} — need a planar face")
    sm = ctx.sketch_mgr
    if sm.ActiveSketch is not None:
        sm.InsertSketch(True)
    ctx.clear_selection()
    if not ctx._select_entity(face, False, 0):
        raise SWError(f"could not select face #{face_index}")
    sm.InsertSketch(True)
    if sm.ActiveSketch is None:
        raise SWError("InsertSketch did not open a sketch on that face")
    # project the face outline: select the face's edges, then SketchUseEdge3(chain, innerLoops)
    edges = []
    for loop in (sw_get(face, "GetLoops") or []):
        try:
            outer = sw_get(loop, "IsOuter")
        except Exception:  # noqa: BLE001
            outer = True
        if outer or inner_loops:
            edges.extend(list(sw_get(loop, "GetEdges") or []))
    if not edges:
        edges = list(sw_get(face, "GetEdges") or [])
    if not edges:
        sm.InsertSketch(True)
        raise SWError("the face exposes no edges to project")
    ctx.clear_selection()
    n = sum(1 for i, e in enumerate(edges) if ctx._select_entity(e, i > 0, 0))
    if n == 0:
        sm.InsertSketch(True)
        raise SWError("could not select the face edges for projection")
    ok = sm.SketchUseEdge3(False, bool(inner_loops))
    segs = list(sw_get(sm.ActiveSketch, "GetSketchSegments") or [])
    if not segs:
        sm.InsertSketch(True)
        raise SWError(f"SketchUseEdge3 returned {ok!r} and produced no sketch segments")
    ctx.clear_selection()
    # cut_extrude works on the ACTIVE sketch (P32 manual-modeling order) and verifies itself
    result = registry.call(ctx, "cut_extrude", {"depth": depth, "flip": bool(flip)})
    out = {"face": fj, "projected_edges": n, "sketch_segments": len(segs), "cut": result}
    return out
