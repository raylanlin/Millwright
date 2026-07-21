"""sw_agent.tools.view —— 视图控制 + 截屏（视觉理解的基础）。

让 agent 能像人一样：转到某个方位 / 旋转 / 缩放 / 切换显示模式，然后截屏观察当前状态。
这些是视觉分析闭环的“手”和“眼”。
"""
from __future__ import annotations
import os
import tempfile

from ..registry import tool
from ..bridge import Context, SWError
from .. import units

# swStandardViews_e
_VIEWS = {
    "front": 1, "back": 2, "left": 3, "right": 4, "top": 5, "bottom": 6,
    "isometric": 7, "trimetric": 8, "dimetric": 9,
}
_VIEW_ALIAS = {"iso": "isometric", "前视": "front", "等轴测": "isometric", "上视": "top"}


@tool(
    "set_view_orientation",
    "把视图切到标准方位（前/后/左/右/上/下/等轴测），便于观察或截屏。",
    params={"orientation": {"type": "string", "desc": "方位",
                           "enum": ["front", "back", "left", "right", "top", "bottom",
                                    "isometric", "trimetric", "dimetric"]}},
    category="view",
)
def set_view_orientation(ctx: Context, orientation: str):
    key = _VIEW_ALIAS.get(orientation, orientation).lower()
    if key not in _VIEWS:
        raise SWError(f"未知方位：{orientation}")
    model = ctx.model
    # ShowNamedView2(名称, ID)；用标准 ID 最稳
    model.ShowNamedView2("", _VIEWS[key])
    model.ViewZoomtofit2()
    return {"orientation": key}


@tool(
    "rotate_view",
    "以当前视角为基准增量旋转视图（度）。用于从别的角度观察零件。",
    params={
        "yaw_deg": {"type": "number", "desc": "绕竖直轴左右旋转(度)", "default": 30},
        "pitch_deg": {"type": "number", "desc": "绕水平轴上下旋转(度)", "default": 0},
    },
    category="view",
)
def rotate_view(ctx: Context, yaw_deg: float = 30, pitch_deg: float = 0):
    view = ctx.model.ActiveView
    if view is None:
        raise SWError("没有活动视图")
    # IModelView.RotateAboutCenter(longitudeRad, latitudeRad)
    view.RotateAboutCenter(units.deg(yaw_deg), units.deg(pitch_deg))
    return {"yaw_deg": yaw_deg, "pitch_deg": pitch_deg}


@tool(
    "zoom_to_fit",
    "缩放使整个模型充满视图。",
    params={},
    category="view",
)
def zoom_to_fit(ctx: Context):
    ctx.model.ViewZoomtofit2()
    return {"zoomed": True}


_DISPLAY = {
    "shaded_edges": lambda m: (m.ViewDisplayShaded(), _edges(m, True)),
    "shaded": lambda m: (m.ViewDisplayShaded(), _edges(m, False)),
    "wireframe": lambda m: m.ViewDisplayWireframe(),
    "hidden_removed": lambda m: m.ViewDisplayHideHiddenLines(),
    "hidden_visible": lambda m: m.ViewDisplayShowHiddenLines(),
}


def _edges(model, on: bool):
    # 上色模式下是否显示边线：swViewDisplayMode_e 通过 ActiveView 可调；此处尽量不报错
    try:
        model.ActiveView.DisplayMode = 3 if on else 2  # 3=ShadedWithEdges, 2=Shaded
    except Exception:  # noqa: BLE001
        pass


@tool(
    "set_display_mode",
    "切换显示模式：带边上色/上色/线框/消隐/可见隐藏线。",
    params={"mode": {"type": "string", "enum": list(_DISPLAY.keys()),
                     "desc": "显示模式", "default": "shaded_edges"}},
    category="view",
)
def set_display_mode(ctx: Context, mode: str = "shaded_edges"):
    fn = _DISPLAY.get(mode)
    if fn is None:
        raise SWError(f"未知显示模式：{mode}")
    fn(ctx.model)
    return {"mode": mode}


@tool(
    "capture_view",
    "截取当前 SolidWorks 视图为图像并返回路径，供你（多模态）做视觉分析。"
    "配合 set_view_orientation / rotate_view 可从多个角度观察零件。",
    params={
        "width": {"type": "number", "desc": "像素宽", "default": 1280},
        "height": {"type": "number", "desc": "像素高", "default": 960},
        "fit": {"type": "boolean", "desc": "截屏前先缩放充满", "default": True},
    },
    category="vision",
    internal=True,  # 机制类：由 Node 的 analyze_view 内部调用，不直接暴露给主模型
)
def capture_view(ctx: Context, width: int = 1280, height: int = 960, fit: bool = True):
    model = ctx.model
    if fit:
        model.ViewZoomtofit2()
    bmp = os.path.join(tempfile.gettempdir(), f"swcp_view_{os.getpid()}.bmp")
    ok = model.SaveBMP(bmp, int(width), int(height))
    if not ok or not os.path.exists(bmp):
        raise SWError("截屏失败：SaveBMP 未生成文件。")
    # 尽量转 PNG（体积更小、多模态更通用）；无 PIL 则回退 BMP，Node 侧用 nativeImage 兜底
    out, fmt = bmp, "bmp"
    try:
        from PIL import Image  # noqa
        png = bmp[:-4] + ".png"
        Image.open(bmp).save(png, "PNG")
        out, fmt = png, "png"
    except Exception:  # noqa: BLE001
        pass
    return {"image_path": out, "format": fmt, "width": int(width), "height": int(height)}
