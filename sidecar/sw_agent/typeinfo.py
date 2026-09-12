"""sw_agent.typeinfo — make LATE-BOUND SolidWorks objects call methods as methods (P122).

## The problem this replaces

P15 switched the bridge to early binding (gencache.EnsureDispatch) because late
binding "misresolved methods as ints": ``model.GetType()`` raised
``'int' object is not callable``. Early binding fixed that and created a worse
problem — every object is bound to ONE interface, and members declared on a
sibling interface do not exist (DISP_E_MEMBERNOTFOUND: P46 IPartDoc.GetBodies2,
P116–P120 IFeature.GetSpecificFeature2 / IRefPlane.Transform / ISketch.ModelTo-
SketchTransform). Four patches built a CastTo/dynamic ladder to climb over that wall.

The 'int' problem has a direct fix that keeps late binding: pywin32's CDispatch
resolves an unknown name speculatively — as a property when the first Invoke
returns a value. ``CDispatch._FlagAsMethod(name)`` tells it to Invoke ``name``
with DISPATCH_METHOD instead. Flag the zero-arg getters we use, and late binding
behaves like the API docs: methods take (), properties don't — and there is no
interface wall, because IDispatch resolves members against the live object.

## Where the method names come from

  1. the makepy wrapper (gen_py) for sldworks.tlb, if a cache exists — read only,
     never used for binding (P72: building it at startup starved the connection)
  2. the curated table below — every zero-arg method the sidecar actually calls,
     so flagging works on a machine that has never run makepy

sw_get() in bridge.py stays as the tolerant reader; flagging just makes the
straightforward ``obj.Method()`` form in tool code correct as well.
"""
from __future__ import annotations

import inspect
import weakref
from typing import Any

from sw_agent.typelib import SW_TYPELIB_GUID

