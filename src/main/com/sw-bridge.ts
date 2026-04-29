// src/main/com/sw-bridge.ts
//
// SolidWorks COM 桥接层。
//
// 通过 cscript.exe 运行 VBScript 实现 COM 操作，完全不依赖 winax 原生模块。
// 这样在 Windows 上总是可用（cscript 自带），且无需处理原生模块编译问题。
//
// 所有 COM 调用通过临时 .vbs 文件 + child_process.exec 执行，结果通过 stdout 回传。
//
// 关键设计:
// 1. 所有 VBS 调用有超时保护（默认 10 秒），防止 SolidWorks 无响应导致主进程卡死
// 2. 非 Windows 平台直接返回未连接，不执行任何操作
// 3. getRawApp() 不再可用（跨进程无法传递 COM 指针），context-collector 改用 VBS 采集

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import type { SWDocumentType, SWStatus } from '../../shared/types';
import { writeVBSFile, safeUnlink } from './vbs-writer';

const VBS_TIMEOUT_MS = 15_000;

export class SolidWorksBridge {
  private cachedStatus: SWStatus = { connected: false };
  private lastCheck = 0;
  private checkInterval = 3_000; // 3 秒内缓存状态不刷新

  /**
   * 检查 SolidWorks 是否正在运行。
   * 通过 GetObject 尝试连接到已有实例（不启动新进程）。
   */
  async connect(): Promise<boolean> {
    if (process.platform !== 'win32') {
      this.cachedStatus = { connected: false };
      return false;
    }

    const connected = await this.checkConnection();
    this.cachedStatus = connected
      ? await this.fetchStatus()
      : { connected: false };
    this.lastCheck = Date.now();
    return connected;
  }

  disconnect(): void {
    this.cachedStatus = { connected: false };
    this.lastCheck = 0;
  }

  /**
   * 心跳检查 —— 快速判断 SolidWorks 是否还活着。
   * 利用缓存避免频繁创建临时文件。
   */
  isConnected(): boolean {
    if (Date.now() - this.lastCheck < this.checkInterval) {
      return this.cachedStatus.connected;
    }
    // 异步刷新（不阻塞）
    this.checkConnection().then((ok) => {
      if (!ok) {
        this.cachedStatus = { connected: false };
        this.lastCheck = Date.now();
      }
    });
    return this.cachedStatus.connected;
  }

  getVersion(): string | undefined {
    return this.cachedStatus.version;
  }

  /** 不再返回 COM 对象，返回文档路径和类型信息 */
  getActiveDocumentInfo(): { path?: string; type: SWDocumentType } | null {
    return this.cachedStatus.connected
      ? {
          path: this.cachedStatus.activeDocumentPath,
          type: this.cachedStatus.activeDocumentType ?? null,
        }
      : null;
  }

  getDocumentType(): SWDocumentType {
    return this.cachedStatus.activeDocumentType ?? null;
  }

  getActiveDocumentPath(): string | undefined {
    return this.cachedStatus.activeDocumentPath;
  }

  /** 聚合状态 */
  getStatus(): SWStatus {
    return this.cachedStatus;
  }

  /**
   * getRawApp() 不再可用 —— cscript 跨进程无法返回 COM 指针。
   * context-collector 和 backup 改用专用的 VBS 采集方法。
   */
  getRawApp(): never {
    throw new Error('getRawApp() is no longer supported (cscript/VBS-based COM)');
  }

  /**
   * 执行 VBS 脚本采集当前文档的上下文信息。
   * 返回 JSON 给 context-collector 使用。
   */
  async collectDocumentFeatures(): Promise<DocumentFeatures> {
    if (process.platform !== 'win32') return emptyFeatures();

    const vbs = buildCollectFeaturesVBS();
    const stdout = await runVBS(vbs);
    if (!stdout) return emptyFeatures();
    try {
      return JSON.parse(stdout);
    } catch {
      return emptyFeatures();
    }
  }

  /**
   * 执行 VBS 脚本备份当前文档。
   */
  async backupDocument(backupPath: string, originalPath?: string): Promise<boolean> {
    if (process.platform !== 'win32') return false;

    const vbs = buildBackupVBS(backupPath, originalPath);
    try {
      await runVBS(vbs);
      return fs.existsSync(backupPath);
    } catch {
      return false;
    }
  }

  // ===== 私有方法 =====

  private async checkConnection(): Promise<boolean> {
    const vbs = `
On Error Resume Next
Set swApp = GetObject(, "SldWorks.Application")
If swApp Is Nothing Then Set swApp = CreateObject("SldWorks.Application")
If Not swApp Is Nothing Then
    WScript.Echo "OK"
Else
    WScript.Echo "FAIL"
End If`;
    try {
      const stdout = await runVBS(vbs);
      return stdout === 'OK';
    } catch {
      return false;
    }
  }

