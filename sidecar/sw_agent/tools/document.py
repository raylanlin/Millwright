"""sw_agent.tools.document — document lifecycle and document-level properties.

Concrete benefits of the Python sidecar over VBS: use os.makedirs for directory
creation, and use the no-[out] IModelDoc2::SaveAs overload for save/export
(stable across SolidWorks versions, sidesteps pywin32 byref pitfalls).
Exceptions are surfaced directly to the agent.
"""
from __future__ import annotations

import os

from sw_agent.bridge import (
    DOC_ASSEMBLY,
    DOC_DRAWING,
    DOC_PART,
    Context,
    SWError,
    doc_type_name,
    sw_get,
)
from sw_agent.registry import tool

# swUserPreferenceStringValue_e: default templates
# P27: fix DOC_PART key (was 9 = swDefaultTemplatePart; correct value is 8 =
# swUserPreferenceStringValue_e.swDefaultTemplatePart — SW enum has these as 8/10/11,
# the 9 was wrong and produced 装配体 instead of 零件).
_PREF = {DOC_PART: 8, DOC_ASSEMBLY: 10, DOC_DRAWING: 11}
_EXT_TO_TYPE = {".sldprt": DOC_PART, ".sldasm": DOC_ASSEMBLY, ".slddrw": DOC_DRAWING}


def _reset_scratch(ctx: Context):
    """P97: 换文档时清掉会话暂存。

    `last_sketch` / `last_feature` 记的是「当前文档里最近建的那个」，可它们从来
    没被清过 —— 新建零件后 `_state` 仍报 `last_feature: 凸台-拉伸1`，那是上一个
    文档的特征。后果不止是显示错：`extrude` 缺省会去选 `last_sketch`，
    `fillet_edges` 的 feature 策略会去找 `last_feature`，两者在新文档里都指向一个
    不存在的名字 —— 实测里 fillet 的报错正是「找不到特征 凸台-拉伸1」。
    """
    for key in ("last_sketch", "last_feature", "edge_strategy", "edge_probe"):
        ctx.scratch.pop(key, None)


def _new(ctx: Context, doc_type: int, label: str):
    app = ctx.sw
    template = app.GetUserPreferenceStringValue(_PREF[doc_type])
    if not template:
        # P107: issue #1 — "no default template" killed new_part on machines where
        # SolidWorks options never had a default set. Fall back to the stock
        # templates shipped in the install dir before giving up.
        template = _fallback_template(ctx, doc_type, label)
    model = app.NewDocument(template, 0, 0, 0)
    if model is None:
        raise SWError(f"failed to create {label}.")
    _reset_scratch(ctx)
    # P26: GetTitle/GetPathName are propget under early binding — bare () raised "'str' object is not callable"
    return {"created": label, "title": sw_get(model, "GetTitle")}


_FALLBACK_DIRS = (
    # ProgramData stock templates (SolidWorks 2019+ keeps them here)
    r"%PROGRAMDATA%\SOLIDWORKS\SOLIDWORKS 20XX\templates",
    r"%PROGRAMDATA%\SOLIDWORKS\SOLIDWORKS 20XX\lang\chinese-simplified\Tutorial",
    # Program Files fallbacks for older layouts
    r"%ProgramFiles%\SOLIDWORKS Corp\SOLIDWORKS\lang\chinese-simplified\Tutorial",
    r"%ProgramFiles%\SOLIDWORKS Corp\SOLIDWORKS\data\templates",
    r"%ProgramFiles%\SOLIDWORKS Corp\SOLIDWORKS\templates",
)


# P107: stock template file names per document type — the classic names every
# install ships, in both the Chinese and English template sets.
_FALLBACK_NAMES = {
    DOC_PART: ("零件.prtdot", "Part.prtdot", "gb_part.prtdot"),
    DOC_ASSEMBLY: ("装配体.asmdot", "Assembly.asmdot", "gb_assembly.asmdot"),
    DOC_DRAWING: ("工程图.drwdot", "Drawing.drwdot", "gb_assembly_drawing.drwdot"),
}


def _fallback_template(ctx: Context, doc_type: int, label: str) -> str:
    """P107: locate a stock SolidWorks template when no default is configured.

    Scans the usual install locations for the classic template file names. Returns
    the first hit; raises the original "no default template" error otherwise.
    """
    import glob
    import os

    candidates = []
    for d in _FALLBACK_DIRS:
        d = os.path.expandvars(d).replace("20XX", "2024")  # probe recent years too
        candidates.append(d)
        # The "20XX" wildcard is literal — expand it to a small range
        base = os.path.expandvars(d)
        if "20XX" in base:
            for year in ("2026", "2025", "2024", "2023", "2022", "2021", "2020", "2019", "2018"):
                candidates.append(base.replace("20XX", year))
    names = _FALLBACK_NAMES[doc_type]
    for d in candidates:
        for pat in names:
            hits = glob.glob(os.path.join(d, pat))
            if hits:
                return hits[0]
    raise SWError(f"no default {label} template found; set a document template in SolidWorks options.")


