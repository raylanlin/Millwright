// src/renderer/hooks/useSWStatus.ts
//
// 订阅 SolidWorks 连接状态。
// 主进程有 SWHealthMonitor 定时 tick,状态变化时通过 IPC SW_STATUS 推送。
// 组件挂载时:先拉一次当前状态,再注册监听。

import { useCallback, useEffect, useState } from 'react';
import type { SWStatus } from '../../shared/types';

export function useSWStatus() {
  const [status, setStatus] = useState<SWStatus>({ connected: false });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // 启动时拉一次当前状态
    window.api.sw.status().then(setStatus);
    // 订阅后续变化
    const off = window.api.sw.onStatus(setStatus);
    return off;
  }, []);

  const reconnect = useCallback(async () => {
    setLoading(true);
    try {
      const { status } = await window.api.sw.connect();
      setStatus(status);
    } finally {
      setLoading(false);
    }
  }, []);

  return { status, loading, reconnect };
}
