"""sw_agent.tools.drawing — engineering drawings: sheets, views, dimensions, BOM.

This whole category was missing, which meant the last step of any real job — turning
a finished model into a drawing someone can manufacture from — had no path at all.

Two things make drawing automation different from modelling and shape the design here:

1. **Views are placed on a sheet in sheet coordinates, in metres.** A view at
   (100, 200) means 100 m across the paper. Every position here is mm in, metres out.
2. **Model-to-drawing is a two-document dance.** The drawing must be the active
   document, and it references a model file BY PATH. An unsaved part cannot be
   drawn — so create_drawing_of saves the model first when it has never been saved,
   rather than failing with a COM error the model cannot interpret.

DimensionMgr / InsertModelAnnotations3 arities drift across releases, so both route
through com_call() adaptive-arity search (same helper as feature.py).
"""
from __future__ import annotations

import os

from sw_agent import units
from sw_agent.bridge import DOC_DRAWING, Context, SWError, sw_get
from sw_agent.registry import tool
from sw_agent.tools.feature import com_call

# swCreateDrawingViewOptions_e / standard view IDs (swStandardViews_e)
_VIEW_IDS = {
    "front": 1, "back": 2, "left": 3, "right": 4, "top": 5, "bottom": 6,
    "isometric": 7, "trimetric": 8, "dimetric": 9,
}

# swDwgTemplates_e — used only when no custom sheet template is configured
_TEMPLATE_A3 = 3
_TEMPLATE_A4 = 5


def _drawing(ctx: Context):
    return ctx.require(DOC_DRAWING, "drawing")


def _model_path_for_drawing(ctx: Context) -> str:
    """Path of the model to draw. Saves an unsaved part to a temp file first —
    a never-saved document has no path and cannot be referenced by a drawing."""
    model = ctx.model
    path = sw_get(model, "GetPathName") or ""
    if path:
        return path
    title = (sw_get(model, "GetTitle") or "part").split(".")[0]
    tmp = os.path.join(os.path.expanduser("~"), "Documents", "Millwright")
    os.makedirs(tmp, exist_ok=True)
    ext = ".sldasm" if sw_get(model, "GetType") == 2 else ".sldprt"
    target = os.path.join(tmp, f"{title}{ext}")
    if not model.SaveAs(target) or not os.path.exists(target):
        raise SWError(
            "the model must be saved before a drawing can reference it, and the automatic "
            f"save to {target} failed. Use save_as first."
        )
    return target


@tool(
    "create_drawing_of",
    "Create a drawing of the CURRENT part/assembly with standard views laid out (= 工程图; "
    "NewDocument + Create3rdAngleViews. Saves the model first if it has never been saved)",
    params={
        "views": {
            "type": "string",
            "desc": 'Which views: "standard3" = front+top+right (most common), "standard3_iso" '
                    '= those plus isometric, "front" = front only',
            "enum": ["standard3", "standard3_iso", "front"],
            "default": "standard3_iso",
        },
        "sheet_size": {"type": "string", "enum": ["a3", "a4"], "desc": "Sheet size", "default": "a3"},
    },
    category="drawing",
)
def create_drawing_of(ctx: Context, views: str = "standard3_iso", sheet_size: str = "a3"):
    model_path = _model_path_for_drawing(ctx)
    app = ctx.sw
    template = app.GetUserPreferenceStringValue(11)  # swDefaultTemplateDrawing
    if template:
        draw = app.NewDocument(template, _TEMPLATE_A4 if sheet_size == "a4" else _TEMPLATE_A3, 0, 0)
    else:
        draw = app.NewDrawing(_TEMPLATE_A4 if sheet_size == "a4" else _TEMPLATE_A3)
    if draw is None:
        raise SWError("failed to create the drawing document (is a drawing template configured?).")

    errors: list = []
    made = com_call(
        draw, ("Create3rdAngleViews2", "Create3rdAngleViews", "Create1stAngleViews2", "Create1stAngleViews"),
        [model_path], errors, min_args=1,
    )
    if made is None:
        # Fall back to placing a single named view — better a partial drawing than none
        placed = com_call(
            draw, ("CreateDrawViewFromModelView3", "CreateDrawViewFromModelView2"),
            [model_path, "*Front", 0.1, 0.2, 0.0], errors, min_args=4,
        )
        if placed is None:
            raise SWError(
                "drawing created but no view could be placed — check that the model path is "
                f"reachable: {model_path}. (attempts: {' | '.join(errors[-3:])})"
            )

    if views == "standard3_iso":
        try:
            com_call(
                draw, ("CreateDrawViewFromModelView3", "CreateDrawViewFromModelView2"),
                [model_path, "*Isometric", 0.24, 0.20, 0.0], errors, min_args=4,
            )
        except Exception:  # noqa: BLE001 — the iso view is a nicety, not a failure
            pass

    draw.ViewZoomtofit2()
    return {
        "drawing": sw_get(draw, "GetTitle"),
        "model": os.path.basename(model_path),
        "views": views,
        "sheet_size": sheet_size,
    }


