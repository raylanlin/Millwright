// src/shared/sw-tools.ts
//
// AI 可调用的 SolidWorks 原子工具清单。
// 这是纯数据(没有执行逻辑),main 和 renderer 都需要引用:
//   - main:  可能作为 system prompt 能力清单 / Phase 3 function calling 入口
//   - renderer:  "工具列表" 标签页展示

export interface SWToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, string>;
  category: 'document' | 'sketch' | 'feature' | 'assembly' | 'export' | 'batch' | 'query';
  /** 用于"试用/预览"时填充的示例参数。不提供表示无参或生成器自行处理缺省 */
  exampleParams?: Record<string, any>;
}

export const SW_TOOLS: SWToolDefinition[] = [
  // —— 文档管理 ——
  { name: 'create_part', description: '创建新零件文档', parameters: {}, category: 'document' },
  { name: 'create_assembly', description: '创建新装配体', parameters: {}, category: 'document' },
  {
    name: 'create_drawing',
    description: '创建新工程图',
    parameters: { template: 'string (可选)' },
    category: 'document',
    exampleParams: {},
  },

  // —— 草图 ——
  {
    name: 'create_sketch',
    description: '在指定平面创建草图',
    parameters: { plane: 'Front | Top | Right' },
    category: 'sketch',
    exampleParams: { plane: 'Front' },
  },
  { name: 'close_sketch', description: '关闭当前草图', parameters: {}, category: 'sketch' },
  {
    name: 'draw_rectangle',
    description: '画矩形',
    parameters: { x: 'number (mm)', y: 'number (mm)', width: 'number (mm)', height: 'number (mm)' },
    category: 'sketch',
    exampleParams: { x: 0, y: 0, width: 50, height: 30 },
  },
  {
    name: 'draw_circle',
    description: '画圆',
    parameters: { x: 'number (mm)', y: 'number (mm)', radius: 'number (mm)' },
    category: 'sketch',
    exampleParams: { x: 0, y: 0, radius: 20 },
  },
  {
    name: 'draw_line',
    description: '画线段',
    parameters: {
      x1: 'number (mm)', y1: 'number (mm)',
      x2: 'number (mm)', y2: 'number (mm)',
    },
    category: 'sketch',
    exampleParams: { x1: 0, y1: 0, x2: 50, y2: 30 },
  },

  // —— 特征 ——
  {
    name: 'extrude_feature',
    description: '拉伸特征',
    parameters: { depth: 'number (mm)', direction: 'both (可选)' },
    category: 'feature',
    exampleParams: { depth: 20 },
  },
  {
    name: 'cut_extrude',
    description: '切除拉伸',
    parameters: { depth: 'number (mm)' },
    category: 'feature',
    exampleParams: { depth: 10 },
  },
  {
    name: 'create_revolve',
    description: '旋转特征',
    parameters: { angle: 'number (度)' },
    category: 'feature',
    exampleParams: { angle: 360 },
  },
  {
    name: 'create_fillet',
    description: '倒圆角',
    parameters: { radius: 'number (mm)' },
    category: 'feature',
    exampleParams: { radius: 3 },
  },
  {
    name: 'create_chamfer',
    description: '倒斜角',
    parameters: { distance: 'number (mm)' },
    category: 'feature',
    exampleParams: { distance: 2 },
  },
  {
    name: 'create_pattern',
    description: '线性阵列',
    parameters: { count: 'number', spacing: 'number (mm)', direction: 'string' },
    category: 'feature',
    exampleParams: { count: 4, spacing: 20, direction: 'Edge' },
  },
  {
    name: 'mirror_feature',
    description: '镜像特征',
    parameters: { plane: 'Front | Top | Right' },
    category: 'feature',
    exampleParams: { plane: 'Front' },
  },
  {
    name: 'modify_dimensions',
    description: '修改尺寸参数',
    parameters: { featureName: 'string', dimName: 'string', value: 'number (mm)' },
    category: 'feature',
    exampleParams: { featureName: 'Boss-Extrude1', dimName: 'D1', value: 30 },
  },

  // —— 装配体 ——
  {
    name: 'insert_component',
    description: '插入零部件',
    parameters: { filePath: 'string' },
    category: 'assembly',
    exampleParams: { filePath: 'C:\\parts\\bolt_m6x20.sldprt' },
  },
  {
    name: 'add_mate',
    description: '添加配合关系',
    parameters: { type: 'coincident | parallel | perpendicular | tangent | concentric | distance' },
    category: 'assembly',
    exampleParams: { type: 'coincident' },
  },

  // —— 导出 ——
  {
    name: 'export_step',
    description: '导出 STEP',
    parameters: { outputPath: 'string' },
    category: 'export',
    exampleParams: { outputPath: 'C:\\output\\part.step' },
  },
  {
    name: 'export_pdf',
    description: '导出 PDF',
    parameters: { outputPath: 'string' },
    category: 'export',
    exampleParams: { outputPath: 'C:\\output\\drawing.pdf' },
  },
  {
    name: 'export_stl',
    description: '导出 STL',
    parameters: { outputPath: 'string', quality: 'coarse | fine (可选)' },
    category: 'export',
    exampleParams: { outputPath: 'C:\\output\\part.stl', quality: 'fine' },
  },
  {
    name: 'export_dxf',
    description: '导出 DXF',
    parameters: { outputPath: 'string' },
    category: 'export',
    exampleParams: { outputPath: 'C:\\output\\part.dxf' },
  },

  // —— 批量 ——
  {
    name: 'batch_rename',
    description: '批量重命名',
    parameters: { pattern: 'string (正则)', replacement: 'string' },
    category: 'batch',
    exampleParams: { pattern: 'Part', replacement: 'REV_A_Part' },
  },

  // —— 查询 ——
  { name: 'check_interference', description: '干涉检查', parameters: {}, category: 'query' },
  { name: 'mass_properties', description: '获取质量属性', parameters: {}, category: 'query' },
  {
    name: 'bom_export',
    description: '导出物料清单',
    parameters: { outputPath: 'string', format: 'xlsx | csv' },
    category: 'query',
    exampleParams: { outputPath: 'C:\\output\\bom.csv', format: 'csv' },
  },
];

export const CATEGORY_LABELS: Record<SWToolDefinition['category'], string> = {
  document: '文档管理',
  sketch: '草图',
  feature: '特征',
  assembly: '装配体',
  export: '导出',
  batch: '批量操作',
  query: '查询',
};

export function getToolNames(): string[] {
  return SW_TOOLS.map((t) => t.name);
}

export function getToolsByCategory(): Record<string, SWToolDefinition[]> {
  return SW_TOOLS.reduce<Record<string, SWToolDefinition[]>>((acc, tool) => {
    (acc[tool.category] ||= []).push(tool);
    return acc;
  }, {});
}
