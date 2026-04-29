// src/main/scripts/backup.ts
//
// 脚本执行前自动备份当前文档。
// 备份到系统临时目录，执行成功后可选择删除。
// 通过 sw-bridge 的 VBScript 代理执行 SaveAs3 + 恢复原文档。

import * as path from 'path';
import * as os from 'os';
import type { SolidWorksBridge } from '../com/sw-bridge';

const BACKUP_DIR = path.join(os.tmpdir(), 'sw-copilot-backups');

export interface BackupResult {
  success: boolean;
  backupPath?: string;
  error?: string;
}

/**
 * 备份当前活动文档。
 * 通过 VBScript 执行 SaveAs3 保存一份副本到临时目录，
 * 然后立即重新打开原文档（恢复活动文档路径）。
 */
export async function backupActiveDocument(bridge: SolidWorksBridge): Promise<BackupResult> {
  if (!bridge.isConnected()) {
    return { success: false, error: 'SolidWorks 未连接' };
  }

  const status = bridge.getStatus();
  const originalPath = status.activeDocumentPath;
  if (!originalPath) {
    // 文档未保存过，跳过备份
    return { success: true, backupPath: undefined };
  }

  try {
    // 确保备份目录存在
    const fs = await import('fs');
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    // 生成备份文件名
    const ext = path.extname(originalPath);
    const base = path.basename(originalPath, ext);
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);
    const backupName = `${base}_backup_${timestamp}${ext}`;
    const backupPath = path.join(BACKUP_DIR, backupName);

    await bridge.backupDocument(backupPath, originalPath);

    // 检查备份文件是否创建成功
    if (!fs.existsSync(backupPath)) {
      return {
        success: false,
        error: '备份 VBScript 未创建备份文件，可能是保存失败',
      };
    }

    return { success: true, backupPath };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 清理指定备份文件。
 */
export function removeBackup(backupPath: string): void {
  try {
    const fs = require('fs');
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
  } catch {
    // 清理失败不影响主流程
  }
}

/**
 * 清理所有超过 24 小时的旧备份。
 */
export function cleanOldBackups(): void {
  try {
    const fs = require('fs');
    if (!fs.existsSync(BACKUP_DIR)) return;

    const files = fs.readdirSync(BACKUP_DIR);
    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;

    for (const file of files) {
      const filePath = path.join(BACKUP_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > ONE_DAY) {
        fs.unlinkSync(filePath);
      }
    }
  } catch {
    // ignore
  }
}
