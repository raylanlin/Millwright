// src/renderer/i18n/tool-labels.ts
//
// P21: friendly, localized display names for every agent tool. Keyed by the tool name
// from sidecar.list_tools. Unknown / future tools fall back to the raw name.
// P127: labels for every tool added since P97 (rounded rectangle, slot, polyline, generators,
// drawing, batch, guidance, search/shell, topology, health, session, workflows).

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
  sketch_on_face: { zh: '在面上新建草图', en: 'Sketch on face' },
  exit_sketch: { zh: '退出草图', en: 'Exit sketch' },
  sketch_rectangle: { zh: '草图·矩形', en: 'Sketch rectangle' },
  sketch_rounded_rectangle: { zh: '草图·圆角矩形', en: 'Sketch rounded rectangle' },
  sketch_circle: { zh: '草图·圆', en: 'Sketch circle' },
  sketch_line: { zh: '草图·直线', en: 'Sketch line' },
  sketch_polyline: { zh: '草图·折线轮廓', en: 'Sketch polyline' },
  sketch_slot: { zh: '草图·槽', en: 'Sketch slot' },
  sketch_centerline: { zh: '草图·中心线', en: 'Sketch centerline' },
  sketch_arc_center: { zh: '草图·圆心圆弧', en: 'Sketch center-arc' },
  sketch_polygon: { zh: '草图·多边形', en: 'Sketch polygon' },
  sketch_fillet: { zh: '草图·圆角', en: 'Sketch fillet' },
  add_sketch_relation: { zh: '添加草图几何关系', en: 'Add sketch relation' },
  add_dimension: { zh: '添加尺寸', en: 'Add dimension' },
  // feature
  extrude: { zh: '拉伸', en: 'Extrude' },
  cut_extrude: { zh: '拉伸切除', en: 'Cut-extrude' },
  cut_face_outline: { zh: '沿面轮廓切除', en: 'Cut face outline' },
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
  build_part: { zh: '批量建模', en: 'Build part' },
  // generators
  create_spur_gear: { zh: '生成直齿轮', en: 'Create spur gear' },
  create_stepped_shaft: { zh: '生成阶梯轴', en: 'Create stepped shaft' },
  gear_pair_geometry: { zh: '齿轮副几何计算', en: 'Gear pair geometry' },
  // topology (P123)
  list_faces: { zh: '列出面（带索引）', en: 'List faces' },
  list_edges: { zh: '列出边（带索引）', en: 'List edges' },
  get_selection: { zh: '读取当前选中', en: 'Get selection' },
  select_entities: { zh: '按索引选择', en: 'Select by index' },
  // health (P124)
  edit_state: { zh: '编辑状态', en: 'Edit state' },
  feature_diagnostics: { zh: '特征错误诊断', en: 'Feature diagnostics' },
  diagnose_document: { zh: '文档健康检查', en: 'Diagnose document' },
  // query
  mass_properties: { zh: '质量属性', en: 'Mass properties' },
  bounding_box: { zh: '包围盒', en: 'Bounding box' },
  list_features: { zh: '列出特征树', en: 'List features' },
  list_components: { zh: '列出装配体组件', en: 'List components' },
  check_interference: { zh: '干涉检查', en: 'Check interference' },
  get_custom_properties: { zh: '读取自定义属性', en: 'Get custom properties' },
  measure_selection: { zh: '测量所选', en: 'Measure selection' },
  sw_status: { zh: 'SolidWorks 状态', en: 'SolidWorks status' },
  sw_diagnostics: { zh: '连接诊断', en: 'Connection diagnostics' },
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
  export_session: { zh: '导出会话脚本', en: 'Export session script' },
  // drawing
  create_drawing_of: { zh: '生成工程图', en: 'Create drawing' },
  add_drawing_view: { zh: '添加视图', en: 'Add drawing view' },
  add_section_view: { zh: '添加剖视图', en: 'Add section view' },
  insert_model_dimensions: { zh: '插入模型尺寸', en: 'Insert model dimensions' },
  insert_bom: { zh: '插入材料明细表', en: 'Insert BOM' },
  add_drawing_note: { zh: '添加注释', en: 'Add note' },
  list_drawing_views: { zh: '列出工程图视图', en: 'List drawing views' },
  // reference
  create_plane: { zh: '创建基准面', en: 'Create plane' },
  create_axis: { zh: '创建基准轴', en: 'Create axis' },
  create_reference_point: { zh: '创建参考点', en: 'Create reference point' },
  // export
  export_stl: { zh: '导出 STL', en: 'Export STL' },
  export_file: { zh: '导出文件', en: 'Export file' },
  // meta
  read_guidance: { zh: '读取规则', en: 'Read guidance' },
  search_files: { zh: '搜索文件', en: 'Search files' },
  run_shell: { zh: '运行命令', en: 'Run shell' },
  run_macro: { zh: '运行宏', en: 'Run macro' },
};

/** Friendly label for a tool, in the given locale. Falls back to the raw name. */
export function toolLabel(name: string, locale: LocaleName): string {
  const e = TOOL_LABELS[name];
  if (!e) return name;
  return locale === 'zh' ? e.zh : e.en;
}
