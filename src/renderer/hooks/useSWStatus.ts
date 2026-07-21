// src/renderer/hooks/useSWStatus.ts
//
// Subscribe to SolidWorks connection state + the current document.
// P1.3: added a 3-second poll — when the user switches documents or enters a
// part in SW, the UI updates automatically without a manual refresh. The poll
// calls `sw.status()`, which on the main-process side already returns the real
// current document every time.

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
    pull(); // pull once immediately
    // Also accept any SW_STATUS pushes from the main process if they arrive
    const off = window.api.sw.onStatus((s) => {
      if (alive) setStatus(s);
    });
    // Poll: keeps the UI in sync after document/part switches
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
