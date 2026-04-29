"""
templates/export-pdf.py
将当前 SolidWorks 文档另存为 PDF。

使用方法:修改 OUTPUT_PATH 为目标路径后执行。
需要已安装 pywin32: pip install pywin32
"""

import os
import sys
import win32com.client


OUTPUT_PATH = r"C:\output\drawing.pdf"  # 修改为你想要的输出路径


def main() -> int:
    # 连接到已运行的 SolidWorks 实例
    try:
        sw = win32com.client.Dispatch("SldWorks.Application")
    except Exception as e:
        print(f"无法连接 SolidWorks: {e}", file=sys.stderr)
        return 1

    model = sw.ActiveDoc
    if model is None:
        print("没有打开的活动文档", file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)

    # SaveAs 参数: Name, Version, Options, ExportData, AdvancedSaveOptions, Errors, Warnings
    errors = 0
    warnings = 0
    ok = model.Extension.SaveAs(
        OUTPUT_PATH,
        0,  # swSaveAsCurrentVersion
        1,  # swSaveAsOptions_Silent
        None,
        None,
        None,
    )

    if ok:
        print(f"已导出: {OUTPUT_PATH}")
        return 0
    print(f"导出失败 (errors={errors}, warnings={warnings})", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
