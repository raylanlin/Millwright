// src/main/scripts/generators/document.ts
//
// 文档级工具:新建零件/装配体/工程图。

import { PRELUDE_APP_ONLY, wrapMain, vbaString } from './vba-helpers';

/**
 * 创建新零件。使用用户默认的零件模板。
 * SolidWorks 的 swUserPreferenceStringValue_e.swDefaultTemplatePart = 9
 * 这里用常量值 9 避免依赖 enum(某些版本 enum 名字不同)
 */
export function createPart(): string {
  const body = `${PRELUDE_APP_ONLY}

Dim templatePath As String
templatePath = swApp.GetUserPreferenceStringValue(9)  ' swDefaultTemplatePart

Dim swModel As ModelDoc2
Set swModel = swApp.NewDocument(templatePath, 0, 0, 0)

If swModel Is Nothing Then
    MsgBox "创建零件失败。请检查默认模板是否配置。", vbExclamation
End If`;
  return wrapMain(body);
}

/**
 * 创建新装配体。swDefaultTemplateAssembly = 10
 */
export function createAssembly(): string {
  const body = `${PRELUDE_APP_ONLY}

Dim templatePath As String
templatePath = swApp.GetUserPreferenceStringValue(10)  ' swDefaultTemplateAssembly

Dim swModel As ModelDoc2
Set swModel = swApp.NewDocument(templatePath, 0, 0, 0)

If swModel Is Nothing Then
    MsgBox "创建装配体失败。请检查默认模板是否配置。", vbExclamation
End If`;
  return wrapMain(body);
}

/**
 * 创建新工程图。swDefaultTemplateDrawing = 11
 * @param template 可选:自定义模板文件路径
 */
export function createDrawing(params?: { template?: string }): string {
  const { template } = params ?? {};
  const templateExpr = template
    ? vbaString(template)
    : "swApp.GetUserPreferenceStringValue(11)  ' swDefaultTemplateDrawing";

  const body = `${PRELUDE_APP_ONLY}

Dim templatePath As String
templatePath = ${templateExpr}

Dim swModel As ModelDoc2
Set swModel = swApp.NewDocument(templatePath, 0, 0, 0)

If swModel Is Nothing Then
    MsgBox "创建工程图失败。请检查模板路径。", vbExclamation
End If`;
  return wrapMain(body);
}
