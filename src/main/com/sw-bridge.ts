// src/main/com/sw-bridge.ts
//
// SolidWorks COM bridge layer.
/* eslint-disable no-useless-escape */
//
// COM operations run VBScript through `cscript.exe` (no native winax module).
//
// P4 fix (SW "not connected" while SolidWorks is clearly running):
// 1. `GetObject(, "SldWorks.Application")` alone fails on many installs where only the
//    version-suffixed ProgID is registered in the ROT (SW 2017–2026 = .25 … .34).
//    All scripts now attach via `AttachSW()`, which tries the bare ProgID first and
//    then every versioned ProgID.
// 2. When every ProgID fails but SLDWORKS.exe IS running, the usual cause is a UAC
//    integrity mismatch (one of the two apps runs elevated — the ROT refuses the
//    handshake). We detect the process via WMI and report `processRunning: true`
//    so the UI can show the real fix instead of "make sure SolidWorks is running".

import * as fs from 'fs';
import { exec } from 'child_process';
import type { SWDocumentType, SWStatus } from '../../shared/types';
import { writeVBSFile, safeUnlink } from './vbs-writer';

const VBS_TIMEOUT_MS = 15_000;

// Shared VBS helper: attach to a running SolidWorks via any registered ProgID.
// Returns Nothing when no attach succeeds (explicit, so `Is Nothing` works —
// a failed GetObject leaves the variable Empty, not Nothing).
const ATTACH_FN = `
Function AttachSW()
    On Error Resume Next
    Dim ids, i, o
    ids = Array("SldWorks.Application", _
        "SldWorks.Application.34", "SldWorks.Application.33", "SldWorks.Application.32", _
        "SldWorks.Application.31", "SldWorks.Application.30", "SldWorks.Application.29", _
        "SldWorks.Application.28", "SldWorks.Application.27", "SldWorks.Application.26", _
        "SldWorks.Application.25")
    For i = 0 To UBound(ids)
        Err.Clear
        Set o = GetObject(, ids(i))
        If Err.Number = 0 And IsObject(o) Then
            Set AttachSW = o
            Exit Function
        End If
    Next
    Err.Clear
    Set AttachSW = Nothing
End Function`;

type ConnCheck = 'ok' | 'proc' | 'fail';

export class SolidWorksBridge {
  private cachedStatus: SWStatus = { connected: false };
  private lastCheck = 0;
  private checkInterval = 3_000;

  /** Attach to an already-running instance — never starts a new process. */
  async connect(): Promise<boolean> {
    if (process.platform !== 'win32') {
      this.cachedStatus = { connected: false };
      return false;
    }
    const check = await this.checkConnection();
    this.cachedStatus =
      check === 'ok'
        ? await this.fetchStatus()
        : { connected: false, processRunning: check === 'proc' };
    this.lastCheck = Date.now();
    return check === 'ok';
  }

  disconnect(): void {
    this.cachedStatus = { connected: false };
    this.lastCheck = 0;
  }

  /** Fetch the real current document state (polled by the UI). */
  async refresh(): Promise<SWStatus> {
    if (process.platform !== 'win32') {
      this.cachedStatus = { connected: false };
      this.lastCheck = Date.now();
      return this.cachedStatus;
    }
    const check = await this.checkConnection();
    this.cachedStatus =
      check === 'ok'
        ? await this.fetchStatus()
        : { connected: false, processRunning: check === 'proc' };
    this.lastCheck = Date.now();
    return this.cachedStatus;
  }

  isConnected(): boolean {
    if (Date.now() - this.lastCheck < this.checkInterval) {
      return this.cachedStatus.connected;
    }
    this.checkConnection().then((check) => {
      if (check !== 'ok') {
        this.cachedStatus = { connected: false, processRunning: check === 'proc' };
        this.lastCheck = Date.now();
      }
    });
    return this.cachedStatus.connected;
  }

  getVersion(): string | undefined {
    return this.cachedStatus.version;
  }

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

  getStatus(): SWStatus {
    return this.cachedStatus;
  }

  getRawApp(): never {
    throw new Error('getRawApp() is no longer supported (cscript/VBS-based COM)');
  }

  async collectDocumentFeatures(): Promise<DocumentFeatures> {
    if (process.platform !== 'win32') return emptyFeatures();
    try {
      const vbs = buildCollectFeaturesVBS();
      const stdout = await runVBS(vbs);
      if (!stdout) return emptyFeatures();
      return JSON.parse(stdout);
    } catch {
      return emptyFeatures();
    }
  }

