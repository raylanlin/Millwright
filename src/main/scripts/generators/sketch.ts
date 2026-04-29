// src/main/scripts/generators/sketch.ts
//
// 草图级工具:进入/退出草图、画矩形/圆/线。
// 所有坐标/尺寸入参是 mm,内部转为 m。

import { PRELUDE_ACTIVE_DOC, wrapMain, selectPlane, mmToM } from './vba-helpers';

/**
 * 在指定基准面创建草图。
 * 注意:已经在活动草图里时再次调用 InsertSketch 会退出,这里先尝试清除再进入。
 */
export function createSketch(params: { plane: 'Front' | 'Top' | 'Right' }): string {
  const body = `${PRELUDE_ACTIVE_DOC}

' 清除当前选择,避免干扰基准面选择
swModel.ClearSelection2 True

' 选择基准面
${selectPlane(params.plane)}

' 进入草图编辑
swModel.SketchManager.InsertSketch True`;
  return wrapMain(body);
}

/**
 * 关闭当前草图。
 * SolidWorks 的 InsertSketch 是开关:在草图外时进入,在草图内时退出。
 * 这里只在确认有活动草图时切换。
 */
export function closeSketch(): string {
  const body = `${PRELUDE_ACTIVE_DOC}

If Not swModel.SketchManager.ActiveSketch Is Nothing Then
    swModel.SketchManager.InsertSketch True
End If`;
  return wrapMain(body);
}

/**
 * 画矩形(角点方式)。
 * SolidWorks CreateCornerRectangle 参数是两个对角点 (x1,y1,z1, x2,y2,z2)。
 * 我们约定用户传入左下角 (x, y) + 宽高,内部算出对角点。
 */
export function drawRectangle(params: {
  x: number;
  y: number;
  width: number;
  height: number;
}): string {
  const x1 = mmToM(params.x);
  const y1 = mmToM(params.y);
  const x2 = mmToM(params.x + params.width);
  const y2 = mmToM(params.y + params.height);

  const body = `${PRELUDE_ACTIVE_DOC}

If swModel.SketchManager.ActiveSketch Is Nothing Then
    MsgBox "请先创建或进入草图", vbExclamation
    Exit Sub
End If

' 画矩形:左下 (${params.x}, ${params.y}) mm,宽 ${params.width} mm × 高 ${params.height} mm
swModel.SketchManager.CreateCornerRectangle ${x1}, ${y1}, 0, ${x2}, ${y2}, 0`;
  return wrapMain(body);
}

/**
 * 画圆。CreateCircle(centerX, centerY, centerZ, edgeX, edgeY, edgeZ) —
 * 圆心 + 圆周上一点。这里内部选 (x+r, y) 作为边缘点。
 */
export function drawCircle(params: { x: number; y: number; radius: number }): string {
  const cx = mmToM(params.x);
  const cy = mmToM(params.y);
  const ex = mmToM(params.x + params.radius);
  const ey = mmToM(params.y);

  const body = `${PRELUDE_ACTIVE_DOC}

If swModel.SketchManager.ActiveSketch Is Nothing Then
    MsgBox "请先创建或进入草图", vbExclamation
    Exit Sub
End If

' 画圆:圆心 (${params.x}, ${params.y}) mm,半径 ${params.radius} mm
swModel.SketchManager.CreateCircle ${cx}, ${cy}, 0, ${ex}, ${ey}, 0`;
  return wrapMain(body);
}

/** 画线段 */
export function drawLine(params: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}): string {
  const x1 = mmToM(params.x1);
  const y1 = mmToM(params.y1);
  const x2 = mmToM(params.x2);
  const y2 = mmToM(params.y2);

  const body = `${PRELUDE_ACTIVE_DOC}

If swModel.SketchManager.ActiveSketch Is Nothing Then
    MsgBox "请先创建或进入草图", vbExclamation
    Exit Sub
End If

' 画线段:(${params.x1}, ${params.y1}) → (${params.x2}, ${params.y2}) mm
swModel.SketchManager.CreateLine ${x1}, ${y1}, 0, ${x2}, ${y2}, 0`;
  return wrapMain(body);
}
