"""sw_agent.tools.sketch — sketch: enter/exit + entities + relations/dimensions.

All coordinate / dimension inputs are in mm; internally units.mm() converts
to meters. Most entity methods (CreateCornerRectangle / CreateCircle /
CreateLine / CreateArc / CreatePolygon) are stable across SolidWorks
versions with well-defined signatures.

P13: add_dimension's SetSystemValue3 config arg corrected — 1 = this
configuration ONLY (the comment claimed "all"); 2 = all configurations.
"""
from __future__ import annotations

try:
    from itertools import pairwise
except ImportError:  # Python 3.9 -- pairwise landed in 3.10
    def pairwise(it):
        seq = list(it)
        return zip(seq, seq[1:])

import math

from .. import units
from ..bridge import Context, SWError, sw_get
from ..registry import tool

# swInConfigurationOpts_e
CFG_ALL = 2


class _direct_geometry:
    """P65: draw generated geometry straight into the sketch database.

    Multiple CreateLine/CreateArc calls otherwise wake up SolidWorks' automatic relation
    inference, which snaps near-coincident endpoints together, adds horizontal/vertical
    constraints and can invent driving dimensions. On a computed profile that is not
    help — it rewrites the geometry. (On the gear it deleted teeth and left the contour
    open, so the extrude failed.) AddToDB skips inference entirely and is much faster;
    DisplayWhenAdded off avoids a redraw per entity. Both are restored on the way out.
    """

    def __init__(self, sk):
        self.sk = sk
        self.prev_add = True
        self.prev_disp = True

    def __enter__(self):
        try:
            self.prev_add = bool(self.sk.AddToDB)
            self.prev_disp = bool(self.sk.DisplayWhenAdded)
        except Exception:  # noqa: BLE001 — write-only on some releases
            pass
        try:
            self.sk.AddToDB = True
            self.sk.DisplayWhenAdded = False
        except Exception:  # noqa: BLE001
            pass
        return self.sk

    def __exit__(self, *exc):
        try:
            self.sk.AddToDB = self.prev_add
            self.sk.DisplayWhenAdded = self.prev_disp
        except Exception:  # noqa: BLE001
            pass
        return False


def _segment_ids(ctx: Context) -> set:
    """Identity of every segment currently in the active sketch, for rollback."""
    try:
        active = ctx.sketch_mgr.ActiveSketch
        segs = active.GetSketchSegments() if active is not None else None
        return {id(s) for s in (segs or [])}
    except Exception:  # noqa: BLE001
        return set()


def _delete_new_segments(ctx: Context, before: set) -> int:
    """P65: remove whatever this call added. A profile that failed halfway used to leave
    stray lines in the sketch — the model would then try to extrude a broken contour, or
    the user would find debris in a part they thought was clean."""
    removed = 0
    try:
        active = ctx.sketch_mgr.ActiveSketch
        segs = list(active.GetSketchSegments() or []) if active is not None else []
        ctx.clear_selection()
        for s in segs:
            if id(s) in before:
                continue
            try:
                if s.Select4(True, None):
                    removed += 1
            except Exception:  # noqa: BLE001
                try:
                    if s.Select(True):
                        removed += 1
                except Exception:  # noqa: BLE001
                    continue
        if removed:
            ctx.model.EditDelete()
        ctx.clear_selection()
    except Exception:  # noqa: BLE001 — cleanup is best-effort; the error below matters more
        pass
    return removed


def _sketch_extent(ctx: Context):
    """Width/height of the active sketch's geometry in mm, or (None, None) if unreadable."""
    try:
        active = ctx.sketch_mgr.ActiveSketch
        segs = list(active.GetSketchSegments() or []) if active is not None else []
        xs, ys = [], []
        for s in segs:
            for attr in ("GetCurveBox", "GetBox"):
                fn = getattr(s, attr, None)
                if fn is None:
                    continue
                try:
                    b = fn()
                except Exception:  # noqa: BLE001
                    continue
                if b and len(b) >= 6:
                    xs.extend((units.m_to_mm(b[0]), units.m_to_mm(b[3])))
                    ys.extend((units.m_to_mm(b[1]), units.m_to_mm(b[4])))
                    break
        if not xs:
            return None, None
        return max(xs) - min(xs), max(ys) - min(ys)
    except Exception:  # noqa: BLE001
        return None, None


