"""P123 — topology helpers, pure logic (no SolidWorks)."""
from __future__ import annotations

from sw_agent import registry
from sw_agent.tools import topology as tp


def test_filter_near_k_axis_kind():
    items = [
        {"i": 0, "kind": "line", "mid_mm": [0, 0, 0], "direction": [1, 0, 0]},
        {"i": 1, "kind": "line", "mid_mm": [10, 0, 0], "direction": [0, 1, 0]},
        {"i": 2, "kind": "circle", "center_mm": [1, 0, 0], "axis": [0, 0, 1]},
    ]
    out = tp._filter([dict(j) for j in items], near=[0.5, 0, 0], k=2, axis=None, kind="", dir_key="direction")
    assert [j["i"] for j in out] == [0, 2] and out[0]["dist_mm"] == 0.5
    out = tp._filter([dict(j) for j in items], None, 0, axis=[0, 1, 0], kind="", dir_key="direction")
    assert [j["i"] for j in out] == [1]
    out = tp._filter([dict(j) for j in items], None, 0, None, kind="circle", dir_key="direction")
    assert [j["i"] for j in out] == [2]


def test_apply_xform_identity_and_translation():
    ident = [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 6, 7, 1, 0, 0, 0]
    assert tp._apply_xform(ident, [1, 2, 3]) == [6, 8, 10]
    assert tp._apply_xform(None, [1, 2, 3]) == [1, 2, 3]
    assert tp._rot_xform(ident, [0, 0, 1]) == [0, 0, 1]


def test_array_params_emit_items():
    spec = registry.TOOLS["select_entities"]
    schema = registry._schema(spec)
    props = schema["function"]["parameters"]["properties"]
    assert props["faces"]["type"] == "array" and props["faces"]["items"] == {"type": "number"}
    assert "faces" not in schema["function"]["parameters"]["required"]


def test_new_tools_registered():
    for n in ("list_faces", "list_edges", "get_selection", "select_entities", "sketch_on_face"):
        assert n in registry.TOOLS
