"""sw_agent.tools.document — document lifecycle and document-level properties.

Concrete benefits of the Python sidecar over VBS: use os.makedirs for directory
creation, and use the no-[out] IModelDoc2::SaveAs overload for save/export
(stable across SolidWorks versions, sidesteps pywin32 byref pitfalls).
Exceptions are surfaced directly to the agent.
"""
from __future__ import annotations
import os

from ..registry import tool
from ..bridge import Context, SWError, DOC_PART, DOC_ASSEMBLY, DOC_DRAWING, doc_type_name, sw_get

# swUserPreferenceStringValue_e: default templates
# P27: fix DOC_PART key (was 9 = swDefaultTemplatePart; correct value is 8 =
# swUserPreferenceStringValue_e.swDefaultTemplatePart — SW enum has these as 8/10/11,
# the 9 was wrong and produced 装配体 instead of 零件).
_PREF = {DOC_PART: 8, DOC_ASSEMBLY: 10, DOC_DRAWING: 11}
_EXT_TO_TYPE = {".sldprt": DOC_PART, ".sldasm": DOC_ASSEMBLY, ".slddrw": DOC_DRAWING}


def _new(ctx: Context, doc_type: int, label: str):
    app = ctx.sw
    template = app.GetUserPreferenceStringValue(_PREF[doc_type])
    if not template:
        raise SWError(f"no default {label} template found; set a document template in SolidWorks options.")
    model = app.NewDocument(template, 0, 0, 0)
    if model is None:
        raise SWError(f"failed to create {label}.")
    # P26: GetTitle/GetPathName are propget under early binding — bare () raised "'str' object is not callable"
    return {"created": label, "title": sw_get(model, "GetTitle")}


@tool("new_part", "Create a new part document", params={}, category="document")
def new_part(ctx: Context):
    return _new(ctx, DOC_PART, "part")


@tool("new_assembly", "Create a new assembly document", params={}, category="document")
def new_assembly(ctx: Context):
    return _new(ctx, DOC_ASSEMBLY, "assembly")


@tool("new_drawing", "Create a new drawing document", params={}, category="document")
def new_drawing(ctx: Context):
    return _new(ctx, DOC_DRAWING, "drawing")


@tool(
    "open_document", "Open a document by path",
    params={"path": {"type": "string", "desc": "Absolute file path"}},
    category="document",
)
def open_document(ctx: Context, path: str):
    ext = os.path.splitext(path)[1].lower()
    dt = _EXT_TO_TYPE.get(ext)
    if dt is None:
        raise SWError(f"unsupported file type: {ext}")
    # OpenDoc6 has [out] err/warn parameters; pywin32 late-binding may return (model) or (model, err, warn)
    r = ctx.sw.OpenDoc6(path, dt, 1, "", 0, 0)
    model = r[0] if isinstance(r, tuple) else r
    if model is None:
        raise SWError(f"open failed: {path}")
    return {"opened": sw_get(model, "GetTitle"), "type": doc_type_name(model)}


@tool("save_document", "Save the current document", params={}, category="document")
def save_document(ctx: Context):
    model = ctx.model
    # Save3's err/warn are [out] — unpack defensively
    r = model.Save3(1, 0, 0)  # 1 = swSaveAsOptions_Silent
    ok = r[0] if isinstance(r, tuple) else r
    if not ok and sw_get(model, "GetPathName") == "":
        raise SWError("document has never been saved; use save_as with a target path.")
    return {"saved": sw_get(model, "GetTitle")}


@tool(
    "save_as", "Save / export to the given path (auto-converts by extension: sldprt/step/stl/pdf/dxf/igs…)",
    params={"path": {"type": "string", "desc": "Target absolute path (including extension)"}},
    category="document",
)
def save_as(ctx: Context, path: str):
    parent = os.path.dirname(path)
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    # IModelDoc2::SaveAs (single argument) has no [out] — stable across SolidWorks versions
    ok = ctx.model.SaveAs(path)
    if not ok or not os.path.exists(path):
        raise SWError(f"save_as failed: {path}")
    return {"saved_to": path}


@tool(
    "set_material", "Set the material for the current part",
    params={
        "material": {"type": "string", "desc": "Material name, e.g. \"Alloy Steel\" or \"6061 Alloy\""},
        "database": {"type": "string", "desc": "Material database name; default solidworks materials", "default": ""},
    },
    category="document",
)
def set_material(ctx: Context, material: str, database: str = ""):
    part = ctx.require(DOC_PART, "part")
    db = database or "SOLIDWORKS Materials"
    part.SetMaterialPropertyName2("", db, material)
    return {"material": material, "database": db}


@tool("rebuild_model", "Force a full model rebuild (equivalent to Ctrl+Q)", params={}, category="document")
def rebuild_model(ctx: Context):
    ctx.model.ForceRebuild3(False)
    return {"rebuilt": True}


@tool(
    "set_custom_property", "Write a custom property (file property)",
    params={
        "name": {"type": "string", "desc": "Property name"},
        "value": {"type": "string", "desc": "Property value"},
    },
    category="document",
)
def set_custom_property(ctx: Context, name: str, value: str):
    mgr = ctx.model.Extension.CustomPropertyManager("")
    # Add3(name, type=30 text, value, overwrite=2 to overwrite existing)
    mgr.Add3(name, 30, str(value), 2)
    return {"property": name, "value": value}


@tool(
    "create_configuration", "Create a new configuration",
    params={"name": {"type": "string", "desc": "Configuration name"}},
    category="document",
)
def create_configuration(ctx: Context, name: str):
    model = ctx.model
    # AddConfiguration3(name, comment, alternateName, options)
    cfg = model.ConfigurationManager.AddConfiguration(name, "", "", 0, "", "")
    if not cfg:
        raise SWError(f"create configuration failed: {name}")
    return {"configuration": name}


@tool(
    "activate_configuration", "Switch to the specified configuration",
    params={"name": {"type": "string", "desc": "Configuration name"}},
    category="document",
)
def activate_configuration(ctx: Context, name: str):
    if not ctx.model.ShowConfiguration2(name):
        raise SWError(f"configuration switch failed (does it exist?): {name}")
    return {"active_configuration": name}


@tool(
    "add_equation", "Add an equation / global variable",
    params={"equation": {"type": "string",
                        "desc": "Full equation, e.g. \"D1@Sketch1\" = 20 or \"width\" = 50"}},
    category="document",
)
def add_equation(ctx: Context, equation: str):
    mgr = ctx.model.GetEquationMgr()
    idx = mgr.Add3(-1, equation, True, 0)  # -1 means append to the end
    ctx.rebuild()
    return {"equation": equation, "index": idx}
