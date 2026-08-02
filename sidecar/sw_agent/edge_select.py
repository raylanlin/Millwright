"""sw_agent.edge_select —选择要加工的边。这件事只在这里做。

## 为什么单独成一个模块

在此之前，边的选择散在 `_edge_kind` 里的六条 fallback 路线中，每次某台机器上失败就再加一条。
到第八轮时，一次调用可能走 A/B/C/D/0/E 任意一条，返回结果没有任何一处能校验——
**这不是健壮，是抽奖**：某条路线给出错误分类时，工具会安静地倒错边。

而且抽象本身选错了。真正要回答的问题不是"第 7 条边是什么类型"，而是
"用户说的那些边是哪几条"。前者是手段，后者才是目的，把手段当目的就会陷入
"再加一条路线也许这次能分类成功"的循环。

## 现在的设计

三条**策略**，各自完整、各自可验证，而不是六条互相兜底的碎片：

  1. `faces`   —— 靠面的归属推断（两个侧面之间是竖边）。任意形状都对。
  2. `box`     —— 靠包围盒算出角点坐标再点选。只对箱体类零件有效，但极稳。
  3. `selected` —— 用户在 SolidWorks 里自己选好。永远可用。

关键在于**策略是被验证过才使用的**：`probe()` 在当前模型上实际跑一遍，
数出各策略选中了几条边，把结果缓存起来。之后直接用那条验证过的策略，
不再每次调用都从头试到尾。

失败时也不再含糊：明确说出每条策略试过什么、拿到什么，并告诉用户
可以手动选边后用 `edges="selected"` —— 一个诚实的兜底，好过一个可能选错边的猜测。
"""
from __future__ import annotations

from .bridge import Context, SWError, edge_fingerprint, sw_get

# 面法向的 Y 分量小于这个值就认为是"侧面"（SolidWorks 是 Y-UP）
_SIDE_FACE_TOL = 0.1


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else min(v, hi)


def _variant_null():
    """VARIANT 形式的空引用。

    P87: Select4 的 callout 参数是接口指针，pywin32 传 Python 的 None 过去有时会被拒；
    显式的 VT_DISPATCH/null 才是正确形式。这一点之前踩过（select_face 就是这么修的），
    但新模块里写回了裸 None。
    """
    try:
        import pythoncom
        from win32com.client import VARIANT
        return VARIANT(pythoncom.VT_DISPATCH, None)
    except Exception:  # noqa: BLE001
        return None


def _select(entity, append: bool = True, errors: list | None = None) -> bool:
    """选中一个实体。Select4/Select2/Select 三种签名跨版本都存在，依次尝试。

    P87: 失败原因会记进 errors。之前它只返回 True/False，于是"一条边都没找到"和
    "找到了但选不中"在上层看起来完全一样 —— 报告最终结果而不报告中间步骤，
    结果就是只能靠猜。
    """
    null = _variant_null()
    for member, args in (("Select4", (append, null)), ("Select2", (append, 0)), ("Select", (append,))):
        fn = getattr(entity, member, None)
        if fn is None:
            if errors is not None:
                errors.append(f"{member}: 不存在")
            continue
        try:
            if fn(*args):
                return True
            if errors is not None:
                errors.append(f"{member}: 返回 False")
        except Exception as e:  # noqa: BLE001 — 换下一种签名
            if errors is not None:
                errors.append(f"{member}: {e}")
            continue
    return False


# ===== 策略 1：面的归属 =====

# P99: edge fingerprint lives in bridge.py (edge_fingerprint) — the SAME function
# feature.py's record_feature_map uses, so the creation-time snapshot and the live
# walk hash identically. A local copy here would be a second implementation, and that
# is exactly how the 8-vs-4 double count survived a round (P96).


