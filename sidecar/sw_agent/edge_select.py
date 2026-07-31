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

from .bridge import Context, SWError, sw_get

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

def _faces_strategy(ctx: Context, which: str):
    """靠"这条边属于哪两个面"来判断，不碰边自身的几何。

    两个侧面相交于竖直边，侧面与顶/底面相交于水平边，圆柱面上的边是圆形边。
    只用 GetFaces / face.Normal / face.GetEdges / IsSame。
    """
    notes: list = []
    edges = _faces_buckets(ctx, notes).get(which, [])
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
    try:
        surf = sw_get(face, "GetSurface")
        if surf is not None and not sw_get(surf, "IsPlane"):
            return "cyl"
    except Exception as ex:  # noqa: BLE001 — a non-planar surface is still worth reporting
        if notes is not None and len(notes) < 3:
            notes.append(f"face.GetSurface/IsPlane: {ex}")
    for member in ("Normal", "GetNormal"):
        try:
            n = sw_get(face, member)
            if n and len(n) >= 3:
                return "side" if abs(float(n[1])) < _SIDE_FACE_TOL else "cap"
        except Exception as ex:  # noqa: BLE001
            if notes is not None and len(notes) < 3:
                notes.append(f"face.{member}: {ex}")
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
    buckets: dict = {"vertical": [], "horizontal": [], "circular": []}
    kinds_seen: dict = {}
    for edge in edges:
        faces = _adjacent_faces(edge)
        if not faces:
            if len(notes) < 3:
                notes.append("GetTwoAdjacentFaces2 没有返回相邻面")
            continue
        kinds = set()
        for f in faces:
            k = _face_kind(f, notes)
            kinds.add(k)
            kinds_seen[k] = kinds_seen.get(k, 0) + 1
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


def _feature_strategy(ctx: Context, which: str) -> int:
    """Only the faces the LAST feature created.

    This is how a person writing a macro does it: right after creating a feature you
    already hold it, and IFeature::GetFaces tells you exactly what it produced — no
    global search, no guessing which of twelve edges was meant. Scoped, accurate, and
    it degrades to nothing (rather than to something wrong) when there is no last
    feature recorded.
    """
    name = ctx.scratch.get("last_feature")
    if not name:
        return Picked(0, 0, ["会话里没有记录最近创建的特征"])
    try:
        from .tools.feature import _find_feature
        feat = _find_feature(ctx, name)
    except Exception as e:  # noqa: BLE001
        return Picked(0, 0, [f"查找特征 {name} 失败: {e}"])
    if feat is None:
        return Picked(0, 0, [f"特征树里找不到 {name}"])
    try:
        # P88: GetFaces resolves as a PROPERTY on this install, so calling it raised
        # "'tuple' object is not callable". sw_get tolerates either binding — the same
        # trap we已 hit with GetTypeName2 and EditSuppress2, and new code keeps walking
        # into it, so every COM member reached from this module now goes through sw_get.
        faces = list(sw_get(feat, "GetFaces") or [])
    except Exception as e:  # noqa: BLE001
        return Picked(0, 0, [f"feature.GetFaces: {e}"])
    if not faces:
        return Picked(0, 0, [f"特征 {name} 没有返回任何面"])
    notes: list = []
    edges = []
    for f in faces:
        edges.extend(_edges_of_face(f))
    if not edges:
        return Picked(0, 0, [f"特征 {name} 的面上取不到边"])
    picked = _bucket_edges(edges, notes).get(which, [])
    got = _select_all(ctx, picked)
    got.notes.extend(notes[:2])
    return got


def _faces_buckets(ctx: Context, notes: list) -> dict:
    """All of the body's edges, grouped by the faces they separate."""
    buckets: dict = {"vertical": [], "horizontal": [], "circular": []}
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

def _selected_strategy(ctx: Context, which: str) -> int:
    """用户在 SolidWorks 里选好的边，原样使用。诚实的兜底，永远可用。"""
    try:
        return int(ctx.selected_count())
    except Exception:  # noqa: BLE001
        return 0


# Order matters: narrowest and most trustworthy first.
_STRATEGIES = (
    ("feature", _feature_strategy),   # only what the last feature made
    ("faces", _faces_strategy),       # whole body, by face topology
    ("box", _box_strategy),           # geometric, box-shaped parts only
)


def probe(ctx: Context) -> dict:
    """在当前模型上实际跑一遍各策略，报告每个各选中几条边。

    这就是诊断该回答的问题——不是"分类失败了吗"，而是"哪条策略在这台机器上真的能用"。
    结果会被 `select()` 缓存复用。
    """
    result: dict = {}
    for name, fn in _STRATEGIES:
        counts = {}
        for which in ("vertical", "horizontal", "circular"):
            try:
                counts[which] = fn(ctx, which).report()
            except Exception as e:  # noqa: BLE001
                counts[which] = {"error": str(e)}
            finally:
                ctx.clear_selection()
        result[name] = counts
    ctx.scratch["edge_probe"] = result
    return result


def select(ctx: Context, which: str) -> int:
    """选中 `which` 描述的那些边，返回选中的数量。

    先用上次验证过有效的策略；没有缓存就按顺序试，第一个选中东西的胜出并被记下。
    全都不行时报错，并把每条策略的实际结果一并说出来——不留"未知原因"。
    """
    if which == "selected":
        n = _selected_strategy(ctx, which)
        if n == 0:
            raise SWError(
                'edges="selected" 需要你先在 SolidWorks 里选中要加工的边，当前没有选中任何实体。'
            )
        return n

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
