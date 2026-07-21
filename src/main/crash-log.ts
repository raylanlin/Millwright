// src/main/crash-log.ts
// Must be loaded BEFORE any business modules, so that `uncaughtException` is
// registered ahead of any `require` chain.

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

let CRASH_LOG = '';

function init(): void {
  try {
    CRASH_LOG = path.join(app.getPath('userData'), 'crash.log');
    fs.mkdirSync(path.dirname(CRASH_LOG), { recursive: true });
  } catch {
    // Fallback: write to the OS temp directory
    try {
      const tmp = process.env.TEMP || process.env.TMP || '/tmp';
      CRASH_LOG = path.join(tmp, 'millwright-crash.log');
      fs.mkdirSync(path.dirname(CRASH_LOG), { recursive: true });
    } catch {
      CRASH_LOG = ''; // give up entirely
    }
  }
}

init();

function write(msg: string): void {
  if (!CRASH_LOG) return;
  try {
    // LOW: auto-truncate when the file exceeds 256 KB, to keep it from growing unbounded
    if (fs.existsSync(CRASH_LOG) && fs.statSync(CRASH_LOG).size > 256 * 1024) {
      fs.truncateSync(CRASH_LOG, 0);
    }
    fs.appendFileSync(CRASH_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* intentionally empty */ }
}

write(`crash-log init, electron ${process.versions.electron}, userData: ${CRASH_LOG}`);

process.on('uncaughtException', (err) => {
  write(`UNCAUGHT: ${err.stack || err.message}`);
  // Do not quit — let Electron handle it by default
});

process.on('unhandledRejection', (reason: any) => {
  write(`UNHANDLED_REJECTION: ${reason?.stack || reason}`);
});

export function crashLog(msg: string): void {
  write(msg);
}
