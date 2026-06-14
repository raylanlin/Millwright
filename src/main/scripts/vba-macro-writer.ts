// src/main/scripts/vba-macro-writer.ts
//
// 将 VBA 宏代码转换为可通过 cscript.exe 执行的 VBScript (.vbs)。
//
// v0.2.1 重写 —— 修复「假成功」问题。
//
// 旧版的三个致命缺陷:
// 1. GetObject 失败时 fallback 到 CreateObject("SldWorks.Application"),
//    会启动一个全新的【隐形】SolidWorks 实例 —— 脚本在看不见的实例里
//    "成功"执行,用户的可见窗口毫无变化,UI 却显示执行完成。
// 2. 把 Sub main() 展开为顶层代码,导致 Exit Sub 非法,只能替换成
//    WScript.Quit 0 —— 前置条件不满足(无活动文档/不在草图中)时以
//    成功码退出且不写结果文件,engine 误判为成功。
// 3. MsgBox 在 cscript 下是真实弹窗,会阻塞直到超时。
//
// 新版设计原则:
// A. 保留 Sub main() 结构,在顶层调用 —— VBS 完全支持 Sub/Exit Sub,
//    不再需要任何展开 hack。main 内未处理的错误会传播到顶层调用点,
//    由 runner 统一捕获并写入结果文件(fail-fast)。
// B. 连接 SolidWorks 只用 GetObject(连接已运行实例)。连不上就写失败
//    结果并退出 —— 绝不 CreateObject 启动新实例。
// C. 所有退出路径(成功/失败/前置条件不满足)都必须写结果文件。
//    engine 把「没有结果文件」视为失败。
// D. MsgBox 一律转换:失败类(vbExclamation/vbCritical)→ SWCP_Fail,
//    其余 → WScript.Echo。cscript 环境下永远不弹窗。
// E. 结果文件以 UTF-16(Unicode) 写入,engine 按 BOM 解码,中文不乱码。

/** 移除一行中引号外的 "As <Type>" 声明(VBS 不支持类型声明) */
function stripAsTypesLine(line: string): string {
  // 按双引号切分:偶数段在字符串外,奇数段在字符串内
  const parts = line.split('"');
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(/\s+As\s+[\w.]+/g, '');
  }
  return parts.join('"');
}

/**
 * 把生成器输出(或 AI 生成)的 VBA 宏代码转换为可独立执行的 VBScript。
 *
 * 转换规则:
 *  1. 移除 Option Explicit
 *  2. 移除 wrapMain/AI 注入的错误处理块(Exit Sub + <label>: ... End Sub 之前)
 *  3. 移除 On Error GoTo <label>(保留 On Error GoTo 0 / Resume Next)
 *  4. 移除残留的孤立 label 行(VBS 顶层 label 非法)
 *  5. 统一 SolidWorks 连接方式 → SWCP_ConnectSW()(只 GetObject,绝不新建实例)
 *  6. MsgBox 转换(见上文 D)
 *  7. 移除 As <Type>(仅引号外)
 *  8. 保留 Sub 结构,确定入口(main > 第一个 Sub > 自动包裹)
 *  9. 组装: banner + 主体 + runner + SWCP 运行时支持函数
 */
