; build/installer.nsh — P129: NSIS hooks that make install / upgrade / uninstall leave nothing behind.
;
; electron-builder includes this file into its NSIS script and calls the macros below.
; Everything here addresses a concrete complaint from the v0.2.x installer era:
;
;   1. Upgrades failed with "cannot write file" — a sidecar python.exe (or Millwright.exe after a
;      crash) still held resources/python/*.dll. customInit stops those processes first, but ONLY
;      the ones running from our install dir — never a user's own Python.
;   2. Two entries in Programs and Features after the SW Copilot → Millwright rename (appId
;      changed com.swcopilot.app → com.millwright.app). customInit runs the old uninstaller
;      silently and removes its key.
;   3. Uninstall left %APPDATA%\Millwright (settings, chat history), %LOCALAPPDATA% caches, and
;      %TEMP% scratch. customUnInstall removes the caches/scratch always and ASKS about user data.
;
; All shell work goes through PowerShell via nsExec (bundled with NSIS); no extra plugins.

!macro _StopOurProcesses
  ; Stop Millwright.exe and any python.exe / cscript.exe whose executable OR command line points at $INSTDIR.
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "\
    $$d = [regex]::Escape(\"$INSTDIR\"); \
    Get-CimInstance Win32_Process | Where-Object { ($$_.Name -in @(\"Millwright.exe\",\"python.exe\",\"pythonw.exe\",\"cscript.exe\")) -and (($$_.ExecutablePath -match $$d) -or ($$_.CommandLine -match $$d)) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; \
    Start-Sleep -Milliseconds 800"'
  Pop $0
!macroend

!macro customInit
  ; --- 1. make the install dir writable: stop anything of ours that is still running
  ${If} ${FileExists} "$INSTDIR\Millwright.exe"
    !insertmacro _StopOurProcesses
  ${EndIf}

  ; --- 2. retire the pre-rename install (SW Copilot, appId com.swcopilot.app)
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.swcopilot.app" "UninstallString"
  ${If} $0 != ""
    ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.swcopilot.app" "InstallLocation"
    DetailPrint "Removing the previous 'SW Copilot' installation..."
    ExecWait '$0 /S _?=$1'
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.swcopilot.app"
    ${If} $1 != ""
      RMDir /r "$1"
    ${EndIf}
  ${EndIf}
  ; a per-machine install of the old name, if it ever existed
  ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.swcopilot.app" "UninstallString"
  ${If} $0 != ""
    ExecWait '$0 /S'
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.swcopilot.app"
  ${EndIf}

  ; --- 3. scratch left by earlier versions (harmless, but it is ours — clean it)
  RMDir /r "$TEMP\Millwright-update"
  RMDir /r "$TEMP\millwright-backups"
!macroend

!macro customInstall
  ; the zip-era users extracted anywhere; nothing to migrate — settings already live in %APPDATA%\Millwright.
  ; Remove stale Python bytecode caches so an upgrade never runs old .pyc against new .py.
  RMDir /r "$INSTDIR\resources\sidecar\sw_agent\__pycache__"
  RMDir /r "$INSTDIR\resources\sidecar\sw_agent\tools\__pycache__"
!macroend

!macro customUnInit
  !insertmacro _StopOurProcesses
!macroend

!macro customUnInstall
  ; always: caches and scratch (regenerated on next run, never user data)
  RMDir /r "$LOCALAPPDATA\millwright-updater"
  RMDir /r "$LOCALAPPDATA\Millwright"
  RMDir /r "$TEMP\Millwright-update"
  RMDir /r "$TEMP\millwright-backups"
  RMDir /r "$TEMP\gen_py"
  Delete "$TEMP\sw_vbs_*.vbs"
  Delete "$TEMP\sw_com_*.vbs"
  Delete "$TEMP\sw_macro_*.vbs"
  Delete "$TEMP\sw_result_*.json"
  Delete "$TEMP\sw_script_*.py"
  Delete "$TEMP\millwright-crash.log"
  ; leftover bytecode makes RMDir of $INSTDIR fail silently → orphaned folder
  RMDir /r "$INSTDIR\resources\sidecar"
  RMDir /r "$INSTDIR\resources\python"

  ; ask: settings (API key), chat history, session logs
  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "同时删除 Millwright 的设置、API Key 与对话历史？$\r$\n(Also remove settings, API key and chat history?)$\r$\n$\r$\n选“否”保留数据，重新安装后可继续使用。" \
      IDYES removeData IDNO keepData
    removeData:
      RMDir /r "$APPDATA\Millwright"
      RMDir /r "$APPDATA\millwright"
      RMDir /r "$APPDATA\SW Copilot"
      RMDir /r "$APPDATA\sw-copilot"
    keepData:
  ${EndIf}
!macroend
