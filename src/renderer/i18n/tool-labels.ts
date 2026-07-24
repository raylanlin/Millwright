// src/renderer/i18n/tool-labels.ts
//
// P21: friendly, localized display names for every agent tool. The card shows
// this label as the title with the raw function name in muted monospace beside
// it. Keyed by the tool name from sidecar.list_tools (@tool("name", ...)).
// Unknown / future tools fall back to the raw name (no crash, just less pretty).

import type { LocaleName } from '../../shared/types';

type LabelMap = Record<string, { zh: string; en: string }>;

export const TOOL_LABELS: LabelMap = {
  // view
  set_view_orientation: { zh: '设置视图方向', en: 'Set view orientation' },
  rotate_view: { zh: '旋转视图', en: 'Rotate view' },
  zoom_to_fit: { zh: '缩放至适合', en: 'Zoom to fit' },
  set_display_mode: { zh: '设置显示模式', en: 'Set display mode' },
  capture_view: { zh: '截取视图', en: 'Capture view' },
  analyze_view: { zh: '分析视图', en: 'Analyze view' },
  // sketch
  start_sketch: { zh: '新建草图', en: 'Start sketch' },
  exit_sketch: { zh: '退出草图', en: 'Exit sketch' },
  sketch_rectangle: { zh: '草图·矩形', en: 'Sketch rectangle' },
  sketch_circle: { zh: '草图·圆', en: 'Sketch circle' },
  sketch_line: { zh: '草图·直线', en: 'Sketch line' },
  sketch_centerline: { zh: '草图·中心线', en: 'Sketch centerline' },
  sketch_arc_center: { zh: '草图·圆心圆弧', en: 'Sketch center-arc' },
  sketch_polygon: { zh: '草图·多边形', en: 'Sketch polygon' },
  sketch_fillet: { zh: '草图·圆角', en: 'Sketch fillet' },
  add_sketch_relation: { zh: '添加草图几何关系', en: 'Add sketch relation' },
  add_dimension: { zh: '添加尺寸', en: 'Add dimension' },
  // feature
  extrude: { zh: '拉伸', en: 'Extrude' },
  cut_extrude: { zh: '拉伸切除', en: 'Cut-extrude' },
  revolve: { zh: '旋转', en: 'Revolve' },
  fillet_edges: { zh: '边线圆角', en: 'Fillet edges' },
  fillet_all: { zh: '统一圆角半径', en: 'Fillet all' },
  chamfer: { zh: '倒角', en: 'Chamfer' },
  shell: { zh: '抽壳', en: 'Shell' },
  linear_pattern: { zh: '线性阵列', en: 'Linear pattern' },
  circular_pattern: { zh: '圆周阵列', en: 'Circular pattern' },
  mirror_feature: { zh: '镜像特征', en: 'Mirror feature' },
  modify_dimension: { zh: '修改尺寸', en: 'Modify dimension' },
  suppress_feature: { zh: '压缩特征', en: 'Suppress feature' },
  unsuppress_feature: { zh: '解除压缩特征', en: 'Unsuppress feature' },
  delete_feature: { zh: '删除特征', en: 'Delete feature' },
  rename_feature: { zh: '重命名特征', en: 'Rename feature' },
  // query
  mass_properties: { zh: '质量属性', en: 'Mass properties' },
  bounding_box: { zh: '包围盒', en: 'Bounding box' },
  list_features: { zh: '列出特征树', en: 'List features' },
  list_components: { zh: '列出装配体组件', en: 'List components' },
  check_interference: { zh: '干涉检查', en: 'Check interference' },
  get_custom_properties: { zh: '读取自定义属性', en: 'Get custom properties' },
  measure_selection: { zh: '测量所选', en: 'Measure selection' },
  // assembly
  insert_component: { zh: '插入组件', en: 'Insert component' },
  add_mate: { zh: '添加配合', en: 'Add mate' },
  suppress_component: { zh: '压缩组件', en: 'Suppress component' },
  unsuppress_component: { zh: '解除压缩组件', en: 'Unsuppress component' },
  // document
  new_part: { zh: '新建零件', en: 'New part' },
  new_assembly: { zh: '新建装配体', en: 'New assembly' },
  new_drawing: { zh: '新建工程图', en: 'New drawing' },
  open_document: { zh: '打开文档', en: 'Open document' },
  save_document: { zh: '保存文档', en: 'Save document' },
  save_as: { zh: '另存为', en: 'Save as' },
  set_material: { zh: '设置材料', en: 'Set material' },
  rebuild_model: { zh: '重建模型', en: 'Rebuild model' },
  set_custom_property: { zh: '写入自定义属性', en: 'Set custom property' },
  create_configuration: { zh: '新建配置', en: 'Create configuration' },
  activate_configuration: { zh: '切换配置', en: 'Activate configuration' },
  add_equation: { zh: '添加方程式', en: 'Add equation' },
  // reference
  create_plane: { zh: '创建基准面', en: 'Create plane' },
  create_axis: { zh: '创建基准轴', en: 'Create axis' },
  create_reference_point: { zh: '创建参考点', en: 'Create reference point' },
  // export
  export_stl: { zh: '导出 STL', en: 'Export STL' },
  export_file: { zh: '导出文件', en: 'Export file' },
};

/** Friendly label for a tool, in the given locale. Falls back to the raw name. */
export function toolLabel(name: string, locale: LocaleName): string {
  const e = TOOL_LABELS[name];
  if (!e) return name;
  return locale === 'zh' ? e.zh : e.en;
}