def _arc_centre(p1, p2, radius: float):
    """Centre of the arc of |radius| from p1 to p2, plus its sweep direction.

    Sign convention (the one CAD users expect): a POSITIVE radius bulges to the right of
    travel, a negative radius to the left. Always the minor arc — with |R| fixed the two
    candidate centres are the two sides, and picking the minor arc is what "fillet this
    corner with R5" means. The alternative (exposing a raw 1/-1 direction flag, as
    sketch_arc_center did) is a coin flip the model loses half the time, producing the
    major arc and an unusable profile.
    """
    (x1, y1), (x2, y2) = p1, p2
    dx, dy = x2 - x1, y2 - y1
    d = math.hypot(dx, dy)
    r = abs(radius)
    if d < 1e-9:
        raise SWError("an arc needs two distinct endpoints.")
    if r < d / 2 - 1e-9:
        raise SWError(
            f"radius {r} is too small to span {d:.3f}mm between those points — "
            f"it must be at least {d / 2:.3f}."
        )
    h = math.sqrt(max(r * r - (d / 2) ** 2, 0.0))
    mx, my = (x1 + x2) / 2, (y1 + y2) / 2
    # unit normal to the left of travel
    nx, ny = -dy / d, dx / d
    if radius >= 0:
        return (mx + h * nx, my + h * ny), 1     # centre left  → CCW → bulges right
    return (mx - h * nx, my - h * ny), -1        # centre right → CW  → bulges left


def _require_sketch(ctx: Context):
    if ctx.sketch_mgr.ActiveSketch is None:
        raise SWError("not currently editing a sketch; call start_sketch first.")


@tool(
    "start_sketch",
    "Start a sketch and enter edit mode. Prefer face=\"top\" etc. to sketch directly ON the model "
    "(like clicking a face in SolidWorks) — no offset plane needed; use plane= only for the very "
    "first sketch or when you genuinely need a datum plane",
    params={
        "plane": {"type": "string", "desc": "front / top / right, or the name of a plane you created (e.g. 基准面1)", "default": ""},
        "face": {"type": "string", "enum": ["top", "bottom", "front", "back", "left", "right"], "desc": "Sketch on the solid's outermost planar face in this direction (e.g. top = the current top face of the part)", "default": ""},
    },
    category="sketch",
)
def start_sketch(ctx: Context, plane: str = "", face: str = ""):
    ctx.clear_selection()
    # P44: face= sketches straight onto the model, the way a person would click the
    # face. Only fall through to datum planes when no face was requested.
    if face:
        if not ctx.select_face(face):
            raise SWError(f"failed to select the {face} face of the solid.")
        ctx.sketch_mgr.InsertSketch(True)
        try:
            active = ctx.sketch_mgr.ActiveSketch
            if active is not None:
                ctx.scratch["last_sketch"] = sw_get(active, "Name")
        except Exception:  # noqa: BLE001
            pass
        return {"sketch_on": f"face:{face}"}

    if not plane:
        raise SWError("give either plane= (front/top/right or a datum plane name) or face= (top/bottom/front/back/left/right).")
    key = (plane or "").strip()
    # P100: "last" resolves to the plane the most recent create_plane returned —
    # the name goes through scratch, so the next step never has to guess "基准面1".
    if key.lower() == "last":
        key = ctx.scratch.get("last_plane", "")
        if not key:
            raise SWError('plane="last" 需要先 create_plane（当前没有最近创建的基准面）')
    ok = ctx.select_plane(key) if key.lower() in ("front", "top", "right") else False
    if not ok:
        # P37: sketch on ANY reference plane in the tree. Previously only the three
        # default planes worked, so a plane the agent had just created with
        # create_plane ("基准面1") failed with "unknown plane".
        ok = bool(ctx.select_by_id(key, "PLANE"))
    if not ok:
        raise SWError(
            f"failed to select plane: {plane} — use front/top/right, "
            "or an existing plane name (list_features shows RefPlane entries)"
        )
    ctx.sketch_mgr.InsertSketch(True)
    # P32: remember this sketch's feature name so extrude/cut can target it after
    # the sketch is exited, without relying on feature-tree traversal.
    try:
        active = ctx.sketch_mgr.ActiveSketch
        if active is not None:
            ctx.scratch["last_sketch"] = sw_get(active, "Name")
    except Exception:  # noqa: BLE001 — best-effort
        pass
    return {"sketch_on": plane}


