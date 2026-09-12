"""P124 — quantitative verify_step, pure logic."""
from __future__ import annotations

from sw_agent import verify


def _snap(**kw):
    base = {"features": [], "suppressed": [], "box": None, "sketch_active": None, "sketch_segments": None,
            "bodies": None, "volume": None, "area": None, "com": None, "components": None, "transforms": None}
    base.update(kw)
    return base


def test_extrude_must_add_volume():
    b = _snap(features=["S1"], volume=0.0, bodies=0)
    a = _snap(features=["S1", "Boss-Extrude1"], volume=3e-5, bodies=1)
    assert verify.verify_step("extrude", {}, b, a)["ok"] is True
    a2 = _snap(features=["S1", "Boss-Extrude1"], volume=0.0, bodies=0)
    out = verify.verify_step("extrude", {}, b, a2)
    assert out["ok"] is False and any("没有增加" in c for c in out["checks"])


def test_cut_must_remove_volume_even_interior():
    box = [0, 0, 0, 0.05, 0.03, 0.02]
    b = _snap(features=["B"], volume=3e-5, bodies=1, box=box)
    a = _snap(features=["B", "Cut-Extrude1"], volume=2.9e-5, bodies=1, box=box)  # box unchanged
    assert verify.verify_step("cut_extrude", {}, b, a)["ok"] is True
    a2 = _snap(features=["B", "Cut-Extrude1"], volume=3e-5, bodies=1, box=box)
    out = verify.verify_step("cut_extrude", {}, b, a2)
    assert out["ok"] is False and any("方向反" in c for c in out["checks"])


def test_fillet_any_volume_change_ok_but_zero_is_not():
    b = _snap(features=["B"], volume=3e-5, bodies=1)
    assert verify.verify_step("fillet_edges", {}, b, _snap(features=["B", "F1"], volume=2.99e-5, bodies=1))["ok"]
    assert not verify.verify_step("fillet_edges", {}, b, _snap(features=["B", "F1"], volume=3e-5, bodies=1))["ok"]


def test_assembly_insert_and_mate():
    b = _snap(components=["A-1"], transforms={"A-1": [1] * 12})
    a = _snap(components=["A-1", "B-1"], transforms={"A-1": [1] * 12, "B-1": [0] * 12})
    assert verify.verify_step("insert_component", {}, b, a)["ok"]
    assert not verify.verify_step("insert_component", {}, b, b)["ok"]
    moved = _snap(components=["A-1"], transforms={"A-1": [2] * 12})
    out = verify.verify_step("add_mate", {}, b, moved)
    assert out["ok"] and any("移动" in c for c in out["checks"])


def test_delete_and_suppress():
    b = _snap(features=["S1", "B1", "F1"])
    a = _snap(features=["S1", "B1"])
    assert verify.verify_step("delete_feature", {"name": "F1"}, b, a)["ok"]
    assert not verify.verify_step("delete_feature", {"name": "F1"}, b, b)["ok"]
    s = _snap(features=["S1", "B1", "F1"], suppressed=["F1"])
    assert verify.verify_step("suppress_feature", {"name": "F1"}, b, s)["ok"]
    assert verify.verify_step("unsuppress_feature", {"name": "F1"}, s, b)["ok"]
    assert not verify.verify_step("suppress_feature", {"name": "F1"}, b, b)["ok"]


def test_new_kinds_are_mutating_and_classified():
    for n in ("insert_component", "add_mate", "delete_feature", "suppress_feature", "unsuppress_feature"):
        assert verify.classify(n) in verify.MUTATING_KINDS
    for n in ("feature_diagnostics", "edit_state"):
        assert verify.classify(n) == "query"
    assert verify.classify("diagnose_document") == "doc"
