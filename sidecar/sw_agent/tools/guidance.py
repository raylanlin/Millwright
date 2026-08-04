"""sw_agent.tools.guidance —— 按需读取规则段（P99）。

长段规则（工具用法、建模要点、宏细则、装配体等）移出了每轮必付的系统提示词，
模型需要某类规则时调用 read_guidance(section) 按段读取。提示词里只留一行索引。
"""
from __future__ import annotations

from sw_agent.bridge import Context
from sw_agent.guidance import GUIDANCE, read_guidance_section
from sw_agent.registry import tool


@tool(
    "read_guidance",
    "Read a rule section on demand — long reference material that is NOT worth paying "
    "for on every turn. Sections: tools (tool usage pitfalls), modeling (modeling "
    "habits), macro (run_macro rules), drawing (engineering drawings), generators "
    "(standard machine parts: gears/shafts), assembly (assemblies and mates). Call "
    "when the current task hits that area; the text is the same rules that used to be "
    "in the system prompt.",
    params={
        "section": {
            "type": "string",
            "enum": sorted(GUIDANCE.keys()),
            "desc": "Which rule section to read: tools / modeling / macro / drawing / generators / assembly",
        },
    },
    category="query",
)
def read_guidance(ctx: Context, section: str):
    text = read_guidance_section(section)
    if text is None:
        from sw_agent.bridge import SWError
        raise SWError(f"unknown guidance section: {section} (known: {sorted(GUIDANCE.keys())})")
    return {"section": section, "guidance": text}
