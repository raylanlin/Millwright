"""sw_agent.tools.view — view control + screenshot (the basis of visual understanding).

Lets the agent act like a human operator: orient to a standard view, rotate,
zoom, switch display modes, then capture a screenshot of the current state.
These are the "hands" and "eyes" of the visual analysis loop.
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
_VIEW_ALIAS = {"iso": "isometric", "front": "front", "isometric": "isometric", "top": "top"}


@tool(
    "set_view_orientation",
    "Switch the view to a standard orientation (front/back/left/right/top/bottom/isometric) for inspection or screenshot.",
    params={"orientation": {"type": "string", "desc": "Orientation",
                           "enum": ["front", "back", "left", "right", "top", "bottom",
                                    "isometric", "trimetric", "dimetric"]}},
    category="view",
)
def set_view_orientation(ctx: Context, orientation: str):
    key = _VIEW_ALIAS.get(orientation, orientation).lower()
    if key not in _VIEWS:
        raise SWError(f"unknown orientation: {orientation}")
    model = ctx.model
    # ShowNamedView2(name, ID); using the standard IDs is the most stable approach
    model.ShowNamedView2("", _VIEWS[key])
    model.ViewZoomtofit2()
    return {"orientation": key}


@tool(
    "rotate_view",
    "Incrementally rotate the view (in degrees) from the current viewpoint. Useful for inspecting the part from another angle.",
    params={
        "yaw_deg": {"type": "number", "desc": "Yaw around the vertical axis (degrees)", "default": 30},
        "pitch_deg": {"type": "number", "desc": "Pitch around the horizontal axis (degrees)", "default": 0},
    },
    category="view",
)
def rotate_view(ctx: Context, yaw_deg: float = 30, pitch_deg: float = 0):
    view = ctx.model.ActiveView
    if view is None:
        raise SWError("no active view")
    # IModelView.RotateAboutCenter(longitudeRad, latitudeRad)
    view.RotateAboutCenter(units.deg(yaw_deg), units.deg(pitch_deg))
    return {"yaw_deg": yaw_deg, "pitch_deg": pitch_deg}


@tool(
    "zoom_to_fit",
    "Zoom so that the entire model fills the view.",
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
    # Whether to show edges in shaded mode: swViewDisplayMode_e can be tweaked via ActiveView; swallow errors here
    try:
        model.ActiveView.DisplayMode = 3 if on else 2  # 3=ShadedWithEdges, 2=Shaded
    except Exception:  # noqa: BLE001
        pass


@tool(
    "set_display_mode",
    "Switch the display mode: shaded with edges / shaded / wireframe / hidden lines removed / hidden lines visible.",
    params={"mode": {"type": "string", "enum": list(_DISPLAY.keys()),
                     "desc": "Display mode", "default": "shaded_edges"}},
    category="view",
)
def set_display_mode(ctx: Context, mode: str = "shaded_edges"):
    fn = _DISPLAY.get(mode)
    if fn is None:
        raise SWError(f"unknown display mode: {mode}")
    fn(ctx.model)
    return {"mode": mode}


@tool(
    "capture_view",
    "Capture the current SolidWorks view as an image and return the path for multimodal visual analysis."
    "Combine with set_view_orientation / rotate_view to inspect the part from multiple angles.",
    params={
        "width": {"type": "number", "desc": "Width in pixels", "default": 1280},
        "height": {"type": "number", "desc": "Height in pixels", "default": 960},
        "fit": {"type": "boolean", "desc": "Zoom to fit before capturing", "default": True},
    },
    category="vision",
    internal=True,  # Plumbing tool: invoked internally by Node's analyze_view, not exposed to the main model
)
def capture_view(ctx: Context, width: int = 1280, height: int = 960, fit: bool = True):
    model = ctx.model
    if fit:
        model.ViewZoomtofit2()
    bmp = os.path.join(tempfile.gettempdir(), f"swcp_view_{os.getpid()}.bmp")
    ok = model.SaveBMP(bmp, int(width), int(height))
    if not ok or not os.path.exists(bmp):
        raise SWError("screenshot failed: SaveBMP did not produce a file.")
    # Prefer PNG (smaller, more universal for multimodal); fall back to BMP if PIL is unavailable — Node side uses nativeImage as a fallback
    out, fmt = bmp, "bmp"
    try:
        from PIL import Image  # noqa
        png = bmp[:-4] + ".png"
        Image.open(bmp).save(png, "PNG")
        out, fmt = png, "png"
    except Exception:  # noqa: BLE001
        pass
    return {"image_path": out, "format": fmt, "width": int(width), "height": int(height)}
