// src/main/com/vbs-writer.ts
//
// VBScript 文件写入工具 —— 解决中文编码问题。
//
// cscript.exe 在中文 Windows 上需要 UTF-16LE + BOM 才能正确读取
// 包含中文字符的 VBScript 文件。直接写 UTF-8 会导致：
//    Microsoft VBScript 编译错误: 未找到字符串常量
//
// 方案：用 UTF-16LE + BOM 写文件，这是 Windows Script Host 原生支持的格式。

import * as fs from 'fs';

/**
 * 将 VBScript 代码写入临时文件，返回文件路径。
 * 自动使用 UTF-16LE + BOM 编码，兼容中文注释和字符串。
 */
export function writeVBSFile(scriptCode: string, prefix: string = 'sw_vbs'): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  const scriptPath = require('path').join(
    require('os').tmpdir(),
    `${prefix}_${ts}_${rand}.vbs`,
  );
  return writeVBSFileTo(scriptPath, scriptCode);
}

/**
 * 将 VBScript 代码写入指定路径。
 * 自动使用 UTF-16LE + BOM 编码。
 */
export function writeVBSFileTo(scriptPath: string, scriptCode: string): string {
  // UTF-16LE BOM + 内容
  const buf = Buffer.concat([
    Buffer.from([0xFF, 0xFE]), // BOM
    Buffer.from(scriptCode, 'ucs2'),
  ]);
  fs.writeFileSync(scriptPath, buf);
  return scriptPath;
}

/**
 * 安全删除临时文件。
 */
export function safeUnlink(p: string): void {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}
