// tests/vba-macro-writer.test.mjs
//
// v0.2.1 重写后的 vbaToVbs + checkVbsCompatibility 测试。
// 运行前先 npm run build:main。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vbaToVbs, checkVbsCompatibility } from '../dist/main/main/scripts/vba-macro-writer.js';

const WRAPPED_VBA = `Option Explicit

Sub main()
    On Error GoTo ErrorHandler

    Dim swApp As SldWorks.SldWorks
    Dim swModel As ModelDoc2
    Set swApp = Application.SldWorks
    Set swModel = swApp.ActiveDoc

    If swModel Is Nothing Then
        MsgBox "请先打开一个文档", vbExclamation
        Exit Sub
    End If

    swModel.SketchManager.InsertSketch True

    Exit Sub
ErrorHandler:
    MsgBox "脚本执行出错: " & Err.Description, vbCritical, "Millwright"
End Sub
`;

test('保留 Sub main() 结构并在顶层调用', () => {
  const vbs = vbaToVbs(WRAPPED_VBA);
  assert.match(vbs, /Sub main\(\)/);
  assert.match(vbs, /^main$/m);
});

test('Exit Sub 原样保留(VBS 中 Sub 内合法)', () => {
  const vbs = vbaToVbs(WRAPPED_VBA);
  assert.match(vbs, /Exit Sub/);
});

test('ErrorHandler 块被移除且无残留 label', () => {
  const vbs = vbaToVbs(WRAPPED_VBA);
  assert.doesNotMatch(vbs, /ErrorHandler/);
  assert.doesNotMatch(vbs, /On Error GoTo ErrorHandler/);
});

test('失败类 MsgBox(vbExclamation) → SWCP_Fail', () => {
  const vbs = vbaToVbs(WRAPPED_VBA);
  assert.match(vbs, /SWCP_Fail "请先打开一个文档"/);
  assert.doesNotMatch(vbs, /MsgBox/);
});

test('Application.SldWorks → SWCP_ConnectSW()', () => {
  const vbs = vbaToVbs(WRAPPED_VBA);
  assert.match(vbs, /Set swApp = SWCP_ConnectSW\(\)/);
  assert.doesNotMatch(vbs, /Application\.SldWorks/);
});

test('As 类型声明被移除但字符串内容无损', () => {
  const vbs = vbaToVbs('Dim s As String\ns = "Save As Copy"');
  assert.doesNotMatch(vbs, /Dim s As String/);
  assert.match(vbs, /"Save As Copy"/);
});

test('绝不出现 CreateObject("SldWorks.Application")', () => {
  const dangerous = 'Set swApp = CreateObject("SldWorks.Application")\nswApp.ActiveDoc.EditRebuild3';
  const vbs = vbaToVbs(dangerous);
  assert.doesNotMatch(vbs, /CreateObject\(\s*"SldWorks\.Application"\s*\)/);
  assert.match(vbs, /SWCP_ConnectSW\(\)/);
});

test('GetObject(, "SldWorks.Application") 也收口到 ConnectSW', () => {
  const code = 'Set app = GetObject(, "SldWorks.Application")\napp.Visible = True';
  const vbs = vbaToVbs(code);
  assert.match(vbs, /Set app = SWCP_ConnectSW\(\)/);
});

test('裸顶层代码被包裹成 Sub main 并调用', () => {
  const vbs = vbaToVbs('Dim x\nx = 1');
  assert.match(vbs, /Sub main\(\)/);
  assert.match(vbs, /^main$/m);
});

test('普通 MsgBox → WScript.Echo(不弹窗)', () => {
  const vbs = vbaToVbs('MsgBox "操作完成"');
  assert.match(vbs, /WScript\.Echo "操作完成"/);
  assert.doesNotMatch(vbs, /MsgBox/);
});

test('MsgBox vbInformation 带标题 → Echo(消息),丢弃参数和标题', () => {
  const vbs = vbaToVbs('MsgBox "导出成功", vbInformation, "标题"');
  assert.match(vbs, /WScript\.Echo "导出成功"/);
  assert.doesNotMatch(vbs, /MsgBox/);
  assert.doesNotMatch(vbs, /vbInformation/);
});

test('结果文件路径直接嵌入(无反斜杠双写)', () => {
  const vbs = vbaToVbs('Dim x', { resultFilePath: 'C:\\Temp\\r.json' });
  assert.match(vbs, /SWCP_RESULT_PATH = "C:\\Temp\\r\.json"/);
  assert.doesNotMatch(vbs, /C:\\\\Temp/);
});

test('runner 在 Err 非零时调 SWCP_Fail,成功时写结果文件(Unicode)', () => {
  const vbs = vbaToVbs(WRAPPED_VBA, { resultFilePath: 'C:\\t\\r.json' });
  assert.match(vbs, /If Err\.Number <> 0 Then/);
  assert.match(vbs, /SWCP_WriteResult True, "脚本执行完成"/);
  assert.match(vbs, /CreateTextFile\(SWCP_RESULT_PATH, True, True\)/);
});

