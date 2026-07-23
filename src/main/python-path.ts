// src/main/python-path.ts
// P12: single source of truth for Python interpreter + sidecar dir resolution.
// Priority: bundled runtime shipped in the installer (zero user install) →
// system PATH → callers fall back to the VBS engine when neither works.
import * as fs from 'fs';
import * as path from 'path';

export function resolvePythonPath(): string {
  if (process.platform !== 'win32') return 'python3';
  for (const base of [process.resourcesPath, process.cwd()]) {
    if (!base) continue;
    const bundled = path.join(base, 'python', 'python.exe');
    try { if (fs.existsSync(bundled)) return bundled; } catch { /* next */ }
  }
  return 'python';
}

/**
 * Locate the sidecar package dir. `process.resourcesPath` is only correct when
 * packaged — in dev it points at Electron's OWN resources dir, so the sidecar
 * was never found during development. Probe for the actual `sw_agent/` package.
 */
export function resolveSidecarCwd(): string {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'sidecar') : '',
    path.join(process.cwd(), 'sidecar'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, 'sw_agent'))) return c; } catch { /* next */ }
  }
  return candidates[0];
}
