// src/main/scripts/generators/export.ts
//
// 导出操作。
// SolidWorks 的 Extension.SaveAs 对扩展名敏感 —— .step/.stp/.pdf/.stl/.dxf 会自动
// 选对应的转换器。我们只要确保路径写对就行。

import { PRELUDE_ACTIVE_DOC, wrapMain, vbaString } from './vba-helpers';

/**
 * 通用 SaveAs 代码片段 —— 给定目标文件路径,调用 SaveAs 并处理错误。
 * 内部使用:不对外导出。
 */
function saveAsBody(path: string, description: string): string {
  return `${PRELUDE_ACTIVE_DOC}

Dim errors As Long
Dim warnings As Long
Dim ok As Boolean

' 确保目录存在 —— VBA 里用 Dir 检测,不存在则尝试用 MkDir 创建
Dim targetPath As String
targetPath = ${vbaString(path)}
Dim dirPath As String
dirPath = Left(targetPath, InStrRev(targetPath, "\\") - 1)
If Len(dirPath) > 0 And Dir(dirPath, vbDirectory) = "" Then
    ' 递归创建目录
    Dim parts() As String
    parts = Split(dirPath, "\\")
    Dim acc As String
    Dim i As Long
    acc = parts(0)
    For i = 1 To UBound(parts)
        acc = acc & "\\" & parts(i)
        If Dir(acc, vbDirectory) = "" Then MkDir acc
    Next i
End If

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

Dim dirPath As String
dirPath = Left(targetPath, InStrRev(targetPath, "\\") - 1)
If Len(dirPath) > 0 And Dir(dirPath, vbDirectory) = "" Then
    Dim parts() As String
    parts = Split(dirPath, "\\")
    Dim acc As String
    Dim i As Long
    acc = parts(0)
    For i = 1 To UBound(parts)
        acc = acc & "\\" & parts(i)
        If Dir(acc, vbDirectory) = "" Then MkDir acc
    Next i
End If

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
