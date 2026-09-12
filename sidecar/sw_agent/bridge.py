"""sw_agent.bridge — SolidWorks COM connection and execution context.

Key conventions:
- Attach to an ALREADY-RUNNING SolidWorks. Never spawn a hidden instance.
- P13: bare ProgID first, then versioned ProgIDs (SW 2017-2026).
- P122: **LATE BINDING is the default again**, with method flagging (typeinfo.py).
  History, so nobody re-fights it:
    P15  late binding raised "'int' object is not callable" → switched to early binding
    P16  early binding exposes some getters as propget → sw_get() reads either form
    P46  early binding: GetBodies2 lives on IPartDoc, model is IModelDoc2 → CastTo ladder
    P116–P120  same wall on IFeature / IRefPlane / ISketch → as_iface/try_member ladder
  The P15 symptom is pywin32 resolving a zero-arg METHOD as a property because its
  speculative Invoke happened to succeed. `CDispatch._FlagAsMethod(name)` fixes exactly
  that, per name. With flagging, late binding has no interface wall at all (IDispatch
  resolves against the live object), so the whole CastTo ladder becomes unnecessary.
  Early binding is still reachable with SW_AGENT_BINDING=early for A/B on a machine.
- P122: every COM call must run on the ComExecutor thread (com_executor.py). Context
  itself is thread-agnostic; server.py routes calls through the executor.
- All tools obtain app / model / managers via Context; "no connection / no document"
  handling lives here, in one place.
"""
from __future__ import annotations

import os
from typing import Any

from sw_agent import typeinfo

# swDocumentTypes_e
DOC_PART = 1
DOC_ASSEMBLY = 2
DOC_DRAWING = 3
DOC_TYPE_NAME = {DOC_PART: "part", DOC_ASSEMBLY: "assembly", DOC_DRAWING: "drawing"}

# P13: real localized plane names (zh-CN). P123 adds runtime discovery on top.
_PLANES = {
    "front": ("Front Plane", "前视基准面"),
    "top": ("Top Plane", "上视基准面"),
    "right": ("Right Plane", "右视基准面"),
}

_PROGIDS = ["SldWorks.Application"] + [f"SldWorks.Application.{n}" for n in range(34, 24, -1)]

BINDING = os.environ.get("SW_AGENT_BINDING", "late").strip().lower()  # late | early

# HRESULTs that mean "the SolidWorks we were attached to is gone" (P125 uses this too)
DEAD_HRESULTS = {
    -2147023174,  # 0x800706BA RPC server unavailable
    -2147023170,  # 0x800706BE remote procedure call failed
    -2147417848,  # 0x80010108 RPC_E_DISCONNECTED object disconnected
    -2147418111,  # 0x80010001 RPC_E_CALL_REJECTED
}


class SWError(Exception):
    """Agent-facing, human-readable error. str(e) is returned as the JSON-RPC error field."""


def hresult(e: Exception):
    v = getattr(e, "hresult", None)
    if isinstance(v, int):
        return v
    args = getattr(e, "args", ())
    if args and isinstance(args[0], int):
        return args[0]
    return None


def is_dead_connection(e: Exception) -> bool:
    return hresult(e) in DEAD_HRESULTS


def sw_get(obj, name: str, *args):
    """Read a SolidWorks member that may surface as a method OR a property.

    Under early binding some no-arg getters are propgets; under late binding an
    unflagged zero-arg method may come back as its value. Either way: if the attribute
    is callable, call it; otherwise return it. Only for NO-ARG or fully-given-arg reads.
    """
    attr = getattr(obj, name)
    return attr(*args) if callable(attr) else attr


