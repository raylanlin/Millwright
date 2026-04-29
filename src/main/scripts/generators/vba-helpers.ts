// src/main/scripts/generators/vba-helpers.ts
//
// VBA 代码生成辅助。
// 这些函数都是纯字符串操作,没有副作用,便于单测。
//
// SolidWorks API 有两个大坑必须由生成器统一处理:
//   1. 长度单位是 米(SI)。用户/AI 习惯用 mm,必须在生成代码时做 /1000。
//   2. 角度是 弧度。用户/AI 习惯度,必须做 * PI / 180。

/** 把毫米换算成 SolidWorks API 需要的米(字符串,方便嵌入代码) */
export function mmToM(mm: number): string {
  // 避免精度/科学计数法问题,统一用定点 8 位
  // 8 位足够到纳米级,远超 CAD 精度需求
  const v = mm / 1000;
  // 去掉末尾多余的 0,但保留至少一位小数避免被误认为 int
  const s = v.toFixed(8).replace(/\.?0+$/, '');
  return s.includes('.') ? s : `${s}.0`;
}

/** 度转弧度 */
export function degToRad(deg: number): string {
  const v = (deg * Math.PI) / 180;
  const s = v.toFixed(8).replace(/\.?0+$/, '');
  return s.includes('.') ? s : `${s}.0`;
}

/**
 * 把字符串嵌入 VBA 字符串字面量。
 * VBA 里转义双引号的方式是把 " 写成 ""。
 * 路径里的反斜杠不需要转义(VBA 不像 JS 把 \ 当转义符)。
 */
export function vbaString(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * 包装一段 VBA 语句为完整可执行的 .swp 宏文件内容。
 * SolidWorks 的 RunMacro2 需要一个有 Sub main() 的模块。
 */
export function wrapMain(body: string, opts?: { withErrorHandler?: boolean }): string {
  const withErr = opts?.withErrorHandler ?? true;
  const indented = body
    .split('\n')
    .map((line) => (line.trim() ? '    ' + line : line))
    .join('\n');

  if (!withErr) {
    return `Option Explicit

Sub main()
${indented}
End Sub
`;
  }

  return `Option Explicit

Sub main()
    On Error GoTo ErrorHandler

${indented}

    Exit Sub
ErrorHandler:
    MsgBox "脚本执行出错: " & Err.Description, vbCritical, "SW Copilot"
End Sub
`;
}

/** 获取 swApp 和活动文档的标准前言 */
export const PRELUDE_ACTIVE_DOC = `Dim swApp As SldWorks.SldWorks
Dim swModel As ModelDoc2
Set swApp = Application.SldWorks
Set swModel = swApp.ActiveDoc

If swModel Is Nothing Then
    MsgBox "请先打开一个文档", vbExclamation
    Exit Sub
End If`;

/** 只要 swApp,不要求有活动文档(用于 create_* 工具) */
export const PRELUDE_APP_ONLY = `Dim swApp As SldWorks.SldWorks
Set swApp = Application.SldWorks`;

/**
 * SolidWorks 基准面名称映射。
 * 英文模板用 "Front Plane"，中文模板用 "前视基准面"。
 * 生成的 VBA 代码先尝试英文名，失败后自动 fallback 到中文名。
 */
const PLANE_NAMES: Record<string, { en: string; zh: string }> = {
  Front: { en: 'Front Plane', zh: '前视基准面' },
  Top: { en: 'Top Plane', zh: '上视基准面' },
  Right: { en: 'Right Plane', zh: '右视基准面' },
};

/**
 * 选择 SolidWorks 基准面（自动兼容中英文模板）。
 * 生成的 VBA 先用英文名尝试 SelectByID2，
 * 如果 SelectCount 仍为 0 则 fallback 到中文名。
 */
export function selectPlane(plane: 'Front' | 'Top' | 'Right'): string {
  const names = PLANE_NAMES[plane];
  return `' 尝试英文基准面名
swModel.Extension.SelectByID2 ${vbaString(names.en)}, "PLANE", 0, 0, 0, False, 0, Nothing, 0
If swModel.SelectionManager.GetSelectedObjectCount2(-1) = 0 Then
    ' Fallback: 中文模板基准面名
    swModel.Extension.SelectByID2 ${vbaString(names.zh)}, "PLANE", 0, 0, 0, False, 0, Nothing, 0
End If`;
}

/**
 * 追加选择基准面（用于镜像等需要保留先前选择的场景）。
 * Append=True, Mark=2 告诉 SolidWorks 这是镜像面而非替换当前选择。
 */
export function selectPlaneAppend(plane: 'Front' | 'Top' | 'Right'): string {
  const names = PLANE_NAMES[plane];
  return `' 追加选择镜像面(英文名)
swModel.Extension.SelectByID2 ${vbaString(names.en)}, "PLANE", 0, 0, 0, True, 2, Nothing, 0
If swModel.SelectionManager.GetSelectedObjectCount2(-1) < 2 Then
    ' Fallback: 中文模板基准面名
    swModel.Extension.SelectByID2 ${vbaString(names.zh)}, "PLANE", 0, 0, 0, True, 2, Nothing, 0
End If`;
}