  /** P6: `docType` makes the post-backup reopen use the right document type (the old code effectively never restored — `OpenDoc7` is not a real API and the error was swallowed by On Error Resume Next) */
  async backupDocument(backupPath: string, originalPath?: string, docType?: SWDocumentType): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    const vbs = buildBackupVBS(backupPath, originalPath, docType);
    try {
      await runVBS(vbs);
      return fs.existsSync(backupPath);
    } catch {
      return false;
    }
  }

  // ===== Private =====

  /** 'ok' = attached · 'proc' = SLDWORKS.exe running but COM refused (UAC mismatch) · 'fail' = not running */
  private async checkConnection(): Promise<ConnCheck> {
    const vbs = `
On Error Resume Next
Dim swApp
Set swApp = AttachSW()
If Not swApp Is Nothing Then
    WScript.Echo "OK"
    WScript.Quit 0
End If
' COM attach failed — is SLDWORKS.exe actually running? (elevation mismatch symptom)
Dim wmi, procs
Err.Clear
Set wmi = GetObject("winmgmts:\\\\.\\root\\cimv2")
If Err.Number = 0 And IsObject(wmi) Then
    Set procs = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='SLDWORKS.exe'")
    If Err.Number = 0 Then
        If procs.Count > 0 Then
            WScript.Echo "PROC"
            WScript.Quit 0
        End If
    End If
End If
WScript.Echo "FAIL"
${ATTACH_FN}`;
    try {
      const stdout = await runVBS(vbs);
      if (stdout === 'OK') return 'ok';
      if (stdout === 'PROC') return 'proc';
      return 'fail';
    } catch {
      return 'fail';
    }
  }

  private async fetchStatus(): Promise<SWStatus> {
    const vbs = `
On Error Resume Next
Dim swApp, doc
Set swApp = AttachSW()
If swApp Is Nothing Then
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
    Dim i, c, cd, r
    If IsNull(s) Then J = "" : Exit Function
    r = ""
    For i = 1 To Len(CStr(s))
        c = Mid(CStr(s), i, 1)
        cd = AscW(c)
        If cd < 0 Then cd = cd + 65536
        If c = "\\" Then
            r = r & "\\\\"
        ElseIf c = """" Then
            r = r & "\\"""
        ElseIf cd < 32 Or cd > 126 Then
            r = r & "\\u" & Right("000" & Hex(cd), 4)
        Else
            r = r & c
        End If
    Next
    J = r
End Function
${ATTACH_FN}`;
    try {
      const stdout = await runVBS(vbs);
      if (!stdout) return { connected: true };
      return JSON.parse(stdout);
    } catch {
      // Keep `connected: true` so a brief VBS hiccup is not misread as a disconnect
      return { connected: true };
    }
  }
}

// ===== VBS executor =====

// P9: output transport is now plain stdout with PURE-ASCII content.
// History: raw stdout decoded as UTF-8 broke CJK (OEM codepage); //U (P8) broke the
// connection check on builds that ignore it for pipes; an FSO temp file (P8.1) is
// blocked by some AV products — Sub Out then dies silently, the script quits with
// empty output and the UI reports "not connected" even when COM attach SUCCEEDED.
// Final approach: never emit a non-ASCII byte. All strings are escaped to \uXXXX
// inside VBS (see J/EscapeJson); ASCII bytes are identical in every codepage, so a
// plain utf8 decode of the pipe is always correct. No //U, no temp file, no FSO.
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
Set swApp = AttachSW()
If swApp Is Nothing Then
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
        features = features & fName & "::" & fType & "::" & LCase(CStr(feat.IsSuppressed()))
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
            cSup = LCase(CStr(comp.IsSuppressed()))
            If Not IsNull(cName) And cName <> "" Then
                cFile = ""
                If Not IsNull(cPath) And cPath <> "" Then
                    arr = Split(cPath, "\\")
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
    Dim i, c, cd, r
    If IsNull(s) Or s = "" Then
        EscapeJson = ""
        Exit Function
    End If
    r = ""
    For i = 1 To Len(CStr(s))
        c = Mid(CStr(s), i, 1)
        cd = AscW(c)
        If cd < 0 Then cd = cd + 65536
        If c = "\\" Then
            r = r & "\\\\"
        ElseIf c = """" Then
            r = r & "\\"""
        ElseIf cd < 32 Or cd > 126 Then
            r = r & "\\u" & Right("000" & Hex(cd), 4)
        Else
            r = r & c
        End If
    Next
    EscapeJson = r
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
${ATTACH_FN}`;
}

function buildBackupVBS(backupPath: string, originalPath?: string, docType?: SWDocumentType): string {
  // P6: 文档类型不再硬编码为零件 —— 装配体/工程图备份后按正确类型重新打开
  const typeNum = docType === 'assembly' ? 2 : docType === 'drawing' ? 3 : 1;
  const restore = originalPath
    ? `\n' 恢复原文档（SaveAs3 会改变活动文档路径）\nswApp.OpenDoc "${originalPath}", ${typeNum}`
    : '';
  return `
On Error Resume Next
Dim swApp
Set swApp = AttachSW()
If swApp Is Nothing Then WScript.Quit 1
Err.Clear
Set doc = swApp.ActiveDoc
If doc Is Nothing Then WScript.Quit 1

doc.Extension.SaveAs3 "${backupPath}", 0, 1, "", "", 0, 0
If Err.Number <> 0 Then WScript.Quit 1${restore}
WScript.Quit 0
${ATTACH_FN}`;
}

// ===== Singleton =====

let instance: SolidWorksBridge | null = null;
export function getBridge(): SolidWorksBridge {
  if (!instance) instance = new SolidWorksBridge();
  return instance;
}