def as_iface(obj, *ifaces):
    """Make members of `ifaces` reachable on `obj`. Returns (obj, note) — never raises.

    Late binding (default): there is no interface wall; flag the interfaces' methods so
    zero-arg ones invoke as methods, and hand the same object back.
    Early binding: the P120 ladder — CastTo(iface) → dynamic IDispatch off _oleobj_.
    """
    if typeinfo.is_late_bound(obj):
        n = typeinfo.flag_methods(obj, *ifaces)
        return obj, f"late-bound (flagged {n})"
    # P122+patch: as_iface carries the "never raises" contract (P116/P118). On a
    # sandbox without pywin32 (Linux CI), the late-bound branch returns False and we
    # would land here with no win32com to import — degrade to as-is with a note,
    # matching the existing CastTo/dynamic failure path below.
    try:
        import win32com.client as wc
    except ImportError:
        return obj, "as-is (win32com unavailable)"
    notes = []
    for iface in ifaces:
        try:
            cast = wc.CastTo(obj, iface)
            if cast is not None and cast is not False:
                return cast, f"CastTo({iface})"
            notes.append(f"CastTo({iface})->{cast!r}")
        except Exception as e:  # noqa: BLE001
            notes.append(f"CastTo({iface}) {e.__class__.__name__}")
    try:
        from win32com.client import dynamic
        raw = getattr(obj, "_oleobj_", None)
        if raw is not None:
            return dynamic.Dispatch(raw), "dynamic IDispatch"
    except Exception as e:  # noqa: BLE001
        notes.append(f"dynamic {e.__class__.__name__}")
    return obj, ("as-is (" + "; ".join(notes) + ")") if notes else "as-is"


def try_member(obj, name: str, *ifaces, args=()):
    """Read `name` off `obj`, re-binding/flagging through as_iface() if needed.
    Returns (value, note); value None on failure, note carries the real reason."""
    try:
        return sw_get(obj, name, *args), "direct"
    except Exception as e_direct:  # noqa: BLE001
        first = f"direct: {e_direct!r}"
    rebound, how = as_iface(obj, *ifaces)
    try:
        if typeinfo.is_late_bound(rebound):
            typeinfo.flag_members(rebound, name)
        return sw_get(rebound, name, *args), f"via {how}"
    except Exception as e:  # noqa: BLE001
        return None, f"{first}; via {how}: {e!r}"


