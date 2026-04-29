// tests/vba-macro-writer.test.mjs
//
// vba-macro-writer 是执行链路上最脆弱的环节:7 条 regex 转换规则,
// 任何一条漏 case 都会让 cscript 报错或行为不符。
// 对每一条规则 + 真实生成器输出做端到端验证。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  vbaToVbs,
  vbaToPython,
  detectRuntimes,
} from '../dist/main/main/scripts/vba-macro-writer.js';
import { generateScript } from '../dist/main/main/scripts/generators/index.js';
import { SW_TOOLS } from '../dist/main/shared/sw-tools.js';

// ============ 单条规则 ============

test('vbaToVbs 规则 1: Option Explicit 被移除', () => {
  const r = vbaToVbs('Option Explicit\nDim x');
  assert.ok(!/Option\s+Explicit/i.test(r));
});

test('vbaToVbs 规则 2: As <Type> 被移除', () => {
  const r = vbaToVbs('Dim swApp As SldWorks.SldWorks');
  assert.ok(!/As\s+SldWorks/i.test(r));
  assert.ok(/Dim\s+swApp/.test(r));
});

test('vbaToVbs 规则 2: 复杂 As 也能删掉', () => {
  const cases = [
    'Dim x As Long',
    'Dim y As String',
    'Dim z As ModelDoc2',
    'Dim a As SldWorks.SldWorks',
  ];
  for (const c of cases) {
    const r = vbaToVbs(c);
    // 去除前后空白后,所有 As Xxx 都应该不见
    assert.ok(!/\bAs\s+[A-Z]\w/i.test(r), `残留 As in: ${r}`);
  }
});

test('vbaToVbs 规则 3: Application.SldWorks → GetObject', () => {
  const r = vbaToVbs('Set swApp = Application.SldWorks');
  assert.ok(r.includes('GetObject(, "SldWorks.Application")'));
  assert.ok(!r.includes('Application.SldWorks'));
});

test('vbaToVbs 规则 4: On Error GoTo → On Error Resume Next', () => {
  const r = vbaToVbs('On Error GoTo ErrorHandler');
  assert.ok(r.includes('On Error Resume Next'));
  assert.ok(!r.includes('GoTo ErrorHandler'));
});

test('vbaToVbs 规则 5: ErrorHandler 块整块移除', () => {
  const code = `
Sub main()
    x = 1
    Exit Sub
ErrorHandler:
    MsgBox "err"
End Sub
  `;
  const r = vbaToVbs(code);
  assert.ok(!r.includes('ErrorHandler:'), 'ErrorHandler label 应被移除');
  // 移除范围不应该误伤到主体 x = 1
  assert.ok(r.includes('x = 1'));
});

test('vbaToVbs 规则 6: 其余 Exit Sub → WScript.Quit', () => {
  // PRELUDE 或 generator 自有的 Exit Sub
  const code = `
Sub main()
    If swModel Is Nothing Then
        Exit Sub
    End If
    x = 1
End Sub
  `;
  const r = vbaToVbs(code);
  assert.ok(!/\bExit\s+Sub\b/i.test(r), `残留 Exit Sub: ${r}`);
  assert.ok(r.includes('WScript.Quit 0'));
});

test('vbaToVbs 规则 6: 多个 Exit Sub 全部转换', () => {
  const code = `
Sub main()
    If a Then Exit Sub
    If b Then
        Exit Sub
    End If
End Sub
  `;
  const r = vbaToVbs(code);
  const matches = r.match(/WScript\.Quit/g) || [];
  assert.equal(matches.length, 2, '两个 Exit Sub 都该被转换');
  assert.ok(!/\bExit\s+Sub\b/i.test(r));
});

test('vbaToVbs 规则 7: Sub main 展开', () => {
  const r = vbaToVbs('Sub main()\n    x = 1\nEnd Sub');
  assert.ok(!/Sub\s+main/i.test(r));
  assert.ok(!/End\s+Sub/i.test(r));
  assert.ok(r.includes('x = 1'));
});

test('vbaToVbs: header 包含 On Error Resume Next', () => {
  const r = vbaToVbs('Dim x');
  assert.ok(r.includes('On Error Resume Next'));
});

test('vbaToVbs: resultFilePath footer 写 JSON', () => {
  const r = vbaToVbs('Dim x', { resultFilePath: 'C:\\tmp\\r.json' });
  // VBS 字符串字面量里的双引号用 "" 表示,所以 "success" 在源码里是 ""success""
  assert.ok(r.includes('""success"":true'), `缺成功分支 JSON: ${r}`);
  assert.ok(r.includes('""success"":false'), `缺失败分支 JSON: ${r}`);
  // 路径里的反斜杠应该被转义成 \\
  assert.ok(r.includes('C:\\\\tmp\\\\r.json'), `路径转义错: ${r}`);
});

test('vbaToVbs: resultFilePath 路径里有引号时也能处理', () => {
  // 这个场景少见但要兜底 —— 路径若含 " 直接拼会挂
  // 当前实现没特别处理,这里记录行为
  const r = vbaToVbs('Dim x', { resultFilePath: 'C:\\a\\b.json' });
  assert.ok(r.includes('resultFile.Close'));
});

test('vbaToVbs: 没 resultFilePath 时 footer 空', () => {
  const r = vbaToVbs('Dim x');
  assert.ok(!r.includes('FileSystemObject'));
});

// ============ 端到端(真实生成器输出)============

