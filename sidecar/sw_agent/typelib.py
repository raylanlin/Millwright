r"""sw_agent.typelib — SolidWorks feature enum values, and OPTIONAL early-binding cache.

## What this module is for now

CreateDefinition(swFmCut) is the one cut API that does not depend on guessing an
argument count, so its enum value has to come from somewhere. Two sources:

  1. win32com.client.constants — populated only if a gen_py cache exists
  2. the hard-coded table below

(2) is authoritative enough: these are swFeatureNameID_e values and they have not moved
in the releases we support. So the definition-based path works on every machine,
regardless of whether the type library was ever generated.

## Why generation is NOT done at startup any more (P72)

P69 built the cache during the startup warmup. That broke SolidWorks connectivity
outright, and the way it broke was instructive:

    makepy over sldworks.tlb takes tens of seconds to minutes (it is an enormous type
    library, and the old code attempted EVERY registered version in turn)
      -> COM and disk saturated for the duration
      -> the separate cscript/VBS probe in sw-bridge.ts times out after 15s
      -> attach fails, the WMI check then sees SLDWORKS.exe running
      -> the UI reports "SolidWorks is running but COM refused — check privilege levels"

The message was accurate about the symptom and completely wrong about the cause: nothing
was misconfigured, the connection was simply starved. A background optimisation must
never be able to do that.

So generation is now on demand only, behind an explicit call, and never on the startup
path. Nothing needs it to run: the enum table already supplies the values, so this is a
nice-to-have that must not cost anything.
"""
from __future__ import annotations

import os
import winreg

# SolidWorks type library GUID — stable across releases (the VERSION varies, not this).
SW_TYPELIB_GUID = "{83A33D31-27C5-11CE-BFD4-00400513BB57}"

# swFeatureNameID_e values needed by CreateDefinition. Hard-coded on purpose — this is
# the primary source, not a fallback, so the definition-based feature path is available
# without any type-library work at all.
FEATURE_ID = {
    "extrusion": 9,   # swFmExtrusion
    "cut": 6,         # swFmCut
    "fillet": 12,     # swFmFillet
    "revolve": 22,    # swFmRevolve
    "shell": 26,      # swFmShell
}

_CONST_NAME = {
    "extrusion": "swFmExtrusion",
    "cut": "swFmCut",
    "fillet": "swFmFillet",
    "revolve": "swFmRevolve",
    "shell": "swFmShell",
}


def feature_id(kind: str):
    """Enum value for CreateDefinition. Prefers the live constants when a cache happens
    to exist, otherwise the built-in table. None only for an unknown kind."""
    try:
        import win32com.client as wc
        name = _CONST_NAME.get(kind)
        if name:
            v = getattr(wc.constants, name, None)
            if isinstance(v, int):
                return v
    except Exception:  # noqa: BLE001
        pass
    return FEATURE_ID.get(kind)


def constants_loaded() -> bool:
    """Whether win32com's constants table is populated (i.e. a gen_py cache exists)."""
    try:
        import win32com.client as wc
        d = getattr(wc.constants, "__dicts__", None)
        return bool(d) and any(d)
    except Exception:  # noqa: BLE001
        return False


def _registered_typelibs():
    """Registered versions of the SolidWorks type library, newest first.

    Yields (major, minor, path). Registry versions are HEX strings ("1f.0"), so they are
    parsed with base 16 — reading them as decimal silently selects the wrong release.
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


_LAST_STATE: dict = {"ok": False, "tried": ["not attempted — generation is on demand only"]}


def typelib_state() -> dict:
    """Outcome of the last build_typelib_cache() call, with per-route failure reasons."""
    state = dict(_LAST_STATE)
    state["constants_loaded"] = constants_loaded()
    return state


def build_typelib_cache(log=None) -> dict:
    """Generate the gen_py cache. EXPENSIVE — tens of seconds to minutes.

    Never call this on the startup path or from anything holding up a user action; see
    the module docstring for what happened when it was. It exists so the cache can be
    built deliberately (a diagnostics action, or a user-initiated repair), not as an
    invisible optimisation.

    Only the NEWEST registered version is attempted. The old code looped over every
    registered version and then ran makepy over each .tlb as well, multiplying an
    already slow operation by the number of installed releases.
    """
    global _LAST_STATE

    def say(msg):
        if log:
            try:
                log(msg)
            except Exception:  # noqa: BLE001
                pass

    if constants_loaded():
        _LAST_STATE = {"ok": True, "how": "already-loaded"}
        return dict(_LAST_STATE)

    tried = []
    versions = _registered_typelibs()
    if not versions:
        _LAST_STATE = {"ok": False, "tried": ["no SolidWorks type library registered"]}
        return dict(_LAST_STATE)

    major, minor, path = versions[0]
    try:
        from win32com.client import gencache
        gencache.EnsureModule(SW_TYPELIB_GUID, 0, major, minor)
        say(f"typelib cache built from registry v{major}.{minor}")
        _LAST_STATE = {"ok": True, "how": "registry", "version": f"{major}.{minor}", "tlb": path}
        return dict(_LAST_STATE)
    except Exception as e:  # noqa: BLE001
        tried.append(f"EnsureModule {major}.{minor}: {e}")

    try:
        from win32com.client import makepy
        makepy.GenerateFromTypeLibSpec(path, bForDemand=False, bBuildHidden=True)
        say("typelib cache built with makepy from the .tlb")
        _LAST_STATE = {"ok": True, "how": "makepy", "tlb": path}
        return dict(_LAST_STATE)
    except Exception as e:  # noqa: BLE001
        tried.append(f"makepy {os.path.basename(path)}: {e}")

    _LAST_STATE = {"ok": False, "tried": tried}
    return dict(_LAST_STATE)
