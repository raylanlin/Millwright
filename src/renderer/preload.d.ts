// src/renderer/preload.d.ts

import type { PreloadAPI } from '../preload/index';

declare global {
  interface Window {
    api: PreloadAPI;
  }
}

export {};
