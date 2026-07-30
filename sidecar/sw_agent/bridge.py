"""sw_agent.bridge — SolidWorks COM connection and execution context.

Key conventions:
- Use GetActiveObject to connect to an **already-running** instance. Never
  CreateObject (that would spawn a hidden SolidWorks, and every subsequent
  operation would silently succeed against an invisible target).
- P13: attach tries the bare ProgID first, then every versioned ProgID
  (SW 2017-2026) — same fix as the VBS AttachSW(). On many installs only
  the versioned ProgID is registered in the ROT.
- P15: connect via EARLY BINDING (gencache.EnsureDispatch) so members resolve
  from the typelib. Dynamic binding misresolved methods as ints
  ("'int' object is not callable").
- P16: even under early binding, a number of SolidWorks *no-argument* getters
  are declared as PROPERTIES (propget) in the typelib — GetPathName→str,
  GetInterferences→tuple, GetType→int, IsSuppressed→bool. Calling those with
  `()` raises "'<type>' object is not callable". `sw_get()` reads a member
  tolerantly (invoke if it's a method, return the value if it's a property),
  so tool code no longer has to know which is which per SW version.
- All tools obtain app / model / the various Managers via Context. The
  "no connection / no document" error handling lives here, in one place.
"""
from __future__ import annotations

from typing import Any

# swDocumentTypes_e
DOC_PART = 1
DOC_ASSEMBLY = 2
DOC_DRAWING = 3
DOC_TYPE_NAME = {DOC_PART: "part", DOC_ASSEMBLY: "assembly", DOC_DRAWING: "drawing"}

# P13: real localized plane names (the old table had English in BOTH slots,
# so the "localized fallback" never actually fell back — start_sketch failed
# on Chinese SolidWorks templates).
_PLANES = {
    "front": ("Front Plane", "前视基准面"),
    "top": ("Top Plane", "上视基准面"),
    "right": ("Right Plane", "右视基准面"),
}

# Bare ProgID first, then versioned (SW 2026 → 2017)
_PROGIDS = ["SldWorks.Application"] + [f"SldWorks.Application.{n}" for n in range(34, 24, -1)]


class SWError(Exception):
    """Agent-facing, human-readable error. str(e) is returned as the JSON-RPC error field."""


def sw_get(obj, name: str, *args):
    """Read a SolidWorks member that the typelib may expose as either a method
    OR a propget.

    Early binding resolves some no-arg 'Get*'/'Is*'/'Name*' accessors as
    properties, whose value is returned on plain attribute access; calling
    those with () raises "'<type>' object is not callable" (str/tuple/int/bool).
    This tolerates both forms. Only use for NO-ARG getters (arg-taking members
    like GetComponents(True) / SelectByID2(...) are always real methods).
    """
    attr = getattr(obj, name)
    return attr(*args) if callable(attr) else attr


