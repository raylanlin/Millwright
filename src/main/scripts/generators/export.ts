// src/main/scripts/generators/export.ts
//
// 导出操作。
// SolidWorks 的 Extension.SaveAs 对扩展名敏感 —— .step/.stp/.pdf/.stl/.dxf 会自动
// 选对应的转换器。我们只要确保路径写对就行。

import { PRELUDE_ACTIVE_DOC, wrapMain, vbaString, ensureParentDir } from './vba-helpers';

/**
 * 通用 SaveAs 代码片段 —— 给定目标文件路径,调用 SaveAs 并处理错误。
 * 内部使用:不对外导出。
 * 注意:目录检测/创建必须用 FileSystemObject ——
 * VBA 的 Dir()/MkDir 在 VBScript 执行环境中不存在。
 */
function saveAsBody(path: string, description: string): string {
  return `${PRELUDE_ACTIVE_DOC}

Dim errors As Long
Dim warnings As Long
Dim ok As Boolean

Dim targetPath As String
targetPath = ${vbaString(path)}

Dim swcpFso As Object
Set swcpFso = CreateObject("Scripting.FileSystemObject")
${ensureParentDir('swcpFso', 'targetPath')}

ok = swModel.Extension.SaveAs(targetPath, 0, 1, Nothing, errors, warnings)

If ok Then
    MsgBox "${description}导出成功: " & targetPath, vbInformation
Else
    MsgBox "${description}导出失败。错误码: " & errors & ", 警告: " & warnings, vbExclamation
End If`;
}

export function exportStep(params: { outputPath: string }): string {
  return wrapMain(saveAsBody(params.outputPath, 'STEP '));
}

export function exportPdf(params: { outputPath: string }): string {
  return wrapMain(saveAsBody(params.outputPath, 'PDF '));
}

export function exportStl(params: { outputPath: string; quality?: 'coarse' | 'fine' }): string {
  // STL 质量通过 UserPreference 设置。SaveAs 之前改一次。
  // swSTLQuality = 334 (enum int),Coarse=0, Fine=1
  const qualityValue = params.quality === 'fine' ? 1 : 0;

  const body = `${PRELUDE_ACTIVE_DOC}

' 设置 STL 质量:${params.quality ?? 'coarse'}
swApp.SetUserPreferenceIntegerValue 334, ${qualityValue}

Dim errors As Long
Dim warnings As Long
Dim targetPath As String
targetPath = ${vbaString(params.outputPath)}

Dim swcpFso As Object
Set swcpFso = CreateObject("Scripting.FileSystemObject")
${ensureParentDir('swcpFso', 'targetPath')}

If swModel.Extension.SaveAs(targetPath, 0, 1, Nothing, errors, warnings) Then
    MsgBox "STL 导出成功: " & targetPath, vbInformation
Else
    MsgBox "STL 导出失败。错误码: " & errors, vbExclamation
End If`;
  return wrapMain(body);
}

export function exportDxf(params: { outputPath: string }): string {
  return wrapMain(saveAsBody(params.outputPath, 'DXF '));
}
