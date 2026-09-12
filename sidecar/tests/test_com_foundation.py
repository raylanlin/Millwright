"""P122 — ComExecutor / typeinfo pure-logic tests (no pywin32 needed)."""
from __future__ import annotations

import threading

import pytest
from sw_agent import typeinfo
from sw_agent.com_executor import ComExecutor


def test_executor_runs_on_one_thread_and_propagates_results():
    ex = ComExecutor("t")
    ex.start()
    try:
        ids = {ex.run(lambda: threading.get_ident()) for _ in range(5)}
        assert len(ids) == 1
        assert ids.pop() != threading.get_ident()
        assert ex.run(lambda: 6 * 7) == 42
    finally:
        ex.stop()
    assert not ex.alive


def test_executor_propagates_exceptions_and_survives():
    ex = ComExecutor("t")
    ex.start()
    try:
        with pytest.raises(ZeroDivisionError):
            ex.run(lambda: 1 / 0)
        assert ex.run(lambda: "still alive") == "still alive"
    finally:
        ex.stop()


def test_executor_is_reentrant_from_worker():
    ex = ComExecutor("t")
    ex.start()
    try:
        # run() called from inside a job must execute inline, not deadlock
        assert ex.run(lambda: ex.run(lambda: "inner")) == "inner"
    finally:
        ex.stop()


class _FakeDispatch:
    """Looks like a pywin32 CDispatch: has _FlagAsMethod, rejects unknown names."""

    def __init__(self, known):
        self.known = set(known)
        self.flagged = []

    def _FlagAsMethod(self, name):
        if name not in self.known:
            # ruff TRY002: bare Exception is intentional in this mock — it's a test double,
            # not product code, and re-raising a custom hierarchy would only obscure intent.
            raise Exception("Unknown name")  # noqa: TRY002
        self.flagged.append(name)


def test_flag_methods_flags_only_known_names_and_caches():
    obj = _FakeDispatch({"GetType", "GetTitle"})
    n = typeinfo.flag_methods(obj, "IModelDoc2")
    assert n == 2 and set(obj.flagged) == {"GetType", "GetTitle"}
    assert typeinfo.flag_methods(obj, "IModelDoc2") == 0  # cached
    assert typeinfo.flag_methods(obj, "IPartDoc") == 0    # nothing known there, but no error


def test_flag_methods_noop_on_early_bound_objects():
    class Early:  # no _FlagAsMethod
        pass
    assert typeinfo.flag_methods(Early(), "IModelDoc2") == 0
    assert typeinfo.flag_doc(None, 1) == 0


def test_curated_table_has_no_known_properties():
    props = {"ActiveDoc", "Name", "Name2", "Visible", "Extension", "FeatureManager", "SketchManager",
             "SelectionManager", "Normal", "Transform2", "Volume", "Components", "ActiveSketch",
             "ArrayData", "PlaneParams", "CircleParams", "LineParams", "FullName", "AddToDB"}
    for iface, names in typeinfo.CURATED.items():
        assert not (names & props), f"{iface} lists a property as a method: {names & props}"