def _empty_part(ctx: Context):
    """The active document, if it is a part with no real features — otherwise None.

    P75: Millwright left trails of 零件1..零件7 behind, because whenever a feature failed
    the model's recovery instinct was to start a fresh part and try again. The user then
    has to guess which of seven documents is the deliverable, which is worse than the
    original failure. An empty part already IS a new part, so hand it back.
    """
    try:
        cur = ctx.sw.ActiveDoc
        if cur is None or sw_get(cur, "GetType") != DOC_PART:
            return None
        # Folders, planes and the origin are present in every new part and are not work.
        boilerplate = {
            "HistoryFolder", "SensorFolder", "DocsFolder", "DetailCabinet",
            "MaterialFolder", "RefPlane", "OriginProfileFeature", "CommentsFolder",
            "SolidBodyFolder", "SurfaceBodyFolder", "EnvFolder", "FavoriteFolder",
        }
        for f in list(cur.FeatureManager.GetFeatures(True) or []):
            try:
                if sw_get(f, "GetTypeName2") not in boilerplate:
                    return None
            except Exception:  # noqa: BLE001 — an unreadable feature still counts as work
                return None
        return cur
    except Exception:  # noqa: BLE001
        return None


@tool("new_part", "Create a new part document, or reuse the active one if it is still empty (= New Part; NewDocument with the default part template)", params={}, category="document")
def new_part(ctx: Context):
    reuse = _empty_part(ctx)
    if reuse is not None:
        # 复用的空零件同样是「重新开始」，暂存也得清 —— 否则它比新建更容易踩坑
        _reset_scratch(ctx)
        return {
            "created": "part",
            "title": sw_get(reuse, "GetTitle"),
            "reused": True,
            "note": "the active part was still empty, so it was reused — a failed feature "
                    "is not a reason to start another document",
        }
    return _new(ctx, DOC_PART, "part")


@tool("new_assembly", "Create a new assembly document (= New Assembly; NewDocument with the default assembly template)", params={}, category="document")
def new_assembly(ctx: Context):
    return _new(ctx, DOC_ASSEMBLY, "assembly")


@tool("new_drawing", "Create a new drawing document (= New Drawing; NewDocument with the default drawing template)", params={}, category="document")
def new_drawing(ctx: Context):
    return _new(ctx, DOC_DRAWING, "drawing")


@tool(
    "open_document", "Open a document by path (= Open; OpenDoc6)",
    params={"path": {"type": "string", "desc": "Absolute file path"}},
    category="document",
)
def open_document(ctx: Context, path: str):
    ext = os.path.splitext(path)[1].lower()
    dt = _EXT_TO_TYPE.get(ext)
    if dt is None:
        raise SWError(f"unsupported file type: {ext}")
    # P127: OpenDoc6's Errors/Warnings are [in,out] byref longs. Under late binding a bare 0
    # raises DISP_E_TYPEMISMATCH on some installs and returns None on others (the document is
    # then never loaded — which is also why AddComponent5 "succeeds" without inserting anything).
    # Pass VARIANT(VT_BYREF|VT_I4) first, fall back to the plain form for early binding.
    if not os.path.isfile(path):
        raise SWError(f"file not found: {path}")
    from sw_agent.verify import _byref_int
    r = None
    attempts: list = []
    for make in (lambda: ctx.sw.OpenDoc6(path, dt, 1, "", _byref_int(), _byref_int()),
                 lambda: ctx.sw.OpenDoc6(path, dt, 1, "", 0, 0)):
        try:
            r = make()
        except Exception as e:  # noqa: BLE001
            attempts.append(str(e))
            continue
        if r is not None:
            break
    model = r[0] if isinstance(r, tuple) else r
    if model is None:
        # some releases return None yet open the document — trust the active doc if its path matches
        try:
            cur = ctx.sw.ActiveDoc
            if cur is not None and os.path.normcase(sw_get(cur, "GetPathName")) == os.path.normcase(path):
                model = cur
        except Exception:  # noqa: BLE001
            pass
    if model is None:
        raise SWError(f"open failed: {path}" + (f" (attempts: {' | '.join(attempts)})" if attempts else ""))
    _reset_scratch(ctx)
    return {"opened": sw_get(model, "GetTitle"), "type": doc_type_name(model)}


