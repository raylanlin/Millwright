"""sw_agent.tools.document —— 文档生命周期与文档级属性。

Python 边车相对 VBS 的直接红利：建目录用 os.makedirs，保存/导出用无 [out] 参数的
IModelDoc2::SaveAs（跨版本稳、避开 pywin32 byref 坑），异常直接抛给 agent。
"""
from __future__ import annotations
import os

from ..registry import tool
from ..bridge import Context, SWError, DOC_PART, DOC_ASSEMBLY, DOC_DRAWING, doc_type_name

# swUserPreferenceStringValue_e: 默认模板
_PREF = {DOC_PART: 9, DOC_ASSEMBLY: 10, DOC_DRAWING: 11}
_EXT_TO_TYPE = {".sldprt": DOC_PART, ".sldasm": DOC_ASSEMBLY, ".slddrw": DOC_DRAWING}


def _new(ctx: Context, doc_type: int, label: str):
    app = ctx.sw
    template = app.GetUserPreferenceStringValue(_PREF[doc_type])
    if not template:
        raise SWError(f"未找到默认{label}模板，请在 SolidWorks 选项里设置文档模板。")
    model = app.NewDocument(template, 0, 0, 0)
    if model is None:
        raise SWError(f"创建{label}失败。")
    return {"created": label, "title": model.GetTitle()}


@tool("new_part", "新建零件文档", params={}, category="document")
def new_part(ctx: Context):
    return _new(ctx, DOC_PART, "零件")


@tool("new_assembly", "新建装配体文档", params={}, category="document")
def new_assembly(ctx: Context):
    return _new(ctx, DOC_ASSEMBLY, "装配体")


@tool("new_drawing", "新建工程图文档", params={}, category="document")
def new_drawing(ctx: Context):
    return _new(ctx, DOC_DRAWING, "工程图")


@tool(
    "open_document", "按路径打开文档",
    params={"path": {"type": "string", "desc": "文件绝对路径"}},
    category="document",
)
def open_document(ctx: Context, path: str):
    ext = os.path.splitext(path)[1].lower()
    dt = _EXT_TO_TYPE.get(ext)
    if dt is None:
        raise SWError(f"不支持的文件类型：{ext}")
    # OpenDoc6 有 [out] err/warn；pywin32 late-bind 可能返回 (model) 或 (model,err,warn)
    r = ctx.sw.OpenDoc6(path, dt, 1, "", 0, 0)
    model = r[0] if isinstance(r, tuple) else r
    if model is None:
        raise SWError(f"打开失败：{path}")
    return {"opened": model.GetTitle(), "type": doc_type_name(model)}


@tool("save_document", "保存当前文档", params={}, category="document")
def save_document(ctx: Context):
    model = ctx.model
    # Save3 的 err/warn 是 [out]，用防御性解包
    r = model.Save3(1, 0, 0)  # 1 = swSaveAsOptions_Silent
    ok = r[0] if isinstance(r, tuple) else r
    if not ok and model.GetPathName() == "":
        raise SWError("文档尚未保存过，请用 save_as 指定路径。")
    return {"saved": model.GetTitle()}


@tool(
    "save_as", "另存 / 导出到指定路径（按扩展名自动转换：sldprt/step/stl/pdf/dxf/igs…）",
    params={"path": {"type": "string", "desc": "目标绝对路径（含扩展名）"}},
    category="document",
)
def save_as(ctx: Context, path: str):
    parent = os.path.dirname(path)
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    # IModelDoc2::SaveAs(单参) 无 [out]，跨版本稳
    ok = ctx.model.SaveAs(path)
    if not ok or not os.path.exists(path):
        raise SWError(f"另存失败：{path}")
    return {"saved_to": path}


@tool(
    "set_material", "为当前零件设定材料",
    params={
        "material": {"type": "string", "desc": "材料名，如“合金钢”/“6061 Alloy”"},
        "database": {"type": "string", "desc": "材料库名，默认 solidworks materials", "default": ""},
    },
    category="document",
)
def set_material(ctx: Context, material: str, database: str = ""):
    part = ctx.require(DOC_PART, "零件")
    db = database or "SOLIDWORKS Materials"
    part.SetMaterialPropertyName2("", db, material)
    return {"material": material, "database": db}


@tool("rebuild_model", "强制重建模型（等价 Ctrl+Q）", params={}, category="document")
def rebuild_model(ctx: Context):
    ctx.model.ForceRebuild3(False)
    return {"rebuilt": True}


@tool(
    "set_custom_property", "写入自定义属性（文件属性）",
    params={
        "name": {"type": "string", "desc": "属性名"},
        "value": {"type": "string", "desc": "属性值"},
    },
    category="document",
)
def set_custom_property(ctx: Context, name: str, value: str):
    mgr = ctx.model.Extension.CustomPropertyManager("")
    # Add3(name, type=30 文本, value, overwrite=2 覆盖已存在)
    mgr.Add3(name, 30, str(value), 2)
    return {"property": name, "value": value}


@tool(
    "create_configuration", "新建配置",
    params={"name": {"type": "string", "desc": "配置名"}},
    category="document",
)
def create_configuration(ctx: Context, name: str):
    model = ctx.model
    # AddConfiguration3(name, comment, alternateName, options)
    cfg = model.ConfigurationManager.AddConfiguration(name, "", "", 0, "", "")
    if not cfg:
        raise SWError(f"新建配置失败：{name}")
    return {"configuration": name}


@tool(
    "activate_configuration", "切换到指定配置",
    params={"name": {"type": "string", "desc": "配置名"}},
    category="document",
)
def activate_configuration(ctx: Context, name: str):
    if not ctx.model.ShowConfiguration2(name):
        raise SWError(f"切换配置失败（不存在？）：{name}")
    return {"active_configuration": name}


@tool(
    "add_equation", "添加方程式 / 全局变量",
    params={"equation": {"type": "string",
                        "desc": '完整方程式，如 "D1@Sketch1" = 20 或 "宽度" = 50'}},
    category="document",
)
def add_equation(ctx: Context, equation: str):
    mgr = ctx.model.GetEquationMgr()
    idx = mgr.Add3(-1, equation, True, 0)  # -1 追加到末尾
    ctx.rebuild()
    return {"equation": equation, "index": idx}
