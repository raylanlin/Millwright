// src/renderer/components/automations-data.ts
//
// 快捷自动化模板的展示数据。
// 点击后把 prompt 送入聊天输入框,让 AI 基于 prompt 生成脚本。

export interface AutomationTemplate {
  icon: string;
  label: string;
  desc: string;
  /** 点击后发送给 AI 的提示词 */
  prompt: string;
}

export const AUTOMATIONS: AutomationTemplate[] = [
  {
    icon: '⚙️',
    label: '批量修改圆角半径',
    desc: '把当前文档中所有圆角统一改为指定半径',
    prompt:
      '生成一个 VBA 宏:遍历当前装配体或零件的所有圆角特征(Fillet),把它们的半径统一改为 3mm。请在开头定义常量 NEW_RADIUS_MM 方便我修改。',
  },
  {
    icon: '📐',
    label: '导出工程图 PDF',
    desc: '将当前工程图/零件导出为 PDF',
    prompt:
      '生成一个 VBA 宏:把当前活动文档另存为 PDF。路径用占位符 C:\\output\\out.pdf,确保目录存在。',
  },
  {
    icon: '🔩',
    label: '插入标准件',
    desc: '在装配体中插入螺栓/螺母等标准件',
    prompt:
      '我要在当前装配体中插入一个 M6x20 的六角螺栓,生成对应的 VBA 脚本。假设标准件路径在 C:\\parts\\bolt_m6x20.sldprt。',
  },
  {
    icon: '📦',
    label: '批量重命名零件',
    desc: '按规则批量重命名装配体内的零部件',
    prompt:
      '生成 VBA 宏:遍历当前装配体中的所有零部件实例,给它们的文件名加上 "REV_A_" 前缀(不修改原文件,只改配置/自定义属性)。',
  },
  {
    icon: '🔄',
    label: '镜像装配体',
    desc: '对当前装配体执行镜像操作',
    prompt: '我想对当前装配体沿 Front 面做镜像,生成 VBA 脚本。',
  },
  {
    icon: '📊',
    label: 'BOM 表导出',
    desc: '导出物料清单到 Excel',
    prompt:
      '生成 VBA 宏:从当前装配体导出 BOM(零件号、名称、数量)到 Excel 文件。路径占位符 C:\\output\\bom.xlsx。',
  },
  {
    icon: '📏',
    label: '质量属性查询',
    desc: '获取当前零件/装配体的质量、体积、重心',
    prompt:
      '生成 VBA 宏:读取当前零件的质量属性(体积 / 质量 / 重心),输出到一个对话框。',
  },
  {
    icon: '🔍',
    label: '干涉检查',
    desc: '在装配体上运行干涉检测',
    prompt:
      '生成 VBA 宏:对当前装配体运行干涉检查,列出所有干涉对的名称。',
  },
];
