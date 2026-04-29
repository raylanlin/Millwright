// tests/sanitizer.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScript } from '../dist/main/main/scripts/sanitizer.js';

test('sanitizer: VBA Shell 命令被拦截', () => {
  const r = validateScript('Shell("cmd /c del *.*")', 'vba');
  assert.equal(r.safe, false);
  assert.ok(r.issues.some((i) => /Shell/.test(i)));
});

test('sanitizer: VBA WScript.Shell 被拦截', () => {
  const r = validateScript('CreateObject("WScript.Shell")', 'vba');
  assert.equal(r.safe, false);
});

test('sanitizer: VBA Kill 删除文件被拦截', () => {
  const r = validateScript('Kill("C:\\tmp\\a.txt")', 'vba');
  assert.equal(r.safe, false);
});

test('sanitizer: 正常 VBA 通过', () => {
  const code = `
    Sub main()
      Dim swApp As SldWorks.SldWorks
      Set swApp = Application.SldWorks
      Dim swModel As ModelDoc2
      Set swModel = swApp.ActiveDoc
    End Sub
  `;
  const r = validateScript(code, 'vba');
  assert.equal(r.safe, true);
  assert.equal(r.issues.length, 0);
});

test('sanitizer: Python os.system 被拦截', () => {
  const r = validateScript('import os\nos.system("ls")', 'python');
  assert.equal(r.safe, false);
  assert.ok(r.issues.some((i) => /命令执行/.test(i)));
});

test('sanitizer: Python subprocess 被拦截', () => {
  const r = validateScript('import subprocess\nsubprocess.run(["ls"])', 'python');
  assert.equal(r.safe, false);
});

test('sanitizer: Python shutil.rmtree 被拦截', () => {
  const r = validateScript('import shutil\nshutil.rmtree("/tmp/x")', 'python');
  assert.equal(r.safe, false);
});

test('sanitizer: Python requests 网络库被拦截', () => {
  const r = validateScript('import requests\nrequests.get("http://x")', 'python');
  assert.equal(r.safe, false);
});

test('sanitizer: 正常 Python 通过', () => {
  const r = validateScript(
    'import win32com.client\nsw = win32com.client.Dispatch("SldWorks.Application")',
    'python',
  );
  assert.equal(r.safe, true);
});

test('sanitizer: 语言维度隔离 - VBA 关键字不该触发 Python 规则', () => {
  // VBA 里的 Shell() 应该只在 vba 模式下被拦,python 模式下不该被拦
  const r = validateScript('Shell("a")', 'python');
  assert.equal(r.safe, true);
});

test('sanitizer: 通用黑名单 - reg add', () => {
  const r = validateScript('Shell("reg add HKCU\\\\X /v y /d z")', 'vba');
  assert.equal(r.safe, false);
  // 两条规则都会命中(VBA Shell + 注册表),issues 会去重
  assert.ok(r.issues.length >= 1);
});

test('sanitizer: 问题列表去重', () => {
  // 同一条规则多次命中应只报一次
  const code = 'Shell("a")\nShell("b")\nShell("c")';
  const r = validateScript(code, 'vba');
  const shellCount = r.issues.filter((i) => /Shell/.test(i)).length;
  assert.equal(shellCount, 1);
});
