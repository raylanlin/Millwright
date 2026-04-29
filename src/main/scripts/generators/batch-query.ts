// src/main/scripts/generators/batch-query.ts
//
// 批量重命名 / 干涉检查 / 质量属性 / BOM 导出。

import { PRELUDE_ACTIVE_DOC, wrapMain, vbaString } from './vba-helpers';

/**
 * 批量重命名 —— 装配体中的零部件按字符串替换重命名。
 *
 * 注意:VBA 本身没有内置正则,我们用 Replace() 做简单字符串替换。
 * 如果需要真正的正则,后续可以在脚本里引入 VBScript.RegExp 对象。
 *
 * @param pattern 要替换的原始字符串(不是正则)
 * @param replacement 替换为
 */
export function batchRename(params: {
  pattern: string;
  replacement: string;
}): string {
  const body = `${PRELUDE_ACTIVE_DOC}

If swModel.GetType <> 2 Then
    MsgBox "请在装配体中运行", vbExclamation
    Exit Sub
End If

Dim swAssembly As AssemblyDoc
Set swAssembly = swModel

Dim vComps As Variant
vComps = swAssembly.GetComponents(True)

Dim renamedCount As Long
renamedCount = 0

Dim i As Long
For i = 0 To UBound(vComps)
    Dim comp As Component2
    Set comp = vComps(i)
    Dim oldName As String
    oldName = comp.Name2
    If InStr(oldName, ${vbaString(params.pattern)}) > 0 Then
        Dim newName As String
        newName = Replace(oldName, ${vbaString(params.pattern)}, ${vbaString(params.replacement)})
        ' 注意:只修改实例名(Name2),不改物理文件
        Dim ok As Boolean
        ok = swAssembly.RenameComponent(oldName, newName)
        If ok Then renamedCount = renamedCount + 1
    End If
Next i

MsgBox "已重命名 " & renamedCount & " 个零部件", vbInformation`;
  return wrapMain(body);
}

/**
 * 干涉检查 —— 在当前装配体上运行 Interference Detection,列出所有干涉对。
 */
export function checkInterference(): string {
  const body = `${PRELUDE_ACTIVE_DOC}

If swModel.GetType <> 2 Then
    MsgBox "请在装配体中运行", vbExclamation
    Exit Sub
End If

Dim swAssembly As AssemblyDoc
Set swAssembly = swModel

Dim swInterMgr As InterferenceDetectionMgr
Set swInterMgr = swAssembly.InterferenceDetectionManager

' 启用常用选项
swInterMgr.TreatCoincidenceAsInterference = False
swInterMgr.IncludeMultibodyPartInterferences = True

Dim vInterferences As Variant
vInterferences = swInterMgr.GetInterferences

If IsEmpty(vInterferences) Then
    MsgBox "未发现干涉", vbInformation
    Exit Sub
End If

Dim msg As String
msg = "发现 " & (UBound(vInterferences) + 1) & " 处干涉:" & vbCrLf & vbCrLf
Dim i As Long
For i = 0 To UBound(vInterferences)
    Dim inter As Interference
    Set inter = vInterferences(i)
    Dim comps As Variant
    comps = inter.Components
    msg = msg & (i + 1) & ". "
    If Not IsEmpty(comps) Then
        Dim j As Long
        For j = 0 To UBound(comps)
            msg = msg & comps(j).Name2
            If j < UBound(comps) Then msg = msg & " ↔ "
        Next j
    End If
    msg = msg & "  体积=" & Format(inter.Volume * 1000000000, "0.00") & " mm³" & vbCrLf
    If i >= 19 Then
        msg = msg & "..." & vbCrLf
        Exit For
    End If
Next i

MsgBox msg, vbInformation, "干涉检查结果"`;
  return wrapMain(body);
}

/**
 * 质量属性查询 —— 质量、体积、重心。
 */