# Curated zero-arg METHODS per interface (things the sidecar calls with `()`).
# Properties (ActiveDoc, Name, Name2, Visible, Extension, FeatureManager, SketchManager,
# SelectionManager, Normal, Transform2, Volume, Components, ActiveSketch, ...) must NOT be
# listed — flagging a property as a method breaks it the other way (pitfall #4 upstream).
CURATED: dict[str, frozenset[str]] = {
    "ISldWorks": frozenset({"RevisionNumber", "GetCurrentLanguage", "GetProcessID", "GetDocumentCount",
                            "GetDocuments", "GetFirstDocument", "ExitApp", "CloseAllDocuments"}),
    "IModelDoc2": frozenset({"GetType", "GetTitle", "GetPathName", "GetActiveConfiguration",
                             "GetConfigurationNames", "GetEquationMgr", "FirstFeature", "IsOpenedReadOnly",
                             "GetSaveFlag", "EditRebuild3", "ViewZoomtofit2", "EditUndo2", "GetUnits",
                             "GetActiveSketch2", "GetSelectionManager", "GetFeatureManager", "ClearSelection2"}),
    "IPartDoc": frozenset({"GetBodies2", "GetPartBox", "GetMaterialPropertyName2", "FeatureByPositionReverse"}),
    "IAssemblyDoc": frozenset({"GetComponents", "GetComponentCount", "GetMates", "ResolveAllLightWeightComponents",
                               "GetLightWeightComponentCount"}),
    "IDrawingDoc": frozenset({"GetFirstView", "GetCurrentSheet", "GetSheetNames", "GetViews"}),
    "IModelDocExtension": frozenset({"GetMassProperties2", "SelectByID2", "CreateMeasure", "GetWhatsWrong",
                                     "CustomPropertyManager", "NeedsRebuild2", "HasDesignTable"}),
    "IFeatureManager": frozenset({"GetFeatures", "GetFeatureCount", "GetFeatureTreeRootItem2"}),
    "IFeature": frozenset({"GetTypeName2", "GetTypeName", "IsSuppressed", "GetSpecificFeature2", "GetDefinition",
                           "GetFaces", "GetNextFeature", "GetFirstSubFeature", "GetNextSubFeature",
                           "GetErrorCode2", "GetParents", "GetChildren", "GetDisplayDimensions",
                           "GetNameForSelection", "IsSuppressed2", "GetUpdateStamp"}),
    "ISketch": frozenset({"GetSketchSegments", "GetSketchPoints2", "GetSketchRegionCount", "GetSketchRegions",
                          "GetReferenceEntity", "IsDerived", "GetSketchContours", "GetRelationCount"}),
    "ISketchManager": frozenset({"InsertSketch", "CreateLine", "CreateCircleByRadius", "CreateCenterRectangle",
                                 "CreateCornerRectangle", "CreatePolygon", "CreateArc", "CreateCenterLine",
                                 "CreateFillet", "SketchUseEdge3"}),
    "ISketchSegment": frozenset({"GetType", "GetLength", "GetSketch", "GetName", "GetCurve", "GetStartPoint2",
                                 "GetEndPoint2", "GetCenterPoint2", "GetRadius"}),
    "ISelectionMgr": frozenset({"GetSelectedObjectCount2", "GetSelectedObject6", "GetSelectedObjectType3",
                                "CreateSelectData", "GetSelectedObjectMark", "GetSelectedObjectsComponent4"}),
    "IBody2": frozenset({"GetFaces", "GetEdges", "GetVertices", "GetFaceCount", "GetEdgeCount", "GetVertexCount",
                         "GetMassProperties", "GetBodyBox", "GetType", "GetFirstFace", "IsTemporaryBody"}),
    "IFace2": frozenset({"GetEdges", "GetLoops", "GetSurface", "GetBox", "GetArea", "GetEdgeCount", "GetLoopCount",
                         "GetFeature", "GetBody", "GetFaceId", "GetTessTriangles", "GetTessNorms", "GetFirstLoop",
                         "IGetFirstLoop", "GetUVBounds", "GetTrimCurves2", "FaceInSurfaceSense"}),
    "IEdge": frozenset({"GetCurve", "GetCurveParams2", "GetCurveParams3", "GetTwoAdjacentFaces2", "GetStartVertex",
                        "GetEndVertex", "GetCurveBox", "GetBody", "GetLength", "GetClosestPointOn", "Evaluate"}),
    "ILoop2": frozenset({"GetEdges", "GetEdgeCount", "IsOuter", "GetFace", "GetFirstCoEdge"}),
    "ISurface": frozenset({"IsPlane", "IsCylinder", "IsCone", "IsSphere", "IsTorus"}),
    "ICurve": frozenset({"IsLine", "IsCircle", "IsEllipse", "IsBcurve", "GetEndParams", "Evaluate2",
                         "GetLength3"}),
    "IVertex": frozenset({"GetPoint", "GetEdges", "GetEdgeCount"}),
    "IComponent2": frozenset({"GetModelDoc2", "GetPathName", "GetChildren", "GetChildrenCount", "IsSuppressed",
                              "IsFixed", "GetBox", "GetBody", "GetConstrainedStatus", "GetSelectByIDString",
                              "GetReferencedConfiguration", "IsLoaded", "IsRoot", "IsHidden", "GetVisibility"}),
    "IMathTransform": frozenset({"Inverse", "IInverse", "Multiply"}),
    "IRefPlane": frozenset({"Transform"}),
    "IDisplayDimension": frozenset({"GetDimension2", "GetDimension", "GetNameForSelection"}),
    "IDimension": frozenset({"GetSystemValue3", "GetValue3", "SetSystemValue3", "IsReference", "GetToleranceType"}),
    "IInterferenceDetectionMgr": frozenset({"GetInterferenceCount", "GetInterferences", "Done"}),
    "IInterference": frozenset({"GetComponentCount"}),
    "IMeasure": frozenset({"Calculate"}),
    "IConfiguration": frozenset({"GetParent", "GetChildrenCount", "GetChildren", "IsDerived"}),
    "IView": frozenset({"GetName2", "GetNextView", "GetDisplayDimensionCount", "GetDisplayDimensions",
                        "GetFirstDisplayDimension5", "GetReferencedModelName", "GetOrientationName",
                        "GetOutline", "GetPosition", "GetPolylines7", "GetDisplayMode2"}),
    "IEquationMgr": frozenset({"GetCount", "GetEquationCount"}),
    "ICustomPropertyManager": frozenset({"GetNames", "GetCount", "GetAll3"}),
}

DOC_TYPE_TO_INTERFACES: dict[int, tuple[str, ...]] = {
    1: ("IModelDoc2", "IPartDoc"),
    2: ("IModelDoc2", "IAssemblyDoc"),
    3: ("IModelDoc2", "IDrawingDoc"),
}

