"""P133 — the SolidWorks the tools drive must be one the user can see; COM objects are
always callable, so sw_get must not call an object it already got back."""
from __future__ import annotations

from sw_agent import bridge
from sw_agent.tools import query


class _ComObj:
    """Stands in for a win32com CDispatch: has _oleobj_, and __call__ hits DISPID_VALUE."""

    _oleobj_ = object()

    def __init__(self, **attrs):
        self.__dict__.update(attrs)

    def __call__(self, *a):
        raise RuntimeError("DISPID_VALUE: member not found")


def test_sw_get_returns_a_com_object_instead_of_calling_it():
    mp = _ComObj(Mass=1.0)
    ext = _ComObj(CreateMassProperty=mp)          # late binding already invoked the method
    assert bridge.sw_get(ext, "CreateMassProperty") is mp
    assert bridge.sw_get(_ComObj(GetTitle=lambda: "零件1"), "GetTitle") == "零件1"  # real method
    assert bridge.sw_get(_ComObj(Mass=2.5), "Mass") == 2.5                         # plain value


def test_mass_properties_with_late_bound_create_mass_property():
    mp = _ComObj(Mass=1.0082, Volume=129258.19e-9, SurfaceArea=0.0251, CenterOfMass=(0.0, 0.0075, 0.0))

    class Ctx:
        model = _ComObj(Extension=_ComObj(CreateMassProperty=mp))

    out = query.mass_properties(Ctx())
    assert out["mass_kg"] == 1.0082
    assert round(out["volume_mm3"]) == 129258
    assert out["center_of_mass_mm"] == [0.0, 7.5, 0.0]


class _App:
    def __init__(self, visible):
        self.Visible = visible
        self.UserControl = False


def test_visible_instance_needs_no_note():
    app = _App(True)
    assert bridge.ensure_visible(app, {100}) is None
    assert app.Visible is True


def test_hidden_second_instance_is_shown_and_reported(monkeypatch):
    monkeypatch.setattr(bridge, "_sw_pids", lambda: {100, 200})   # 200 started by COM
    monkeypatch.setattr(bridge, "_is_elevated", lambda: True)
    app = _App(False)
    note = bridge.ensure_visible(app, {100})
    assert app.Visible is True and app.UserControl is True
    assert "新启动了一个 SolidWorks" in note and "管理员" in note


def test_hidden_only_instance_is_shown(monkeypatch):
    monkeypatch.setattr(bridge, "_sw_pids", lambda: {300})
    app = _App(False)
    note = bridge.ensure_visible(app, set())    # SolidWorks was not running before
    assert app.Visible is True
    assert "新启动" not in note