export function massProperties(): string {
  const body = `${PRELUDE_ACTIVE_DOC}

Dim swMass As MassProperty
Set swMass = swModel.Extension.CreateMassProperty

Dim m As Double
Dim v As Double
m = swMass.Mass
v = swMass.Volume

Dim cog As Variant
cog = swMass.CenterOfMass  ' [x, y, z] in meters

Dim msg As String
msg = "质量: " & Format(m, "0.0000") & " kg" & vbCrLf & _
      "体积: " & Format(v * 1000000000, "0.00") & " mm³" & vbCrLf & _
      "重心: (" & Format(cog(0) * 1000, "0.00") & ", " & _
                 Format(cog(1) * 1000, "0.00") & ", " & _
                 Format(cog(2) * 1000, "0.00") & ") mm"

MsgBox msg, vbInformation, "质量属性"`;
  return wrapMain(body);
}

/**
 * BOM 导出 —— 装配体物料清单到 Excel/CSV。
 *
 * 实现策略:遍历装配体组件,写入文本文件。
 * xlsx 格式需要 Excel 自动化(或 OpenXML),这里生成 CSV 最简单,UTF-8 BOM 让 Excel 能正确识别中文。
 * 如果用户传入 xlsx,我们说明只支持 CSV 并继续。
 */
export function bomExport(params: {
  outputPath: string;
  format: 'xlsx' | 'csv';
}): string {
  // xlsx 走更复杂路径 —— 这里先统一写 CSV,并在 xlsx 情况下给出说明
  const isXlsx = params.format === 'xlsx';

  const body = `${PRELUDE_ACTIVE_DOC}

If swModel.GetType <> 2 Then
    MsgBox "请在装配体中运行", vbExclamation
    Exit Sub
End If

${isXlsx ? "' 注:Excel 自动化较重,此脚本仅导出 CSV。如需 xlsx,请用 Excel 打开 CSV 后另存。" : ''}

Dim swAssembly As AssemblyDoc
Set swAssembly = swModel

Dim vComps As Variant
vComps = swAssembly.GetComponents(True)

' 汇总:零件文件名 → 数量
Dim dict As Object
Set dict = CreateObject("Scripting.Dictionary")
Dim i As Long
For i = 0 To UBound(vComps)
    Dim comp As Component2
    Set comp = vComps(i)
    Dim pathName As String
    pathName = comp.GetPathName
    If Len(pathName) = 0 Then GoTo NextComp
    Dim fileName As String
    fileName = Mid(pathName, InStrRev(pathName, "\\") + 1)
    If dict.Exists(fileName) Then
        dict(fileName) = dict(fileName) + 1
    Else
        dict(fileName) = 1
    End If
NextComp:
Next i

' 写 CSV
Dim fileNum As Integer
fileNum = FreeFile
Dim outPath As String
outPath = ${vbaString(params.outputPath)}

' 确保目录存在
Dim dirPath As String
dirPath = Left(outPath, InStrRev(outPath, "\\") - 1)
If Len(dirPath) > 0 And Dir(dirPath, vbDirectory) = "" Then
    Dim parts() As String
    parts = Split(dirPath, "\\")
    Dim acc As String
    Dim k As Long
    acc = parts(0)
    For k = 1 To UBound(parts)
        acc = acc & "\\" & parts(k)
        If Dir(acc, vbDirectory) = "" Then MkDir acc
    Next k
End If

Open outPath For Output As #fileNum
' UTF-8 BOM,Excel 才能识别中文
Print #fileNum, Chr(239) & Chr(187) & Chr(191);
Print #fileNum, "文件名,数量"
Dim keys As Variant
keys = dict.Keys
For i = 0 To UBound(keys)
    Print #fileNum, keys(i) & "," & dict(keys(i))
Next i
Close #fileNum

MsgBox "BOM 导出完成: " & outPath & vbCrLf & "共 " & dict.Count & " 种零件", vbInformation`;
  return wrapMain(body);
}