def _feature_strategy(ctx: Context, which: str):
    """P94: 最近特征创建的边（几何指纹去重，见 _feature_edges）。

    范围最小最准：用户说「圆柱顶面边」时，只有最近特征的边会被选中，
    不会像 circular 那样把整个文档的圆边全捞进来。
    """
    edges, why = _feature_edges(ctx)
    if why:
        return Picked(0, 0, [why])
    notes: list = []
    buckets = _bucket_edges(edges, notes)
    if which == "all":
        picked = [edge for group in buckets.values() for edge in group]
    else:
        picked = buckets.get(which, [])
    got = _select_all(ctx, picked)
    got.notes.extend(notes[:2])
    return got


def _faces_strategy(ctx: Context, which: str):
    """靠"这条边属于哪两个面"来判断，不碰边自身的几何。

    两个侧面相交于竖直边，侧面与顶/底面相交于水平边，圆柱面上的边是圆形边。
    只用 GetFaces / face.Normal / face.GetEdges / IsSame。
    """
    notes: list = []
    buckets = _faces_buckets(ctx, notes)
    if which == "all":
        # P92: buckets 只有 vertical/horizontal/circular 三个键，"all" 取空会让
        # faces 返回 0，然后落到 box —— 而 box 的底面点在等轴测视角下不可见，
        # 于是 "all" 永远选不全。faces 明明能一次给出全部边，直接合并。
        edges = [e for group in buckets.values() for e in group]
    else:
        edges = buckets.get(which, [])
    got = _select_all(ctx, edges)
    got.notes.extend(notes[:2])
    return got


class Picked:
    """一次选边的结果：找到几条、选中几条、以及为什么没选中。

    P87: 只回一个数字时，0 既可能是"没找到边"也可能是"找到了但选不中"，
    两者的修法完全不同却分辨不出来。这个类存在的唯一目的就是让它们分开。
    """

    __slots__ = ("found", "notes", "selected")

    def __init__(self, found: int = 0, selected: int = 0, notes=None):
        self.found = found
        self.selected = selected
        self.notes = notes or []

    def __bool__(self):
        return self.selected > 0

    def report(self):
        r: dict = {"found": self.found, "selected": self.selected}
        if self.notes:
            r["why"] = self.notes[:3]
        return r


def _select_all(ctx: Context, edges) -> Picked:
    """把这些边全部选中，并如实报告找到多少、选中多少、失败原因。"""
    if not edges:
        return Picked(0, 0, ["没有找到符合描述的边"])
    ctx.clear_selection()
    errors: list = []
    n = sum(1 for e in edges if _select(e, True, errors))
    return Picked(len(edges), n, errors)


def _edges_of_face(face) -> list:
    """A face's edges, via its LOOPS — which is where they actually hang.

    The documented traversal is body -> faces -> loops -> edges, and face.GetEdges is a
    shortcut that reads a temporary buffer populated by GetTrimCurves2. Call it without
    that and it can come back empty, which is exactly what happened when we asked a face
    for its edges directly and got nothing back on a model that plainly had twelve.
    """
    out = []
    try:
        for loop in (sw_get(face, "GetLoops") or []):
            try:
                out.extend(list(sw_get(loop, "GetEdges") or []))
            except Exception:  # noqa: BLE001
                continue
    except Exception:  # noqa: BLE001
        pass
    if out:
        return out
    # Shortcut path, kept as a fallback for installs where it does work
    try:
        return list(sw_get(face, "GetEdges") or [])
    except Exception:  # noqa: BLE001
        return []


