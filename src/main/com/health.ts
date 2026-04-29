// src/main/com/health.ts

import type { SolidWorksBridge } from './sw-bridge';
import type { SWStatus } from '../../shared/types';

/**
 * 心跳监控器。
 * 定时查 SolidWorks 连接状态,状态变化时回调。
 */
export class SWHealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private lastStatus: SWStatus = { connected: false };

  constructor(
    private readonly bridge: SolidWorksBridge,
    private readonly onChange: (status: SWStatus) => void,
    private readonly intervalMs: number = 5_000,
  ) {}

  start(): void {
    if (this.timer) return;
    // 立即先检测一次
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const current = this.bridge.getStatus();
    if (!statusEqual(this.lastStatus, current)) {
      this.lastStatus = current;
      this.onChange(current);
    }
  }
}

function statusEqual(a: SWStatus, b: SWStatus): boolean {
  return (
    a.connected === b.connected &&
    a.version === b.version &&
    a.activeDocumentType === b.activeDocumentType &&
    a.activeDocumentPath === b.activeDocumentPath
  );
}
