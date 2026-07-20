// src/renderer/hooks/useSWStatus.ts
//
// 订阅 SolidWorks 连接 + 当前文档状态。
// P1.3：新增 3 秒轮询 —— 用户在 SW 里切换文档/进入零件时，UI 自动更新，
// 无需手动点“刷新”。轮询调用 sw.status()，主进程侧已改为每次取真实当前文档。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SWStatus } from '../../shared/types';

const POLL_MS = 3000;

export function useSWStatus() {
  const [status, setStatus] = useState<SWStatus>({ connected: false });
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = () => {
      window.api.sw.status().then((s) => {
        if (alive) setStatus(s);
      });
    };
    pull(); // 立即拉一次
    // 主进程若有 SW_STATUS 主动推送也照单接收
    const off = window.api.sw.onStatus((s) => {
      if (alive) setStatus(s);
    });
    // 轮询：切换文档 / 进入零件后自动反映
    timer.current = setInterval(pull, POLL_MS);
    return () => {
      alive = false;
      off?.();
      if (timer.current) clearInterval(timer.current);
    };
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