def _face_kind(face, notes: list | None = None) -> str:
    """side (wall) / cap (floor or ceiling) / cyl — SolidWorks is Y-up.

    P89: this used to answer "cap" whenever anything failed, so a machine where the face
    normal cannot be read looked exactly like a machine where every face happens to be
    horizontal — and the caller then filed all twelve edges as horizontal. A failure now
    says so.
    """
    # P90: GetSurface/IsPlane answers "member not found" on this install, so planarity is
    # inferred from the normal instead: a planar face has one, a cylinder does not (or
    # reports a degenerate one). Asking is still worth a try — it is exact when available —
    # but its absence is no longer reported as a problem, because it is the normal case here
    # and the noise buried the real findings.
    try:
        surf = sw_get(face, "GetSurface")
        if surf is not None:
            planar = sw_get(surf, "IsPlane")
            if planar is not None:
                if not planar:
                    return "cyl"
    except Exception:  # noqa: BLE001 — expected on installs without ISurface access
        pass
    for member in ("Normal", "GetNormal"):
        try:
            n = sw_get(face, member)
        except Exception as ex:  # noqa: BLE001
            if notes is not None and len(notes) < 3:
                notes.append(f"face.{member}: {ex}")
            continue
        if not n or len(n) < 3:
            continue
        nx, ny, nz = (float(n[0]), float(n[1]), float(n[2]))
        # A cylindrical face has no single normal; SolidWorks returns a zero-length or
        # meaningless vector for one, which is how a curved face is told apart here.
        if (nx * nx + ny * ny + nz * nz) ** 0.5 < 0.5:
            return "cyl"
        return "side" if abs(ny) < _SIDE_FACE_TOL else "cap"
    return "unknown"


def _adjacent_faces(edge):
    """The two faces an edge separates."""
    for name in ("GetTwoAdjacentFaces2", "IGetTwoAdjacentFaces2"):
        try:
            faces = sw_get(edge, name)
        except Exception:  # noqa: BLE001
            continue
        if faces:
            return [f for f in faces if f is not None]
    return []


def _bucket_edges(edges, notes: list) -> dict:
    """Group edges by the kinds of face they separate.

    P89: this used to walk the FACES and collect their edges, which needed the same edge
    to be recognised across two faces — and `IsSame` was silently failing, so every edge
    was counted twice. The tell was "found: 24" on a box that has twelve edges: 12 x 2
    faces, no de-duplication, and every one bucketed as horizontal because the face
    classification was falling into its `except` branch and returning "cap" for all six
    faces.

    Walking the EDGES instead removes both problems at once. Each edge is visited exactly
    once, and it names its own two faces, so there is nothing to de-duplicate and nothing
    to compare for identity.
    """
    # P97: "top"/"bottom" exist because "circular" was the only way to reach a cylinder's
    # rim, and it means EVERY circular edge — asked for "顶面边倒 R3" on a cylinder, the
    # tool rounded the bottom rim too, and reported 4 edges (a full cylinder is split into
    # two half-faces, so each rim is two arcs — the count was right, the scope was not).
    # A cap face's outward normal points along +Y or -Y, which is all it takes to tell
    # them apart.
    buckets: dict = {"vertical": [], "horizontal": [], "circular": [], "top": [], "bottom": []}
    kinds_seen: dict = {}
    for edge in edges:
        faces = _adjacent_faces(edge)
        if not faces:
            if len(notes) < 3:
                notes.append("GetTwoAdjacentFaces2 没有返回相邻面")
            continue
        kinds = set()
        cap_dir = 0     # +1 這條邊挨著上盖面, -1 下底面
        for f in faces:
            k = _face_kind(f, notes)
            kinds.add(k)
            kinds_seen[k] = kinds_seen.get(k, 0) + 1
            if k == "cap":
                try:
                    ny = sw_get(f, "Normal")[1]
                    if ny > 0.9:
                        cap_dir = 1
                    elif ny < -0.9:
                        cap_dir = -1
                except Exception:  # noqa: BLE001 — 读不到就不分上下，仍归入原有桶
                    pass
        if cap_dir > 0:
            buckets["top"].append(edge)
        elif cap_dir < 0:
            buckets["bottom"].append(edge)
        if "cyl" in kinds:
            buckets["circular"].append(edge)
        elif kinds == {"side"}:
            buckets["vertical"].append(edge)
        elif "cap" in kinds and "side" in kinds:
            buckets["horizontal"].append(edge)
        else:
            # Two cap faces meeting means the normals did not read — say so rather than
            # quietly filing it as horizontal, which is what produced 24 bogus edges.
            if len(notes) < 3:
                notes.append(f"无法判断这条边（相邻面类型 {sorted(kinds)}）")
    if kinds_seen and len(notes) < 3:
        notes.append(f"相邻面类型统计 {kinds_seen}")
    return buckets


