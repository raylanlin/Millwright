// src/main/com/vbs-writer.ts
//
// VBScript file writer — solves the Chinese encoding problem.
//
// On a Chinese-locale Windows, cscript.exe requires UTF-16LE + BOM to read VBScript
// files that contain CJK characters. Writing plain UTF-8 results in:
//
//    Microsoft VBScript compilation error: Statement expected / Expected literal constant
//
// Solution: write the file as UTF-16LE + BOM — the format natively supported by
// Windows Script Host.

import * as fs from 'fs';

/**
 * Write VBScript code to a temporary file and return the file path.
 * Automatically uses UTF-16LE + BOM encoding so Chinese comments and strings work correctly.
 */
export function writeVBSFile(scriptCode: string, prefix: string = 'sw_vbs'): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const scriptPath = require('path').join(
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('os').tmpdir(),
    `${prefix}_${ts}_${rand}.vbs`,
  );
  return writeVBSFileTo(scriptPath, scriptCode);
}

/**
 * Write VBScript code to a specific path.
 * Automatically uses UTF-16LE + BOM encoding.
 */
export function writeVBSFileTo(scriptPath: string, scriptCode: string): string {
  // UTF-16LE BOM + body
  const buf = Buffer.concat([
    Buffer.from([0xFF, 0xFE]), // BOM
    Buffer.from(scriptCode, 'ucs2'),
  ]);
  fs.writeFileSync(scriptPath, buf);
  return scriptPath;
}

/**
 * Safely delete a temporary file (silently ignores errors).
 */
export function safeUnlink(p: string): void {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}
