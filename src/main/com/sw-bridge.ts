// src/main/com/sw-bridge.ts
//
// SolidWorks COM bridge layer.
/* eslint-disable no-useless-escape */
//
// COM operations are implemented by running VBScript through `cscript.exe`, removing the
// need for any native `winax` module. This works everywhere on Windows (cscript ships
// with the OS) and avoids native module build issues.
//
// Every COM call is dispatched by writing a temporary `.vbs` file and invoking
// `child_process.exec`; results come back over stdout.
//
// Key design points:
// 1. Every VBS call has a timeout guard (default 15 seconds) so a hung SolidWorks
//    instance cannot freeze the main process.
// 2. On non-Windows platforms we short-circuit and report "not connected"
//    without performing any work.
// 3. `getRawApp()` is no longer available (COM pointers cannot cross processes);
//    `context-collector` collects context via dedicated VBS scripts instead.

import * as fs from 'fs';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import * as path from 'path';
import { exec } from 'child_process';
import type { SWDocumentType, SWStatus } from '../../shared/types';
import { writeVBSFile, safeUnlink } from './vbs-writer';

const VBS_TIMEOUT_MS = 15_000;

export class SolidWorksBridge {
  private cachedStatus: SWStatus = { connected: false };
  private lastCheck = 0;
  private checkInterval = 3_000; // cached status is not refreshed within this window

  /**
   * Check whether SolidWorks is running.
   * Uses `GetObject` to attach to an already-running instance — never starts a new process.
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
   * FEATURE: fetch the real current document state (does not run the connection flow;
   * meant to be polled / called before each conversation turn).
   * Always fetches — the caller is responsible for throttling.
   */
  async refresh(): Promise<SWStatus> {
    if (process.platform !== 'win32') {
      this.cachedStatus = { connected: false };
      this.lastCheck = Date.now();
      return this.cachedStatus;
    }
    const connected = await this.checkConnection();
    this.cachedStatus = connected ? await this.fetchStatus() : { connected: false };
    this.lastCheck = Date.now();
    return this.cachedStatus;
  }

