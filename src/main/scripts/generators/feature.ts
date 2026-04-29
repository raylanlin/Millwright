// src/main/scripts/generators/feature.ts
//
// 特征工具:拉伸、切除、旋转、倒圆角/倒角、阵列、镜像、尺寸修改。

import {
  PRELUDE_ACTIVE_DOC,
  wrapMain,
  selectPlane,
  selectPlaneAppend,
  mmToM,
  degToRad,
  vbaString,
} from './vba-helpers';

/**
 * 拉伸当前草图为实体。
 * SolidWorks FeatureExtrusion3 有 27 个参数 —— 非常多,我们用最常见的默认值:
 *   - 单方向、给定深度、不反向、不合并(作为独立实体时适用)
 * @param direction 'both' 表示双向等距拉伸
 */
export function extrudeFeature(params: { depth: number; direction?: 'both' }): string {
  const both = params.direction === 'both';
  const depth = mmToM(params.depth);

  const body = `${PRELUDE_ACTIVE_DOC}

' 如果当前在草图编辑中,先退出
If Not swModel.SketchManager.ActiveSketch Is Nothing Then
    swModel.SketchManager.InsertSketch True
End If

' 拉伸深度 ${params.depth} mm${both ? '(双向)' : ''}
swModel.FeatureManager.FeatureExtrusion3 _
    True, False, ${both ? 'True' : 'False'}, _
    0, 0, _
    ${depth}, ${both ? depth : '0'}, _
    False, False, False, False, _
    0, 0, False, False, False, False, _
    True, True, True, 0, 0, False`;
  return wrapMain(body);
}

/** 切除拉伸(挖料) */
export function cutExtrude(params: { depth: number }): string {
  const depth = mmToM(params.depth);
  const body = `${PRELUDE_ACTIVE_DOC}

If Not swModel.SketchManager.ActiveSketch Is Nothing Then
    swModel.SketchManager.InsertSketch True
End If

' 切除拉伸 ${params.depth} mm
swModel.FeatureManager.FeatureCut4 _
    True, False, False, _
    0, 0, _
    ${depth}, 0, _
    False, False, False, False, _
    0, 0, False, False, False, False, _
    True, True, True, True, _
    0, 0, False`;
  return wrapMain(body);
}

/** 旋转特征 */
export function createRevolve(params: { angle: number }): string {
  const angleRad = degToRad(params.angle);
  const body = `${PRELUDE_ACTIVE_DOC}

If Not swModel.SketchManager.ActiveSketch Is Nothing Then
    swModel.SketchManager.InsertSketch True
End If

' 旋转 ${params.angle}°(${angleRad} 弧度)
swModel.FeatureManager.FeatureRevolve2 _
    True, True, False, False, False, False, _
    0, 0, ${angleRad}, 0, _
    False, False, _
    0, 0, 0, 0, 0, _
    True, True, True`;
  return wrapMain(body);
}

/**
 * 倒圆角 —— 批量改所有圆角特征的半径。
 * 这是用户最常见的批量场景:现有模型里所有 Fillet 特征改为统一半径。
 */
export function createFillet(params: { radius: number }): string {
  const r = mmToM(params.radius);
  const body = `${PRELUDE_ACTIVE_DOC}

' 遍历所有特征,把 Fillet 类型的半径改为 ${params.radius} mm
Dim swFeat As Feature
Dim count As Long
count = 0

Set swFeat = swModel.FirstFeature
Do While Not swFeat Is Nothing
    If swFeat.GetTypeName2 = "Fillet" Then
        Dim swFeatData As Object
        Set swFeatData = swFeat.GetDefinition
        If Not swFeatData Is Nothing Then
            swFeatData.DefaultRadius = ${r}
            swFeat.ModifyDefinition swFeatData, swModel, Nothing
            count = count + 1
        End If
    End If
    Set swFeat = swFeat.GetNextFeature
Loop

swModel.ForceRebuild3 False
MsgBox "已修改 " & count & " 个圆角特征为 ${params.radius} mm", vbInformation`;
  return wrapMain(body);
}

