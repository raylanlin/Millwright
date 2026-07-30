// src/shared/sw-tools.ts
//
// Catalog of the atomic SolidWorks tools the AI can invoke.
// This file is pure data (no execution logic); both the main and renderer processes need it:
//   - main:  serves as the system-prompt capability list / Phase-3 function-calling entry point
//   - renderer: shown on the "Tools" tab

export interface SWToolDefinition {
  name: string;
  /** Chinese description — also serves as the main process's capability list */
  description: string;
  /** P68: English description. The Tools tab renders whichever matches the UI language;
   *  without it the panel showed Chinese descriptions and category headings even with the
   *  interface set to English. */
  descriptionEn: string;
  parameters: Record<string, string>;
  category: 'document' | 'sketch' | 'feature' | 'assembly' | 'export' | 'batch' | 'query';
  /** Example parameters pre-filled for "try/preview". Omit when the tool takes no arguments or the generator handles defaults itself */
  exampleParams?: Record<string, any>;
}

export const SW_TOOLS: SWToolDefinition[] = [
  // —— Document management ——
  { name: 'create_part', description: '创建新零件文档', descriptionEn: 'Create a new part document', parameters: {}, category: 'document' },
  { name: 'create_assembly', description: '创建新装配体', descriptionEn: 'Create a new assembly', parameters: {}, category: 'document' },
  {
    name: 'create_drawing',
    description: '创建新工程图',
    descriptionEn: 'Create a new drawing',
    parameters: { template: 'string (可选)' },
    category: 'document',
    exampleParams: {},
  },

  // —— Sketches ——
  {
    name: 'create_sketch',
    description: '在指定平面创建草图',
    descriptionEn: 'Start a sketch on the given plane',
    parameters: { plane: 'Front | Top | Right' },
    category: 'sketch',
    exampleParams: { plane: 'Front' },
  },
  { name: 'close_sketch', description: '关闭当前草图', descriptionEn: 'Close the current sketch', parameters: {}, category: 'sketch' },
  {
    name: 'draw_rectangle',
    description: '画矩形',
    descriptionEn: 'Draw a rectangle',
    parameters: { x: 'number (mm)', y: 'number (mm)', width: 'number (mm)', height: 'number (mm)' },
    category: 'sketch',
    exampleParams: { x: 0, y: 0, width: 50, height: 30 },
  },
  {
    name: 'draw_circle',
    description: '画圆',
    descriptionEn: 'Draw a circle',
    parameters: { x: 'number (mm)', y: 'number (mm)', radius: 'number (mm)' },
    category: 'sketch',
    exampleParams: { x: 0, y: 0, radius: 20 },
  },
  {
    name: 'draw_line',
    description: '画线段',
    descriptionEn: 'Draw a line segment',
    parameters: {
      x1: 'number (mm)', y1: 'number (mm)',
      x2: 'number (mm)', y2: 'number (mm)',
    },
    category: 'sketch',
    exampleParams: { x1: 0, y1: 0, x2: 50, y2: 30 },
  },

  // —— Features ——
  {
    name: 'extrude_feature',
    description: '拉伸特征',
    descriptionEn: 'Extrude (boss)',
    parameters: { depth: 'number (mm)', direction: 'both (可选)' },
    category: 'feature',
    exampleParams: { depth: 20 },
  },
  {
    name: 'cut_extrude',
    description: '切除拉伸',
    descriptionEn: 'Cut-extrude',
    parameters: { depth: 'number (mm)' },
    category: 'feature',
    exampleParams: { depth: 10 },
  },
  {
    name: 'create_revolve',
    description: '旋转特征',
    descriptionEn: 'Revolve',
    parameters: { angle: 'number (度)' },
    category: 'feature',
    exampleParams: { angle: 360 },
  },
  {
    name: 'create_fillet',
    description: '倒圆角',
    descriptionEn: 'Round edges (fillet)',
    parameters: { radius: 'number (mm)' },
    category: 'feature',
    exampleParams: { radius: 3 },
  },
  {
    name: 'create_chamfer',
    description: '倒斜角',
    descriptionEn: 'Chamfer edges',
    parameters: { distance: 'number (mm)' },
    category: 'feature',
    exampleParams: { distance: 2 },
  },
  {
    name: 'create_pattern',
    description: '线性阵列',
    descriptionEn: 'Linear pattern',
    parameters: { count: 'number', spacing: 'number (mm)', direction: 'string' },
    category: 'feature',
    exampleParams: { count: 4, spacing: 20, direction: 'Edge' },
  },
  {
    name: 'mirror_feature',
    description: '镜像特征',
    descriptionEn: 'Mirror a feature',
    parameters: { plane: 'Front | Top | Right' },
    category: 'feature',
    exampleParams: { plane: 'Front' },
  },
  {
    name: 'modify_dimensions',
    description: '修改尺寸参数',
    descriptionEn: 'Modify a dimension parameter',
    parameters: { featureName: 'string', dimName: 'string', value: 'number (mm)' },
    category: 'feature',
    exampleParams: { featureName: 'Boss-Extrude1', dimName: 'D1', value: 30 },
  },

  // —— Assemblies ——
  {
    name: 'insert_component',
    description: '插入零部件',
    descriptionEn: 'Insert a component',
    parameters: { filePath: 'string' },
    category: 'assembly',
    exampleParams: { filePath: 'C:\\parts\\bolt_m6x20.sldprt' },
  },
  {
    name: 'add_mate',
    description: '添加配合关系',
    descriptionEn: 'Add a mate',
    parameters: { type: 'coincident | parallel | perpendicular | tangent | concentric | distance' },
    category: 'assembly',
    exampleParams: { type: 'coincident' },
  },

  // —— Export ——
  {
    name: 'export_step',
    description: '导出 STEP',
    descriptionEn: 'Export STEP',
    parameters: { outputPath: 'string' },
    category: 'export',
    exampleParams: { outputPath: 'C:\\output\\part.step' },
  },
  {
    name: 'export_pdf',
    description: '导出 PDF',
    descriptionEn: 'Export PDF',
    parameters: { outputPath: 'string' },
    category: 'export',
    exampleParams: { outputPath: 'C:\\output\\drawing.pdf' },
  },
  {
    name: 'export_stl',
    description: '导出 STL',
    descriptionEn: 'Export STL',
    parameters: { outputPath: 'string', quality: 'coarse | fine (可选)' },
    category: 'export',
    exampleParams: { outputPath: 'C:\\output\\part.stl', quality: 'fine' },
  },
  {
    name: 'export_dxf',
    description: '导出 DXF',
    descriptionEn: 'Export DXF',
    parameters: { outputPath: 'string' },
    category: 'export',
    exampleParams: { outputPath: 'C:\\output\\part.dxf' },
  },

  // —— Batch ——
  {
    name: 'batch_rename',
    description: '批量重命名',
    descriptionEn: 'Batch rename',
    parameters: { pattern: 'string (正则)', replacement: 'string' },
    category: 'batch',
    exampleParams: { pattern: 'Part', replacement: 'REV_A_Part' },
  },

  // —— Query ——
  { name: 'check_interference', description: '干涉检查', descriptionEn: 'Interference check', parameters: {}, category: 'query' },
  { name: 'mass_properties', description: '获取质量属性', descriptionEn: 'Get mass properties', parameters: {}, category: 'query' },
  {
    name: 'bom_export',
    description: '导出物料清单',
    descriptionEn: 'Export the bill of materials',
    parameters: { outputPath: 'string', format: 'xlsx | csv' },
    category: 'query',
    exampleParams: { outputPath: 'C:\\output\\bom.csv', format: 'csv' },
  },
];