_wrapper_methods: dict[str, frozenset[str]] | None = None
# id(obj) -> (weakref, flagged interface names). The weakref makes the id key sound:
# CPython reuses addresses eagerly, so a fresh dispatch at a dead one's address must
# not inherit "already flagged".
_flag_cache: dict[int, tuple[Any, set[str]]] = {}


def _load_wrapper_methods() -> dict[str, frozenset[str]]:
    """Method names per interface from the gen_py wrapper — read-only, never generated."""
    global _wrapper_methods
    if _wrapper_methods is not None:
        return _wrapper_methods
    out: dict[str, frozenset[str]] = {}
    try:
        from win32com.client import DispatchBaseClass, gencache  # type: ignore
        mod = None
        for major in range(36, 24, -1):
            try:
                mod = gencache.GetModuleForTypelib(SW_TYPELIB_GUID, 0, major, 0)
            except Exception:  # noqa: BLE001
                mod = None
            if mod is not None:
                break
        if mod is not None:
            for name in dir(mod):
                cls = getattr(mod, name, None)
                if not (inspect.isclass(cls) and issubclass(cls, DispatchBaseClass)):
                    continue
                names = {a for a, v in vars(cls).items() if not a.startswith("_") and callable(v)}
                if names:
                    out[name] = frozenset(names)
    except Exception:  # noqa: BLE001 — no pywin32 / no cache: curated table only
        pass
    _wrapper_methods = out
    return out


def method_names(interface: str) -> frozenset[str]:
    """Curated ∪ wrapper names for one interface."""
    return CURATED.get(interface, frozenset()) | _load_wrapper_methods().get(interface, frozenset())


def _already(obj: Any) -> set[str]:
    key = id(obj)
    entry = _flag_cache.get(key)
    if entry is not None:
        ref, names = entry
        if ref is None or ref() is obj:
            return names
        del _flag_cache[key]
    names: set[str] = set()
    try:
        _flag_cache[key] = (weakref.ref(obj), names)
    except TypeError:
        pass  # not weak-referenceable: flag every time, correct if slower
    return names


def is_late_bound(obj: Any) -> bool:
    # P122+patch: hasattr() only swallows AttributeError. is_late_bound is a COM probe
    # called from try_member / as_iface, which carry the P116/P118 "never raises"
    # contract. Any other exception (e.g. _MemberNotFound raised by mock COM objects
    # in tests, TypeError from hasattr(None, ...), or win32 edge cases) must degrade
    # to False, not propagate. Tested by sidecar/tests/test_refplane.py::TestTryMember.
    try:
        return hasattr(obj, "_FlagAsMethod")
    except Exception:  # noqa: BLE001
        return False


def flag_methods(obj: Any, *interfaces: str) -> int:
    """Flag every method of the given interfaces on ``obj``. Safe to repeat; no-op on
    early-bound / non-COM objects. Returns the number of names flagged."""
    if obj is None or not is_late_bound(obj):
        return 0
    done = _already(obj)
    new = [i for i in interfaces if i not in done]
    if not new:
        return 0
    names: set[str] = set()
    for i in new:
        names |= method_names(i)
    n = 0
    for name in names:
        try:
            obj._FlagAsMethod(name)
            n += 1
        except Exception:  # noqa: BLE001
            pass
    done.update(new)
    return n


def flag_members(obj: Any, *names: str) -> int:
    """Flag a handful of names — for short-lived objects inside loops (cheaper than a
    whole interface)."""
    if obj is None or not is_late_bound(obj):
        return 0
    n = 0
    for name in names:
        try:
            obj._FlagAsMethod(name)
            n += 1
        except Exception:  # noqa: BLE001
            pass
    return n


def flagged(obj: Any, *interfaces: str) -> Any:
    """flag_methods then return obj — call-chain friendly."""
    if obj is not None:
        flag_methods(obj, *interfaces)
    return obj


def flag_doc(obj: Any, doc_type: int) -> int:
    return flag_methods(obj, *DOC_TYPE_TO_INTERFACES.get(doc_type, ("IModelDoc2",)))


def invalidate(obj: Any | None = None) -> None:
    if obj is None:
        _flag_cache.clear()
    else:
        _flag_cache.pop(id(obj), None)
