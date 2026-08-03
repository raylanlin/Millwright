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

# P105: absolute import at MODULE level — a function-level "from ..verify import"
# died with "attempted relative import beyond top-level package" on the bundled
# interpreter (runpy.run_module("sw_agent", run_name="__main__") leaves __package__
# broken for deeper relative hops). Loading at import time also surfaces any verify
# problem at startup instead of at the first build_part call.
from sw_agent.verify import precheck, snapshot, verify_step

from ..bridge import Context, SWError
from ..registry import TOOLS, call, tool

MAX_STEPS = 80

# 批处理里不允许出现的工具:递归、机制类、以及会把当前文档换掉的操作
# (换文档会让后续步骤作用在错误的零件上,是最难排查的一类错误)
_FORBIDDEN = {
    "build_part",
    "new_part", "new_assembly", "new_drawing", "open_document",
    "save_as",
    # P99: assembly tools need an assembly document + interactive selection —
    # build_part auto-creates a PART document (P94), so these would fail on the
    # wrong document type or on an empty selection. Keep batches part-only.
    "insert_component", "add_mate", "suppress_component", "unsuppress_component",
    "list_components",
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
                f"step {index} arrived empty — your provider flattened the nested step objects in "
                "transit, and resending the same shape will fail the same way. Use the steps_text "
                'parameter instead, one step per line: "start_sketch plane=top" / '
                '"sketch_rectangle x=-20 y=-15 width=40 height=30" / "extrude depth=10"'
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


def _steps_from_text(text: str):
    """P87: parse the line-oriented form
    (P88: defined ABOVE the @tool decorator — a helper placed between the decorator and
    `def build_part` gets registered as the tool itself, which is how the second-time
    "unexpected keyword argument 'steps'" happened. The assertion below now guards it.) — "<tool> key=value key=value" per line.

    Why this exists: MiniMax flattens the nested step objects to empty strings on the way
    out, so a correct request arrives as ["", "", ""] however the schema declares itself.
    Three rounds of schema work did not fix that, because the problem is not in the schema
    — the provider simply does not serialise arrays-of-objects faithfully.

    A scalar string does survive, so this is the escape hatch. Values are typed by
    _coerce_values downstream, so "depth=10" arrives as a number.
    """
    steps = []
    for raw in (text or "").replace("|", "\n").splitlines():
        line = raw.strip().lstrip("-").strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        tool = parts[0].rstrip(":,")
        params: dict = {}
        for token in parts[1:]:
            if "=" not in token:
                continue
            k, v = token.split("=", 1)
            params[k.strip()] = v.strip().strip("\"'`,")
        steps.append({"tool": tool, "params": params})
    return steps


@tool(
    "build_part",
    "Build a whole part in ONE call by submitting its complete feature sequence. "
    "STRONGLY PREFERRED over calling sketch/feature tools one at a time: plan the "
    "entire part (dimensions, planes, coordinates, feature order) and submit it here. "
    "Steps run in order and STOP at the first failure, reporting which step failed and "
    "why, so you can fix that one step and resubmit the remainder. All dimensions are "
    "in mm/degrees exactly as with the individual tools.",
    params={
        "steps_text": {
            "type": "string",
            "desc": 'ALTERNATIVE to "steps", one step per line: "<tool> key=value key=value". '
                    'e.g. "start_sketch plane=top | sketch_rectangle x=-20 y=-15 width=40 height=30 | '
                    'extrude depth=10" (newline-separated). Use this if "steps" comes back empty — '
                    'some providers flatten nested arrays in transit, and a plain string survives.',
            "default": "",
        },
        "steps": {
            "type": "array",
            # P98: steps_text-only calls were being rejected by the required-parameter
            # gate — "steps" has no default, so the registry demanded it even when
            # steps_text fully specified the batch. Default [] keeps the gate open;
            # build_part's hollow check then routes to steps_text exactly as designed.
            "default": [],
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
def build_part(ctx: Context, steps=None, steps_text: str = "", part: str = ""):
    # P87: fall back to the line form when the array arrived empty or was never sent.
    hollow = not steps or (
        isinstance(steps, list)
        and all(isinstance(s, str) and not s.strip() for s in steps)
    )
    if steps_text and hollow:
        steps = _steps_from_text(steps_text)
        if not steps:
            raise SWError(
                'steps_text 没有解析出任何步骤。每行一个："<工具名> 参数=值 参数=值"，'
                '例如 "extrude depth=10"。'
            )
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
    # P94: no document open → create one first, then run the batch. Previously the
    # model burned a round-trip: build_part failed with "No document is open", the
    # model called new_part, then resubmitted the whole batch. (new_part stays in
    # _FORBIDDEN for user-supplied steps — it switches the active document, which is
    # exactly why a batch must not contain it — but auto-creating a fresh part when
    # there is NO document at all is always the right thing for build_part.)
    try:
        ctx.model
    except SWError:
        call(ctx, "new_part", {})

    # P95: static pre-check of the whole plan BEFORE touching the model — sequence
    # dependencies (sketch tools need an active sketch, solid tools need a body) and
    # numeric sanity (depth/count/radius must be > 0). A batch that dies halfway
    # because of a bad step leaves a half-built part behind; a batch that never starts
    # because of a bad step costs one round-trip. Refuse up front, tell the model which
    # step and why. (precheck/snapshot/verify_step are imported at module top, P105.)
    issues = precheck(plan)
    if issues:
        return {
            "part": part or None,
            "status": "rejected",
            "completed": 0,
            "total": len(plan),
            "steps": [],
            "rejected": issues,
            "hint": "计划在开跑前被预检拦下（见 rejected）。修好这些问题再整批重提 —— "
                    "预检不通过说明计划本身有错，重发同样的内容还会被拦。",
        }

    before = snapshot(ctx)
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
        # P95: verify the step actually changed the model the way it claims. A tool that
        # reports success while building nothing (silent failure) must be caught HERE,
        # not discovered three steps later by a confused analyze_view.
        after = snapshot(ctx)
        check = verify_step(name, params, before, after)
        if isinstance(result, dict):
            result = dict(result)
            result["_verified"] = check
        done.append({"index": i + 1, "tool": name, "result": result})
        if not check.get("ok", True):
            return {
                "part": part or None,
                "status": "verified_failed",
                "completed": len(done),
                "total": len(plan),
                "steps": done,
                "failed_step": {
                    "index": i + 1, "tool": name, "params": params,
                    "error": "; ".join(check.get("checks", [])),
                    "note": "工具没有抛异常，但几何验证发现它没建成/没改对 —— "
                            "这是静默失败，继续后面的步骤只会建立在错误假设上。",
                },
                "hint": "这一步报告成功但验证不通过。修好这一步再重提剩余步骤；"
                        "如果反复出现，换一种建模方式（例如 sketch_fillet 代替 fillet_edges）。",
            }
        before = after

    return {
        "part": part or None,
        "status": "ok",
        "completed": len(done),
        "total": len(plan),
        "steps": done,
    }
