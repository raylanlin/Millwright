"""sw_agent.units — 单位换算。

SolidWorks API 一律用 SI：长度=米、角度=弧度。
用户/LLM 习惯 mm / 度，工具入口统一在这里转换，绝不让裸数字直接进 API。
"""
from __future__ import annotations
import math


def mm(value: float) -> float:
    """毫米 → 米"""
    return float(value) / 1000.0


def deg(value: float) -> float:
    """度 → 弧度"""
    return math.radians(float(value))


def m_to_mm(value: float) -> float:
    """米 → 毫米（用于把 API 读数回报给用户）"""
    return float(value) * 1000.0


def m3_to_mm3(value: float) -> float:
    """立方米 → 立方毫米"""
    return float(value) * 1.0e9
