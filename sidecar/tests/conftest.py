"""Make `sw_agent` importable when pytest runs from the repo root.

CI runs `pytest sidecar/tests -q` from the repository root, where `sidecar/`
is not on sys.path — the tests under this directory import `from sw_agent
import …`, which would otherwise raise ModuleNotFoundError. This conftest
injects the sidecar package root before collection.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
