"""sw_agent.tools.batch —— 批量建模：一次调用提交整个零件的特征序列。

为什么需要它(P56):
    逐步调用让模型"每一步都成功、整体不成形"——它没有机会在落笔前把整个几何
    算完。而一次性宏之所以看起来规划更好,正是因为作者(或模型)是**一口气写完
    整个零件**的。

    但一次性 VBA 宏有三个致命问题,这也是它实际跑出来往往是废品的原因:
      1. 单位。SolidWorks API 一律用**米**,与文档单位无关。手写宏里
         `FeatureExtrusion2 ... 40` 就是 40 米。
      2. 参数个数。FeatureCut/FeatureExtrusion 的位置参数个数随版本变化,
         写死一个个数在别的机器上必然 400/类型错误。
      3. `On Error Resume Next`。每一步都"报告成功",错误静默累积,最后得到
         一个看起来跑完了、实际什么也没做的零件。

    build_part 取两者之长:模型**一次提交整个零件计划**(规划完整),执行仍走
    已经过真机加固的工具实现(自动单位换算、参数个数自适应、失败立即停并如实
    报告哪一步、为什么)。
"""
from __future__ import annotations

import json

from ..bridge import Context, SWError
from ..registry import TOOLS, call, tool

MAX_STEPS = 80

# 批处理里不允许出现的工具:递归、机制类、以及会把当前文档换掉的操作
# (换文档会让后续步骤作用在错误的零件上,是最难排查的一类错误)
_FORBIDDEN = {
    "build_part",
    "new_part", "new_assembly", "new_drawing", "open_document",
    "save_as",
}


def _coerce_step(raw, index: int):
    """One step, from whatever shape the provider actually delivered.

    P78/P79: providers reshape nested arguments incompatibly — some send the object, some
    a JSON string per element, some the whole array as one string, and some stringify every
    number inside it. Rejecting all but the canonical form meant a correct request from the
    model could fail several times running, after which it gives up on batching entirely.
    Accept what is unambiguous; complain only when the intent is genuinely unreadable.
    """
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            raise SWError(
                f"step {index} arrived empty — the nested step objects were lost in transit. "
                'Resubmit with each step as an object, e.g. {"tool":"extrude","params":{"depth":10}}'
            )
        try:
            raw = json.loads(text)
        except ValueError:
            if text.replace("_", "").isalnum():
                return {"tool": text, "params": {}}   # a bare tool name is unambiguous
            raise SWError(f"step {index} is not valid JSON: {text[:80]}") from None
    if not isinstance(raw, dict):
        raise SWError(f"step {index} is not an object: {raw!r}")

    name = raw.get("tool") or raw.get("name")
    if not name:
        raise SWError(f'step {index} has no "tool" field: {raw!r}')
    params = raw.get("params") or raw.get("args") or raw.get("arguments") or {}
    if isinstance(params, str):
        try:
            params = json.loads(params) if params.strip() else {}
        except ValueError:
            raise SWError(f"step {index} ({name}) has unparseable params: {params[:80]}") from None
    if not isinstance(params, dict):
        raise SWError(f"step {index} ({name}) params must be an object, got {params!r}")
    # Arguments the model put next to "tool" instead of inside "params"
    for k, v in raw.items():
        if k not in ("tool", "name", "params", "args", "arguments") and k not in params:
            params[k] = v
    return {"tool": name, "params": _coerce_values(params)}


def _coerce_values(params: dict) -> dict:
    """P79: un-stringify numbers and booleans.

    Providers serialise nested objects loosely: a step arrived as
    {"x": "-40", "width": "80", "through_all": "true"}. Every downstream tool then does
    arithmetic on a string. Converting here is right because these values came through a
    schema that already declared their types — the quoting is transport noise, not intent.
    """
    out = {}
    for k, v in params.items():
        if isinstance(v, str):
            s = v.strip()
            low = s.lower()
            if low in ("true", "false"):
                out[k] = low == "true"
                continue
            try:
                out[k] = int(s) if s.lstrip("+-").isdigit() else float(s)
                continue
            except ValueError:
                pass
        out[k] = v
    return out