@tool("exit_sketch", "Exit the current sketch", params={}, category="sketch")
def exit_sketch(ctx: Context):
    if ctx.sketch_mgr.ActiveSketch is not None:
        ctx.sketch_mgr.InsertSketch(True)
    return {"exited": True}


@tool(
    "sketch_rectangle", "Draw a rectangle (lower-left corner + width/height)",
    params={
        "x": {"type": "number", "desc": "Lower-left X (mm)", "default": 0},
        "y": {"type": "number", "desc": "Lower-left Y (mm)", "default": 0},
        "width": {"type": "number", "desc": "Width (mm)"},
        "height": {"type": "number", "desc": "Height (mm)"},
    },
    category="sketch",
)
def sketch_rectangle(ctx: Context, width: float, height: float, x: float = 0, y: float = 0):
    _require_sketch(ctx)
    ctx.sketch_mgr.CreateCornerRectangle(
        units.mm(x), units.mm(y), 0, units.mm(x + width), units.mm(y + height), 0
    )
    return {"rectangle": {"x": x, "y": y, "w": width, "h": height}}


@tool(
    "sketch_circle", "Draw a circle (center + radius)",
    params={
        "x": {"type": "number", "desc": "Center X (mm)", "default": 0},
        "y": {"type": "number", "desc": "Center Y (mm)", "default": 0},
        "radius": {"type": "number", "desc": "Radius (mm)"},
    },
    category="sketch",
)
def sketch_circle(ctx: Context, radius: float, x: float = 0, y: float = 0):
    _require_sketch(ctx)
    # P110: warn loudly when the requested circle would land far outside the current
    # sketch's bounds. The issue-1 failure: the model placed a hole at x=105 on a
    # 120mm plate centred at the origin (range -60..+60), SolidWorks then rejected
    # the WHOLE cut with "profile may not overlap the solid" — one out-of-bounds
    # circle silently killed all three holes. A bounds check makes the mistake
    # visible at DRAW time instead of at CUT time.
    ex_w, ex_h = _sketch_extent(ctx)
    if ex_w is not None and ex_h is not None and ex_w > 0 and ex_h > 0:
        # centre of the existing geometry, plus half-extent as a loose fence
        cx, cy = ex_w / 2, ex_h / 2
        r = float(radius)
        margin = max(ex_w, ex_h) * 0.5 + r * 3
        if abs(x) > margin or abs(y) > margin:
            return {
                "circle": {"x": x, "y": y, "r": radius},
                "warning": (
                    f"⚠️ 圆 ({x}, {y}) r{radius} 可能超出当前草图范围 "
                    f"(现有几何约 {ex_w:.0f}×{ex_h:.0f}mm，中心约 ({cx:.0f},{cy:.0f}))。"
                    "如果它不在实体轮廓内，后续切除会整个失败——请先确认坐标相对草图中心"
                    "而不是相对某条边。"
                ),
            }
    ctx.sketch_mgr.CreateCircle(units.mm(x), units.mm(y), 0, units.mm(x + radius), units.mm(y), 0)
    # P69: confirm the circle actually landed. A circle that reports success but is not
    # on the solid produces the most misleading failure we have seen: the cut then fails
    # with "the sketch profile may not overlap the solid", which reads like a planning
    # mistake when in fact the geometry never arrived. Comparing the sketch extent
    # against the requested diameter catches it at the source.
    got_w, got_h = _sketch_extent(ctx)
    want = 2.0 * float(radius)
    if got_w is not None and max(got_w, got_h) < want * 0.5:
        raise SWError(
            f"the circle was requested at ({x}, {y}) r{radius} but the sketch measures only "
            f"{got_w:.1f}x{got_h:.1f}mm — the geometry did not reach the sketch. Re-open the "
            "sketch with start_sketch and draw it again; do not cut against this sketch."
        )

    return {"circle": {"x": x, "y": y, "r": radius}}


