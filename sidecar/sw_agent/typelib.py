r"""sw_agent.typelib — build the SolidWorks early-binding cache from the REGISTRY.

Why this file exists, in one line: without a gen_py cache nothing else works properly.

The chain of failures it causes, observed end to end on a real machine:

    EnsureDispatch(live swApp)
        -> "This COM object can not automate the makepy process"
    -> no gen_py module
    -> win32com.client.constants is empty
    -> swFmCut cannot be resolved
    -> IFeatureManager.CreateDefinition(swFmCut) -- the ONE cut API that does not
       depend on guessing an argument count -- is unreachable
    -> fall back to positional FeatureCut4/27, which the server "accepts" and then
       silently creates nothing
    -> and separately: SelectByID2(name, "SKETCH") cannot resolve either, so the
       sketch cannot even be selected by name

So a missing type library presents as "cut_extrude sometimes doesn't work", which is
about as far from the cause as an error message can get.

EnsureDispatch asks the LIVE object for its type information (IProvideClassInfo).
SolidWorks' automation object does not always answer, and there is no way to make it.
But the type library itself is right there on disk and registered — SolidWorks ships
sldworks.tlb and records it under HKEY_CLASSES_ROOT\TypeLib. Reading the registry and
generating from the .tlb needs no cooperation from the running application at all.
"""
from __future__ import annotations

import os
import winreg

# SolidWorks type library GUID — stable across releases (the VERSION varies, not this).
SW_TYPELIB_GUID = "{83A33D31-27C5-11CE-BFD4-00400513BB57}"


def _registered_typelibs():
    """Every registered version of the SolidWorks type library, newest first.

    Yields (major, minor, path). Versions are hex strings in the registry ("1f.0"),
    which is why they are parsed with base 16 — reading them as decimal silently picks
    the wrong release.
    """
    found = []
    for root in (winreg.HKEY_CLASSES_ROOT, winreg.HKEY_LOCAL_MACHINE):
        base = "TypeLib\\" + SW_TYPELIB_GUID
        if root == winreg.HKEY_LOCAL_MACHINE:
            base = "SOFTWARE\\Classes\\" + base
        try:
            key = winreg.OpenKey(root, base)
        except OSError:
            continue
        try:
            i = 0
            while True:
                try:
                    ver = winreg.EnumKey(key, i)
                except OSError:
                    break
                i += 1
                try:
                    major_s, minor_s = (ver.split(".") + ["0"])[:2]
                    major, minor = int(major_s, 16), int(minor_s, 16)
                except ValueError:
                    continue
                for sub in ("win64", "win32"):
                    try:
                        with winreg.OpenKey(key, rf"{ver}\0\{sub}") as k:
                            path = winreg.QueryValue(k, "")
                        if path and os.path.exists(path):
                            found.append((major, minor, path))
                            break
                    except OSError:
                        continue
        finally:
            key.Close()
    found.sort(key=lambda t: (t[0], t[1]), reverse=True)
    return found


_LAST_STATE: dict = {"ok": False, "tried": ["not attempted yet"]}


def typelib_state() -> dict:
    """The outcome of the last ensure_typelib() call, including per-route failure
    reasons. Startup runs on a background thread, so without stashing this the reason a
    route failed was only ever visible in the log — and by the time a tool misbehaved it
    had scrolled away."""
    return dict(_LAST_STATE)


def _ensure_typelib_inner(log=None) -> dict:
    """Make sure the gen_py cache and `constants` are populated. Idempotent.

    Returns a dict describing what happened — it goes into the handshake reply so a
    machine where this fails says so up front, instead of surfacing three layers later
    as a cut that quietly does nothing.
    """
    def say(msg):
        if log:
            try:
                log(msg)
            except Exception:  # noqa: BLE001
                pass

    import win32com.client as wc
    from win32com.client import gencache

    # Already good? (a populated constants table is the thing we actually need)
    if getattr(wc.constants, "__dicts__", None) and any(wc.constants.__dicts__):
        return {"ok": True, "how": "already-loaded"}

    tried = []

    # Route 1 — generate from the registered .tlb. Needs nothing from the running app.
    for major, minor, path in _registered_typelibs():
        try:
            gencache.EnsureModule(SW_TYPELIB_GUID, 0, major, minor)
            say(f"typelib cache built from registry v{major}.{minor}")
            return {"ok": True, "how": "registry", "version": f"{major}.{minor}", "tlb": path}
        except Exception as e:  # noqa: BLE001
            tried.append(f"EnsureModule {major}.{minor}: {e}")
        try:
            gencache.MakeModuleForTypelibInterface(
                gencache.MakePyFromTypelib(path) if hasattr(gencache, "MakePyFromTypelib") else path,
            )
        except Exception:  # noqa: BLE001 — best effort, older pywin32 lacks these helpers
            pass

    # Route 2 — makepy against the .tlb path directly
    for _major, _minor, path in _registered_typelibs():
        try:
            from win32com.client import makepy
            makepy.GenerateFromTypeLibSpec(path, bForDemand=False, bBuildHidden=True)
            say("typelib cache built with makepy from the .tlb")
            return {"ok": True, "how": "makepy", "tlb": path}
        except Exception as e:  # noqa: BLE001
            tried.append(f"makepy {os.path.basename(path)}: {e}")

    # Route 3 — the old way: ask the live object. Documented to fail on some installs,
    # kept last because when it does work it is the least trouble.
    try:
        gencache.EnsureDispatch("SldWorks.Application")
        say("typelib cache built from the live application")
        return {"ok": True, "how": "ensure-dispatch"}
    except Exception as e:  # noqa: BLE001
        tried.append(f"EnsureDispatch: {e}")

    return {"ok": False, "tried": tried[-4:]}


# swFeatureNameID_e values needed by CreateDefinition. Hard-coded so a machine with no
# type library still gets the definition-based feature path (which is arity-independent)
# instead of falling through to positional argument guessing.
FEATURE_ID = {
    "extrusion": 9,   # swFmExtrusion
    "cut": 6,         # swFmCut
    "fillet": 12,     # swFmFillet
    "revolve": 22,    # swFmRevolve
    "shell": 26,      # swFmShell
}


def feature_id(kind: str):
    """Enum value for CreateDefinition — from constants when available, else the
    hard-coded table. Returns None only for an unknown kind."""
    try:
        import win32com.client as wc
        name = {"extrusion": "swFmExtrusion", "cut": "swFmCut", "fillet": "swFmFillet",
                "revolve": "swFmRevolve", "shell": "swFmShell"}.get(kind)
        if name:
            v = getattr(wc.constants, name, None)
            if isinstance(v, int):
                return v
    except Exception:  # noqa: BLE001
        pass
    return FEATURE_ID.get(kind)


def ensure_typelib(log=None) -> dict:
    """Wrapper that records the outcome for typelib_state()."""
    global _LAST_STATE
    try:
        _LAST_STATE = _ensure_typelib_inner(log=log)
    except Exception as e:  # noqa: BLE001 — never let cache generation break startup
        _LAST_STATE = {"ok": False, "tried": [f"unexpected: {e}"]}
    return dict(_LAST_STATE)
