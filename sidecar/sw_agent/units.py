"""sw_agent.units — unit conversions.

The SolidWorks API always uses SI: length in meters, angle in radians.
Users and LLMs naturally think in mm / degrees, so all tool entry points
convert here. Never pass raw user numbers straight into the API.
"""
from __future__ import annotations
import math


def mm(value: float) -> float:
    """millimeters → meters"""
    return float(value) / 1000.0


def deg(value: float) -> float:
    """degrees → radians"""
    return math.radians(float(value))


def m_to_mm(value: float) -> float:
    """meters → millimeters (for reporting API readings back to the user)"""
    return float(value) * 1000.0


def m3_to_mm3(value: float) -> float:
    """cubic meters → cubic millimeters"""
    return float(value) * 1.0e9