  private async fetchStatus(): Promise<SWStatus> {
    const vbs = `
On Error Resume Next
Set swApp = GetObject(, "SldWorks.Application")
If swApp Is Nothing Then Set swApp = CreateObject("SldWorks.Application")
If swApp Is Nothing Then
    WScript.Echo "{""connected"":false}"
    WScript.Quit 0
End If

Dim doc, docType, docPath, docTypeStr, ver
Set doc = swApp.ActiveDoc
ver = swApp.RevisionNumber()

If Not doc Is Nothing Then
    docType = doc.GetType()
    docPath = doc.GetPathName()
    If docPath = "" Or IsNull(docPath) Then docPath = "(未保存)"
    If docType = 1 Then docTypeStr = "part"
    If docType = 2 Then docTypeStr = "assembly"
    If docType = 3 Then docTypeStr = "drawing"
End If

WScript.Echo "{""connected"":true,""version"":""" & EscapeJson(ver) & """,""activeDocumentType"":""" & docTypeStr & """,""activeDocumentPath"":""" & EscapeJson(docPath) & """}"

Function EscapeJson(s)
    If IsNull(s) Or s = "" Then
        EscapeJson = ""
        Exit Function
    End If
    EscapeJson = Replace(Replace(Replace(s, "\", "\\"), """", "\"""), vbCrLf, "\n")
End Function`;
    try {
      const stdout = await runVBS(vbs);
      if (!stdout) return { connected: true };
      return JSON.parse(stdout);
    } catch {
      return { connected: true };
    }
  }
}

// ===== VBS 执行器 =====

function runVBS(scriptCode: string): Promise<string> {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('VBScript 仅支持 Windows'));
  }

  const scriptPath = writeVBSFile(scriptCode, 'sw_com');

  return new Promise<string>((resolve, reject) => {
    const cscriptPath =
      `${process.env.SYSTEMROOT || 'C:\\Windows'}\\System32\\cscript.exe`;
    exec(
      `"${cscriptPath}" //NoLogo "${scriptPath}"`,
      { timeout: VBS_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        safeUnlink(scriptPath);
        if (error) reject(error);
        else resolve(stdout.trim());
      },
    );
  });
}


// ===== VBS 脚本生成 =====

export interface DocumentFeatures {
  features: Array<{ name: string; type: string; suppressed: boolean }>;
  dimensions: Array<{ fullName: string; value: number }>;
  customProperties: Record<string, string>;
  components?: Array<{ name: string; fileName: string; suppressed: boolean }>;
  material?: string;
  activeConfiguration?: string;
}

function emptyFeatures(): DocumentFeatures {
  return { features: [], dimensions: [], customProperties: {} };
}