@tool(
    "add_drawing_view",
    "Place one more view of a model on the current drawing sheet at a position "
    "(= 模型视图; CreateDrawViewFromModelView3)",
    params={
        "orientation": {
            "type": "string",
            "enum": list(_VIEW_IDS.keys()),
            "desc": "Which orientation to place",
            "default": "isometric",
        },
        "x": {"type": "number", "desc": "Sheet X in mm from the lower-left corner", "default": 200},
        "y": {"type": "number", "desc": "Sheet Y in mm from the lower-left corner", "default": 150},
        "model_path": {"type": "string", "desc": "Model file to view; defaults to the drawing's first referenced model", "default": ""},
    },
    category="drawing",
)
def add_drawing_view(ctx: Context, orientation: str = "isometric", x: float = 200,
                     y: float = 150, model_path: str = ""):
    draw = _drawing(ctx)
    path = model_path
    if not path:
        refs = sw_get(draw, "GetDependencies2") if hasattr(draw, "GetDependencies2") else None
        if refs:
            # GetDependencies2 returns [name, path, name, path, …]
            cands = [r for i, r in enumerate(list(refs)) if i % 2 == 1 and r]
            if cands:
                path = cands[0]
    if not path:
        raise SWError("give model_path= — this drawing has no resolvable model reference.")

    key = (orientation or "isometric").lower()
    if key not in _VIEW_IDS:
        raise SWError(f"unknown orientation: {orientation}")
    errors: list = []
    view = com_call(
        draw, ("CreateDrawViewFromModelView3", "CreateDrawViewFromModelView2"),
        [path, f"*{key.capitalize()}", units.mm(x), units.mm(y), 0.0], errors, min_args=4,
    )
    if view is None:
        raise SWError(f"failed to place the {key} view. (attempts: {' | '.join(errors[-3:])})")
    return {"view": sw_get(view, "Name") or key, "orientation": key, "at_mm": [x, y]}


@tool(
    "add_section_view",
    "Cut a section view through an existing view along a horizontal or vertical line "
    "(= 剖面视图; CreateSectionViewAt5)",
    params={
        "x": {"type": "number", "desc": "Where to place the section view, sheet X (mm)"},
        "y": {"type": "number", "desc": "Where to place the section view, sheet Y (mm)"},
        "label": {"type": "string", "desc": "Section label, e.g. A", "default": "A"},
    },
    category="drawing",
)
def add_section_view(ctx: Context, x: float, y: float, label: str = "A"):
    """The cutting line must already be sketched on the parent view and selected —
    SolidWorks has no automation path that infers where you meant to cut."""
    draw = _drawing(ctx)
    if ctx.selected_count() < 1:
        raise SWError(
            "sketch the cutting line on the parent view and select it first — "
            "SolidWorks cannot infer where to cut."
        )
    errors: list = []
    view = com_call(
        draw, ("CreateSectionViewAt5", "CreateSectionViewAt4", "CreateSectionViewAt3"),
        [units.mm(x), units.mm(y), 0.0, False, False, None, 0], errors, min_args=4,
    )
    if view is None:
        raise SWError(f"section view failed. (attempts: {' | '.join(errors[-3:])})")
    return {"section_view": sw_get(view, "Name") or label, "at_mm": [x, y]}


