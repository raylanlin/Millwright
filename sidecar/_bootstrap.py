# sidecar/_bootstrap.py
#
# P14: robust entry point for the Python sidecar.
#
# The installer bundles the *embeddable* Python distribution. Its `._pth` file
# switches Python into a mode where the current working directory is NOT added
# to sys.path — so `python -m sw_agent` (which relies on cwd being importable)
# raises ModuleNotFoundError and the sidecar dies before the JSON-RPC handshake,
# silently dropping the whole app onto the VBS fallback (missing suppress /
# analyze_view / etc.). System Python on a dev box adds cwd for -m, which is why
# this never reproduced in development.
#
# Running THIS file by path and explicitly inserting its own directory on
# sys.path makes the `sw_agent` package importable regardless of interpreter
# flavor. runpy then executes the package exactly as `-m sw_agent` would.
import os
import sys
import runpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
runpy.run_module("sw_agent", run_name="__main__")
