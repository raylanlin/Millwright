"""sw_agent.tools.export —— 导出。

多数格式（STEP/IGES/PDF/DXF/Parasolid…）直接用 document.save_as(按扩展名转换)即可。
这里单列 STL，因为要先设精细度偏好。
"""
from __future__ import annotations
import os

from ..registry import tool
from ..bridge import Context, SWError

# swUserPreferenceIntegerValue_e: STL 精细度偏好
# VERIFY: 常量值（此处 334）建议宏录制器核对目标版本；粗糙=0 精细=1
_PREF_STL_QUALITY = 334


@tool(
    "export_stl", "导出 STL（可选精细度）",
    params={
        "path": {"type": "string", "desc": "目标 .stl 绝对路径"},
        "quality": {"type": "string", "enum": ["coarse", "fine"], "desc": "精细度", "default": "fine"},
    },
    category="export",
)
def export_stl(ctx: Context, path: str, quality: str = "fine"):
    ctx.sw.SetUserPreferenceIntegerValue(_PREF_STL_QUALITY, 1 if quality == "fine" else 0)
    parent = os.path.dirname(path)
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    if not ctx.model.SaveAs(path) or not os.path.exists(path):
        raise SWError(f"STL 导出失败：{path}")
    return {"exported": path, "quality": quality}


@tool(
    "export_file", "按扩展名导出（step/stp/iges/igs/pdf/dxf/x_t/parasolid…）",
    params={"path": {"type": "string", "desc": "目标绝对路径（含扩展名）"}},
    category="export",
)
def export_file(ctx: Context, path: str):
    parent = os.path.dirname(path)
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    if not ctx.model.SaveAs(path) or not os.path.exists(path):
        raise SWError(f"导出失败：{path}")
    return {"exported": path}