@tool("save_document", "Save the current document (= Save; Save3)", params={}, category="document")
def save_document(ctx: Context):
    model = ctx.model
    # P100: Save3's signature varies across releases (returns tuple vs int, arg count
    # differs) — the benchmark's save_document died with "类型不匹配". Route through
    # the same defensive com_call used everywhere else; fall back to SaveAs when the
    # document was never saved. Model.Save3(Silent) then GetPathName check is the
    # intent; the arity/typing dance is transport noise.
    from sw_agent.tools.feature import com_call
    errors: list = []
    r = com_call(model, ("Save3", "Save2"), (1, 0, 0), errors, min_args=1)
    ok = bool(r)
    if not ok:
        try:
            ok = bool(sw_get(model, "GetPathName"))
        except Exception:  # noqa: BLE001
            ok = False
        if not ok:
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
    "set_material", "Set the material for the current part (= Material; SetMaterialPropertyName2)",
    params={
        "material": {"type": "string", "desc": "Material name, e.g. \"Alloy Steel\" or \"6061 Alloy\""},
        "database": {"type": "string", "desc": "Material database name; default solidworks materials", "default": ""},
    },
    category="document",
)
def set_material(ctx: Context, material: str, database: str = ""):
    """P133: SetMaterialPropertyName2 returns nothing, and an unknown name is silently
    ignored — a Chinese SolidWorks has 「合金钢」, not "Alloy Steel". The tool used to report
    success while the tree still said 材质 <未指定> and every mass came out at water
    density. Now each candidate (the given name, then its zh/en alias) is applied and
    VERIFIED by reading the density back; nothing taking is an error, not a success."""
    part = ctx.require(DOC_PART, "part")
    dbs = [database] if database else ["SOLIDWORKS Materials", "solidworks materials"]
    names = _material_candidates(material)
    before = _density(ctx)
    tried = []
    for db in dbs:
        for name in names:
            tried.append(f"{db}/{name}")
            try:
                part.SetMaterialPropertyName2("", db, name)
            except Exception:  # noqa: BLE001 — try the next spelling
                continue
            try:
                ctx.model.ForceRebuild3(False)
            except Exception:  # noqa: BLE001
                pass
            after = _density(ctx)
            if after is None:   # cannot read back on this install — report, do not claim
                return {"material": name, "database": db, "verified": False}
            if _changed(before, after):
                return {"material": name, "database": db, "verified": True,
                        "density_kg_m3": round(after, 3)}
            if before is not None and not _changed(_NO_MATERIAL_DENSITY, before):
                continue        # still the no-material density: the name did not take
            # the part already had a material of this density — re-applying the same one,
            # or a name SolidWorks ignored; the density cannot tell which
            return {"material": name, "database": db, "verified": False,
                    "density_kg_m3": round(after, 3),
                    "note": "density unchanged — either this material was already applied, or "
                            "the name was not recognised; check the material in the feature tree"}
    raise SWError(
        f"material '{material}' was not applied — SolidWorks did not recognise the name "
        f"(tried {', '.join(tried)}; density still {before} kg/m³). Use the exact name from "
        "SolidWorks' material dialog — a Chinese install names them e.g. 合金钢 / 普通碳钢 / 6061 合金.")


# P133: English ↔ Chinese names of SolidWorks' standard materials (+ generic words)
_MATERIAL_ALIASES: list[tuple[str, ...]] = [
    ("Alloy Steel", "合金钢"),
    ("Plain Carbon Steel", "普通碳钢"),
    ("Cast Carbon Steel", "铸造碳钢"),
    ("Cast Alloy Steel", "铸造合金钢"),
    ("1060 Alloy", "1060 合金"),
    ("6061 Alloy", "6061 合金"),
    ("Plain Carbon Steel", "普通碳钢", "steel", "钢"),
    ("6061 Alloy", "6061 合金", "aluminum", "aluminium", "铝", "铝合金"),
]

_NO_MATERIAL_DENSITY = 1000.0   # SolidWorks' density for a part with no material assigned


def _material_candidates(material: str) -> list[str]:
    m = material.strip()
    low = m.lower()
    out = [m]
    for group in _MATERIAL_ALIASES:
        if low in (g.lower() for g in group):
            out += [g for g in group[:2] if g not in out]
    return out


def _density(ctx) -> float | None:
    """kg/m³ from IMassProperty, or None when it cannot be read."""
    try:
        ext = ctx.model.Extension
        for maker in ("CreateMassProperty", "CreateMassProperty2"):
            try:
                mp = sw_get(ext, maker)
            except Exception:  # noqa: BLE001
                continue
            if mp is not None:
                return float(sw_get(mp, "Density"))
    except Exception:  # noqa: BLE001
        pass
    return None


def _changed(before: float | None, after: float) -> bool:
    ref = _NO_MATERIAL_DENSITY if before is None else before
    return abs(after - ref) > 1e-6


@tool("rebuild_model", "Force a full model rebuild, i.e. Ctrl+Q (= Rebuild; ForceRebuild3)", params={}, category="document")
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
    "add_equation", "Add an equation / global variable (= Equation; EquationMgr.Add3)",
    params={"equation": {"type": "string",
                        "desc": "Full equation, e.g. \"D1@Sketch1\" = 20 or \"width\" = 50"}},
    category="document",
)
def add_equation(ctx: Context, equation: str):
    mgr = ctx.model.GetEquationMgr()
    idx = mgr.Add3(-1, equation, True, 0)  # -1 means append to the end
    ctx.rebuild()
    return {"equation": equation, "index": idx}
