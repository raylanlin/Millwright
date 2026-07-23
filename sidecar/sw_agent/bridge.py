"""sw_agent.bridge — SolidWorks COM connection and execution context.

Key conventions:
- Use GetActiveObject to connect to an **already-running** instance. Never
  CreateObject (that would spawn a hidden SolidWorks, and every subsequent
  operation would silently succeed against an invisible target).
- P13: attach tries the bare ProgID first, then every versioned ProgID
  (SW 2017-2026) — same fix as the VBS AttachSW(). On many installs only
  the versioned ProgID is registered in the ROT.
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


class Context:
    """Per-session execution context. Long-lived so multi-step tool calls reuse the same COM connection."""

    def __init__(self) -> None:
        self._app = None
        self.scratch: dict[str, Any] = {}  # Inter-tool scratchpad (e.g. the feature name created in the previous step)

    # ---- Connection ----
    @property
    def sw(self):
        if self._app is None:
            import win32com.client  # Lazy import so the module loads on non-Windows hosts too
            last_err: Exception | None = None
            for progid in _PROGIDS:
                try:
                    self._app = win32com.client.GetActiveObject(progid)
                    break
                except Exception as e:  # noqa: BLE001
                    last_err = e
            if self._app is None:
                raise SWError(
                    "Cannot connect to SolidWorks: make sure SolidWorks is running and has been opened at least once. "
                    f"({last_err})"
                )
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
        if m.GetType() != doc_type:
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
        return bool(
            self.model.Extension.SelectByID2(name, typ, x, y, z, append, mark, None, 0)
        )

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
    return DOC_TYPE_NAME.get(model.GetType(), "unknown")