@tool(
    "sketch_rounded_rectangle",
    "Draw a rectangle with all four corners rounded to the same radius — one call, exact "
    "outer size (= 边角矩形 + 草图圆角). Use this for plates and blocks with rounded corners "
    "instead of working out arc tangent points by hand",
    params={
        "x": {"type": "number", "desc": "Lower-left X (mm) of the OVERALL rectangle", "default": 0},
        "y": {"type": "number", "desc": "Lower-left Y (mm) of the OVERALL rectangle", "default": 0},
        "width": {"type": "number", "desc": "Overall width (mm) — the finished part measures exactly this"},
        "height": {"type": "number", "desc": "Overall height (mm)"},
        "radius": {"type": "number", "desc": "Corner radius (mm); must be less than half the shorter side"},
    },
    category="sketch",
)
def sketch_rounded_rectangle(ctx: Context, width: float, height: float, radius: float,
                             x: float = 0, y: float = 0):
    """P97: a rounded rectangle whose outer dimensions are exactly what was asked for.

    Doing this through sketch_polyline means working out where each arc is TANGENT to the
    straight edges — eight coordinates that all have to agree. Getting them wrong does not
    fail loudly: the arcs simply bulge past the corner and the part comes out 80.196 wide
    where 80 was intended. That happened on a plate here and survived unnoticed, because
    the extrude succeeded and only a bounding-box reading caught the 0.196mm.

    Tangent points are arithmetic, so the tool should do the arithmetic.
    """
    _require_sketch(ctx)
    if width <= 0 or height <= 0:
        raise SWError("width 和 height 必须大于 0。")
    r = float(radius)
    if r <= 0:
        raise SWError("radius 必须大于 0；不需要圆角请用 sketch_rectangle。")
    if r >= min(width, height) / 2:
        raise SWError(
            f"radius {r} 太大：四个 R{r} 圆角要求短边大于 {2 * r}，"
            f"而当前短边是 {min(width, height)}。"
        )

    x2, y2 = x + width, y + height
    before = _segment_ids(ctx)
    try:
        with _direct_geometry(ctx.sketch_mgr) as sk:
            # 四条直边各在两端让出一个 r，再用四段真圆弧接上；端点共用同一组坐标，
            # 所以轮廓精确闭合，外形尺寸就是 width × height
            for p1, p2 in (
                ((x + r, y), (x2 - r, y)),
                ((x2, y + r), (x2, y2 - r)),
                ((x2 - r, y2), (x + r, y2)),
                ((x, y2 - r), (x, y + r)),
            ):
                if sk.CreateLine(units.mm(p1[0]), units.mm(p1[1]), 0.0,
                                 units.mm(p2[0]), units.mm(p2[1]), 0.0) is None:
                    raise SWError("直边绘制失败。")
            for start, end, centre in (
                ((x2 - r, y), (x2, y + r), (x2 - r, y + r)),
                ((x2, y2 - r), (x2 - r, y2), (x2 - r, y2 - r)),
                ((x + r, y2), (x, y2 - r), (x + r, y2 - r)),
                ((x, y + r), (x + r, y), (x + r, y + r)),
            ):
                if sk.CreateArc(units.mm(centre[0]), units.mm(centre[1]), 0.0,
                                units.mm(start[0]), units.mm(start[1]), 0.0,
                                units.mm(end[0]), units.mm(end[1]), 0.0, 1) is None:
                    raise SWError("圆角圆弧绘制失败。")
    except SWError:
        cleaned = _delete_new_segments(ctx, before)
        raise SWError(f"圆角矩形绘制失败，已清理 {cleaned} 段残留。请检查尺寸。") from None

    return {
        "rounded_rectangle": {"x": x, "y": y, "width": width, "height": height, "radius": r},
        "segments": 8, "closed": True, "extent_mm": [width, height],
    }


