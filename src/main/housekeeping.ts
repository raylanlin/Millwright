// src/main/housekeeping.ts
//
// P129: the app must leave the machine the way it found it.
//
//   - single instance: a second Millwright.exe hands its argv to the first and exits —
//     two instances meant two sidecars fighting over one SolidWorks COM server
//   - stale sidecar: after a crash the previous run's python.exe could survive and keep
//     resources/python/*.dll open (the classic "upgrade cannot write file"). On start we stop
//     python.exe processes whose command line points at OUR sidecar dir — never anyone else's
//   - temp scratch: sw_vbs_/sw_com_/sw_macro_/sw_result_/sw_script_ files older than a day
//     in %TEMP% (a killed cscript leaves them), plus millwright-backups older than 24 h
//   - session logs live under userData (SW_AGENT_SESSION_DIR is set by sw-sidecar.ts), so
//     "remove settings" in the uninstaller removes everything

import { app } from 'electron';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveSidecarCwd } from './python-path';

const SCRATCH = /^(sw_vbs|sw_com|sw_macro|sw_result|sw_script)_.*\.(vbs|json|py)$/i;
const DAY = 24 * 60 * 60 * 1000;

/** Returns false when another instance already runs (caller should quit). */
export function claimSingleInstance(onSecond: () => void): boolean {
  const ok = app.requestSingleInstanceLock();
  if (!ok) return false;
  app.on('second-instance', () => onSecond());
  return true;
}

/** Match temp names that are ours and older than `maxAge`. Exported for tests. */
export function isStaleScratch(name: string, mtimeMs: number, now = Date.now(), maxAge = DAY): boolean {
  return SCRATCH.test(name) && now - mtimeMs > maxAge;
}

export function sweepTemp(): void {
  const tmp = os.tmpdir();
  try {
    for (const name of fs.readdirSync(tmp)) {
      if (!SCRATCH.test(name)) continue;
      const p = path.join(tmp, name);
      try {
        if (isStaleScratch(name, fs.statSync(p).mtimeMs)) fs.unlinkSync(p);
      } catch { /* in use or gone */ }
    }
  } catch { /* temp unreadable: nothing to do */ }
  const backups = path.join(tmp, 'millwright-backups');
  try {
    for (const name of fs.readdirSync(backups)) {
      const p = path.join(backups, name);
      try { if (Date.now() - fs.statSync(p).mtimeMs > DAY) fs.unlinkSync(p); } catch { /* ignore */ }
    }
  } catch { /* no backups dir */ }
}

/** Stop python.exe left over from a previous run of THIS install (matched by our sidecar path). */
export function killStaleSidecars(): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve();
  const dir = resolveSidecarCwd().replace(/'/g, "''");
  const ps = `$d=[regex]::Escape('${dir}'); Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('python.exe','pythonw.exe') -and $_.CommandLine -match $d -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true, timeout: 8000 }, () => resolve());
  });
}

/** userData/sessions — where the sidecar writes its per-call JSONL (P125). */
export function sessionDir(): string {
  const d = path.join(app.getPath('userData'), 'sessions');
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  return d;
}
