// src/main/scripts/generators/index.ts
//
// 生成器注册表。
// 每个工具名对应一个生成函数,接受参数返回 VBA 代码。
// 参数校验很简单(undefined 报错),深入校验留给调用方。

import * as doc from './document';
import * as sketch from './sketch';
import * as feat from './feature';
import * as asm from './assembly';
import * as exp from './export';
import * as bq from './batch-query';
import type { SWToolDefinition } from '../../../shared/sw-tools';

type GeneratorFn = (params: any) => string;

export interface GenerateResult {
  code: string;
  language: 'vba';
  toolName: string;
}

/**
 * 工具名 → 生成器函数。
 * 所有 SW_TOOLS 里的 name 都应该有对应条目,我们在下面的"完整性"自检里验证。
 */
const REGISTRY: Record<string, GeneratorFn> = {
  // —— 文档 ——
  create_part: () => doc.createPart(),
  create_assembly: () => doc.createAssembly(),
  create_drawing: (p) => doc.createDrawing(p),

  // —— 草图 ——
  create_sketch: (p) => sketch.createSketch(p),
  close_sketch: () => sketch.closeSketch(),
  draw_rectangle: (p) => sketch.drawRectangle(p),
  draw_circle: (p) => sketch.drawCircle(p),
  draw_line: (p) => sketch.drawLine(p),

  // —— 特征 ——
  extrude_feature: (p) => feat.extrudeFeature(p),
  cut_extrude: (p) => feat.cutExtrude(p),
  create_revolve: (p) => feat.createRevolve(p),
  create_fillet: (p) => feat.createFillet(p),
  create_chamfer: (p) => feat.createChamfer(p),
  create_pattern: (p) => feat.createPattern(p),
  mirror_feature: (p) => feat.mirrorFeature(p),
  modify_dimensions: (p) => feat.modifyDimensions(p),

  // —— 装配体 ——
  insert_component: (p) => asm.insertComponent(p),
  add_mate: (p) => asm.addMate(p),

  // —— 导出 ——
  export_step: (p) => exp.exportStep(p),
  export_pdf: (p) => exp.exportPdf(p),
  export_stl: (p) => exp.exportStl(p),
  export_dxf: (p) => exp.exportDxf(p),

  // —— 批量 / 查询 ——
  batch_rename: (p) => bq.batchRename(p),
  check_interference: () => bq.checkInterference(),
  mass_properties: () => bq.massProperties(),
  bom_export: (p) => bq.bomExport(p),
};

/**
 * 按工具名生成 VBA 脚本。
 * @throws Error 如果工具名未注册或参数缺失
 */
export function generateScript(toolName: string, params?: Record<string, any>): GenerateResult {
  const fn = REGISTRY[toolName];
  if (!fn) {
    throw new Error(`未知工具: ${toolName}`);
  }
  try {
    const code = fn(params ?? {});
    return { code, language: 'vba', toolName };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`生成 ${toolName} 脚本失败: ${msg}`);
  }
}

/** 已注册的工具名集合。用于对照 SW_TOOLS 的完整性。 */
export function registeredToolNames(): string[] {
  return Object.keys(REGISTRY);
}

/**
 * 完整性检查:注册表应该覆盖 SW_TOOLS 中所有工具。
 * 调用方可以在启动时做一次,打印缺失项。
 */
export function checkCoverage(tools: SWToolDefinition[]): {
  covered: string[];
  missing: string[];
  extra: string[];
} {
  const registered = new Set(Object.keys(REGISTRY));
  const declared = new Set(tools.map((t) => t.name));

  const covered: string[] = [];
  const missing: string[] = [];
  for (const t of declared) {
    if (registered.has(t)) covered.push(t);
    else missing.push(t);
  }
  const extra: string[] = [];
  for (const r of registered) {
    if (!declared.has(r)) extra.push(r);
  }
  return { covered, missing, extra };
}