@tool(
    "build_part",
    "Build a whole part in ONE call by submitting its complete feature sequence. "
    "STRONGLY PREFERRED over calling sketch/feature tools one at a time: plan the "
    "entire part (dimensions, planes, coordinates, feature order) and submit it here. "
    "Steps run in order and STOP at the first failure, reporting which step failed and "
    "why, so you can fix that one step and resubmit the remainder. All dimensions are "
    "in mm/degrees exactly as with the individual tools.",
    params={
        "steps": {
            "type": "array",
            # P78: the element schema MUST be declared. Without "items" the provider's
            # function-calling layer does not know the array holds objects, and some of them
            # flatten each element to an empty string — every submission arrived as
            # ["", "", ""] and failed with "step 1 is not an object", repeatedly, until the
            # model abandoned batching and fell back to one call per feature.
            "items": {
                "type": "object",
                "properties": {
                    "tool": {"type": "string", "description": "Tool name, e.g. start_sketch / sketch_rectangle / extrude"},
                    "params": {"type": "object", "description": "That tool's arguments, mm/degrees as usual"},
                },
                "required": ["tool"],
            },
            "desc": 'Ordered feature steps, each {"tool": "<tool name>", "params": {...}} — '
                    'e.g. [{"tool":"start_sketch","params":{"plane":"top"}}, '
                    '{"tool":"sketch_rectangle","params":{"x":0,"y":0,"width":80,"height":50}}, '
                    '{"tool":"extrude","params":{"depth":10}}]',
        },
        "part": {
            "type": "string",
            "desc": "What this batch builds (for the log, e.g. 'pinion shaft')",
            "default": "",
        },
    },
    category="feature", destructive=True,
)
def build_part(ctx: Context, steps, part: str = ""):
    if isinstance(steps, str):   # the whole array may arrive as one JSON string
        try:
            steps = json.loads(steps)
        except ValueError:
            raise SWError(f"steps is not valid JSON: {steps[:120]}") from None
    if not isinstance(steps, list) or not steps:
        raise SWError("steps must be a non-empty array of {tool, params} objects.")
    if len(steps) > MAX_STEPS:
        raise SWError(f"too many steps ({len(steps)}); split the part into stages of ≤{MAX_STEPS}.")

    # Validate the WHOLE plan before touching the model — a batch that dies halfway
    # because of a typo in step 20 leaves a half-built part behind, which is worse
    # than not starting. Everything checkable statically is checked up front.
    plan = []
    for i, raw in enumerate(steps):
        # P78: normalise whatever shape the provider delivered before validating it
        step = _coerce_step(raw, i + 1)
        name, params = step["tool"], step["params"]
        if name in _FORBIDDEN:
            raise SWError(
                f"step {i + 1}: {name} cannot be used inside build_part "
                "(call it on its own — it creates or switches the active document)."
            )
        spec = TOOLS.get(name)
        if spec is None:
            raise SWError(f"step {i + 1}: unknown tool '{name}'.")
        if spec.internal:
            raise SWError(f"step {i + 1}: {name} is an internal tool, not usable in a batch.")
        if not isinstance(params, dict):
            raise SWError(f"step {i + 1} ({name}): params must be an object.")
        for pname, p in spec.params.items():
            if p.get("required", True) and "default" not in p and pname not in params:
                raise SWError(f"step {i + 1} ({name}): missing required parameter '{pname}'.")
        plan.append((name, params))

    done = []
    for i, (name, params) in enumerate(plan):
        try:
            result = call(ctx, name, params)
        except Exception as e:  # noqa: BLE001 — report, never swallow (see module docstring)
            return {
                "part": part or None,
                "status": "failed",
                "completed": len(done),
                "total": len(plan),
                "steps": done,
                "failed_step": {"index": i + 1, "tool": name, "params": params, "error": str(e)},
                "hint": "Fix this step, then resubmit build_part with the REMAINING steps only "
                        "— the steps listed in 'steps' are already applied to the model.",
            }
        done.append({"index": i + 1, "tool": name, "result": result})

    return {
        "part": part or None,
        "status": "ok",
        "completed": len(done),
        "total": len(plan),
        "steps": done,
    }
