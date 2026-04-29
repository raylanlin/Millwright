// src/main/com/tools.ts
//
// 保留此文件作为主进程的工具入口。实际数据已迁到 shared/sw-tools.ts,
// 让 renderer 也能复用。这里直接 re-export 以保持模块路径稳定。

export {
  SW_TOOLS,
  getToolNames,
  getToolsByCategory,
  CATEGORY_LABELS,
} from '../../shared/sw-tools';
export type { SWToolDefinition } from '../../shared/sw-tools';