test('支持库包含连接函数且强制实例可见', () => {
  const vbs = vbaToVbs('Dim x');
  assert.match(vbs, /Function SWCP_ConnectSW\(\)/);
  assert.match(vbs, /GetObject\(, "SldWorks\.Application"\)/);
  assert.match(vbs, /If Not SWCP_APP\.Visible Then SWCP_APP\.Visible = True/);
});

test('非 main 的 Sub 作为入口被调用', () => {
  const vbs = vbaToVbs('Sub DoWork()\n    Dim x\nEnd Sub');
  assert.match(vbs, /^DoWork$/m);
});

test('On Error GoTo 0 被保留', () => {
  const vbs = vbaToVbs('Sub main()\nOn Error GoTo 0\nDim x\nEnd Sub');
  assert.match(vbs, /On Error GoTo 0/);
});

test('Next <var> → 裸 Next', () => {
  const vbs = vbaToVbs('Sub main()\nFor i = 0 To 5\n    Dim x\nNext i\nEnd Sub');
  assert.match(vbs, /^\s*Next\s*$/m);
  assert.doesNotMatch(vbs, /Next i/);
});

test('Format() → SWCP_Format()', () => {
  const vbs = vbaToVbs('Sub main()\nDim s\ns = Format(1.23, "0.00")\nEnd Sub');
  assert.match(vbs, /SWCP_Format\(/);
});

test('SWCP_Format 支持函数存在于支持库', () => {
  const vbs = vbaToVbs('Dim x');
  assert.match(vbs, /Function SWCP_Format\(v, fmt\)/);
  assert.match(vbs, /FormatNumber/);
});

test('checkVbsCompatibility 检测 GoTo(排除 On Error GoTo)', () => {
  const issues = checkVbsCompatibility('On Error GoTo ErrH\nGoTo Label1');
  assert.ok(issues.some(i => /GoTo/i.test(i)));
});

test('checkVbsCompatibility 检测 Dir()/MkDir', () => {
  const issues = checkVbsCompatibility('If Dir("C:\\", vbDirectory) = "" Then MkDir "C:\\"');
  assert.ok(issues.length >= 2);
});

test('checkVbsCompatibility 检测 Open/FreeFile/Print#', () => {
  const issues = checkVbsCompatibility('Dim f\nf = FreeFile\nOpen "a.txt" For Output As #f\nPrint #f, "hi"\nClose #f');
  assert.ok(issues.length >= 2);
});

test('checkVbsCompatibility 检测 InputBox', () => {
  const issues = checkVbsCompatibility('Dim s\ns = InputBox("请输入")');
  assert.ok(issues.some(i => /InputBox/i.test(i)));
});

test('checkVbsCompatibility 合法代码无误报', () => {
  const issues = checkVbsCompatibility(WRAPPED_VBA);
  assert.equal(issues.length, 0, `不应有兼容性问题: ${issues.join(', ')}`);
});

// P133: run_macro promised "swApp and Part are already bound" — nothing bound them, and a
// runtime error inside the entry Sub still ended as "脚本执行完成".
test('P133: swApp / Part / swModel are bound when the macro uses them', () => {
  const vbs = vbaToVbs('Debug = Part.GetTitle', { resultFilePath: 'C:\\r.json' });
  assert.match(vbs, /Set swApp = SWCP_ConnectSW\(\)\n\s*Set Part = swApp\.ActiveDoc\n\s*Set swModel = Part/);
  const plain = vbaToVbs('x = 1 + 1', { resultFilePath: 'C:\\r.json' });
  assert.doesNotMatch(plain, /Set Part = /, 'no SolidWorks connection for a macro that does not touch it');
});

test('P133: completion flag + failing line are reported', () => {
  const vbs = vbaToVbs('a = 1\nb = Part.GetTitle', { resultFilePath: 'C:\\r.json' });
  assert.match(vbs, /SWCP_DONE = False/);
  assert.match(vbs, /SWCP_LN = 2: SWCP_AT = "b = Part\.GetTitle"\n\s*b = Part\.GetTitle/);
  assert.match(vbs, /SWCP_DONE = True\nEnd Sub/);
  assert.match(vbs, /If Not SWCP_DONE Then\n\s*SWCP_Fail/);
});

test('P133: no marker where VBScript allows no statement; Exit Sub still completes', () => {
  const vbs = vbaToVbs(
    'Select Case k\n  Case 1\n    y = 1\nEnd Select\ns = "a" & _\n  "b"\nIf z Then Exit Sub',
    { resultFilePath: 'C:\\r.json' },
  );
  assert.match(vbs, /Select Case k\n\s*Case 1/, 'nothing between Select Case and the first Case');
  assert.match(vbs, /s = "a" & _\n\s*"b"/, 'a continued line is not split');
  assert.match(vbs, /If z Then SWCP_DONE = True: Exit Sub/);
});

test('P133: a script with only Functions is not marked as unfinished', () => {
  const vbs = vbaToVbs('Function f()\n  f = 1\nEnd Function', { resultFilePath: 'C:\\r.json' });
  assert.match(vbs, /SWCP_DONE = True\n/);
  assert.doesNotMatch(vbs, /SWCP_DONE = False/);
});
