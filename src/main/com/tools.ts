// src/main/com/tools.ts
//
// Kept as the main-process entry point for tools. The actual data has been moved
// to `shared/sw-tools.ts` so the renderer can reuse it. This file simply
// re-exports from there to keep the module path stable.

export {
  SW_TOOLS,
  getToolNames,
  getToolsByCategory,
  CATEGORY_LABELS,
} from '../../shared/sw-tools';
export type { SWToolDefinition } from '../../shared/sw-tools';
