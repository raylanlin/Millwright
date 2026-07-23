// src/main/scripts/backup.ts
//
// 脚本执行前自动备份当前文档 (P6)。
// - 传递真实文档类型给 sw-bridge，恢复时按正确类型重新打开（旧版硬编码为零件）
// - 装配体备份只含顶层文件（SaveAs3 不复制引用零件），结果里明确标注这个局限
// - cleanOldBackups 现在由本模块在每次备份前顺手调用（旧版写了从未被调用）

import * as path from 'path';
import * as os from 'os';
import type { SolidWorksBridge } from '../com/sw-bridge';

const BACKUP_DIR = path.join(os.tmpdir(), 'millwright-backups');

export interface BackupResult {
  success: boolean;
  backupPath?: string;
  /** P6: 提示性说明（如装配体备份的局限） */
  note?: string;
  error?: string;
}

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
    const fs = await import('fs');
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    cleanOldBackups(); // P6: 顺手清理超过 24h 的旧备份

    const ext = path.extname(originalPath);
    const base = path.basename(originalPath, ext);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupName = `${base}_backup_${timestamp}${ext}`;
    const backupPath = path.join(BACKUP_DIR, backupName);

    await bridge.backupDocument(backupPath, originalPath, status.activeDocumentType ?? null);

    if (!fs.existsSync(backupPath)) {
      return {
        success: false,
        error: '备份 VBScript 未创建备份文件，可能是保存失败',
      };
    }

    return {
      success: true,
      backupPath,
      note:
        status.activeDocumentType === 'assembly'
          ? '注意：装配体备份仅包含顶层 .sldasm 文件，不含引用的零件文件'
          : undefined,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function removeBackup(backupPath: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
  } catch { /* 清理失败不影响主流程 */ }
}

export function cleanOldBackups(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
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
  } catch { /* ignore */ }
}
