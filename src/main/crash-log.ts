// src/main/crash-log.ts
// 必须在所有业务模块之前加载，确保 uncaughtException 在 require 链之前注册

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

let CRASH_LOG = '';

function init(): void {
  try {
    CRASH_LOG = path.join(app.getPath('userData'), 'crash.log');
    fs.mkdirSync(path.dirname(CRASH_LOG), { recursive: true });
  } catch {
    // 备用：写到临时目录
    try {
      const tmp = process.env.TEMP || process.env.TMP || '/tmp';
      CRASH_LOG = path.join(tmp, 'sw-copilot-crash.log');
      fs.mkdirSync(path.dirname(CRASH_LOG), { recursive: true });
    } catch {
      CRASH_LOG = ''; // 彻底放弃
    }
  }
}

init();

function write(msg: string): void {
  if (!CRASH_LOG) return;
  try {
    fs.appendFileSync(CRASH_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* intentionally empty */ }
}

write(`crash-log init, electron ${process.versions.electron}, userData: ${CRASH_LOG}`);

process.on('uncaughtException', (err) => {
  write(`UNCAUGHT: ${err.stack || err.message}`);
  // 不 quit，让 Electron 默认处理
});

process.on('unhandledRejection', (reason: any) => {
  write(`UNHANDLED_REJECTION: ${reason?.stack || reason}`);
});

export function crashLog(msg: string): void {
  write(msg);
}