class Context:
    """Per-session execution context. Long-lived so multi-step tool calls reuse the same COM connection."""

    def __init__(self) -> None:
        self._app = None
        self.scratch: dict[str, Any] = {}  # Inter-tool scratchpad (e.g. the feature name created in the previous step)

    # ---- Connection ----
    def _connect(self):
        import win32com.client
        # P24: defensively initialize COM on THIS thread. If the calling thread was
        # never CoInitialize'd, every GetActiveObject fails with confusing errors.
        try:
            import pythoncom
            pythoncom.CoInitialize()
        except Exception:  # noqa: BLE001 — already initialized is fine
            pass
        errors: list[str] = []

        # P73: win32com.client.Dispatch internally calls GetActiveObject FIRST, then
        # falls back to CoCreateInstance if the object isn't in the ROT. For SolidWorks
        # (a singleton COM server), CoCreateInstance returns the running instance.
        # https://timgolden.me.uk/python/win32_how_do_i/attach-to-a-com-instance.html
        # https://stackoverflow.com/questions/74670195
        #
        # We try Dispatch FIRST because it covers both ROT and class-factory paths in
        # one call. The manual GetActiveObject loop below is kept as a fallback for
        # version-specific ProgIDs and gencache early binding.
        try:
            raw = win32com.client.Dispatch("SldWorks.Application")
        except Exception as e_dispatch:  # noqa: BLE001
            errors.append(f"SldWorks.Application (Dispatch): {e_dispatch}")
        else:
            try:
                from win32com.client import gencache
                return gencache.EnsureDispatch(raw)
            except Exception:  # noqa: BLE001 — makepy unavailable
                return raw

        # Fallback: try version-specific ProgIDs via GetActiveObject (ROT only).
        # Some SolidWorks installs register the versioned ProgID in the ROT but not
        # the bare one; this catches that case.
        for progid in _PROGIDS:
            try:
                raw = win32com.client.GetActiveObject(progid)
            except Exception as e:  # noqa: BLE001
                errors.append(f"{progid}: {e}")
                continue
            # P15: prefer early binding so members resolve from the typelib.
            try:
                from win32com.client import gencache
                return gencache.EnsureDispatch(raw)
            except Exception:  # noqa: BLE001 — makepy unavailable → degrade to dynamic dispatch
                return raw

        # P24: report the BARE-ProgID error (the meaningful one) — the old code
        # reported the LAST versioned ProgID's error ("invalid class string" for an
        # unregistered .25), masking the real failure cause.
        primary = errors[0] if errors else "unknown"
        raise SWError(
            "Cannot connect to SolidWorks: make sure SolidWorks is running and has been opened at least once. "
            f"(primary: {primary})"
        )

    @property
    def sw(self):
        if self._app is None:
            self._app = self._connect()
        return self._app

    def reconnect(self):
        self._app = None
        return self.sw

    @property
    def model(self):
        m = self.sw.ActiveDoc
        if m is None:
            raise SWError("No document is open. Please create or open a document in SolidWorks first.")
        return m

    def require(self, doc_type: int, label: str):
        m = self.model
        if sw_get(m, "GetType") != doc_type:
            raise SWError(f"This operation requires a {label} document.")
        return m

    # ---- Common Managers ----
    @property
    def feat_mgr(self):
        return self.model.FeatureManager

    @property
    def sketch_mgr(self):
        return self.model.SketchManager

    @property
    def sel_mgr(self):
        return self.model.SelectionManager

    # ---- Selection helpers ----
    def clear_selection(self):
        self.model.ClearSelection2(True)

    def selected_count(self) -> int:
        return self.model.SelectionManager.GetSelectedObjectCount2(-1)

    def select_by_id(self, name, typ, x=0.0, y=0.0, z=0.0, append=False, mark=0) -> bool:
        # P26: under early binding the Callout param ([in] IDispatch*) must be a
        # VARIANT(VT_DISPATCH, None) — a bare None raises DISP_E_TYPEMISMATCH
        # (0x80020005), which broke start_sketch / every selection-based tool.
        import pythoncom
        from win32com.client import VARIANT
        callout = VARIANT(pythoncom.VT_DISPATCH, None)
        return bool(
            self.model.Extension.SelectByID2(name, typ, x, y, z, append, mark, callout, 0)
        )

    def _variant_null(self):
        import pythoncom
        from win32com.client import VARIANT
        return VARIANT(pythoncom.VT_DISPATCH, None)

    def solid_bodies(self):
        """P46: GetBodies2 is declared on **IPartDoc**, not IModelDoc2 — and under early
        binding `self.model` is typed as IModelDoc2, so the member simply isn't there
        ('<unknown>.GetBodies2'). Reaching it needs an explicit CastTo, or plain
        IDispatch. Previously the failure was swallowed and an empty list returned,
        which surfaced as the misleading "no vertical edges found on the solid" even
        though the part was sitting right there on screen.
        """
        errs = []

        def _try(owner, label):
            fn = getattr(owner, "GetBodies2", None)
            if fn is None:
                errs.append(f"{label}: member absent")
                return None
            try:
                bodies = fn(0, True)  # 0 = swSolidBody, True = visible only
            except Exception as ex:  # noqa: BLE001
                errs.append(f"{label}: {ex}")
                return None
            if not bodies:
                errs.append(f"{label}: returned no bodies")
                return None
            return list(bodies) if isinstance(bodies, (list, tuple)) else [bodies]

        import win32com.client as wc

        # a) the properly-typed IPartDoc interface
        try:
            got = _try(wc.CastTo(self.model, "IPartDoc"), "IPartDoc")
            if got:
                return got
        except Exception as ex:  # noqa: BLE001
            errs.append(f"CastTo(IPartDoc): {ex}")

        # b) plain IDispatch — resolves members the typed wrapper is missing
        try:
            from win32com.client import dynamic
            raw = getattr(self.model, "_oleobj_", self.model)
            got = _try(dynamic.Dispatch(raw), "dynamic")
            if got:
                return got
        except Exception as ex:  # noqa: BLE001
            errs.append(f"dynamic: {ex}")

        # c) as-is (works when the doc was late-bound to begin with)
        got = _try(self.model, "model")
        if got:
            return got

        raise SWError(
            "could not read the part's solid bodies — create a solid feature first, "
            f"or report this: {'; '.join(errs[-3:])}"
        )

    def all_features(self):
        """Feature-tree listing — works on installs where body enumeration doesn't."""
        try:
            return list(self.feat_mgr.GetFeatures(True) or [])
        except Exception:  # noqa: BLE001
            return []

    def geometry(self):
        """P49: return (faces, edges, trace) for the current part.

        Two independent routes, because IBody2.GetFaces/GetEdges came back EMPTY on a
        real install even though the solid was plainly on screen — which surfaced as the
        nonsense "no edges matched" / "no planar face facing top". Route B uses the same
        call list_features already proves works there. `trace` carries per-route counts,
        so any failure reports what was actually tried.
        """
        faces, edges, trace = [], [], []

        # Route A — solid bodies
        try:
            found = self.solid_bodies()
        except SWError as e:
            found = []
            trace.append(f"bodies: {e}")
        for b in found:
            for member, sink in (("GetFaces", faces), ("GetEdges", edges)):
                try:
                    got = getattr(b, member)() or []
                    sink.extend(list(got) if isinstance(got, (list, tuple)) else [got])
                except Exception as ex:  # noqa: BLE001
                    trace.append(f"body.{member}: {ex}")
        if found:
            trace.append(f"bodies={len(found)} faces={len(faces)} edges={len(edges)}")

        # Route B — faces off the feature tree
        if not faces:
            feats = self.all_features()
            for ft in feats:
                try:
                    got = ft.GetFaces() or []
                except Exception:  # noqa: BLE001 — folders and datums have no faces
                    continue
                faces.extend(list(got) if isinstance(got, (list, tuple)) else [got])
            trace.append(f"features={len(feats)} faces={len(faces)}")

        # Edges off whatever faces we ended up with
        if not edges:
            for fa in faces:
                try:
                    got = fa.GetEdges() or []
                except Exception:  # noqa: BLE001
                    continue
                edges.extend(list(got) if isinstance(got, (list, tuple)) else [got])
            trace.append(f"edges-from-faces={len(edges)}")

        return faces, edges, trace

    def _face_normal(self, face):
        """Outward normal of a planar face — IFace2.Normal, else the plane's own params."""
        try:
            n = face.Normal
            if n and len(n) >= 3:
                return (n[0], n[1], n[2])
        except Exception:  # noqa: BLE001
            pass
        try:
            surf = face.GetSurface()
            if surf.IsPlane():
                p = surf.PlaneParams  # normal xyz, then a point on the plane
                return (p[0], p[1], p[2])
        except Exception:  # noqa: BLE001
            pass
        return None

    def _select_entity(self, ent, append: bool, mark: int) -> bool:
        """P45.1: when a MARK is required, Select2 must come first — IEntity::Select4
        takes (Append, Callout) and has no mark parameter, so preferring it silently
        dropped every mark to 0. Patterns and mirror distinguish "the feature" from
        "the direction / mirror plane" purely by mark, so they reported
        "produced nothing" no matter what was selected."""
        callout = self._variant_null()
        order = (
            (("Select2", (append, mark)), ("Select4", (append, callout)), ("Select", (append,)))
            if mark
            else (("Select4", (append, callout)), ("Select2", (append, mark)), ("Select", (append,)))
        )
        for member, args in order:
            fn = getattr(ent, member, None)
            if fn is None:
                continue
            try:
                if fn(*args):
                    return True
            except Exception:  # noqa: BLE001
                continue
        return False

    def _edge_kind(self, edge):
        """Classify an edge: ('line', unit-direction) | ('circle', radius) | (None, None).

        Three routes, because ICurve is not reachable on every install. GetCurve() is the
        clean way, but on this machine it resolves to nothing and EVERY edge came back
        unclassifiable — "read 12 edges but could not classify any" — which then pushed the
        model into hand-writing macros just to round four corners.

        The fallbacks read the edge's two VERTICES instead. That is enough to recognise a
        straight edge and its direction, which is all vertical/horizontal need, and it goes
        through plain IDispatch. (An edge with no distinct end vertices closes on itself,
        i.e. a circle — so even that case is inferable.)
        """
        def unit(dx, dy, dz):
            n = (dx * dx + dy * dy + dz * dz) ** 0.5
            return None if n < 1e-9 else (dx / n, dy / n, dz / n)

        # Route A — the curve object, when the typelib exposes it
        try:
            curve = edge.GetCurve()
            if curve.IsLine():
                p = curve.LineParams          # x,y,z, dx,dy,dz
                d = unit(p[3], p[4], p[5])
                if d:
                    return "line", d
            if curve.IsCircle():
                return "circle", curve.CircleParams[6]
        except Exception:  # noqa: BLE001 — fall through to the vertex routes
            pass

        # Route B — end vertices; a straight edge's direction is simply p2 - p1
        try:
            v1 = edge.GetStartVertex()
            v2 = edge.GetEndVertex()
            if v1 is None or v2 is None:
                box = edge.GetCurveBox() if hasattr(edge, "GetCurveBox") else None
                if box:
                    return "circle", max(box[3] - box[0], box[4] - box[1], box[5] - box[2]) / 2.0
                return "circle", None
            p1, p2 = v1.GetPoint(), v2.GetPoint()
            d = unit(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2])
            if d:
                return "line", d
        except Exception:  # noqa: BLE001
            pass

        # Route C — the vertex-params form some releases expose instead
        try:
            sp = edge.GetStartVertexParams()
            ep = edge.GetEndVertexParams()
            d = unit(ep[0] - sp[0], ep[1] - sp[1], ep[2] - sp[2])
            if d:
                return "line", d
        except Exception:  # noqa: BLE001
            pass

        # Route D — IGetCurveParams2 returns curve type + parameters as SAFEARRAY of
        # doubles. No COM ICurve / IVertex objects needed at all, which is why it
        # works on installs where GetCurve() and GetStartVertex() both resolve to
        # nothing (the first three routes).
        # Params layout:
        #   LINE:    [startPt(3), endPt(3), startU, endU, paramA, paramB]
        #            → direction = endPt - startPt
        #   CIRCLE:  [center(3), axis(3), radius, startU, endU, paramA, paramB]
        #   ARC:     same layout as CIRCLE
        #   ELLIPSE:  radius is major-axis radius
        try:
            params = edge.IGetCurveParams2()
            if not params:
                return None, None
            # The first element is a tuple of curve-data doubles. len varies by type.
            data = params[0] if isinstance(params, tuple) else params
            n = len(data)
            if n >= 9:  # LINE: 3+3+3 = at least 9
                d = unit(data[3] - data[0], data[4] - data[1], data[5] - data[2])
                if d:
                    return "line", d
            if n >= 10:  # CIRCLE/ARC/ELLIPSE
                r = data[9] if n > 9 else data[6]
                if isinstance(r, (int, float)) and r > 0:
                    return "circle", r
        except Exception:  # noqa: BLE001
            pass

        return None, None

    def select_edges(self, which: str = "all", append=False, mark=0) -> int:
        """Select edges BY DESCRIPTION: vertical / horizontal / circular / all."""
        key = (which or "all").lower()
        if key not in ("vertical", "horizontal", "circular", "all"):
            raise SWError(f"unknown edge set: {which} (expected vertical/horizontal/circular/all)")
        _faces, edges, trace = self.geometry()
        if not edges:
            raise SWError(f"could not read any edge of the solid ({'; '.join(trace)})")
        n, unread = 0, 0
        first = not append
        for edge in edges:
            kind, info = self._edge_kind(edge)
            if kind is None:
                unread += 1
                continue
            # "vertical" = along the model's UP axis, which is Y in SolidWorks
            if key == "vertical" and not (kind == "line" and abs(info[1]) > 0.95):
                continue
            if key == "horizontal" and not (kind == "line" and abs(info[1]) < 0.05):
                continue
            if key == "circular" and kind != "circle":
                continue
            if self._select_entity(edge, append or not first, mark):
                n += 1
                first = False
        if n == 0 and unread == len(edges):
            raise SWError(
                f"read {len(edges)} edges but none could be classified — neither ICurve nor the "
                f"edge vertices were reachable on this SolidWorks. "
                f"({'; '.join(trace)})"
            )
        return n

    def select_axis_edge(self, axis: str, append=False, mark=0) -> bool:
        """Select a straight edge running along x/y/z — used as a pattern direction."""
        # P45.1: accept plain axis names AND the intuitive ones (up = Y, depth = Z)
        want = {
            "x": (1, 0, 0), "y": (0, 1, 0), "z": (0, 0, 1),
            "up": (0, 1, 0), "depth": (0, 0, 1), "width": (1, 0, 0),
        }.get((axis or "").lower())
        if want is None:
            raise SWError(f"unknown direction: {axis} (expected x/y/z)")
        _faces, edges, _trace = self.geometry()
        for edge in edges:
            if True:
                kind, d = self._edge_kind(edge)
                if kind != "line":
                    continue
                if abs(d[0] * want[0] + d[1] * want[1] + d[2] * want[2]) > 0.95:
                    if self._select_entity(edge, append, mark):
                        return True
        return False

    def select_cylindrical_face(self, append=False, mark=0) -> bool:
        """Select a cylindrical face — SolidWorks accepts it as a rotation axis."""
        faces, _edges, _trace = self.geometry()
        for face in faces:
            if True:
                try:
                    if face.GetSurface().IsCylinder():
                        if self._select_entity(face, append, mark):
                            return True
                except Exception:  # noqa: BLE001
                    continue
        return False

    def select_feature(self, name: str, append=False, mark=0) -> bool:
        """Select a feature by its feature-tree name (BODYFEATURE)."""
        for typ in ("BODYFEATURE", "SOLIDBODY", "REFERENCECURVES"):
            if self.select_by_id(name, typ, append=append, mark=mark):
                return True
        return False

    def select_face(self, which: str, append=False, mark=0) -> bool:
        """P44: select the outermost planar face of the solid facing `which`.

        Sketching straight onto a model face is how people actually model — without
        it every feature above the base needed a hand-computed offset plane, which
        is why complex parts ended up littered with 基准面N and mis-positioned
        geometry. Picks the planar face whose normal points along the requested
        axis and which sits furthest along it, then selects it so InsertSketch
        starts a sketch right there.
        """
        # P45.1: SolidWorks world space is Y-UP — the Front plane is XY (normal +Z),
        # Top is XZ (normal +Y), Right is YZ (normal +X). The first cut of this code
        # assumed Z-up, so face="top" hunted for the FRONT face of the part.
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
            if n is None:
                continue
            if n[0] * ax + n[1] * ay + n[2] * az < 0.95:   # not facing the requested way
                continue
            try:
                box = face.GetBox()   # xmin,ymin,zmin,xmax,ymax,zmax
                d = ((box[0] + box[3]) / 2 * ax + (box[1] + box[4]) / 2 * ay
                     + (box[2] + box[5]) / 2 * az)
            except Exception:  # noqa: BLE001
                d = 0.0
            if best_d is None or d > best_d:
                best, best_d = face, d
        if best is None:
            raise SWError(
                f"no planar face facing {which} among {len(faces)} faces ({'; '.join(trace)})"
            )

        return self._select_entity(best, append, mark)

    def select_plane(self, which: str, append=False, mark=0) -> bool:
        """Select a reference plane; auto-handles both English and localized (zh-CN) templates."""
        key = (which or "").lower()
        if key not in _PLANES:
            raise SWError(f"unknown plane: {which} (expected front/top/right)")
        en, zh = _PLANES[key]
        if self.select_by_id(en, "PLANE", append=append, mark=mark):
            return True
        return self.select_by_id(zh, "PLANE", append=append, mark=mark)

    # ---- Rebuild ----
    def rebuild(self, top_only=False):
        self.model.ForceRebuild3(top_only)


def doc_type_name(model) -> str:
    return DOC_TYPE_NAME.get(sw_get(model, "GetType"), "unknown")
