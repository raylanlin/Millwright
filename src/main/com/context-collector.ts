// src/main/com/context-collector.ts
//
// 从当前打开的 SolidWorks 文档中采集上下文信息。
// 采集的信息会注入到 AI 的 system prompt 中，
// 让 AI 知道用户当前在操作什么文件、有哪些特征和尺寸。
//
// 所有 COM 调用通过 sw-bridge 的 VBScript 代理完成，
// 不再直接调用 COM API（winax 依赖已移除）。

import type { SolidWorksBridge, DocumentFeatures } from './sw-bridge';

export interface SWDocumentContext {
  fileName: string;
  filePath: string;
  docType: 'part' | 'assembly' | 'drawing';
  swVersion?: string;
  activeConfiguration?: string;
  features: Array<{ name: string; type: string; suppressed: boolean }>;
  dimensions: Array<{ fullName: string; value: number }>;
  customProperties: Record<string, string>;
  components?: Array<{ name: string; fileName: string; suppressed: boolean }>;
  material?: string;
}

/**
 * 从当前活动文档采集上下文。
 * 如果没有打开文档或 SolidWorks 未连接，返回 null。
 */
export async function collectDocumentContext(
  bridge: SolidWorksBridge,
): Promise<SWDocumentContext | null> {
  const status = bridge.getStatus();
  if (!status.connected) return null;

  // 采集文档特征信息
  const features = await bridge.collectDocumentFeatures();
  if (!features) return null;

  const filePath = status.activeDocumentPath ?? '(未保存)';
  const fileName = filePath
    ? filePath.split('\\').pop() || filePath
    : '(未保存)';

  return {
    fileName,
    filePath,
    docType: status.activeDocumentType ?? 'part',
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
 * 将上下文格式化为可嵌入 system prompt 的文本。
 */
export async function formatContextForPromptAsync(
  bridge: SolidWorksBridge,
): Promise<string> {
  const ctx = await collectDocumentContext(bridge);
  if (!ctx) return '';
  return formatContextForPrompt(ctx);
}

/**
 * 将上下文格式化为可嵌入 system prompt 的文本。
 * 同步版本，直接从缓存读取（不触发 VBS 调用）。
 */
export function formatContextForPrompt(ctx: SWDocumentContext): string {
  const lines: string[] = [
    `## 当前 SolidWorks 文档信息`,
    `- 文件: ${ctx.fileName}`,
    `- 类型: ${ctx.docType === 'part' ? '零件' : ctx.docType === 'assembly' ? '装配体' : '工程图'}`,
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

  // 特征树
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

  // 尺寸
  if (ctx.dimensions.length > 0) {
    lines.push('', '### 主要尺寸');
    for (const d of ctx.dimensions) {
      lines.push(`- ${d.fullName} = ${d.value.toFixed(2)} mm`);
    }
    if (ctx.dimensions.length >= 30) {
      lines.push('- ... (超过 30 个，已截断)');
    }
  }

  // 装配体组件
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

  // 自定义属性
  const propKeys = Object.keys(ctx.customProperties);
  if (propKeys.length > 0) {
    lines.push('', '### 自定义属性');
    for (const k of propKeys) {
      lines.push(`- ${k}: ${ctx.customProperties[k]}`);
    }
  }

  return lines.join('\n');
}
