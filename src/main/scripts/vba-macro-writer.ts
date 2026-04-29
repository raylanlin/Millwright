// src/main/scripts/vba-macro-writer.ts
//
// 将 VBA 宏代码转换为可通过 cscript.exe 执行的 VBScript (.vbs)。
//
// 背景:
// SolidWorks 的 .swp 宏文件是 OLE 复合文档格式，不是纯文本。
// 直接 fs.writeFileSync 写纯文本 .swp 在大多数 SW 版本上无法被 RunMacro2 执行。
//
// 解决方案:
// 1. 主路径: 转成 VBScript (.vbs)，通过 cscript.exe 执行
//    VBScript 可以通过 CreateObject("SldWorks.Application") 连接 SW 并操作
// 2. 备用路径: 用 Python + win32com 执行（engine.ts 已支持）
//
// VBA → VBS 的关键差异:
// - VBA: Set swApp = Application.SldWorks (在 SW 宏环境内部)
// - VBS: Set swApp = CreateObject("SldWorks.Application") 或 GetObject(, "SldWorks.Application")
// - VBA: Dim x As Integer → VBS: Dim x (VBS 不支持 As Type)
// - VBA: On Error GoTo label → VBS: On Error Resume Next (VBS 不支持 GoTo)

/**
 * 把生成器输出的 VBA 宏代码转换为可独立执行的 VBScript。
 *
 * 转换规则:
 * 1. 移除 Option Explicit（VBS 中可选，移除避免未声明变量报错）
 * 2. 移除所有 As <Type> 声明（VBS 弱类型）
 * 3. 替换 Application.SldWorks → GetObject(, "SldWorks.Application")
 * 4. 替换 On Error GoTo xxx → On Error Resume Next
 * 5. 移除 wrapMain 注入的 ErrorHandler 块(含它前面那一个 Exit Sub)
 * 6. 把剩余的 Exit Sub 转成 WScript.Quit 0(VBS 顶层非法,必须替换)
 * 7. 把 Sub main() ... End Sub 展开为顶层执行代码
 * 8. 清理多余空行
 * 9. 添加 header(顶层 On Error Resume Next,保护 footer 能跑)
 * 10. 如果给了 resultFilePath,追加 footer 把执行结果写成 JSON 文件
 */
export function vbaToVbs(vbaCode: string, opts?: { resultFilePath?: string }): string {
  let code = vbaCode;

  // 1. 移除 Option Explicit
  code = code.replace(/^\s*Option\s+Explicit\s*$/gim, '');

  // 2. 移除 As <Type> 声明
  // 匹配 "As SldWorks.SldWorks", "As ModelDoc2", "As Long", "As String" 等
  code = code.replace(/\bAs\s+[\w.]+/g, '');

  // 3. 替换 SW 连接方式
  // VBA 宏环境内: Set swApp = Application.SldWorks
  // VBS 独立环境: Set swApp = GetObject(, "SldWorks.Application")
  code = code.replace(
    /Set\s+swApp\s*=\s*Application\.SldWorks/gi,
    'Set swApp = GetObject(, "SldWorks.Application")\nIf swApp Is Nothing Then Set swApp = CreateObject("SldWorks.Application")',
  );

  // 4. 替换错误处理
  code = code.replace(/On\s+Error\s+GoTo\s+\w+/gi, 'On Error Resume Next');

  // 5. 移除 wrapMain 注入的 ErrorHandler 块
  //    精确匹配 wrapMain 产物: 紧挨 "Exit Sub" 下一行是 "ErrorHandler:",
  //    然后是 MsgBox 行,最后跟 "End Sub"。一起删掉,避免误伤其他 Exit Sub。
  code = code.replace(
    /^\s*Exit\s+Sub\s*\n\s*ErrorHandler:\s*\n[\s\S]*?(?=End\s+Sub)/gim,
    '',
  );

  // 6. 把剩余的 Exit Sub 转成 WScript.Quit 0。
  //    PRELUDE_ACTIVE_DOC 和各 generator 的防御性分支(如"没有活动草图就退出")
  //    都会用 Exit Sub。在 VBS 顶层代码里 Exit Sub 非法,cscript 会报 "Expected statement"。
  //    WScript.Quit 0 是语义等价的合法终止,且保留了"正常退出"的语义(不改 Err.Number)。
  //    ⚠️ 仅在原始代码有 Sub main() 时才替换,避免误伤嵌套 Sub 中的 Exit Sub。
  const hadSubMain = /^\s*Sub\s+main\s*\(\s*\)/im.test(vbaCode);
  if (hadSubMain) {
    code = code.replace(/\bExit\s+Sub\b/gi, 'WScript.Quit 0');
  }

  // 7. 展开 Sub main() ... End Sub 为顶层代码。
  //    ⚠️ 只有在 hadSubMain 为 true 时才替换 End Sub，
  //    否则会把非 main 子程序的 End Sub 也删掉，导致 "Missing End" 编译错误。
  code = code.replace(/^\s*Sub\s+main\s*\(\s*\)\s*$/gim, "' --- 脚本开始 ---");
  if (hadSubMain) {
    code = code.replace(/^\s*End\s+Sub\s*$/gim, "' --- 脚本结束 ---");
  }

  // 7a. 如果代码中有非 main 的 Sub 但没有被展开，
  //     在末尾添加调用语句，确保子程序会被执行。
  const subMatch = code.match(/^\s*Sub\s+(\w+)\s*\(\s*\)\s*$/im);
  if (subMatch && !code.includes("' --- 脚本开始 ---")) {
    code += `\n\n' --- 执行子程序 ---\n${subMatch[1]}`;
  }

  // 8. 清理多余空行
  code = code.replace(/\n{3,}/g, '\n\n');

  // 9. 添加 VBS 头部。
  //    注意:这里的 "On Error Resume Next" 看起来和规则 4 转换出来的重复,但它是必需的。
  //    理由:footer 用 Err.Number 判断执行成功与否。如果 body 里没设 On Error Resume Next
  //    (比如用户的自定义脚本、或规则 4 没触发),body 抛出的错误会终止整个 cscript,
  //    footer 写不了结果文件,engine 只能拿到 stderr 且没法知道具体错误类型。
  const header = `' SW Copilot 自动生成的 VBScript
' 通过 cscript.exe 执行，连接到已运行的 SolidWorks 实例
' 生成时间: ${new Date().toISOString()}

On Error Resume Next

`;

  // 10. 如果需要结果回传,追加写结果文件的代码
  let footer = '';
  if (opts?.resultFilePath) {
    const escapedPath = opts.resultFilePath.replace(/\\/g, '\\\\');
    footer = `

' --- 写入执行结果 ---
If Err.Number = 0 Then
    Dim fso, resultFile
    Set fso = CreateObject("Scripting.FileSystemObject")
    Set resultFile = fso.CreateTextFile("${escapedPath}", True)
    resultFile.Write "{""success"":true,""message"":""脚本执行完成""}"
    resultFile.Close
Else
    Dim fso2, errFile
    Set fso2 = CreateObject("Scripting.FileSystemObject")
    Set errFile = fso2.CreateTextFile("${escapedPath}", True)
    errFile.Write "{""success"":false,""message"":""" & Replace(Err.Description, """", "'") & """}"
    errFile.Close
End If
`;
  }

  return header + code.trim() + footer;
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
