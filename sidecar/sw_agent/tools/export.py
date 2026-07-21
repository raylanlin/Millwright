"""sw_agent.tools.export — export.

Most formats (STEP/IGES/PDF/DXF/Parasolid…) can be handled by document.save_as
with the appropriate extension. STL is split out into its own tool because
it needs a quality preference set first.
"""
from __future__ import annotations
import os

from ..registry import tool
from ..bridge import Context, SWError

# swUserPreferenceIntegerValue_e: STL quality preference
# VERIFY: verify the constant value (334 here) against the target SolidWorks version via macro recorder; coarse=0, fine=1
_PREF_STL_QUALITY = 334


@tool(
    "export_stl", "Export STL (with optional quality)",
    params={
        "path": {"type": "string", "desc": "Absolute path to the target .stl file"},
        "quality": {"type": "string", "enum": ["coarse", "fine"], "desc": "Quality level", "default": "fine"},
    },
    category="export",
)
def export_stl(ctx: Context, path: str, quality: str = "fine"):
    ctx.sw.SetUserPreferenceIntegerValue(_PREF_STL_QUALITY, 1 if quality == "fine" else 0)
    parent = os.path.dirname(path)
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    if not ctx.model.SaveAs(path) or not os.path.exists(path):
        raise SWError(f"STL export failed: {path}")
    return {"exported": path, "quality": quality}


@tool(
    "export_file", "Export by extension (step/stp/iges/igs/pdf/dxf/x_t/parasolid…)",
    params={"path": {"type": "string", "desc": "Absolute target path (including extension)"}},
    category="export",
)
def export_file(ctx: Context, path: str):
    parent = os.path.dirname(path)
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    if not ctx.model.SaveAs(path) or not os.path.exists(path):
        raise SWError(f"export failed: {path}")
    return {"exported": path}
