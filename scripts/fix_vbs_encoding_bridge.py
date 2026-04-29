#!/usr/bin/env python3
"""Update sw-bridge.ts to use vbs-writer"""
import sys

path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Fix imports: add vbs-writer import
old_import = """import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import type { SWDocumentType, SWStatus } from '../../shared/types';"""

new_import = """import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import type { SWDocumentType, SWStatus } from '../../shared/types';
import { writeVBSFile, safeUnlink } from './vbs-writer';"""

count = content.count(old_import)
assert count == 1, f"Expected 1 match for imports, found {count}"
content = content.replace(old_import, new_import)

# 2. Replace the runVBS function and safeUnlink
old_body = """  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  const scriptPath = path.join(os.tmpdir(), `sw_com_${ts}_${rand}.vbs`);
  fs.writeFileSync(scriptPath, scriptCode, 'utf8');

  return new Promise<string>((resolve, reject) => {
    const cscriptPath =
      `${process.env.SYSTEMROOT || 'C:\\Windows'}\\System32\\cscript.exe`;
    exec(
      `"${cscriptPath}" //NoLogo "${scriptPath}"`,
      { timeout: VBS_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        safeUnlink(scriptPath);
        if (error) reject(error);
        else resolve(stdout.trim());
      },
    );
  });
}

function safeUnlink(p: string): void {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}"""

new_body = """  const scriptPath = writeVBSFile(scriptCode, 'sw_com');

  return new Promise<string>((resolve, reject) => {
    const cscriptPath =
      `${process.env.SYSTEMROOT || 'C:\\Windows'}\\System32\\cscript.exe`;
    exec(
      `"${cscriptPath}" //NoLogo "${scriptPath}"`,
      { timeout: VBS_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        safeUnlink(scriptPath);
        if (error) reject(error);
        else resolve(stdout.trim());
      },
    );
  });
}"""

count = content.count(old_body)
assert count == 1, f"Expected 1 match for runVBS body, found {count}"
content = content.replace(old_body, new_body)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print("OK - sw-bridge.ts updated")