class Context:
    """Per-session execution context. Long-lived so multi-step tool calls reuse the same COM connection."""

    def __init__(self) -> None:
        self._app = None
        self._model = None          # P122: flagged ActiveDoc cache (same underlying object → reuse)
        self._model_key = None
        self.scratch: dict[str, Any] = {}

    # ---- Connection ----
    def _connect(self):
        import win32com.client
        try:
            import pythoncom
            pythoncom.CoInitialize()  # idempotent; the executor thread already did this
        except Exception:  # noqa: BLE001
            pass
        errors: list[str] = []
        raw = None
        # P73: Dispatch covers ROT + class-factory in one call (SW is a singleton server)
        try:
            raw = win32com.client.dynamic.Dispatch("SldWorks.Application")
        except Exception as e:  # noqa: BLE001
            errors.append(f"SldWorks.Application (Dispatch): {e}")
        if raw is None:
            for progid in _PROGIDS:
                try:
                    raw = win32com.client.GetActiveObject(progid)
                    break
                except Exception as e:  # noqa: BLE001
                    errors.append(f"{progid}: {e}")
        if raw is None:
            primary = errors[0] if errors else "unknown"
            raise SWError(
                "Cannot connect to SolidWorks: make sure SolidWorks is running and has been opened at least once. "
                f"(primary: {primary})"
            )
        if BINDING == "early":
            try:
                from win32com.client import gencache
                return gencache.EnsureDispatch(raw)
            except Exception:  # noqa: BLE001 — makepy unavailable → late anyway
                pass
        app = win32com.client.dynamic.Dispatch(getattr(raw, "_oleobj_", raw))
        typeinfo.flag_methods(app, "ISldWorks")
        return app

    @property
    def sw(self):
        if self._app is None:
            self._app = self._connect()
        return self._app

    def reconnect(self):
        self._app = None
        self._model = None
        self._model_key = None
        typeinfo.invalidate()
        return self.sw

    def call_guarded(self, fn):
        """Run fn(); if the connection is dead (P125), reconnect once and retry."""
        try:
            return fn()
        except Exception as e:
            if not is_dead_connection(e):
                raise
            self.reconnect()
            return fn()

    @property
    def model(self):
        m = self.sw.ActiveDoc
        if m is None:
            self._model = None
            self._model_key = None
            raise SWError("No document is open. Please create or open a document in SolidWorks first.")
        key = getattr(m, "_oleobj_", None)
        if self._model is not None and key is not None and key == self._model_key:
            return self._model
        # New document object: flag the doc interfaces once (the cache keeps it cheap)
        try:
            dt = int(sw_get(m, "GetType"))
        except Exception:  # noqa: BLE001
            dt = 0
        typeinfo.flag_doc(m, dt)
        try:
            typeinfo.flag_methods(m.Extension, "IModelDocExtension")
        except Exception:  # noqa: BLE001
            pass
        self._model, self._model_key = m, key
        return m

    def require(self, doc_type: int, label: str):
        m = self.model
        if sw_get(m, "GetType") != doc_type:
            raise SWError(f"This operation requires a {label} document.")
        return m

    # ---- Version ----
    def sw_info(self) -> dict:
        """RevisionNumber → {revision, major, year}. SW 2025 = 33.x → year = 1992 + major."""
        info: dict = {}
        try:
            rev = str(sw_get(self.sw, "RevisionNumber"))
            info["revision"] = rev
            major = int(rev.split(".")[0])
            info["major"] = major
            info["year"] = 1992 + major
        except Exception as e:  # noqa: BLE001
            info["error"] = str(e)
        return info

    # ---- Managers ----
    @property
    def feat_mgr(self):
        return typeinfo.flagged(self.model.FeatureManager, "IFeatureManager")

    @property
    def sketch_mgr(self):
        return typeinfo.flagged(self.model.SketchManager, "ISketchManager")

    @property
    def sel_mgr(self):
        return typeinfo.flagged(self.model.SelectionManager, "ISelectionMgr")

    # ---- Selection helpers ----
    def clear_selection(self):
        self.model.ClearSelection2(True)

    def selected_count(self) -> int:
        return int(self.sel_mgr.GetSelectedObjectCount2(-1))

    def selected_edge_count(self):
        """P93: (edges, other_types) among the current selection. swSelEDGES = 1... careful:
        swSelectType_e: 1 = EDGES, 2 = FACES, 3 = VERTICES, 4 = DATUMPLANES. The P93
        code compared GetType() of the OBJECT (swSelEDGES=2 in that enum family); keep
        both readings so either install classifies edges correctly."""
        others: set = set()
        try:
            sel = self.sel_mgr
            total = int(sw_get(sel, "GetSelectedObjectCount2", -1))
        except Exception:  # noqa: BLE001
            return 0, others
        edges = 0
        for i in range(1, total + 1):
            typ = -1
            try:
                typ = int(sw_get(sel, "GetSelectedObjectType3", i, -1))
                is_edge = typ == 1
            except Exception:  # noqa: BLE001
                try:
                    obj = sw_get(sel, "GetSelectedObject6", i, -1)
                    typ = int(sw_get(obj, "GetType")) if obj is not None else -1
                    is_edge = typ == 2
                except Exception:  # noqa: BLE001
                    is_edge = False
            if is_edge:
                edges += 1
            else:
                others.add(typ)
        return edges, others

    def select_by_id(self, name, typ, x=0.0, y=0.0, z=0.0, append=False, mark=0) -> bool:
        # P26: Callout must be VARIANT(VT_DISPATCH, None); bare None → DISP_E_TYPEMISMATCH
        return bool(self.model.Extension.SelectByID2(name, typ, x, y, z, append, mark, self._variant_null(), 0))

    def _variant_null(self):
        import pythoncom
        from win32com.client import VARIANT
        return VARIANT(pythoncom.VT_DISPATCH, None)

    def solid_bodies(self):
        """Visible solid bodies of the active part.

        P46 needed a CastTo ladder because early binding hid IPartDoc.GetBodies2. Late
        binding resolves it directly; the ladder is kept only for BINDING=early.
        """
        errs = []

        def _try(owner, label):
            try:
                # ruff B009: getattr + constant attribute is intentional here — late-bound COM
                # objects may raise AttributeError, and direct `owner.GetBodies2` would not be
                # caught cleanly. Keep the getattr.
                fn = getattr(owner, "GetBodies2")  # noqa: B009
            except Exception as ex:  # noqa: BLE001
                errs.append(f"{label}: {ex}")
                return None
            try:
                bodies = fn(0, True)  # swSolidBody, visible only
            except Exception as ex:  # noqa: BLE001
                errs.append(f"{label}: {ex}")
                return None
            if not bodies:
                errs.append(f"{label}: returned no bodies")
                return None
            return list(bodies) if isinstance(bodies, (list, tuple)) else [bodies]

        m = self.model
        got = _try(m, "model")
        if got:
            return got
        if not typeinfo.is_late_bound(m):
            import win32com.client as wc
            try:
                got = _try(wc.CastTo(m, "IPartDoc"), "IPartDoc")
                if got:
                    return got
            except Exception as ex:  # noqa: BLE001
                errs.append(f"CastTo(IPartDoc): {ex}")
            try:
                from win32com.client import dynamic
                got = _try(dynamic.Dispatch(getattr(m, "_oleobj_", m)), "dynamic")
                if got:
                    return got
            except Exception as ex:  # noqa: BLE001
                errs.append(f"dynamic: {ex}")
        raise SWError(
            "could not read the part's solid bodies — create a solid feature first, "
            f"or report this: {'; '.join(errs[-3:])}"
        )

    def all_features(self):
        """Feature-tree listing — flagged so tools may call f.GetTypeName2() etc. directly."""
        try:
            feats = list(self.feat_mgr.GetFeatures(True) or [])
        except Exception:  # noqa: BLE001
            return []
        for f in feats:
            typeinfo.flag_members(f, "GetTypeName2", "GetFaces", "GetSpecificFeature2", "GetDefinition",
                                  "IsSuppressed", "GetErrorCode2", "GetNextFeature", "GetFirstSubFeature")
        return feats

    def doc_state(self) -> dict:
        """P94: lightweight document state appended to every tool result.
        P122 adds `editing_sketch` (the GetEditState gate from just1step) and `sw_year`."""
        state: dict = {"doc": None}
        try:
            m = self.sw.ActiveDoc
            if m is None:
                return state
            m = self.model
            state["doc"] = sw_get(m, "GetTitle")
            state["type"] = doc_type_name(m)
        except Exception:  # noqa: BLE001
            return state
        try:
            state["features"] = len(self.all_features())
        except Exception:  # noqa: BLE001
            pass
        try:
            act = self.sketch_mgr.ActiveSketch
            state["editing_sketch"] = act is not None
        except Exception:  # noqa: BLE001
            pass
        lf = self.scratch.get("last_feature")
        if lf:
            state["last_feature"] = lf
        try:
            edges, others = self.selected_edge_count()
            if edges or others:
                state["selected"] = {"edges": edges}
                if others:
                    state["selected"]["other_types"] = sorted(others)
        except Exception:  # noqa: BLE001
            pass
        y = self.scratch.get("sw_year")
        if y is None:
            y = self.sw_info().get("year")
            self.scratch["sw_year"] = y
        if y:
            state["sw_year"] = y
        return state

    def record_feature_map(self, feat):
        """P99: fingerprint the topology a feature just created (edges by box)."""
        try:
            name = sw_get(feat, "Name")
        except Exception:  # noqa: BLE001
            return
        try:
            faces = list(sw_get(feat, "GetFaces") or [])
        except Exception:  # noqa: BLE001
            faces = []
        seen: set = set()
        for f in faces:
            for loop in (sw_get(f, "GetLoops") or []):
                for e in (sw_get(loop, "GetEdges") or []):
                    fp = edge_fingerprint(e)
                    if fp:
                        seen.add(fp)
        self.scratch.setdefault("feature_map", {})[name] = {
            "faces": len(faces), "edges": len(seen), "fingerprints": sorted(seen),
        }

    def geometry(self):
        """(faces, edges, trace) for the current part — bodies first, feature tree as route B (P49)."""
        faces, edges, trace = [], [], []
        try:
            found = self.solid_bodies()
        except SWError as e:
            found = []
            trace.append(f"bodies: {e}")
        for b in found:
            for member, sink in (("GetFaces", faces), ("GetEdges", edges)):
                try:
                    got = sw_get(b, member) or []
                    sink.extend(list(got) if isinstance(got, (list, tuple)) else [got])
                except Exception as ex:  # noqa: BLE001
                    trace.append(f"body.{member}: {ex}")
        if found:
            trace.append(f"bodies={len(found)} faces={len(faces)} edges={len(edges)}")
        if not faces:
            feats = self.all_features()
            for ft in feats:
                try:
                    got = sw_get(ft, "GetFaces") or []
                except Exception:  # noqa: BLE001
                    continue
                faces.extend(list(got) if isinstance(got, (list, tuple)) else [got])
            trace.append(f"features={len(feats)} faces={len(faces)}")
        if not edges:
            for fa in faces:
                try:
                    got = sw_get(fa, "GetEdges") or []
                except Exception:  # noqa: BLE001
                    continue
                edges.extend(list(got) if isinstance(got, (list, tuple)) else [got])
            trace.append(f"edges-from-faces={len(edges)}")
        for f in faces:
            typeinfo.flag_members(f, "GetEdges", "GetLoops", "GetSurface", "GetBox", "GetArea")
        for e in edges:
            typeinfo.flag_members(e, "GetCurve", "GetCurveParams2", "GetTwoAdjacentFaces2", "GetCurveBox",
                                  "GetStartVertex", "GetEndVertex")
        return faces, edges, trace

    def _face_normal(self, face):
        try:
            n = face.Normal
            if n and len(n) >= 3:
                return (n[0], n[1], n[2])
        except Exception:  # noqa: BLE001
            pass
        try:
            surf = sw_get(face, "GetSurface")
            if sw_get(surf, "IsPlane"):
                p = surf.PlaneParams
                return (p[0], p[1], p[2])
        except Exception:  # noqa: BLE001
            pass
        return None

    def _select_entity(self, ent, append: bool, mark: int) -> bool:
        """P45.1: with a mark, Select2 first (Select4 has no mark parameter)."""
        callout = self._variant_null()
        order = (
            (("Select2", (append, mark)), ("Select4", (append, callout)), ("Select", (append,)))
            if mark
            else (("Select4", (append, callout)), ("Select2", (append, mark)), ("Select", (append,)))
        )
        for member, args in order:
            fn = getattr(ent, member, None)
            if fn is None or not callable(fn):
                continue
            try:
                if fn(*args):
                    return True
            except Exception:  # noqa: BLE001
                continue
        return False

    def ensure_tessellated(self):
        """P122: new feature edges are not selectable by coordinate until a rebuild
        (upstream pitfall #3 — exactly the 'found 4 selected 3' shape of P92). Cheap;
        call once before any coordinate-based SelectByID2."""
        try:
            self.model.ForceRebuild3(True)
        except Exception:  # noqa: BLE001
            pass

    def select_edges(self, which: str = "all", append=False, mark=0) -> int:
        """Edge selection lives in edge_select.py (P86). P122 pre-tessellates."""
        from sw_agent.edge_select import select
        if which != "selected":
            self.ensure_tessellated()
        return select(self, which)

    def select_axis_edge(self, axis: str, append=False, mark=0) -> bool:
        want = {
            "x": (1, 0, 0), "y": (0, 1, 0), "z": (0, 0, 1),
            "up": (0, 1, 0), "depth": (0, 0, 1), "width": (1, 0, 0),
        }.get((axis or "").lower())
        if want is None:
            raise SWError(f"unknown direction: {axis} (expected x/y/z)")
        _faces, edges, _trace = self.geometry()
        for edge in edges:
            kind, d = self._edge_kind(edge)
            if kind != "line":
                continue
            if abs(d[0] * want[0] + d[1] * want[1] + d[2] * want[2]) > 0.95:
                if self._select_entity(edge, append, mark):
                    return True
        return False

    def _edge_kind(self, edge):
        """('line', unit direction) | ('circle', axis) | ('other', None) — from the curve."""
        try:
            curve = sw_get(edge, "GetCurve")
            if sw_get(curve, "IsLine"):
                p = curve.LineParams  # x,y,z, dx,dy,dz
                d = (float(p[3]), float(p[4]), float(p[5]))
                n = (d[0] ** 2 + d[1] ** 2 + d[2] ** 2) ** 0.5 or 1.0
                return "line", (d[0] / n, d[1] / n, d[2] / n)
            if sw_get(curve, "IsCircle"):
                p = curve.CircleParams
                return "circle", (float(p[3]), float(p[4]), float(p[5]))
        except Exception:  # noqa: BLE001
            pass
        # fallback: chord direction from the curve box
        try:
            box = sw_get(edge, "GetCurveBox")
            d = (box[3] - box[0], box[4] - box[1], box[5] - box[2])
            n = (d[0] ** 2 + d[1] ** 2 + d[2] ** 2) ** 0.5 or 1.0
            return "line", (d[0] / n, d[1] / n, d[2] / n)
        except Exception:  # noqa: BLE001
            return "other", None

    def select_cylindrical_face(self, append=False, mark=0) -> bool:
        faces, _edges, _trace = self.geometry()
        for face in faces:
            try:
                if sw_get(sw_get(face, "GetSurface"), "IsCylinder"):
                    if self._select_entity(face, append, mark):
                        return True
            except Exception:  # noqa: BLE001
                continue
        return False

    def select_feature(self, name: str, append=False, mark=0) -> bool:
        for typ in ("BODYFEATURE", "SOLIDBODY", "REFERENCECURVES"):
            if self.select_by_id(name, typ, append=append, mark=mark):
                return True
        return False

    def select_face(self, which: str, append=False, mark=0) -> bool:
        """P44: outermost planar face facing `which` (SolidWorks is Y-UP: top = +Y)."""
        axes = {
            "top": (0, 1, 0), "bottom": (0, -1, 0),
            "front": (0, 0, 1), "back": (0, 0, -1),
            "right": (1, 0, 0), "left": (-1, 0, 0),
        }
        key = (which or "").lower()
        if key not in axes:
            raise SWError(f"unknown face: {which} (expected top/bottom/front/back/left/right)")
        ax, ay, az = axes[key]
        faces, _edges, trace = self.geometry()
        if not faces:
            raise SWError(f"could not read any face of the solid ({'; '.join(trace)})")
        best, best_d = None, None
        for face in faces:
            n = self._face_normal(face)
            if n is None or n[0] * ax + n[1] * ay + n[2] * az < 0.95:
                continue
            try:
                box = sw_get(face, "GetBox")
                d = ((box[0] + box[3]) / 2 * ax + (box[1] + box[4]) / 2 * ay + (box[2] + box[5]) / 2 * az)
            except Exception:  # noqa: BLE001
                d = 0.0
            if best_d is None or d > best_d:
                best, best_d = face, d
        if best is None:
            raise SWError(f"no planar face facing {which} among {len(faces)} faces ({'; '.join(trace)})")
        return self._select_entity(best, append, mark)

    def plane_names(self) -> dict:
        """P122: the three default planes' REAL names on this document, discovered from the
        tree (RefPlane features in creation order), falling back to the EN/zh table."""
        cached = self.scratch.get("plane_names")
        if cached:
            return cached
        names = []
        for f in self.all_features():
            try:
                if sw_get(f, "GetTypeName2") == "RefPlane":
                    names.append(sw_get(f, "Name"))
            except Exception:  # noqa: BLE001
                continue
            if len(names) == 3:
                break
        out = {k: v[0] for k, v in _PLANES.items()}
        if len(names) == 3:
            out = {"front": names[0], "top": names[1], "right": names[2]}
        self.scratch["plane_names"] = out
        return out

    def select_plane(self, which: str, append=False, mark=0) -> bool:
        key = (which or "").lower()
        if key not in _PLANES:
            raise SWError(f"unknown plane: {which} (expected front/top/right)")
        en, zh = _PLANES[key]
        for candidate in dict.fromkeys((self.plane_names().get(key), en, zh)):
            if candidate and self.select_by_id(candidate, "PLANE", append=append, mark=mark):
                return True
        return False

    # ---- Rebuild ----
    def rebuild(self, top_only=False):
        self.model.ForceRebuild3(top_only)


def doc_type_name(model) -> str:
    return DOC_TYPE_NAME.get(sw_get(model, "GetType"), "unknown")


def edge_fingerprint(edge):
    """P99: reference-independent edge key (curve box, 6dp) — shared with edge_select."""
    try:
        box = sw_get(edge, "GetCurveBox")
        if box and len(box) >= 6:
            return ("box", tuple(round(float(v), 6) for v in box[:6]))
    except Exception:  # noqa: BLE001
        pass
    return ("id", id(edge))


def face_fingerprint(face):
    """P123: reference-independent face key (box + area, 6dp)."""
    try:
        box = sw_get(face, "GetBox")
        area = float(sw_get(face, "GetArea"))
        return ("face", tuple(round(float(v), 6) for v in box[:6]), round(area, 9))
    except Exception:  # noqa: BLE001
        return ("id", id(face))
