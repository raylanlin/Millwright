"""P127 — query.py pure-logic checks (no SolidWorks)."""
from __future__ import annotations

from sw_agent import registry
from sw_agent.tools import query


def test_noise_table_excludes_design_features():
    for real in ("ProfileFeature", "Extrusion", "Cut", "Fillet", "RefPlane", "Chamfer", "MirrorPattern"):
        assert real not in query._NOISE


def test_list_features_has_include_noise_flag():
    spec = registry.TOOLS["list_features"]
    assert "include_noise" in spec.params and spec.params["include_noise"]["default"] is False


class _Mgr:
    def __init__(self, inters):
        self._inters = inters
        self.done = 0
        self.TreatCoincidenceAsInterference = None
        self.IncludeMultibodyPartInterferences = None

    def GetInterferences(self):
        return self._inters

    def GetInterferenceCount(self):
        return len(self._inters or [])

    def Done(self):
        self.done += 1


class _Asm:
    def __init__(self, mgr):
        self.InterferenceDetectionManager = mgr


class _Ctx:
    def __init__(self, mgr):
        self._asm = _Asm(mgr)

    def require(self, doc_type, label):
        return self._asm


def test_check_interference_always_releases_manager():
    mgr = _Mgr(None)
    out = query.check_interference(_Ctx(mgr))
    assert out == {"count": 0, "interferences": []}
    assert mgr.done == 1

    class Inter:
        Volume = 2e-9
        # ruff RUF012: mutable class attribute in a test mock — Inter is constructed once per
        # _Mgr([Inter()]) call, never shared across tests; the lint warns about a footgun
        # that doesn't apply here.
        Components = []  # noqa: RUF012
    mgr2 = _Mgr([Inter()])
    out = query.check_interference(_Ctx(mgr2))
    assert out["count"] == 1 and out["interferences"][0]["volume_mm3"] == 2.0
    assert mgr2.done == 1