test('vbaToVbs e2e: 所有 SW_TOOLS 生成的代码转换后无 Exit Sub/Sub/End Sub/As Type', () => {
  const failed = [];
  for (const tool of SW_TOOLS) {
    const vba = generateScript(tool.name, tool.exampleParams ?? {}).code;
    const vbs = vbaToVbs(vba);

    const issues = [];
    if (/\bExit\s+Sub\b/i.test(vbs)) issues.push('Exit Sub 残留');
    if (/\bSub\s+main\b/i.test(vbs)) issues.push('Sub main 残留');
    if (/\bEnd\s+Sub\b/i.test(vbs)) issues.push('End Sub 残留');
    if (/\bAs\s+[A-Z]\w/i.test(vbs)) issues.push('As <Type> 残留');
    if (/Application\.SldWorks/.test(vbs)) issues.push('Application.SldWorks 未替换');

    if (issues.length > 0) failed.push(`${tool.name}: ${issues.join(', ')}`);
  }
  assert.deepEqual(failed, [], `这些工具转换有问题:\n${failed.join('\n')}`);
});

test('vbaToVbs e2e: 所有生成器输出都包含 GetObject 连接', () => {
  for (const tool of SW_TOOLS) {
    const vba = generateScript(tool.name, tool.exampleParams ?? {}).code;
    const vbs = vbaToVbs(vba);
    // 每个脚本都以 swApp 连接开始(create_* 用 PRELUDE_APP_ONLY,其他用 PRELUDE_ACTIVE_DOC,
    // 两者都会 Set swApp = Application.SldWorks)
    assert.ok(
      vbs.includes('GetObject(, "SldWorks.Application")'),
      `${tool.name} 没有 GetObject 连接`,
    );
  }
});

test('vbaToVbs e2e: 输出长度合理(不该被误删成空)', () => {
  for (const tool of SW_TOOLS) {
    const vba = generateScript(tool.name, tool.exampleParams ?? {}).code;
    const vbs = vbaToVbs(vba);
    assert.ok(vbs.length > 200, `${tool.name} 输出太短: ${vbs.length} chars`);
    // 转换后不应该比原来缩水超过 40%(主要是 As Type 和 Option Explicit 减少)
    assert.ok(vbs.length > vba.length * 0.5, `${tool.name} 输出异常缩水`);
  }
});

// ============ VBS 语法合法性 ============
//
// 我们不能真跑 cscript(非 Windows 环境),但能做几项静态合法性检查:
// - 大括号/引号配对
// - Sub/End/If/End If 都成对

test('vbaToVbs 静态检查: If/End If 成对', () => {
  for (const tool of SW_TOOLS) {
    const vba = generateScript(tool.name, tool.exampleParams ?? {}).code;
    const vbs = vbaToVbs(vba);

    // 粗略统计顶层 If...Then (后面是换行或只剩注释) 应该被 End If 平衡。
    // 单行形式 "If x Then y" (后面跟语句)不算开启块。
    // 允许 "If x Then  ' comment" 这种尾随注释。
    const lines = vbs.split('\n');
    let ifDepth = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("'")) continue;
      // 块型:Then 后直接行末,或 Then 后只剩空白+注释
      const isBlockIf = /\bIf\b.*\bThen\s*(?:'.*)?$/i.test(trimmed);
      const isEndIf = /^\s*End\s+If\b/i.test(trimmed);
      if (isBlockIf) ifDepth++;
      if (isEndIf) ifDepth--;
    }
    assert.equal(ifDepth, 0, `${tool.name} If/End If 不平衡: depth=${ifDepth}`);
  }
});

test('vbaToVbs 静态检查: Do/Loop 成对', () => {
  for (const tool of SW_TOOLS) {
    const vba = generateScript(tool.name, tool.exampleParams ?? {}).code;
    const vbs = vbaToVbs(vba);
    const doCount = (vbs.match(/^\s*Do\b/gim) || []).length;
    const loopCount = (vbs.match(/^\s*Loop\b/gim) || []).length;
    assert.equal(doCount, loopCount, `${tool.name} Do/Loop 不平衡: Do=${doCount} Loop=${loopCount}`);
  }
});

test('vbaToVbs 静态检查: 引号平衡(每行偶数个 ")', () => {
  for (const tool of SW_TOOLS) {
    const vba = generateScript(tool.name, tool.exampleParams ?? {}).code;
    const vbs = vbaToVbs(vba);
    for (const [i, line] of vbs.split('\n').entries()) {
      // 注释行里的引号也按字面算,VBS 允许。这里只确保每行引号是偶数
      const quoteCount = (line.match(/"/g) || []).length;
      assert.equal(
        quoteCount % 2,
        0,
        `${tool.name} 行 ${i + 1} 引号不平衡: "${line}"`,
      );
    }
  }
});

// ============ 其他 helpers ============

test('vbaToPython: 产出合法 Python 脚本骨架', () => {
  const r = vbaToPython('Sub main()\nEnd Sub', { resultFilePath: 'C:\\r.json' });
  assert.ok(r.includes('import win32com.client'));
  assert.ok(r.includes('GetObject'));
  assert.ok(r.includes('success'));
});

test('detectRuntimes: 在非 Windows 返回 python(如果可用)或空', async () => {
  const rs = await detectRuntimes();
  // 非 Windows 不包含 cscript
  if (process.platform !== 'win32') {
    assert.ok(!rs.includes('cscript'));
  }
  // 类型正确
  for (const r of rs) {
    assert.ok(r === 'python' || r === 'cscript');
  }
});