type Category = SWToolDefinition['category'];

export const CATEGORY_LABELS: Record<Category, string> = {
  document: '文档管理',
  sketch: '草图',
  feature: '特征',
  assembly: '装配体',
  export: '导出',
  batch: '批量操作',
  query: '查询',
};

export const CATEGORY_LABELS_EN: Record<Category, string> = {
  document: 'Documents',
  sketch: 'Sketch',
  feature: 'Features',
  assembly: 'Assembly',
  export: 'Export',
  batch: 'Batch',
  query: 'Query',
};

/** P68: category heading in the active UI language. */
export function categoryLabel(cat: string, locale: 'zh' | 'en'): string {
  return (locale === 'en' ? CATEGORY_LABELS_EN : CATEGORY_LABELS)[cat as Category] ?? cat;
}

/** P68: tool description in the active UI language. */
export function toolDescription(tool: SWToolDefinition, locale: 'zh' | 'en'): string {
  return locale === 'en' ? tool.descriptionEn || tool.description : tool.description;
}

export function getToolNames(): string[] {
  return SW_TOOLS.map((t) => t.name);
}

export function getToolsByCategory(): Record<string, SWToolDefinition[]> {
  return SW_TOOLS.reduce<Record<string, SWToolDefinition[]>>((acc, tool) => {
    (acc[tool.category] ||= []).push(tool);
    return acc;
  }, {});
}