@tool(
    "insert_model_dimensions",
    "Import the model's own dimensions onto the drawing views — the fast way to dimension "
    "a drawing (= 模型项目; InsertModelAnnotations3)",
    params={
        "all_views": {"type": "boolean", "desc": "Apply to every view on the sheet, not just the selected one", "default": True},
    },
    category="drawing",
)
def insert_model_dimensions(ctx: Context, all_views: bool = True):
    draw = _drawing(ctx)
    errors: list = []
    # (option, types, allViews, dimAsDimXpert, hideDangling, includeInstances)
    # swInsertAnnotation_e: 1 = dimensions
    made = com_call(
        draw, ("InsertModelAnnotations3", "InsertModelAnnotations2", "InsertModelAnnotations"),
        [0, 1, bool(all_views), True, False, False], errors, min_args=3,
    )
    if made is None:
        raise SWError(
            "importing model dimensions failed — the views may have no driving dimensions to show. "
            f"(attempts: {' | '.join(errors[-3:])})"
        )
    count = len(list(made)) if isinstance(made, (list, tuple)) else 1
    return {"dimensions_imported": count, "all_views": bool(all_views)}


@tool(
    "add_drawing_note",
    "Add a text note on the drawing sheet — title-block text, tolerances, general notes "
    "(= 注释; InsertNote)",
    params={
        "text": {"type": "string", "desc": "Note text"},
        "x": {"type": "number", "desc": "Sheet X (mm)"},
        "y": {"type": "number", "desc": "Sheet Y (mm)"},
        "height": {"type": "number", "desc": "Text height (mm)", "default": 5},
    },
    category="drawing",
)
def add_drawing_note(ctx: Context, text: str, x: float, y: float, height: float = 5):
    draw = _drawing(ctx)
    ctx.clear_selection()
    note = draw.InsertNote(text)
    if note is None:
        raise SWError("failed to insert the note.")
    try:
        ann = note.GetAnnotation()
        ann.SetPosition(units.mm(x), units.mm(y), 0)
        tf = note.GetTextFormat()
        if tf is not None:
            tf.CharHeight = units.mm(height)
            note.SetTextFormat(0, False, tf)
    except Exception:  # noqa: BLE001 — placement/format are best-effort; the note exists
        pass
    return {"note": text, "at_mm": [x, y]}


@tool(
    "insert_bom",
    "Insert a bill of materials table on an assembly drawing (= 材料明细表; InsertBomTable4)",
    params={
        "x": {"type": "number", "desc": "Table anchor, sheet X (mm)", "default": 250},
        "y": {"type": "number", "desc": "Table anchor, sheet Y (mm)", "default": 260},
        "indented": {"type": "boolean", "desc": "Indented (shows sub-assembly structure) instead of parts-only", "default": False},
    },
    category="drawing",
)
def insert_bom(ctx: Context, x: float = 250, y: float = 260, indented: bool = False):
    draw = _drawing(ctx)
    # A BOM attaches to a view, so one must be selected — pick the first if nothing is.
    if ctx.selected_count() < 1:
        sheet = draw.GetCurrentSheet()
        names = sw_get(sheet, "GetViews") if sheet is not None else None
        first = None
        for v in (names or []):
            first = v
            break
        if first is not None:
            try:
                first.Select2(False, 0)
            except Exception:  # noqa: BLE001
                pass
    errors: list = []
    # swBomType_e: 1 = parts only, 2 = indented
    table = com_call(
        draw.Extension, ("InsertBomTable4", "InsertBomTable3", "InsertBomTable2"),
        ["", units.mm(x), units.mm(y), 2 if indented else 1, "", False, 1, "", False],
        errors, min_args=5,
    )
    if table is None:
        raise SWError(
            "BOM insert failed — a BOM needs an assembly view selected on the sheet. "
            f"(attempts: {' | '.join(errors[-3:])})"
        )
    return {"bom": "indented" if indented else "parts_only", "at_mm": [x, y]}


@tool(
    "list_drawing_views",
    "List the views on the current drawing sheet with their names and positions — "
    "read this before placing or sectioning anything",
    params={},
    category="drawing",
)
def list_drawing_views(ctx: Context):
    draw = _drawing(ctx)
    sheet = draw.GetCurrentSheet()
    if sheet is None:
        raise SWError("no active sheet.")
    out = []
    for v in (sw_get(sheet, "GetViews") or []):
        try:
            pos = sw_get(v, "Position") or [0, 0]
            out.append({
                "name": sw_get(v, "Name"),
                "at_mm": [round(units.m_to_mm(pos[0]), 1), round(units.m_to_mm(pos[1]), 1)],
                "scale": sw_get(v, "ScaleDecimal"),
            })
        except Exception:  # noqa: BLE001 — skip a view whose members won't read
            continue
    return {"sheet": sw_get(sheet, "GetName"), "count": len(out), "views": out}
