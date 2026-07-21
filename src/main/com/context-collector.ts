// src/main/com/context-collector.ts
//
// Collects context information from the currently open SolidWorks document.
// The collected information is injected into the AI's system prompt so it
// knows which file the user is editing and which features/dimensions exist.
//
// All COM calls go through the VBScript proxy exposed by `sw-bridge`; we no
// longer call COM APIs directly (the `winax` dependency has been removed).

import type { SolidWorksBridge } from './sw-bridge';

export interface SWDocumentContext {
  fileName: string;
  filePath: string;
  docType: 'part' | 'assembly' | 'drawing' | null;
  swVersion?: string;
  activeConfiguration?: string;
  features: Array<{ name: string; type: string; suppressed: boolean }>;
  dimensions: Array<{ fullName: string; value: number }>;
  customProperties: Record<string, string>;
  components?: Array<{ name: string; fileName: string; suppressed: boolean }>;
  material?: string;
}

/**
 * Collect context from the currently active document.
 * Returns null when no document is open or SolidWorks is not connected.
 */
export async function collectDocumentContext(
  bridge: SolidWorksBridge,
): Promise<SWDocumentContext | null> {
  const status = bridge.getStatus();
  if (!status.connected) return null;

  // Collect feature information from the document
  const features = await bridge.collectDocumentFeatures();
  if (!features) return null;

  // FEATURE: prefer `activeDocumentTitle` as the display name (SW returns placeholder titles like "Part1" for unsaved docs)
  const filePath =
    status.activeDocumentPath && status.activeDocumentPath !== '(未保存)'
      ? status.activeDocumentPath
      : '';
  const fileName =
    status.activeDocumentTitle ||
    (filePath ? filePath.split('\\').pop()! : '(未命名文档)');

  // docType is no longer guessed as `part` — whatever SW actually reports is what we return
  const docType = status.activeDocumentType ?? null;

  // When no document is open, return an explicit placeholder object so downstream models don't misjudge the state
  if (!status.hasDoc || !docType) {
    return {
      fileName: '(当前无打开文档)',
      filePath: '',
      docType: null,
      swVersion: status.version,
      activeConfiguration: undefined,
      features: [],
      dimensions: [],
      customProperties: {},
    };
  }

  return {
    fileName,
    filePath,
    docType,
    swVersion: status.version,
    activeConfiguration: features.activeConfiguration,
    features: features.features ?? [],
    dimensions: features.dimensions ?? [],
    customProperties: features.customProperties ?? {},
    components: features.components,
    material: features.material,
  };
}

/**
 * Format the context as text that can be embedded in the system prompt.
 */
export async function formatContextForPromptAsync(
  bridge: SolidWorksBridge,
): Promise<string> {
  const ctx = await collectDocumentContext(bridge);
  if (!ctx) return '';
  return formatContextForPrompt(ctx);
}

/**
 * Format the context as text that can be embedded in the system prompt.
 * Synchronous version that reads from cache directly (does not trigger any VBS call).
 */
export function formatContextForPrompt(ctx: SWDocumentContext): string {
  const lines: string[] = [
    `## 当前 SolidWorks 文档信息`,
    `- 文件: ${ctx.fileName}`,
    `- 类型: ${ctx.docType === 'part' ? '零件' : ctx.docType === 'assembly' ? '装配体' : ctx.docType === 'drawing' ? '工程图' : '未知'}`,
  ];

  if (ctx.activeConfiguration) {
    lines.push(`- 活动配置: ${ctx.activeConfiguration}`);
  }
  if (ctx.material) {
    lines.push(`- 材料: ${ctx.material}`);
  }
  if (ctx.swVersion) {
    lines.push(`- SolidWorks 版本: ${ctx.swVersion}`);
  }

  // Feature tree
  if (ctx.features.length > 0) {
    lines.push('', '### 特征树');
    for (const f of ctx.features) {
      const sup = f.suppressed ? ' [已压缩]' : '';
      lines.push(`- ${f.name} (${f.type})${sup}`);
    }
    if (ctx.features.length >= 50) {
      lines.push('- ... (超过 50 个，已截断)');
    }
  }

  // Dimensions
  if (ctx.dimensions.length > 0) {
    lines.push('', '### 主要尺寸');
    for (const d of ctx.dimensions) {
      lines.push(`- ${d.fullName} = ${d.value.toFixed(2)} mm`);
    }
    if (ctx.dimensions.length >= 30) {
      lines.push('- ... (超过 30 个，已截断)');
    }
  }

  // Assembly components
  if (ctx.components && ctx.components.length > 0) {
    lines.push('', '### 装配体组件');
    for (const c of ctx.components) {
      const sup = c.suppressed ? ' [已压缩]' : '';
      lines.push(`- ${c.name} → ${c.fileName}${sup}`);
    }
    if (ctx.components.length >= 50) {
      lines.push('- ... (超过 50 个，已截断)');
    }
  }

  // Custom properties
  const propKeys = Object.keys(ctx.customProperties);
  if (propKeys.length > 0) {
    lines.push('', '### 自定义属性');
    for (const k of propKeys) {
      lines.push(`- ${k}: ${ctx.customProperties[k]}`);
    }
  }

  return lines.join('\n');
}
