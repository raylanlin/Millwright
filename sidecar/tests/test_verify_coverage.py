"""P121 — 完备性门禁：每个注册工具必须被 verify.classify 认领。

P96（为 start_sketch 写的验证分支被 _SKIP 拦成死代码）和 P100（sketch_rounded_
rectangle 上线三个版本无人验证）是同一类失败：工具注册表（registry）和验证分类
表（verify）是两张平行的人肉维护表，没有任何机制保证同步。这里把「忘了分类」
从静默的验证缺口变成 CI 失败——新工具不登记分类就合不进主干。

纯逻辑，不需要 SolidWorks / pywin32（typelib 的 winreg 已改为惰性导入，P121）。
"""
from __future__ import annotations

from sw_agent import registry, verify

# 触发全部 17 个工具模块的注册 —— 与 server.py 的导入清单一致；漏一个模块，
# 它的工具就不在 registry.TOOLS 里，门禁等于没看它
from sw_agent.tools import (  # noqa: F401
    assembly,
    batch,
    diagnose,
    document,
    drawing,
    export,
    feature,
    guidance,
    machine,
    query,
    reference,
    search,
    shell,
    sketch,
    status,
    view,
)


def test_every_tool_is_classified():
    missing = sorted(n for n in registry.TOOLS if verify.classify(n) is None)
    assert not missing, (
        f"unclassified tools: {missing} — 每个工具必须出现在 verify.py 的某一张表里 "
        "(_FEATURE_CREATORS / _SKETCH_ADDERS / _QUERY_ONLY / _SKIP / _META / …)。"
        "没被认领的工具会同时逃过 precheck 和 server 级验证——「不验证」必须是"
        "显式决定，不是遗忘的默认值。"
    )


def test_no_tool_in_two_kinds():
    """一个工具落进两张表会让 classify 按遍历顺序悄悄二选一 —— 禁止。"""
    seen: dict = {}
    for kind, names in verify._KINDS:
        for n in names:
            assert n not in seen, f"{n} 同时被分类为 {seen[n]} 和 {kind}"
            seen[n] = kind


def test_mutating_kinds_are_real_kinds():
    kinds = {k for k, _ in verify._KINDS}
    assert verify.MUTATING_KINDS <= kinds


def test_mutating_tools_get_real_verification():
    """MUTATING_KINDS 里的每个工具，verify_step 必须真的检查（checked: True）——
    否则 server 白付两次快照，还给出「已验证」的假印象。用空快照对拍即可：
    这里测的是分支覆盖，不是几何。"""
    empty = {"features": [], "box": None, "sketch_active": None,
             "sketch_segments": None, "bodies": None}
    for name in sorted(registry.TOOLS):
        if verify.classify(name) in verify.MUTATING_KINDS:
            out = verify.verify_step(name, {}, dict(empty), dict(empty))
            assert out.get("checked") is True, (
                f"{name} 被分类为 mutating，但 verify_step 没有对它做任何检查"
            )


def test_query_tools_are_never_snapshotted():
    for name in ("bounding_box", "list_features", "sw_status", "read_guidance", "build_part"):
        if name in registry.TOOLS:
            assert verify.classify(name) not in verify.MUTATING_KINDS
