"""sw_agent.tools.health — 文档健康：官方错误码、编辑态、重建诊断（P124）。

对标 just1step 的 GetFeatureDiagnostics / GetEditState / DiagnoseActiveDocumentHealth：
特征树上的红叉是结构化数据（IFeature.GetErrorCode2 → swFeatureError_e），不需要截图
让视觉模型去猜。`edit_state` 是删特征/读树前的门——P105 delete_feature 连报十次成功
实际零删除，最可能就是在草图编辑态下删。
"""
from __future__ import annotations

from sw_agent.bridge import Context, SWError, sw_get
from sw_agent.registry import tool

# swFeatureError_e —— 只列确定的；其余按 code 原样报，不编名字
_FEATURE_ERROR = {
    0: "none",
    1: "unknown",
}


def _edit_state(ctx: Context) -> dict:
    st: dict = {"editing_sketch": False, "editing_feature": False, "safe_for_tree_edits": True}
    try:
        st["editing_sketch"] = ctx.sketch_mgr.ActiveSketch is not None
    except Exception:  # noqa: BLE001
        pass
    try:
        # IModelDoc2.GetType is document type; edit-feature mode surfaces via IsEditingSelf? Not exposed
        # for all versions — the sketch check is the one that matters for tree ops.
        st["needs_rebuild"] = bool(ctx.model.Extension.NeedsRebuild2)
    except Exception:  # noqa: BLE001
        try:
            st["needs_rebuild"] = bool(ctx.model.Extension.NeedsRebuild2())
        except Exception:  # noqa: BLE001
            pass
    st["safe_for_tree_edits"] = not st["editing_sketch"] and not st["editing_feature"]
    return st


@tool("edit_state",
      "Is the document in sketch-edit mode? Call before delete_feature / suppress / list_features; "
      "if editing_sketch is true, exit_sketch first.",
      params={}, category="query")
def edit_state(ctx: Context):
    return _edit_state(ctx)


def _feature_errors(ctx: Context) -> list:
    out = []
    for f in ctx.all_features():
        try:
            name = sw_get(f, "Name")
        except Exception:  # noqa: BLE001
            continue
        code = None
        # ruff B023: lambda tuple is built and consumed in the same iteration;
        # `f` is the current feature, and each lambda is invoked immediately by call() — no
        # late binding across loop iterations.
        for call in (lambda: f.GetErrorCode2(True), lambda: f.GetErrorCode2(False), lambda: sw_get(f, "GetErrorCode")):  # noqa: B023
            try:
                code = int(call())
                break
            except Exception:  # noqa: BLE001
                continue
        if code is None or code == 0:
            continue
        item = {"feature": name, "code": code, "error": _FEATURE_ERROR.get(code, f"swFeatureError_e {code}")}
        try:
            item["type"] = sw_get(f, "GetTypeName2")
        except Exception:  # noqa: BLE001
            pass
        try:
            if sw_get(f, "IsSuppressed"):
                item["suppressed"] = True
        except Exception:  # noqa: BLE001
            pass
        out.append(item)
    return out


@tool("feature_diagnostics",
      "Structured FeatureManager error report: every feature with a non-zero swFeatureError_e code "
      "(the red/yellow marks in the tree). Use instead of screenshots to find what is broken.",
      params={}, category="query")
def feature_diagnostics(ctx: Context):
    errs = _feature_errors(ctx)
    return {"error_count": len(errs), "errors": errs, "edit_state": _edit_state(ctx)}


@tool("diagnose_document",
      "Health gate after risky edits: optional ForceRebuild3, then feature errors, edit state, body count, "
      "and (parts) volume. Returns healthy=false if any feature reports an error or a part has no body.",
      params={
          "force_rebuild": {"type": "boolean", "desc": "Rebuild before evaluating (default true)", "default": True},
          "top_only": {"type": "boolean", "desc": "ForceRebuild3 top-level only", "default": False},
      },
      category="document")
def diagnose_document(ctx: Context, force_rebuild: bool = True, top_only: bool = False):
    m = ctx.model
    report: dict = {"healthy": True, "problems": []}
    if force_rebuild:
        try:
            ok = m.ForceRebuild3(bool(top_only))
            report["rebuilt"] = bool(ok) if ok is not None else True
        except Exception as e:  # noqa: BLE001
            report["rebuilt"] = False
            report["problems"].append(f"ForceRebuild3 failed: {e}")
    errs = _feature_errors(ctx)
    report["feature_errors"] = errs
    if errs:
        report["healthy"] = False
        report["problems"].append(f"{len(errs)} feature(s) report errors: {[e['feature'] for e in errs]}")
    report["edit_state"] = _edit_state(ctx)
    try:
        dt = sw_get(m, "GetType")
    except Exception:  # noqa: BLE001
        dt = None
    if dt == 1:
        try:
            n = len(ctx.solid_bodies())
        except SWError:
            n = 0
        report["bodies"] = n
        if n == 0 and len(ctx.all_features()) > 3:
            report["healthy"] = False
            report["problems"].append("part has features but no solid body")
        try:
            from sw_agent.verify import _mass_props
            mp = _mass_props(ctx)
            if mp:
                report["volume_mm3"] = round(mp[0] * 1e9, 3)
                report["area_mm2"] = round(mp[1] * 1e6, 3)
        except Exception:  # noqa: BLE001
            pass
    elif dt == 2:
        try:
            report["components"] = len(list(m.GetComponents(True) or []))
        except Exception:  # noqa: BLE001
            pass
    return report