function buildCollectFeaturesVBS(): string {
  return `
On Error Resume Next
Set swApp = GetObject(, "SldWorks.Application")
If swApp Is Nothing Then Set swApp = CreateObject("SldWorks.Application")
If swApp Is Nothing Then
    WScript.Echo "{}"
    WScript.Quit 0
End If

Set doc = swApp.ActiveDoc
If doc Is Nothing Then
    WScript.Echo "{}"
    WScript.Quit 0
End If

' 采集基本信息
Dim docType, configName, matName
docType = doc.GetType()
configName = doc.ConfigurationManager.ActiveConfiguration.Name

' 采集特征
Dim features, fCount
features = ""
fCount = 0
Set feat = doc.FirstFeature()
Do While Not feat Is Nothing And fCount < 50
    fName = feat.Name
    fType = feat.GetTypeName2()
    ' 跳过系统特征
    If Not (fType = "OriginProfile" Or fType = "Reference" Or fName = "") Then
        If features <> "" Then features = features & "|"
        features = features & fName & "::" & fType & "::" & CStr(feat.IsSuppressed())
        fCount = fCount + 1
    End If
    Set feat = feat.GetNextFeature()
Loop

' 采集尺寸
Dim dims, dCount
dims = ""
dCount = 0
Set feat = doc.FirstFeature()
Do While Not feat Is Nothing And dCount < 30
    Set dispDim = feat.GetFirstDisplayDimension()
    Do While Not dispDim Is Nothing And dCount < 30
        Set dim = dispDim.GetDimension2(0)
        If Not dim Is Nothing Then
            dName = dim.FullName
            dVal = dim.GetSystemValue3(1, Nothing)
            If Not IsNull(dName) And Not IsNull(dVal) Then
                If dName <> "" Then
                    If dims <> "" Then dims = dims & "|"
                    dims = dims & dName & "::" & CStr(dVal * 1000)
                    dCount = dCount + 1
                End If
            End If
        End If
        Set dispDim = feat.GetNextDisplayDimension(dispDim)
    Loop
    Set feat = feat.GetNextFeature()
Loop

' 采集自定义属性
Dim props, pCount
props = ""
pCount = 0
Set mgr = doc.Extension.CustomPropertyManager("")
If Not mgr Is Nothing Then
    names = mgr.GetNames()
    If IsArray(names) Then
        For Each name In names
            If pCount >= 20 Then Exit For
            mgr.Get2 name, False, val, resolved
            pVal = resolved
            If pVal = "" Or IsNull(pVal) Then pVal = val
            If pVal <> "" And Not IsNull(pVal) Then
                If props <> "" Then props = props & "|"
                props = props & EscapeJson(name) & "::" & EscapeJson(pVal)
                pCount = pCount + 1
            End If
        Next
    End If
End If

' 材料（仅零件）
Dim material
If docType = 1 Then
    material = doc.GetMaterialPropertyName2("", "")
End If

' 装配体组件
Dim comps, cCount
comps = ""
cCount = 0
If docType = 2 Then
    Set components = doc.GetComponents(True)
    If IsArray(components) Then
        For Each comp In components
            If cCount >= 50 Then Exit For
            cName = comp.Name2
            cPath = comp.GetPathName()
            cSup = CStr(comp.IsSuppressed())
            If Not IsNull(cName) And cName <> "" Then
                cFile = ""
                If Not IsNull(cPath) And cPath <> "" Then
                    arr = Split(cPath, "\")
                    cFile = arr(UBound(arr))
                End If
                If comps <> "" Then comps = comps & "|"
                comps = comps & EscapeJson(cName) & "::" & EscapeJson(cFile) & "::" & cSup
                cCount = cCount + 1
            End If
        Next
    End If
End If

' 输出 JSON
WScript.Echo "{"
WScript.Echo """activeConfiguration"":""" & EscapeJson(configName) & ""","
WScript.Echo """material"":""" & EscapeJson(material) & ""","
WScript.Echo """features"":[" & FeaturesToJson(features) & "],"
WScript.Echo """dimensions"":[" & DimsToJson(dims) & "],"
WScript.Echo """customProperties"":{" & PropsToJson(props) & "},"
WScript.Echo """components"":[" & CompsToJson(comps) & "]"
WScript.Echo "}"

Function EscapeJson(s)
    If IsNull(s) Or s = "" Then
        EscapeJson = ""
        Exit Function
    End If
    EscapeJson = Replace(Replace(Replace(s, "\", "\\"), """", "\"""), vbCrLf, "\n")
End Function

Function FeaturesToJson(s)
    If s = "" Then FeaturesToJson = "": Exit Function
    Dim arr, i, parts, result
    arr = Split(s, "|")
    result = ""
    For i = 0 To UBound(arr)
        parts = Split(arr(i), "::")
        If result <> "" Then result = result & ","
        result = result & "{""name"":""" & EscapeJson(parts(0)) & """,""type"":""" & EscapeJson(parts(1)) & """,""suppressed"":" & parts(2) & "}"
    Next
    FeaturesToJson = result
End Function

Function DimsToJson(s)
    If s = "" Then DimsToJson = "": Exit Function
    Dim arr, i, parts, result
    arr = Split(s, "|")
    result = ""
    For i = 0 To UBound(arr)
        parts = Split(arr(i), "::")
        If result <> "" Then result = result & ","
        result = result & "{""fullName"":""" & EscapeJson(parts(0)) & """,""value"":" & parts(1) & "}"
    Next
    DimsToJson = result
End Function

Function PropsToJson(s)
    If s = "" Then PropsToJson = "{}": Exit Function
    Dim arr, i, parts, result
    arr = Split(s, "|")
    result = ""
    For i = 0 To UBound(arr)
        parts = Split(arr(i), "::")
        If result <> "" Then result = result & ","
        result = result & """" & parts(0) & """:""" & parts(1) & """"
    Next
    PropsToJson = result
End Function

Function CompsToJson(s)
    If s = "" Then CompsToJson = "": Exit Function
    Dim arr, i, parts, result
    arr = Split(s, "|")
    result = ""
    For i = 0 To UBound(arr)
        parts = Split(arr(i), "::")
        If result <> "" Then result = result & ","
        result = result & "{""name"":""" & parts(0) & """,""fileName"":""" & parts(1) & """,""suppressed"":" & parts(2) & "}"
    Next
    CompsToJson = result
End Function`;
}

function buildBackupVBS(backupPath: string, originalPath?: string): string {
  const escBackup = backupPath.replace(/\\/g, '\\\\');
  const restore = originalPath
    ? `\n' 恢复原文档（SaveAs3 会改变活动文档路径）\nswApp.OpenDoc7 \"${originalPath.replace(/\\/g, '\\\\')}\", \"\", 1, \"\"`
    : '';
  return `
On Error Resume Next
Set swApp = GetObject(, "SldWorks.Application")
If swApp Is Nothing Then Set swApp = CreateObject("SldWorks.Application")
If swApp Is Nothing Then WScript.Quit 1
Set doc = swApp.ActiveDoc
If doc Is Nothing Then WScript.Quit 1

doc.Extension.SaveAs3 "${escBackup}", 0, 1, "", "", 0, 0
If Err.Number <> 0 Then WScript.Quit 1${restore}
WScript.Quit 0`;
}

// ===== 单例 =====

let instance: SolidWorksBridge | null = null;
export function getBridge(): SolidWorksBridge {
  if (!instance) instance = new SolidWorksBridge();
  return instance;
}
