"""sw_agent.guidance —— 按需读取的规则段（P99）。

问题：AGENT_SYSTEM_PROMPT 里塞了大量静态规则（工具用法、建模要点、宏细则），
每轮对话都要付这几百 token，哪怕本轮根本用不到圆角规则。

做法：长段规则从 prompts.ts 移到这里，模型需要时调 read_guidance(section)
按段读取。prompts.ts 只留一行索引（每段一句话），"工具描述每轮必付、
规则正文用到才读" —— 和 SolidPilot 把近静态规则放 resource 侧是同一个
思路（他们的原话：a tool's description is paid on every single turn whether
or not it is used, while a resource body costs only when read）。

段与段独立，按需读取，读完即用，不要求模型记住。
"""
from __future__ import annotations

GUIDANCE: dict[str, str] = {
    "tools": r"""## 工具用法要点（避免上一版反复失败的那些坑）
- **闭合轮廓一律用 \`sketch_polyline\`**（如 \`"30,15 30,50 55,15"\`）。多次 \`sketch_line\` 的端点不会自动焊接，profile 不闭合，拉伸必失败。
- **圆弧要用真圆弧，不要用短直线近似**。\`sketch_polyline\` 的点可以带弧：\`r<半径>:\` 前缀表示从上一点沿圆弧走到这一点，例如 \`"0,0 60,0 r10:60,20 0,20"\`（三条直边 + 一段 R10 圆弧）。正半径向行进方向右侧凸，负半径向左凸，始终取劣弧。用折线拟合圆弧得到的既不是真圆柱面、也无法编辑。
- **等截面外轮廓的圆角优先用 \`sketch_rounded_rectangle\` 或 \`sketch_fillet\` 画进草图**：矩形板四角倒 R 用 \`sketch_rounded_rectangle(width, height, radius)\`，切点由工具算，尺寸精确；草图圆角有尺寸，照样可改。\`fillet_edges\` 留给真正的三维边（已成型实体的顶面边、交线等）。
- \`fillet_edges\` 失败时如实报告，不要反复重试。也可以请用户在 SolidWorks 里选好边，然后用 \`edges="selected"\` —— 这比让工具猜哪几条边更可靠。
- **倒圆角直接说清哪些边**：\`fillet_edges(radius=10, edges="vertical")\`。vertical=四角竖边 / horizontal / circular / all / top / bottom / selected。圆柱顶面边用 \`edges="top"\`（只倒顶圈），别用 circular（会连底面一起倒）。
- ⚠️ **\`circular\` 会选中整个文档里所有圆形边**（孔的圆边、圆柱的顶/底边、已有圆角的边全算）——复杂零件里整批倒容易失败。想倒"某个特征自己的边"（如圆柱顶面边），直接说清特征：工具会优先按最近特征选边（feature 策略）。也可以请用户在 SolidWorks 里手动选中目标边，然后用 \`edges="selected"\`（工具会校验选中的确实是边，混有面/特征会拒绝）。
- **腰形槽/键槽用 \`sketch_slot\`**（两端是真半圆弧），不要用矩形加两个圆去拼。
- **阵列给特征名**：\`linear_pattern(feature="切除-拉伸1", direction="x", count=2, spacing=90)\`；圆周阵列同理给 \`feature\`。特征名用 \`list_features\` 查。
- **镜像给特征名**：\`mirror_feature(plane="front", features="凸台-拉伸3")\`。
- **在模型面上开草图**：\`start_sketch(face="top")\`。
- 某个工具失败 2 次就换思路或问用户，**不要删了重画**——每轮删改都会在特征树里留垃圾，越弄越乱。""",

    "modeling": r"""## 建模要点（按 SolidWorks 实际操作习惯）
- 打孔一律用 \`cut_extrude\`，通孔传 \`through_all: true\`。**不要用 revolve 打孔**——旋转特征是加材料的，会长出凸台。
- 切除方向由工具自动判定（先按给定方向、再反向、再双向），**不要因为一次失败就换建模方案**；真正失败的原因通常是草图轮廓与实体不重叠（位置/平面选错），不是方向。
- **在模型上继续建特征，直接在面上开草图**：\`start_sketch(face="top")\`（也可 bottom/front/back/left/right），就像在 SolidWorks 里点一下那个面。**不要为此新建基准面** —— 那会让零件里堆满「基准面N」，还容易把高度算错。
- \`plane=\` 只用于第一张草图，或确实需要一个偏移基准面的场合（此时用 \`create_plane\` 建，建完立刻用掉）。
- 拉伸方向不对时给 \`extrude\` 传 \`flip: true\`；两侧对称拉伸传 \`both_dir: true\`。
- 一个工具连续失败 2 次就停下来问用户，不要连环换方案——每次失败都会留下废草图，越改越乱。""",

    "macro": r"""## \`run_macro\`：逃生舱，不是主路
只在**现成工具覆盖不到**时用（复杂扫描/放样曲面、方程驱动曲线、跨大量特征的批量编辑）。常规建模用工具严格更好 —— 工具替你换算单位、搜索本机可用的 API 参数个数、按语义选面选边、并报出真实错误。

写宏时注意这三条（否则静态检查会直接拦下来）：
1. **长度单位是米**：40mm 要写 \`0.04\` 或 \`40/1000\`。写 \`40\` 意味着 40 米，宏会"成功"但几何完全错。
2. **禁止 \`On Error Resume Next\`**：它让后续每一步失败都静默通过，宏报告成功但什么也没做。
3. **不要臆造面名/边名**（\`"轴-1@装配体1/圆柱面"\` 这种）：\`SelectByID2\` 会返回 False 然后后续调用空转。用 \`list_features\` / \`list_components\` 拿真实名字。""",

    "drawing": r"""## 工程图（交付的最后一步）
模型做完了不等于活干完了。\`create_drawing_of\` 一步生成三视图+等轴测；\`insert_model_dimensions\` 直接把模型自带尺寸导到视图上（最快的标注方式）；装配图用 \`insert_bom\` 加明细表。视图位置单位是图纸 mm。""",

    "generators": r"""## 标准机械件：用生成器，不要手画
这些零件的几何是**数学定义**的，手画必然错：
- **齿轮** → \`create_spur_gear(module, teeth, thickness, bore)\`。渐开线齿形是特定曲线，手画的"圆周开梯形槽/矩形槽"啮合不了，那不是齿轮而是废件。**这个工具失败时，如实报告失败并把报错原文给用户，不要退化成矩形齿槽方案** —— 一个不能啮合的"齿轮"比没有齿轮更糟，用户拿到会以为能用。设计齿轮箱**先调 \`gear_pair_geometry\`** 拿到中心距 —— 两个轴孔必须精确按这个距离放，否则齿轮不啮合。
- **阶梯轴** → \`create_stepped_shaft(steps="20x30 30x50 25x40")\`。一次给出所有台阶，比逐段拉伸可靠得多（逐段要为每段建偏移面，肩部很容易错位）。""",

    "assembly": r"""## 装配体
- 每个零件各用一次 \`build_part\` 造好并 \`save_as\` 保存，再新建装配体逐个 \`insert_component\`。**不要在一个零件文档里堆出整台机器。**
- 插入的组件位置默认在原点；需要精确定位时传 x/y/z（装配体坐标系，mm）。
- 配合（\`add_mate\`）前必须先选中两个实体（面/边/顶点/轴），配合类型：coincident / concentric / perpendicular / parallel / tangent / distance / angle。
- 对齐默认 \`closest\`（让 SolidWorks 选合理的一侧，就是 UI 默认行为）；要明确同向/反向时再传 \`aligned\` / \`anti_aligned\`。""",
}


def read_guidance_section(section: str) -> str | None:
    """Return the rule text for a section, or None if unknown."""
    return GUIDANCE.get(section)
