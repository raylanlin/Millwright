"""Offline tests for sw_agent — no SolidWorks / pywin32 required.
Covers: registry schema generation, required-param validation, units conversion,
and P13 regression points (plane table, chamfer args, config scope).
Run: pytest sidecar/tests -q
"""
from __future__ import annotations
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from sw_agent import registry, units  # noqa: E402
from sw_agent.bridge import _PLANES, _PROGIDS, SWError  # noqa: E402
# Trigger tool registration
from sw_agent.tools import view, document, sketch, feature, reference, assembly, export, query  # noqa: F401, E402


# ---- units ----

def test_mm_to_m():
    assert units.mm(1000) == 1.0
    assert units.mm(8) == pytest.approx(0.008)

def test_deg_to_rad():
    assert units.deg(180) == pytest.approx(math.pi)

def test_roundtrip():
    assert units.m_to_mm(units.mm(42.5)) == pytest.approx(42.5)
    assert units.m3_to_mm3(1e-9) == pytest.approx(1.0)


# ---- registry / schema ----

def test_tools_registered():
    assert len(registry.TOOLS) >= 26

def test_schema_is_openai_function_format():
    for t in registry.list_tools():
        assert t["type"] == "function"
        fn = t["function"]
        assert fn["name"] and isinstance(fn["description"], str)
        params = fn["parameters"]
        assert params["type"] == "object"
        for req in params["required"]:
            assert req in params["properties"]
        assert set(t["x_meta"]) == {"category", "destructive", "internal"}

def test_destructive_tools_marked():
    destructive = {n for n, s in registry.TOOLS.items() if s.destructive}
    assert {"cut_extrude", "delete_feature", "shell"} <= destructive

def test_call_unknown_tool():
    with pytest.raises(SWError, match="unknown tool"):
        registry.call(None, "no_such_tool", {})

def test_call_missing_required_param():
    with pytest.raises(SWError, match="missing required parameter"):
        registry.call(None, "extrude", {})

def test_params_with_default_are_optional():
    spec = registry.TOOLS["sketch_rectangle"]
    schema = [t for t in registry.list_tools() if t["function"]["name"] == "sketch_rectangle"][0]
    req = schema["function"]["parameters"]["required"]
    assert "width" in req and "height" in req
    assert "x" not in req and "y" not in req
    assert spec.params["x"]["default"] == 0


# ---- P13 regression points ----

def test_planes_have_real_localized_names():
    for en, zh in _PLANES.values():
        assert en != zh, "localized fallback must differ from the English name"
        assert "Plane" in en
        assert "基准面" in zh

def test_progid_list_covers_versions():
    assert _PROGIDS[0] == "SldWorks.Application"
    assert "SldWorks.Application.34" in _PROGIDS
    assert "SldWorks.Application.25" in _PROGIDS


class _RecordingFeatMgr:
    def __init__(self):
        self.calls = []
    def InsertFeatureChamfer(self, *args):
        self.calls.append(("InsertFeatureChamfer", args))
        class F:  # minimal feature stub
            Name = "Chamfer1"
        return F()

class _Dim:
    def __init__(self):
        self.set_args = None
    def SetSystemValue3(self, *args):
        self.set_args = args

class _Model:
    def __init__(self, dim):
        self._dim = dim
        self.rebuilt = False
    def Parameter(self, full):
        return self._dim
    def ForceRebuild3(self, top_only):
        self.rebuilt = True

class _ChamferCtx:
    """Duck-typed Context for offline tool invocation."""
    def __init__(self):
        self.feat_mgr = _RecordingFeatMgr()
        self._dim = _Dim()
        self.model = _Model(self._dim)
    def selected_count(self):
        return 1
    def rebuild(self, top_only=False):
        self.model.ForceRebuild3(top_only)

def test_chamfer_uses_distance_distance_type():
    ctx = _ChamferCtx()
    out = feature.chamfer(ctx, distance=5)
    name, args = ctx.feat_mgr.calls[0]
    assert name == "InsertFeatureChamfer"
    assert args[0] == 2, "type must be 2 (distance-distance), not 1 (angle-distance)"
    assert args[2] == pytest.approx(0.005)   # width in meters
    assert args[3] == 0                       # angle unused
    assert args[4] == pytest.approx(0.005)   # other distance = equal
    assert out["distance_mm"] == 5

def test_modify_dimension_applies_to_all_configs():
    ctx = _ChamferCtx()
    feature.modify_dimension(ctx, feature="Boss-Extrude1", dimension="D1", value=8)
    val, cfg, _ = ctx._dim.set_args
    assert val == pytest.approx(0.008)
    assert cfg == 2, "swInConfigurationOpts_e: 2 = all configurations"
    assert ctx.model.rebuilt
