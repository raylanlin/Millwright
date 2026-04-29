// src/main/scripts/generators/assembly.ts
//
// 装配体操作:插入零部件、添加配合。

import { PRELUDE_ACTIVE_DOC, wrapMain, vbaString } from './vba-helpers';

/**
 * 在当前装配体中插入零部件。
 * 插入位置:装配体原点 (0,0,0)。
 */
export function insertComponent(params: { filePath: string }): string {
  const body = `${PRELUDE_ACTIVE_DOC}

If swModel.GetType <> 2 Then  ' 2 = Assembly
    MsgBox "当前文档不是装配体", vbExclamation
    Exit Sub
End If

Dim swAssembly As AssemblyDoc
Set swAssembly = swModel

Dim swComp As Object
Set swComp = swAssembly.AddComponent5( _
    ${vbaString(params.filePath)}, _
    0, "", False, "", 0, 0, 0)

If swComp Is Nothing Then
    MsgBox "插入组件失败。请检查文件路径是否存在。", vbExclamation
End If`;
  return wrapMain(body);
}

/**
 * 配合类型常量映射 —— SolidWorks swMateType_e 枚举。
 */
const MATE_TYPE_MAP: Record<string, number> = {
  coincident: 0,
  concentric: 1,
  perpendicular: 2,
  parallel: 3,
  tangent: 4,
  distance: 5,
  angle: 6,
};

/**
 * 添加配合。需要用户预先选择两个要配合的实体(面/边/点/轴)。
 * 我们生成的脚本会校验选中数量。
 */
export function addMate(params: { type: keyof typeof MATE_TYPE_MAP | string }): string {
  const mateType = MATE_TYPE_MAP[params.type];
  if (mateType === undefined) {
    // 不抛异常,在生成的脚本里提醒 —— 生成器本身要容错,错误参数留给运行时处理
    const body = `MsgBox "未知配合类型: ${params.type}", vbCritical`;
    return wrapMain(body);
  }

  const body = `${PRELUDE_ACTIVE_DOC}

If swModel.GetType <> 2 Then
    MsgBox "当前文档不是装配体", vbExclamation
    Exit Sub
End If

Dim swSelMgr As SelectionMgr
Set swSelMgr = swModel.SelectionManager

If swSelMgr.GetSelectedObjectCount2(-1) < 2 Then
    MsgBox "请先选择两个要配合的实体(面/边/点/轴)", vbExclamation
    Exit Sub
End If

Dim swAssembly As AssemblyDoc
Set swAssembly = swModel

' 添加配合:${params.type} (MateType=${mateType})
' AddMate5(MateTypeFromEnum, AlignFromEnum, Flip, Distance, DistanceAbsUpperLimit,
'          DistanceAbsLowerLimit, GearRatioNumerator, GearRatioDenominator,
'          Angle, AngleAbsUpperLimit, AngleAbsLowerLimit, ForPositioningOnly,
'          LockRotation, WidthMateOption, ErrorStatus)
Dim errStatus As Long
swAssembly.AddMate5 ${mateType}, 1, False, 0, 0, 0, 0, 0, 0, 0, 0, False, False, 0, errStatus

If errStatus <> 0 Then
    MsgBox "配合添加失败 (错误码 " & errStatus & ")", vbExclamation
End If`;
  return wrapMain(body);
}