@tool(
    "sketch_polyline",
    "Draw a CLOSED contour (triangle, trapezoid, any polygon) in one call — use this instead "
    "of several sketch_line calls, which leave the profile open and make extrude fail",
    params={
        "points": {
            "type": "string",
            "desc": "Corner coordinates in mm, e.g. \"30,15 30,50 55,15\" — the contour is closed back to the first point automatically",
        },
    },
    category="sketch",
)
def sketch_polyline(ctx: Context, points: str):
    """P45: three separate sketch_line calls did NOT weld their endpoints, so every
    triangular rib failed with "no closed sketch" no matter how the numbers were
    written. One call draws the whole loop with shared endpoints.

    P65: segments may now be ARCS, so a profile with rounded ends (slots, con-rod eyes,
    cam outlines) is drawn as real arc geometry instead of being faked with short chords.
    Prefix a point with `r<radius>:` to reach it along an arc:

        "0,0 60,0 r10:60,20 0,20"      → three straight sides, one R10 arc
        "0,0 r-8:40,0"                 → single arc bulging the other way

    Positive radius bulges right of travel, negative left; always the minor arc.
    """
    _require_sketch(ctx)
    # re-join into tokens of the form [r<radius>:]x,y
    tokens = [t for t in (points or "").replace("\n", " ").split() if t]
    if len(tokens) < 2:
        raise SWError('give at least two points, e.g. "0,0 40,0 40,20 0,20".')

    parsed = []  # (point, radius_or_None)
    for tok in tokens:
        radius = None
        body = tok
        if ":" in tok:
            head, body = tok.split(":", 1)
            head = head.strip().lower()
            if not head.startswith("r"):
                raise SWError(f'bad segment prefix "{head}" — use r<radius>: for an arc, e.g. r10:40,20.')
            try:
                radius = float(head[1:])
            except ValueError:
                raise SWError(f'bad arc radius in "{tok}".') from None
            if radius == 0:
                raise SWError("arc radius cannot be 0.")
        part = body.split(",")
        if len(part) != 2:
            raise SWError(f'bad point "{tok}" — use x,y (arcs: r10:x,y).')
        try:
            parsed.append(((float(part[0]), float(part[1])), radius))
        except ValueError:
            raise SWError(f'bad point "{tok}" — coordinates must be numbers.') from None
    if parsed[0][1] is not None:
        raise SWError("the FIRST point starts the loop, so it cannot carry an arc radius.")

    pts = [p for p, _ in parsed]
    closed = math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) < 1e-9
    loop = parsed if closed else parsed + [(pts[0], None)]

    before = _segment_ids(ctx)
    made = 0
    try:
        with _direct_geometry(ctx.sketch_mgr) as sk:
            for (p1, _), (p2, radius) in pairwise(loop):
                if radius is None:
                    seg = sk.CreateLine(units.mm(p1[0]), units.mm(p1[1]), 0.0,
                                        units.mm(p2[0]), units.mm(p2[1]), 0.0)
                else:
                    centre, ccw = _arc_centre(p1, p2, radius)
                    seg = sk.CreateArc(
                        units.mm(centre[0]), units.mm(centre[1]), 0.0,
                        units.mm(p1[0]), units.mm(p1[1]), 0.0,
                        units.mm(p2[0]), units.mm(p2[1]), 0.0,
                        ccw,
                    )
                if seg is None:
                    raise SWError(
                        f"segment {made + 1} of {len(loop) - 1} failed "
                        f"({'arc' if radius is not None else 'line'} to {p2[0]},{p2[1]})."
                    )
                made += 1
    except SWError:
        # P65: never leave half a profile behind for someone else to trip over
        cleaned = _delete_new_segments(ctx, before)
        raise SWError(
            f"polyline failed after {made} segment(s); removed {cleaned} partial "
            f"segment(s) so the sketch is clean. Check the coordinates and retry."
        ) from None

    # P67: verify the drawn geometry matches the numbers we were given. An earlier arc
    # profile came out as a ~7940mm blob instead of an 80x50 plate — the extrude then
    # "succeeded", so nothing failed until the part was measured. Generated geometry must
    # be checked, not assumed: compare the sketch's extents against the input points.
    want_w = max(p[0] for p in pts) - min(p[0] for p in pts)
    want_h = max(p[1] for p in pts) - min(p[1] for p in pts)
    arc_r = max((abs(r) for _, r in parsed if r), default=0.0)
    tol = max(2.0 * arc_r, 1.0) + 0.5      # an arc may bulge up to its radius past a point
    got_w, got_h = _sketch_extent(ctx)
    if got_w is not None and (got_w > want_w + tol or got_h > want_h + tol):
        cleaned = _delete_new_segments(ctx, before)
        raise SWError(
            f"the drawn profile measures {got_w:.1f}x{got_h:.1f}mm but the points describe "
            f"{want_w:.1f}x{want_h:.1f}mm — SolidWorks did not build the arcs as specified. "
            f"Removed {cleaned} segment(s). Use straight segments here and round the corners "
            f"afterwards with fillet_edges (radius {arc_r or 10:g}, edges=\"vertical\"), which "
            f"is also the more editable result."
        )

    return {"segments": made, "closed": True, "points": len(pts),
            "extent_mm": [round(got_w or want_w, 2), round(got_h or want_h, 2)]}