  /**
   * Heartbeat check — quickly tells whether SolidWorks is still alive.
   * Uses the cache to avoid spawning temp files too often.
   */
  isConnected(): boolean {
    if (Date.now() - this.lastCheck < this.checkInterval) {
      return this.cachedStatus.connected;
    }
    // Refresh asynchronously (do not block)
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

  /** No longer returns a COM object; returns document path and type info instead */
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

  /** Aggregated status */
  getStatus(): SWStatus {
    return this.cachedStatus;
  }

  /**
   * `getRawApp()` is no longer available — cscript cannot return COM pointers across processes.
   * `context-collector` and `backup` use dedicated VBS-based collection methods instead.
   */
  getRawApp(): never {
    throw new Error('getRawApp() is no longer supported (cscript/VBS-based COM)');
  }

  /**
   * Execute a VBS script that collects context info for the current document.
   * Returns JSON for `context-collector` to consume.
   */
  async collectDocumentFeatures(): Promise<DocumentFeatures> {
    if (process.platform !== 'win32') return emptyFeatures();
    // FIX-vbs-line47: any VBS failure is degraded to an empty feature context so the chat stream never breaks
    try {
      const vbs = buildCollectFeaturesVBS();
      const stdout = await runVBS(vbs);
      if (!stdout) return emptyFeatures();
      return JSON.parse(stdout);
    } catch {
      return emptyFeatures();
    }
  }

  /**
   * Execute a VBS script that backs up the current document.
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

  // ===== Private methods =====

  private async checkConnection(): Promise<boolean> {
    // Only use `GetObject` to attach to an already-running instance.
    // Never use `CreateObject` — that would spin up an invisible new SolidWorks process,
    // and every subsequent script would "succeed" against that hidden instance.
    // Note: when `GetObject` fails, `swApp` is `Empty` (not `Nothing`),
    // so we must check via `Err.Number` + `IsObject` instead of `Is Nothing`.
    const vbs = `
On Error Resume Next
Dim swApp
Set swApp = GetObject(, "SldWorks.Application")
If Err.Number = 0 And IsObject(swApp) Then
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
    // FEATURE: per-field error tolerance — any optional call failure must not blank out core fields;
    // `hasDoc` / `activeDocumentTitle` let the UI display the current document correctly (even when unsaved).
    // Note: variable names avoid VBScript reserved words (`dim`/`date`/`type`/etc.) — we use `dt`/`dtStr`/`dp`/`title`/`ver`.
    const vbs = `
On Error Resume Next
Dim swApp, doc
Set swApp = GetObject(, "SldWorks.Application")
If Err.Number <> 0 Or Not IsObject(swApp) Then
    WScript.Echo "{""connected"":false}"
    WScript.Quit 0
End If
Err.Clear

Dim ver
ver = swApp.RevisionNumber()
If Err.Number <> 0 Then ver = "" : Err.Clear

Set doc = swApp.ActiveDoc
If doc Is Nothing Then
    WScript.Echo "{""connected"":true,""hasDoc"":false,""version"":""" & J(ver) & """}"
    WScript.Quit 0
End If

Dim dt, dtStr, dp, title
dt = doc.GetType()
dtStr = ""
If dt = 1 Then dtStr = "part"
If dt = 2 Then dtStr = "assembly"
If dt = 3 Then dtStr = "drawing"

dp = doc.GetPathName()
If Err.Number <> 0 Then dp = "" : Err.Clear
If IsNull(dp) Then dp = ""

title = doc.GetTitle()
If Err.Number <> 0 Then title = "" : Err.Clear
If IsNull(title) Then title = ""

WScript.Echo "{""connected"":true,""hasDoc"":true,""version"":""" & J(ver) & """,""activeDocumentType"":""" & dtStr & """,""activeDocumentPath"":""" & J(dp) & """,""activeDocumentTitle"":""" & J(title) & """}"

Function J(s)
    If IsNull(s) Then J = "" : Exit Function
    J = Replace(Replace(Replace(CStr(s), "\", "\\"), """", "\"""), vbCrLf, "\n")
End Function`;
    try {
      const stdout = await runVBS(vbs);
      if (!stdout) return { connected: true };
      return JSON.parse(stdout);
    } catch {
      // Even if VBS fails, keep `connected: true` so the UI does not misread a brief VBS error as a disconnect
      return { connected: true };
    }
  }
}

// ===== VBS executor =====

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


// ===== VBS script generators =====

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
Dim swApp
Set swApp = GetObject(, "SldWorks.Application")
If Err.Number <> 0 Or Not IsObject(swApp) Then
    WScript.Echo "{}"
    WScript.Quit 0
End If
Err.Clear

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
        Set swDim = dispDim.GetDimension2(0)
        If Not swDim Is Nothing Then
            dName = swDim.FullName
            dVal = swDim.GetSystemValue3(1, Nothing)
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
  // VBS strings have no backslash escaping, so the path can be embedded directly (the legacy "\\\\" doubling is unnecessary)
  const restore = originalPath
    ? `\n' 恢复原文档（SaveAs3 会改变活动文档路径）\nswApp.OpenDoc7 "${originalPath}", "", 1, ""`
    : '';
  return `
On Error Resume Next
Dim swApp
Set swApp = GetObject(, "SldWorks.Application")
If Err.Number <> 0 Or Not IsObject(swApp) Then WScript.Quit 1
Err.Clear
Set doc = swApp.ActiveDoc
If doc Is Nothing Then WScript.Quit 1

doc.Extension.SaveAs3 "${backupPath}", 0, 1, "", "", 0, 0
If Err.Number <> 0 Then WScript.Quit 1${restore}
WScript.Quit 0`;
}

// ===== Singleton =====

let instance: SolidWorksBridge | null = null;
export function getBridge(): SolidWorksBridge {
  if (!instance) instance = new SolidWorksBridge();
  return instance;
}