def _faces_buckets(ctx: Context, notes: list) -> dict:
    """All of the body's edges, grouped by the faces they separate."""
    # P98: must mirror _bucket_edges' keys exactly — _bucket_edges now also produces
    # "top"/"bottom" (P97), and this loop only copies the keys that EXIST here.
    # A 3-key dict silently dropped the cylinder-rim edges, which is why edges="top"
    # could never find anything even though _bucket_edges had bucketed them.
    buckets: dict = {"vertical": [], "horizontal": [], "circular": [], "top": [], "bottom": []}
    try:
        bodies = ctx.solid_bodies()
    except SWError as ex:
        notes.append(str(ex))
        return buckets
    for body in bodies:
        try:
            edges = list(sw_get(body, "GetEdges") or [])
        except Exception as ex:  # noqa: BLE001
            notes.append(f"body.GetEdges: {ex}")
            continue
        if not edges:
            notes.append("body.GetEdges 返回空")
            continue
        part = _bucket_edges(edges, notes)
        for k, value in buckets.items():
            value.extend(part[k])
    return buckets

def _box_strategy(ctx: Context, which: str) -> Picked:
    """按位置点选：SelectByID2 会选中离给定三维点最近的实体。

    箱体类零件的四条竖棱就在包围盒的四个角上，取 Y 中点即棱的中部。
    只对箱体有意义，所以 circular 直接返回 0 交给别的策略。
    """
    if which == "circular":
        return Picked(0, 0, ["箱体坐标法不适用于圆形边"])
    try:
        box = ctx.model.GetPartBox(True)   # x1,y1,z1,x2,y2,z2，单位米
    except Exception as e:  # noqa: BLE001
        return Picked(0, 0, [f"GetPartBox: {e}"])
    if not box or len(box) < 6:
        return Picked(0, 0, ["GetPartBox 没有返回包围盒"])
    x1, y1, z1, x2, y2, z2 = (float(v) for v in box[:6])
    if min(abs(x2 - x1), abs(y2 - y1), abs(z2 - z1)) < 1e-9:
        return Picked(0, 0, ["包围盒是退化的（某个方向厚度为 0）"])
    mx, my, mz = (x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2

    # P88: probe a point ON the edge but AWAY from its ends, and nudged very slightly
    # outward from the solid.
    #
    # SelectByID2 picks whatever entity is nearest the point, so probing exactly at a
    # corner is a three-way tie between the edge, the vertex terminating it and the two
    # faces meeting there — which is why 3 of 4 vertical edges came back selected and one
    # lost the tie. Sampling at 40% along the edge removes the vertex from contention, and
    # a hair of outward offset breaks the tie with the faces.
    eps = min(abs(x2 - x1), abs(y2 - y1), abs(z2 - z1)) * 0.01
    y_mid = y1 + (y2 - y1) * 0.4          # off-centre: never coincides with a mid-edge vertex
    x_mid = x1 + (x2 - x1) * 0.4
    z_mid = z1 + (z2 - z1) * 0.4

    corners = [
        (x1 - eps, y_mid, z1 - eps), (x2 + eps, y_mid, z1 - eps),
        (x2 + eps, y_mid, z2 + eps), (x1 - eps, y_mid, z2 + eps),
    ]
    rims = [
        (x_mid, y2 + eps, z1 - eps), (x2 + eps, y2 + eps, z_mid),
        (x_mid, y2 + eps, z2 + eps), (x1 - eps, y2 + eps, z_mid),
        (x_mid, y1 - eps, z1 - eps), (x2 + eps, y1 - eps, z_mid),
        (x_mid, y1 - eps, z2 + eps), (x1 - eps, y1 - eps, z_mid),
    ]
    points = corners if which == "vertical" else rims if which == "horizontal" else corners + rims

    # Coordinate picking only reaches entities that are selectable from the CURRENT view
    # — if the point is hidden at this camera angle, SelectByID2 returns False just as a
    # click would. Isometric shows every corner of a box, so orient first, then restore.
    try:
        ctx.model.ShowNamedView2("*Isometric", 7)
        ctx.model.ViewZoomtofit2()
        # P89: the FIRST pick after a view change consistently lost — always the same
        # corner, the first one probed, both before and after the offset change. The view
        # has not settled when the pick fires, so fire one throwaway pick and discard it.
        ctx.model.Extension.SelectByID2("", "EDGE", mx, my, mz, False, 0, _variant_null(), 0)
    except Exception:  # noqa: BLE001 — orientation is an aid, not a requirement
        pass

    ctx.clear_selection()
    null = _variant_null()
    n = 0
    notes: list = []
    for px, py, pz in points:
        hit = False
        # P88: the offset helps in the common case but can overshoot on a thin part, so a
        # miss is retried at the exact surface point before it counts as a failure.
        for qx, qy, qz in ((px, py, pz), (_clamp(px, x1, x2), _clamp(py, y1, y2), _clamp(pz, z1, z2))):
            try:
                if ctx.model.Extension.SelectByID2("", "EDGE", qx, qy, qz, True, 0, null, 0):
                    hit = True
                    break
            except Exception as e:  # noqa: BLE001
                if len(notes) < 2:
                    notes.append(f"SelectByID2: {e}")
                break
        if hit:
            n += 1
        elif len(notes) < 2:
            # P89: coordinate picking only reaches what the current view can see, so the
            # bottom edges are unreachable from an isometric view — an inherent limit of
            # this strategy, not a fixable miss. Name it, so it is not chased again.
            hidden = abs(py - y1) < abs(py - y2)
            notes.append(
                f"({px * 1000:.1f}, {py * 1000:.1f}, {pz * 1000:.1f})mm 处没有选到边"
                + ("（底面边在等轴测视角下不可见——坐标法的固有限制）" if hidden else "")
            )
    if n == 0:
        ctx.clear_selection()
        notes.append(
            f"包围盒 mm: x {x1 * 1000:.1f}~{x2 * 1000:.1f}, "
            f"y {y1 * 1000:.1f}~{y2 * 1000:.1f}, z {z1 * 1000:.1f}~{z2 * 1000:.1f}"
        )
    return Picked(len(points), n, notes)


# ===== 策略 3：用户已选 =====

def _selected_strategy(ctx: Context, which: str):
    """用户在 SolidWorks 里选好的边，原样使用。诚实的兜底，永远可用。

    P96: 这里原本数的是 selected_count()（任意选中实体）。P93 已经查明那会出事 ——
    拉伸完 SolidWorks 会留下残留选中（特征或轮廓），count 到 1 就走 selected 分支，
    FeatureFillet3 对那个面/特征作用，它的所有边全被圆角，而且报告成功。P93 在
    feature.py 的调用处堵了，共享模块这条路没堵 —— 同一个 bug 修在了一个入口，
    另一个入口还开着。选择这件事只在这个模块做，所以校验也该在这里。
    """
    try:
        n, others = ctx.selected_edge_count()
    except Exception as ex:  # noqa: BLE001
        return Picked(0, 0, [f"读取选中状态失败: {ex}"])
    if n == 0:
        detail = f"（当前选中: {others}）" if others else "（当前没有选中任何实体）"
        return Picked(0, 0, [f"没有选中任何边{detail}"])
    if others:
        # 混着面/特征时不能悄悄多做 —— 那正是 P93 抓到的静默倒错边
        return Picked(n, 0, [f"选中里混有非边实体 {others}，请只选边后重试"])
    return Picked(n, n, [])


# P94: the "feature" strategy is back.
#
# P91 deleted it because it collected edges face by face, so every edge arrived twice,
# and identity-based de-duplication (IsSame, COM pointer, adjacent-face pair) all failed
# on this install. P94 replaces identity with GEOMETRY: an edge's bounding-box coords are
# reference-independent, so the same edge seen from two faces hashes to the same key.
# With de-dup fixed, "feature" is the most precise strategy — it scopes to the edges the
# LAST feature created, which is exactly what "the top edge of the cylinder" means, and
# it avoids "circular" pulling in every round edge of the whole document.
_STRATEGIES = (
    ("feature", _feature_strategy),   # last feature's faces -> edges (P94, geometry de-dup)
    ("faces", _faces_strategy),       # whole body, by the faces each edge separates
    ("box", _box_strategy),           # geometric fallback, box-shaped parts only
)


def _feature_edges(ctx: Context):
    """P96: the last feature's edges, de-duplicated — the ONE place this is worked out.

    _feature_strategy and _probe_feature each carried their own copy of this walk, so
    diagnostics and the real selection could drift apart. They already did once: the
    8-versus-4 double count survived a round because the two paths were fixed
    independently. Extracted so there is a single answer.

    Returns (edges, note) — note is None on success, otherwise why there are no edges.
    """
    name = ctx.scratch.get("last_feature")
    if not name:
        return [], "没有 last_feature（先建一个特征，再按特征选边）"

    # P99: prefer the creation-time snapshot. feature_map records the topology the
    # moment the feature was made, so "the top edge of the cylinder" stays answerable
    # even if later features reshape or hide those faces (the case where a live
    # GetFaces walk comes back empty). Fall back to the live walk when no snapshot
    # exists (old session, feature created before this build).
    fmap = ctx.scratch.get("feature_map") or {}
    snap = fmap.get(name)
    if snap and snap.get("fingerprints"):
        wanted = set(snap["fingerprints"])
        matched = []
        for body in ctx.solid_bodies():
            try:
                edges = list(sw_get(body, "GetEdges") or [])
            except Exception:  # noqa: BLE001
                continue
            for e in edges:
                if edge_fingerprint(e) in wanted:
                    matched.append(e)
        if matched:
            return matched, None
        # snapshot exists but none of its edges survive on the body — the feature was
        # consumed or reshaped; fall through to the live walk for a best effort.

    feat = None
    for f in (ctx.all_features() or []):
        try:
            if sw_get(f, "Name") == name:
                feat = f
                break
        except Exception:  # noqa: BLE001
            continue
    if feat is None:
        return [], f"找不到特征 {name}（可能已被改名或删除）"
    try:
        faces = list(sw_get(feat, "GetFaces") or [])
    except Exception as ex:  # noqa: BLE001
        return [], f"feature.GetFaces: {ex}"
    if not faces:
        return [], f"特征 {name} 没有可读的面"

    seen: set = set()
    edges: list = []
    for face in faces:
        for edge in _edges_of_face(face):
            fp = edge_fingerprint(edge)
            if fp in seen:
                continue
            seen.add(fp)
            edges.append(edge)
    return edges, None


def _probe_feature(ctx: Context) -> dict:
    """P94: report what the feature strategy sees on the current model."""
    edges, why = _feature_edges(ctx)
    if why:
        return {"skipped": why}
    notes: list = []
    buckets = _bucket_edges(edges, notes)
    report: dict = {}
    for which in ("vertical", "horizontal", "circular", "top", "bottom"):
        got = _select_all(ctx, buckets.get(which, []))
        got.notes.extend(notes[:2])
        report[which] = got.report()
        ctx.clear_selection()
    return report


def probe(ctx: Context) -> dict:
    """报告每条策略在当前模型上能选到什么。

    P91: 原来对 3 条策略 × 3 类边各跑一次完整的选择流程 —— 9 次选中再清空，
    其中 box 策略每次还要切换视图，诊断因此超时过一次。现在拓扑只遍历一遍，
    三类边一起分出来；box 策略只在 faces 没结果时才试，因为它本来就是兜底。
    """
    result: dict = {}

    # P94: feature strategy first — it scopes to the last feature, the most precise
    # answer when the model asks about edges the most recent feature created.
    try:
        result["feature"] = _probe_feature(ctx)
    except Exception as e:  # noqa: BLE001
        result["feature"] = {"error": str(e)}

    notes: list = []
    buckets = _faces_buckets(ctx, notes)
    faces_report: dict = {}
    for which in ("vertical", "horizontal", "circular", "top", "bottom"):
        edges = buckets.get(which, [])
        got = _select_all(ctx, edges) if edges else Picked(0, 0, ["没有找到符合描述的边"])
        got.notes.extend(notes[:2])
        faces_report[which] = got.report()
        ctx.clear_selection()
    result["faces"] = faces_report

    # 只有 faces 一条都没选中时才值得试 box —— 它要切视图，代价明显更高
    if any(r.get("selected") for r in faces_report.values()):
        result["box"] = {"skipped": "faces 策略已可用，未测试坐标兜底"}
    else:
        box_report = {}
        for which in ("vertical", "horizontal", "circular", "top", "bottom"):
            try:
                box_report[which] = _box_strategy(ctx, which).report()
            except Exception as e:  # noqa: BLE001
                box_report[which] = {"error": str(e)}
            finally:
                ctx.clear_selection()
        result["box"] = box_report

    ctx.scratch["edge_probe"] = result
    return result


def select(ctx: Context, which: str) -> int:
    """选中 `which` 描述的那些边，返回选中的数量。

    先用上次验证过有效的策略；没有缓存就按顺序试，第一个选中东西的胜出并被记下。
    全都不行时报错，并把每条策略的实际结果一并说出来——不留"未知原因"。
    """
    if which in ("top", "bottom"):
        # 上下盖边只能由面法向判定，坐标兜底给不出这个信息
        notes: list = []
        got = _select_all(ctx, _faces_buckets(ctx, notes).get(which, []))
        if got:
            return got.selected
        raise SWError(
            f'找不到{"顶面" if which == "top" else "底面"}的边'
            + (f"（{'; '.join(got.notes[:2])}）" if got.notes else "")
            + '。也可以在 SolidWorks 里手动选中后用 edges="selected"。'
        )

    if which == "selected":
        got = _selected_strategy(ctx, which)
        if not got:
            raise SWError(
                'edges="selected" 需要你先在 SolidWorks 里手动选中要加工的边。'
                + ("；".join(got.notes) if got.notes else "")
            )
        return got.selected

    cached = ctx.scratch.get("edge_strategy")
    order = [s for s in _STRATEGIES if s[0] == cached] + [s for s in _STRATEGIES if s[0] != cached]

    tried = []
    for name, fn in order:
        try:
            got = fn(ctx, which)
        except Exception as e:  # noqa: BLE001
            tried.append(f"{name}: {e}")
            continue
        if got:
            # P92: found/selected 分开就是为了分辨「没找到」和「选不中」。部分成功
            # （找到 4 条只选中 3 条）不能静默 —— 那会倒 3 个角、用户以为 4 个都圆了，
            # 正是十轮前「只有两个角是真圆角」的复发路径。少选时记进错误信息。
            if got.selected < got.found:
                ctx.clear_selection()
                tried.append(
                    f"{name}: 找到 {got.found} 条只选中 {got.selected} 条"
                    + (f"（{'; '.join(got.notes[:2])}）" if got.notes else "")
                )
                continue
            ctx.scratch["edge_strategy"] = name
            return got.selected
        # 找到了边却选不中，和一条边都没找到，是两个完全不同的问题 —— 说清楚是哪个
        detail = "; ".join(got.notes[:2]) if got.notes else ""
        tried.append(
            f"{name}: 找到 {got.found} 条、选中 0 条" + (f"（{detail}）" if detail else "")
        )
        ctx.clear_selection()

    raise SWError(
        f'找不到 {which} 的边（{"; ".join(tried)}）。'
        '你可以在 SolidWorks 里手动选中要加工的边，然后用 edges="selected" 重试 —— '
        "这比让工具去猜哪几条边更可靠。"
    )