/**
 * 倒斜角。需要预先选择边。
 * 这里生成的脚本假设用户已经在 SolidWorks 里选好了边 —— 如果没有,报错提示。
 */
export function createChamfer(params: { distance: number }): string {
  const d = mmToM(params.distance);
  const body = `${PRELUDE_ACTIVE_DOC}

Dim swSelMgr As SelectionMgr
Set swSelMgr = swModel.SelectionManager

If swSelMgr.GetSelectedObjectCount2(-1) = 0 Then
    MsgBox "请先选择一条或多条边,再执行倒斜角", vbExclamation
    Exit Sub
End If

' 倒斜角 ${params.distance} mm
' InsertFeatureChamfer(Type, PropagateFeature, DefaultType, Width, Angle, OtherDist)
' Type: 0 = 距离-距离等距
swModel.FeatureManager.InsertFeatureChamfer _
    4, 1, ${d}, ${d}, 0.785398163397448, ${d}`;
  return wrapMain(body);
}

/**
 * 线性阵列。
 * 简化:只做单方向线性阵列,需要用户先选中要阵列的特征并选好方向边。
 */
export function createPattern(params: {
  count: number;
  spacing: number;
  direction: string;
}): string {
  const spacing = mmToM(params.spacing);
  const body = `${PRELUDE_ACTIVE_DOC}

Dim swSelMgr As SelectionMgr
Set swSelMgr = swModel.SelectionManager

If swSelMgr.GetSelectedObjectCount2(-1) < 2 Then
    MsgBox "请先选择要阵列的特征 + 阵列方向(边或坐标轴)", vbExclamation
    Exit Sub
End If

' 线性阵列:间距 ${params.spacing} mm,数量 ${params.count},方向:${params.direction}
swModel.FeatureManager.FeatureLinearPattern5 _
    ${params.count}, ${spacing}, _
    1, 0.01, _
    False, False, _
    "NULL", "NULL", _
    False, False, False, False, False, False, _
    True, True, False, False, 0, 0`;
  return wrapMain(body);
}

/**
 * 镜像特征 —— 以指定基准面为对称面,需要用户先选中要镜像的特征。
 */
export function mirrorFeature(params: { plane: 'Front' | 'Top' | 'Right' }): string {
  const body = `${PRELUDE_ACTIVE_DOC}

Dim swSelMgr As SelectionMgr
Set swSelMgr = swModel.SelectionManager

If swSelMgr.GetSelectedObjectCount2(-1) = 0 Then
    MsgBox "请先选择要镜像的特征", vbExclamation
    Exit Sub
End If

' 追加选择对称面(保留已选中的特征)
${selectPlaneAppend(params.plane)}

' 镜像
swModel.FeatureManager.InsertMirrorFeature2 _
    False, False, False, False, 0`;
  return wrapMain(body);
}

/**
 * 修改尺寸参数。
 * SolidWorks 的 Parameter 访问方式是 "尺寸名@特征名",例如 "D1@Boss-Extrude1"。
 */
export function modifyDimensions(params: {
  featureName: string;
  dimName: string;
  value: number;
}): string {
  const v = mmToM(params.value);
  const fullName = `${params.dimName}@${params.featureName}`;
  const body = `${PRELUDE_ACTIVE_DOC}

Dim swDim As Dimension
Set swDim = swModel.Parameter(${vbaString(fullName)})

If swDim Is Nothing Then
    MsgBox "找不到尺寸 ${fullName}", vbExclamation
    Exit Sub
End If

' 修改尺寸为 ${params.value} mm
swDim.SetSystemValue3 ${v}, 1, Nothing  ' 1 = swSetValue_InAllConfigurations

swModel.ForceRebuild3 False`;
  return wrapMain(body);
}
