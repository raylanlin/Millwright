"""sw_agent.guidance —— 按需读取的规则段（P99）。

问题：AGENT_SYSTEM_PROMPT 里塞了大量静态规则（工具用法、建模要点、宏细则），
每轮对话都要付这几百 token，哪怕本轮根本用不到圆角规则。

做法：长段规则从 prompts.ts 移到这里，模型需要时调 read_guidance(section)
按段读取。prompts.ts 只留一行索引（每段一句话），"工具描述每轮必付、
规则正文用到才读" —— 和 SolidPilot 把近静态规则放 resource 侧是同一个
思路（他们的原话：a tool's description is paid on every single turn whether
or not it is used, while a resource body costs only when read）。

段与段独立，按需读取，读完即用，不要求模型记住。
"""
from __future__ import annotations

GUIDANCE: dict[str, str] = {
    "tools": r"""## Tool usage notes (avoiding the pitfalls that failed repeatedly in the previous version)
- **Always use \`sketch_polyline\` for closed profiles** (e.g. \`"30,15 30,50 55,15"\`). Endpoints of separate \`sketch_line\` calls are not auto-welded; if the profile is not closed, extrusion fails.
- **Use real arcs, not short straight segments.** \`sketch_polyline\` points can carry arcs: the \`r<radius>:\` prefix means "go from the previous point to this point along an arc", e.g. \`"0,0 60,0 r10:60,20 0,20"\` (three straight edges + one R10 arc). A positive radius bulges to the right of travel, a negative one to the left; the minor arc is always taken. A polyline fit of an arc is neither a true cylindrical face nor editable.
- **For corner radii of a constant cross-section outline, prefer \`sketch_rounded_rectangle\` or \`sketch_fillet\` inside the sketch**: round the four corners of a rectangular plate with \`sketch_rounded_rectangle(width, height, radius)\` — the tool computes the tangent points and the size is exact; sketch fillets carry dimensions and stay editable. Keep \`fillet_edges\` for true 3D edges (top-face edges of a formed solid, intersection lines, etc.).
- When \`fillet_edges\` fails, report it honestly; do not retry repeatedly. You can also ask the user to select the edges in SolidWorks and use \`edges="selected"\` — more reliable than letting the tool guess which edges.
- **Say exactly which edges to fillet**: \`fillet_edges(radius=10, edges="vertical")\`. vertical = the four corner uprights / horizontal / circular / all / top / bottom / selected. For a cylinder's top rim use \`edges="top"\` (rim of the top cap only); do not use circular (it would fillet the bottom rim too).
- ⚠️ **\`circular\` selects every circular edge in the whole document** (hole edges, cylinder top/bottom rims, existing fillet edges all count) — batch-filleting complex parts this way fails easily. To fillet "a feature's own edges" (e.g. a cylinder's top rim), name the feature: the tool picks edges by the most recent feature (feature strategy). You can also ask the user to manually select the target edges in SolidWorks and use \`edges="selected"\` (the tool verifies the selection really is edges; selections mixed with faces/features are rejected).
- **Use \`sketch_slot\` for obround/keyway slots** (both ends are true half-arcs); do not build them from a rectangle plus two circles.
- **Give the feature name for patterns**: \`linear_pattern(feature="Cut-Extrude1", direction="x", count=2, spacing=90)\`; circular patterns take \`feature\` the same way. Look up feature names with \`list_features\`.
- **Give the feature name for mirroring**: \`mirror_feature(plane="front", features="Boss-Extrude3")\`.
- **Start sketches on model faces**: \`start_sketch(face="top")\`.
- If a tool fails twice, change approach or ask the user — **do not delete and redraw**: every delete/edit round leaves junk in the feature tree and makes things messier.""",

    "modeling": r"""## Modeling notes (following real SolidWorks workflow)
- Make holes with \`cut_extrude\`; pass \`through_all: true\` for through holes. **Do not use revolve for holes** — a revolve adds material and grows a boss.
- The cut direction is auto-detected (tries the given direction, then reversed, then both ways); **do not switch modeling approaches because of a single failure** — the usual real cause is the sketch profile not overlapping the solid (wrong position/plane), not the direction.
- **To continue building features on the model, start the sketch directly on a face**: \`start_sketch(face="top")\` (also bottom/front/back/left/right), like clicking that face in SolidWorks. **Do not create a new reference plane for this** — it fills the part with "PlaneN" junk and makes height calculations error-prone.
- Use \`plane=\` only for the first sketch, or when you genuinely need an offset plane (create it with \`create_plane\` and use it immediately).
- If the extrusion direction is wrong, pass \`flip: true\` to \`extrude\`; for a symmetric two-side extrusion pass \`both_dir: true\`.
- If a tool fails twice in a row, stop and ask the user; do not chain through alternatives — every failure leaves a wasted sketch behind, and things only get messier.""",

    "macro": r"""## \`run_macro\`: an escape hatch, not the main path
Use it only when the **built-in tools cannot cover the task** (complex sweep/loft surfaces, equation-driven curves, batch edits across many features). For regular modeling, the tools are strictly better — they convert units for you, probe how many API arguments this local install accepts, pick faces/edges by semantics, and report real errors.

Three rules when writing a macro (the static check rejects violations otherwise):
1. **Lengths are in meters**: 40mm must be written \`0.04\` or \`40/1000\`. Writing \`40\` means 40 meters — the macro "succeeds" but the geometry is completely wrong.
2. **No \`On Error Resume Next\`**: it silently lets every later step fail, so the macro reports success while doing nothing.
3. **Do not invent face/edge names** (like \`"Axis-1@Assembly1/CylindricalFace"\`): \`SelectByID2\` returns False and later calls spin idly. Get real names from \`list_features\` / \`list_components\`.""",

    "drawing": r"""## Drawings (the final delivery step)
The model being done is not the job being done. \`create_drawing_of\` generates the three standard views plus an isometric in one call; \`insert_model_dimensions\` pulls the model's own dimensions straight onto the views (the fastest way to dimension); for assembly drawings use \`insert_bom\` to add the bill of materials. View positions are in drawing mm.""",

    "generators": r"""## Standard mechanical parts: use the generators, do not draw by hand
The geometry of these parts is **mathematically defined**; drawing them by hand always fails:
- **Gear** → \`create_spur_gear(module, teeth, thickness, bore)\`. An involute tooth profile is a specific curve; a hand-drawn "trapezoidal/rectangular slots around the circumference" cannot mesh — that is scrap, not a gear. **When this tool fails, report the failure honestly and give the user the original error text; do not fall back to rectangular tooth slots** — a "gear" that cannot mesh is worse than no gear, because the user will assume it works. For a gearbox, **call \`gear_pair_geometry\` first** to get the center distance — the two shaft holes must be placed exactly at that distance or the gears will not mesh.
- **Stepped shaft** → \`create_stepped_shaft(steps="20x30 30x50 25x40")\`. Give all steps in one call — far more reliable than extruding segment by segment (each segment needs its own offset plane, and shoulders easily misalign).""",

    "assembly": r"""## Assemblies
- Build each part with one \`build_part\` call and save it with \`save_as\`, then create a new assembly and \`insert_component\` each one. **Do not pile an entire machine into a single part document.**
- Inserted components are placed at the origin by default; pass x/y/z (assembly coordinates, mm) when precise positioning is needed.
- Before mating (\`add_mate\`), you must select two entities first (face/edge/vertex/axis). Mate types: coincident / concentric / perpendicular / parallel / tangent / distance / angle.
- Alignment defaults to \`closest\` (let SolidWorks pick the sensible side — the UI default behavior); pass \`aligned\` / \`anti_aligned\` only when you need an explicit same/opposite direction.""",
}


def read_guidance_section(section: str) -> str | None:
    """Return the rule text for a section, or None if unknown."""
    return GUIDANCE.get(section)