@tool(
    "sketch_line", "Draw a line segment",
    params={
        "x1": {"type": "number", "desc": "Start X (mm)"}, "y1": {"type": "number", "desc": "Start Y (mm)"},
        "x2": {"type": "number", "desc": "End X (mm)"}, "y2": {"type": "number", "desc": "End Y (mm)"},
    },
    category="sketch",
)
def sketch_line(ctx: Context, x1: float, y1: float, x2: float, y2: float):
    _require_sketch(ctx)
    ctx.sketch_mgr.CreateLine(units.mm(x1), units.mm(y1), 0, units.mm(x2), units.mm(y2), 0)
    return {"line": [x1, y1, x2, y2]}


@tool(
    "sketch_centerline", "Draw a centerline (used for revolve/mirror)",
    params={
        "x1": {"type": "number", "desc": "Start X (mm)"}, "y1": {"type": "number", "desc": "Start Y (mm)"},
        "x2": {"type": "number", "desc": "End X (mm)"}, "y2": {"type": "number", "desc": "End Y (mm)"},
    },
    category="sketch",
)
def sketch_centerline(ctx: Context, x1: float, y1: float, x2: float, y2: float):
    _require_sketch(ctx)
    ctx.sketch_mgr.CreateCenterLine(units.mm(x1), units.mm(y1), 0, units.mm(x2), units.mm(y2), 0)
    return {"centerline": [x1, y1, x2, y2]}


@tool(
    "sketch_arc_center", "Draw a center-arc (center + start + end + direction)",
    params={
        "cx": {"type": "number", "desc": "Center X (mm)"}, "cy": {"type": "number", "desc": "Center Y (mm)"},
        "sx": {"type": "number", "desc": "Start X (mm)"}, "sy": {"type": "number", "desc": "Start Y (mm)"},
        "ex": {"type": "number", "desc": "End X (mm)"}, "ey": {"type": "number", "desc": "End Y (mm)"},
        "direction": {"type": "number", "desc": "1 = counter-clockwise / -1 = clockwise", "default": 1},
    },
    category="sketch",
)
def sketch_arc_center(ctx, cx, cy, sx, sy, ex, ey, direction=0):
    """P65: direction=0 (the default) picks the MINOR arc automatically. The old default
    of 1 meant the model had to guess the sweep sense and got the major arc half the
    time — a 300° arc where a 60° one was meant, which then fails to bound a profile."""
    _require_sketch(ctx)
    d = int(direction or 0)
    if d == 0:
        a_start = math.atan2(sy - cy, sx - cx)
        a_end = math.atan2(ey - cy, ex - cx)
        sweep = (a_end - a_start) % (2 * math.pi)
        d = 1 if sweep <= math.pi else -1
    ctx.sketch_mgr.CreateArc(
        units.mm(cx), units.mm(cy), 0,
        units.mm(sx), units.mm(sy), 0,
        units.mm(ex), units.mm(ey), 0, int(direction),
    )
    return {"arc_center": [cx, cy], "start": [sx, sy], "end": [ex, ey]}