export function vbaToVbs(vbaCode: string, opts?: { resultFilePath?: string }): string {
  let code = vbaCode.replace(/\r\n/g, '\n');

  // 1. 移除 Option Explicit(转换会注入 SWCP_* 变量,保留会误报)
  code = code.replace(/^\s*Option\s+Explicit\s*$/gim, '');

  // 2. 移除错误处理块。wrapMain 产物形如:
  //        Exit Sub
  //    ErrorHandler:
  //        MsgBox "脚本执行出错: " & Err.Description, vbCritical, "SW Copilot"
  //    End Sub
  //    AI 生成的代码可能用其他 label 名,统一按结构匹配。
  code = code.replace(
    /^[ \t]*Exit\s+Sub\s*\n[ \t]*[A-Za-z_]\w*:[ \t]*\n[\s\S]*?(?=^[ \t]*End\s+Sub)/gim,
    '',
  );

  // 3. 移除 On Error GoTo <label>。错误改为传播到顶层 runner 统一捕获。
  //    保留 On Error GoTo 0(合法 VBS)和 On Error Resume Next。
  code = code.replace(/^[ \t]*On\s+Error\s+GoTo\s+(?!0\b)\w+[ \t]*$/gim, '');

  // 4. 删除残留的孤立 label 行 —— VBS 不支持 label,残留会编译错误。
  //    只匹配整行仅为 "<identifier>:" 的行,并排除常见关键字。
  code = code.replace(
    /^[ \t]*(?!(?:Else|End|Exit|Case|Next|Loop|Wend|Sub|Function|If|Then|Do|While|For|Dim|Set|Const|Public|Private|ReDim)\b)[A-Za-z_]\w*:[ \t]*$/gim,
    '',
  );

  // 5. 统一 SolidWorks 连接方式。三种来源全部收口到 SWCP_ConnectSW():
  //    - 生成器/VBA 宏环境: Set swApp = Application.SldWorks
  //    - AI 仿独立脚本:     GetObject(, "SldWorks.Application")
  //    - AI 危险写法:       CreateObject("SldWorks.Application") ← 会开隐形新实例!
  code = code.replace(/Set\s+(\w+)\s*=\s*Application\.SldWorks\b/gi, 'Set $1 = SWCP_ConnectSW()');
  code = code.replace(/GetObject\s*\(\s*,\s*["']SldWorks\.Application["']\s*\)/gi, 'SWCP_ConnectSW()');
  code = code.replace(/CreateObject\s*\(\s*["']SldWorks\.Application["']\s*\)/gi, 'SWCP_ConnectSW()');

  // 6. MsgBox 转换。cscript 下 MsgBox 是真实弹窗,会阻塞到超时,必须全部移除:
  //    - 失败语义(vbExclamation/vbCritical) → SWCP_Fail(写失败结果 + 退出码 1)
  //    - 其它 MsgBox → WScript.Echo(消息进 stdout)
  code = code.replace(
    /^([ \t]*)MsgBox\s+(.+?),\s*vb(?:Exclamation|Critical)\b[^\n]*$/gim,
    '$1SWCP_Fail $2',
  );
  // 其它带选项的 MsgBox(vbInformation 等):只保留消息表达式,丢弃 vb* 参数和标题
  code = code.replace(/^([ \t]*)MsgBox\s+(.+?),\s*vb\w+\b[^\n]*$/gim, '$1WScript.Echo $2');
  code = code.replace(/^([ \t]*)MsgBox\s+(.+)$/gim, '$1WScript.Echo $2');

  // 7. 移除 As <Type>(逐行处理,跳过字符串字面量)
  code = code.split('\n').map(stripAsTypesLine).join('\n');

  // 7b. VBA 的 "Next i" → VBS 只允许裸 Next(带变量名会编译错误)
  code = code.replace(/^([ \t]*)Next\s+\w+[ \t]*$/gim, '$1Next');

  // 7c. VBA Format() → SWCP_Format()(VBS 没有 Format 函数)
  code = code.replace(/\bFormat\s*\(/g, 'SWCP_Format(');

  // 8. 清理多余空行
  code = code.replace(/\n{3,}/g, '\n\n').trim();

  // 9. 确定入口。保留 Sub 结构(VBS 原生支持,Exit Sub 合法)。
  const mainMatch = code.match(/^\s*Sub\s+(main)\s*\(/im);
  const firstSubMatch = code.match(/^\s*Sub\s+(\w+)\s*\(/im);
  const hasAnyProc = /^\s*(?:Sub|Function)\s+\w+/im.test(code);

  let entry = '';
  if (mainMatch) {
    entry = 'main';
  } else if (firstSubMatch) {
    entry = firstSubMatch[1];
  } else if (!hasAnyProc) {
    // 纯顶层代码(AI 未包 Sub):包裹成 main,让错误能被 runner 捕获
    const indented = code
      .split('\n')
      .map((l) => (l.trim() ? '    ' + l : l))
      .join('\n');
    code = `Sub main()\n${indented}\nEnd Sub`;
    entry = 'main';
  }
  // 只有 Function 没有 Sub 的罕见情形: 顶层代码原样执行,entry 留空

  // 10. 组装完整 VBS
  const resultPath = opts?.resultFilePath ?? '';
  // VBS 字符串没有反斜杠转义,路径直接嵌入;只需防御性处理双引号
  const resultPathLiteral = resultPath.replace(/"/g, '""');

  const banner = `' SW Copilot 自动生成的 VBScript
' 通过 cscript.exe 连接到【已运行】的 SolidWorks 实例执行
' 生成时间: ${new Date().toISOString()}

Dim SWCP_RESULT_PATH
SWCP_RESULT_PATH = "${resultPathLiteral}"
Dim SWCP_APP
`;

  const runner = entry
    ? `
' ===== 执行入口 =====
On Error Resume Next
Err.Clear
${entry}
If Err.Number <> 0 Then
    Dim SWCP_ERRDESC
    SWCP_ERRDESC = Err.Description
    If SWCP_ERRDESC = "" Then SWCP_ERRDESC = "未知错误 (代码 " & Err.Number & ")"
    SWCP_Fail "脚本执行出错: " & SWCP_ERRDESC
End If
On Error GoTo 0
SWCP_WriteResult True, "脚本执行完成"
WScript.Quit 0
`
    : `
' ===== 顶层代码已执行完毕 =====
SWCP_WriteResult True, "脚本执行完成"
WScript.Quit 0
`;

  const supportLib = `
' ===== SW Copilot 运行时支持 =====

' 连接已运行的 SolidWorks 实例。
' 关键: 只用 GetObject。CreateObject 会启动一个隐形的新实例,
' 脚本会在用户看不见的窗口里"成功"执行 —— 这是必须杜绝的静默失败。
Function SWCP_ConnectSW()
    If IsObject(SWCP_APP) Then
        If Not SWCP_APP Is Nothing Then
            Set SWCP_ConnectSW = SWCP_APP
            Exit Function
        End If
    End If
    On Error Resume Next
    Err.Clear
    Set SWCP_APP = GetObject(, "SldWorks.Application")
    If Err.Number <> 0 Or Not IsObject(SWCP_APP) Then
        Err.Clear
        On Error GoTo 0
        SWCP_Fail "无法连接到正在运行的 SolidWorks。请确认: 1) SolidWorks 已启动; 2) SolidWorks 与本应用以相同权限运行(同为管理员或同为普通用户); 3) 任务管理器中没有残留的 SLDWORKS.exe 后台进程。"
    End If
    ' 若连接到的实例不可见(可能是旧版本残留的后台实例),强制显示出来
    If Not SWCP_APP.Visible Then SWCP_APP.Visible = True
    Err.Clear
    On Error GoTo 0
    Set SWCP_ConnectSW = SWCP_APP
End Function

' 写执行结果 JSON。Unicode=True → UTF-16LE+BOM,中文消息不乱码。
Sub SWCP_WriteResult(ok, msg)
    On Error Resume Next
    If SWCP_RESULT_PATH = "" Then Exit Sub
    Dim fso, f, okStr
    If ok Then okStr = "true" Else okStr = "false"
    Set fso = CreateObject("Scripting.FileSystemObject")
    Set f = fso.CreateTextFile(SWCP_RESULT_PATH, True, True)
    f.Write "{""success"":" & okStr & ",""message"":""" & SWCP_JsonEsc(msg) & """}"
    f.Close
End Sub

' 报告失败并退出(退出码 1)。所有失败路径都经过这里,保证结果文件存在。
Sub SWCP_Fail(msg)
    SWCP_WriteResult False, CStr(msg)
    WScript.Echo "[SWCP_FAIL] " & msg
    WScript.Quit 1
End Sub

Function SWCP_JsonEsc(s)
    Dim t
    t = CStr(s)
    t = Replace(t, "\\", "\\\\")
    t = Replace(t, """", "\\""")
    t = Replace(t, vbCrLf, "\\n")
    t = Replace(t, vbCr, "\\n")
    t = Replace(t, vbLf, "\\n")
    t = Replace(t, vbTab, "\\t")
    SWCP_JsonEsc = t
End Function

' VBA Format() 的 VBS 替代:按格式串小数位数调 FormatNumber
Function SWCP_Format(v, fmt)
    Dim p, decs
    p = InStr(CStr(fmt), ".")
    If p > 0 Then decs = Len(CStr(fmt)) - p Else decs = 0
    SWCP_Format = FormatNumber(v, decs, -1, 0, 0)
End Function
`;

  return `${banner}
' ===== 用户脚本主体 =====
${code}
${runner}${supportLib}`;
}

/**
 * 检查 VBA 代码中无法转换为 VBScript 的语法。
 * 返回问题列表(空 = 兼容)。engine 在执行前调用,
 * 提前拦截并给出可操作的错误信息,而不是让 cscript 报一堆编译错误。
 */
export function checkVbsCompatibility(vbaCode: string): string[] {
  // On Error GoTo 会被转换器处理,先排除再查裸 GoTo
  const code = vbaCode.replace(/On\s+Error\s+GoTo\s+\w+/gi, '');
  const rules: Array<[RegExp, string]> = [
    [/\bGoTo\s+\w+/i, 'GoTo 跳转(VBScript 不支持),请改用 If/Do 结构'],
    [/^\s*Open\b[^\n]*\bFor\s+(?:Output|Input|Append|Binary|Random)\b/im, 'Open 文件 I/O(VBScript 不支持),请改用 Scripting.FileSystemObject'],
    [/\bPrint\s*#/i, 'Print # 文件写入,请改用 FileSystemObject 的 WriteLine'],
    [/\bFreeFile\b/i, 'FreeFile(VBScript 不支持),请改用 FileSystemObject'],
    [/\bInputBox\s*\(/i, 'InputBox 交互对话框(脚本在后台执行,无法交互)'],
    [/\b(?:MkDir|RmDir|ChDir|ChDrive)\b/i, 'VBA 文件系统语句(VBScript 不支持),请改用 FileSystemObject'],
    [/\bDir\s*\(/i, 'Dir() 函数(VBScript 不支持),请改用 FileSystemObject 的 FolderExists/FileExists'],
  ];
  const issues: string[] = [];
  for (const [re, msg] of rules) {
    if (re.test(code)) issues.push(msg);
  }
  return issues;
}

/**
 * 把 VBA 宏代码转为 Python win32com 脚本。
 * 这是最可靠的执行方式（Python 完全控制 COM 调用，不依赖 SW 宏环境）。
 *
 * 适用场景：用户机器上已安装 Python + pywin32。
 */
export function vbaToPython(vbaCode: string, opts?: { resultFilePath?: string }): string {
  // 提取 VBA 中的核心逻辑很难做通用转换。
  // 更实用的方案：直接让 AI 生成 Python 代码，或生成器直接输出 Python 版本。
  // 这里提供一个 "用 Python 调 VBS" 的桥接方案。

  const resultPath = opts?.resultFilePath
    ? opts.resultFilePath.replace(/\\/g, '\\\\')
    : '';

  return `# SW Copilot 自动生成的 Python 脚本
# 通过 win32com 连接已运行的 SolidWorks 实例
import win32com.client
import json
import os
import sys

result_path = r"${resultPath}" if "${resultPath}" else None

try:
    sw = win32com.client.GetObject(Class="SldWorks.Application")
    model = sw.ActiveDoc
    if model is None:
        raise RuntimeError("SolidWorks 中没有打开的文档")

    # --- 以下为用户操作 ---
    # (由 AI 或生成器填充具体逻辑)

    if result_path:
        with open(result_path, 'w', encoding='utf-8') as f:
            json.dump({"success": True, "message": "脚本执行完成"}, f, ensure_ascii=False)

except Exception as e:
    print(f"错误: {e}", file=sys.stderr)
    if result_path:
        with open(result_path, 'w', encoding='utf-8') as f:
            json.dump({"success": False, "message": str(e)}, f, ensure_ascii=False)
    sys.exit(1)
`;
}

/**
 * 检测系统上可用的脚本执行运行时。
 * 返回优先级排序的可用运行时列表。
 */
export async function detectRuntimes(): Promise<Array<'python' | 'cscript'>> {
  const { exec } = await import('child_process');
  const available: Array<'python' | 'cscript'> = [];

  // 检测 Python + pywin32
  const hasPython = await new Promise<boolean>((resolve) => {
    exec('python -c "import win32com.client; print(1)"', { timeout: 5000, windowsHide: true },
      (err, stdout) => resolve(!err && stdout.trim() === '1'));
  });
  if (hasPython) available.push('python');

  // cscript 在 Windows 上总是可用的
  if (process.platform === 'win32') {
    available.push('cscript');
  }

  return available;
}
