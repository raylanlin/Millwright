"""sw_agent.tools.export — export.

Most formats (STEP/IGES/PDF/DXF/Parasolid…) go through document.save_as with the right
extension. STL is separate because its resolution is a user preference that has to be set
before saving.
"""
from __future__ import annotations

import os

from sw_agent.bridge import Context, SWError
from sw_agent.registry import tool

# swUserPreferenceIntegerValue_e.swExportStlQuality. P77: this used to carry a "# VERIFY"
# note, and setting it was on the critical path — a wrong constant on some release would
# have failed the whole export over a resolution setting. Now the preference is
# best-effort and the export proceeds regardless: producing an STL at the default
# resolution beats producing nothing.
_PREF_STL_QUALITY = 334


@tool(
    "export_stl", "Export STL at coarse or fine resolution (SetUserPreferenceIntegerValue + SaveAs)",
    params={
        "path": {"type": "string", "desc": "Absolute path to the target .stl file"},
        "quality": {"type": "string", "enum": ["coarse", "fine"], "desc": "Mesh resolution", "default": "fine"},
    },
    category="export",
)
def export_stl(ctx: Context, path: str, quality: str = "fine"):
    quality_set = True
    try:
        ctx.sw.SetUserPreferenceIntegerValue(_PREF_STL_QUALITY, 1 if quality == "fine" else 0)
    except Exception:  # noqa: BLE001 — resolution is a nicety; the file matters
        quality_set = False

    parent = os.path.dirname(path)
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    if not path.lower().endswith(".stl"):
        raise SWError(f"export_stl needs a .stl path, got: {path}")
    if not ctx.model.SaveAs(path) or not os.path.exists(path):
        raise SWError(f"STL export failed: {path}")
    out = {"exported": path, "quality": quality}
    if not quality_set:
        out["note"] = "the resolution preference could not be set on this SolidWorks; " \
                      "the STL was written at the current default"
    return out


@tool(
    "export_file", "Export by extension (step/stp/iges/igs/pdf/dxf/x_t/parasolid…)",
    params={"path": {"type": "string", "desc": "Absolute target path (including extension)"}},
    category="export",
)
def export_file(ctx: Context, path: str):
    parent = os.path.dirname(path)
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    if not os.path.splitext(path)[1]:
        raise SWError(f"the target path needs a file extension so SolidWorks knows the format: {path}")
    if not ctx.model.SaveAs(path) or not os.path.exists(path):
        raise SWError(f"export failed: {path}")
    return {"exported": path}