@tool(
    "sketch_polygon", "Draw a regular polygon",
    params={
        "cx": {"type": "number", "desc": "Center X (mm)", "default": 0},
        "cy": {"type": "number", "desc": "Center Y (mm)", "default": 0},
        "radius": {"type": "number", "desc": "Circumradius or inradius (mm)"},
        "sides": {"type": "number", "desc": "Number of sides"},
        "inscribed": {"type": "boolean", "desc": "True = inscribed / False = circumscribed", "default": True},
    },
    category="sketch",
)
def sketch_polygon(ctx, radius, sides, cx=0, cy=0, inscribed=True):
    _require_sketch(ctx)
    # CreatePolygon(cx, cy, cz, xp, yp, zp, sides, inscribed)
    ctx.sketch_mgr.CreatePolygon(
        units.mm(cx), units.mm(cy), 0,
        units.mm(cx + radius), units.mm(cy), 0, int(sides), bool(inscribed),
    )
    return {"polygon": {"center": [cx, cy], "r": radius, "sides": int(sides)}}


@tool(
    "sketch_fillet", "Fillet two selected sketch segments in the active sketch (select two segments in SolidWorks first)",
    params={"radius": {"type": "number", "desc": "Fillet radius (mm)"}},
    category="sketch",
)
def sketch_fillet(ctx: Context, radius: float):
    _require_sketch(ctx)
    if ctx.selected_count() < 1:
        raise SWError("please select two sketch segments to fillet first.")
    # CreateFillet(radius, constrainCorners) — 2 = swConstrainCorners_Keep
    ctx.sketch_mgr.CreateFillet(units.mm(radius), 2)
    return {"sketch_fillet_r": radius}


@tool(
    "add_sketch_relation", "Add a geometric relation to the selected sketch entities",
    params={"relation": {"type": "string",
                        "enum": ["horizontal", "vertical", "coincident", "parallel",
                                 "perpendicular", "tangent", "equal", "concentric", "symmetric"],
                        "desc": "Relation type"}},
    category="sketch",
)
def add_sketch_relation(ctx: Context, relation: str):
    if ctx.selected_count() < 1:
        raise SWError("please select sketch entities to add the relation to first.")
    key = {
        "horizontal": "sgHORIZONTAL2D", "vertical": "sgVERTICAL2D",
        "coincident": "sgCOINCIDENT", "parallel": "sgPARALLEL",
        "perpendicular": "sgPERPENDICULAR", "tangent": "sgTANGENT",
        "equal": "sgEQUAL", "concentric": "sgCONCENTRIC", "symmetric": "sgSYMMETRIC",
    }.get(relation)
    if not key:
        raise SWError(f"unknown relation: {relation}")
    ctx.model.SketchAddConstraints(key)
    return {"relation": relation}


@tool(
    "add_dimension", "Add a driving dimension at the given location for the selected entities (applies to ALL configurations)",
    params={
        "x": {"type": "number", "desc": "Dimension placement X (mm)"},
        "y": {"type": "number", "desc": "Dimension placement Y (mm)"},
        "value": {"type": "number", "desc": "Dimension value (mm); omit to use the current geometric value", "default": 0},
    },
    category="sketch",
)
def add_dimension(ctx: Context, x: float, y: float, value: float = 0):
    if ctx.selected_count() < 1:
        raise SWError("please select entities to dimension first.")
    disp = ctx.model.AddDimension2(units.mm(x), units.mm(y), 0)
    if disp is None:
        raise SWError("failed to add dimension.")
    if value:
        d = disp.GetDimension2(0) if hasattr(disp, "GetDimension2") else disp.GetDimension()
        # P13: swInConfigurationOpts_e — 2 = all configurations (1 = this config only)
        d.SetSystemValue3(units.mm(value), CFG_ALL, None)
        ctx.rebuild()
    return {"dimension_at": [x, y], "value_mm": value or None}
