"""sw_agent.bridge — SolidWorks COM 连接与执行上下文。

关键约定：
- 只用 GetActiveObject 连接**已运行**的实例，绝不 CreateObject（否则会起一个隐形 SW，
  后续所有操作都对着看不见的实例“成功”执行）。
- 所有工具通过 Context 拿 app / model / 各 Manager，统一在这里处理“没连上 / 没文档”。
"""
from __future__ import annotations
from typing import Any

# swDocumentTypes_e
DOC_PART = 1
DOC_ASSEMBLY = 2
DOC_DRAWING = 3
DOC_TYPE_NAME = {DOC_PART: "part", DOC_ASSEMBLY: "assembly", DOC_DRAWING: "drawing"}

_PLANES = {
    "front": ("Front Plane", "前视基准面"),
    "top": ("Top Plane", "上视基准面"),
    "right": ("Right Plane", "右视基准面"),
}


class SWError(Exception):
    """面向 agent 的可读错误。str(e) 会作为 JSON-RPC error 返回。"""


class Context:
    """一次会话的执行上下文，持久驻留（跨多步工具调用复用同一 COM 连接）。"""

    def __init__(self) -> None:
        self._app = None
        self.scratch: dict[str, Any] = {}  # 供工具间传值（如上一步创建的特征名）

    # ---- 连接 ----
    @property
    def sw(self):
        if self._app is None:
            try:
                import win32com.client  # 延迟导入，非 Windows 环境也能 import 本模块
                self._app = win32com.client.GetActiveObject("SldWorks.Application")
            except Exception as e:  # noqa: BLE001
                raise SWError(
                    "无法连接 SolidWorks：请确认 SolidWorks 已启动并至少打开过一次。"
                    f"（{e}）"
                )
        return self._app

    def reconnect(self):
        self._app = None
        return self.sw

    @property
    def model(self):
        m = self.sw.ActiveDoc
        if m is None:
            raise SWError("没有打开的文档，请先在 SolidWorks 中新建或打开一个文档。")
        return m

    def require(self, doc_type: int, label: str):
        m = self.model
        if m.GetType() != doc_type:
            raise SWError(f"当前操作要求{label}文档。")
        return m

    # ---- 常用 Manager ----
    @property
    def feat_mgr(self):
        return self.model.FeatureManager

    @property
    def sketch_mgr(self):
        return self.model.SketchManager

    @property
    def sel_mgr(self):
        return self.model.SelectionManager

    # ---- 选择辅助 ----
    def clear_selection(self):
        self.model.ClearSelection2(True)

    def selected_count(self) -> int:
        return self.model.SelectionManager.GetSelectedObjectCount2(-1)

    def select_by_id(self, name, typ, x=0.0, y=0.0, z=0.0, append=False, mark=0) -> bool:
        return bool(
            self.model.Extension.SelectByID2(name, typ, x, y, z, append, mark, None, 0)
        )

    def select_plane(self, which: str, append=False, mark=0) -> bool:
        """选基准面，自动兼容中/英文模板。"""
        key = (which or "").lower()
        if key not in _PLANES:
            raise SWError(f"未知基准面：{which}（应为 front/top/right）")
        en, zh = _PLANES[key]
        before = self.selected_count()
        if self.select_by_id(en, "PLANE", append=append, mark=mark):
            return True
        if self.selected_count() <= before:  # 英文名没选中 → 试中文
            return self.select_by_id(zh, "PLANE", append=append, mark=mark)
        return True

    # ---- 重建 ----
    def rebuild(self, top_only=False):
        self.model.ForceRebuild3(top_only)


def doc_type_name(model) -> str:
    return DOC_TYPE_NAME.get(model.GetType(), "unknown")
