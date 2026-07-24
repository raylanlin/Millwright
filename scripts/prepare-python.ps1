# scripts/prepare-python.ps1
# P11: 下载 Python embeddable 运行时 + 安装 pywin32，产物放到 vendor/python/。
# 本地打包和 CI 都在 electron-builder 之前跑一次。已存在则跳过（幂等）。
$ErrorActionPreference = "Stop"
$ver = "3.11.9"
$dest = "vendor/python"

if (Test-Path "$dest/python.exe") {
  if ((Test-Path "$dest/Lib/site-packages/win32com") -and (Test-Path "$dest/Lib/site-packages/PIL")) {
    Write-Host "vendor/python 已就绪，跳过"; exit 0
  }
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$zip = "$env:TEMP/python-embed.zip"
Write-Host "下载 Python $ver embeddable..."
Invoke-WebRequest "https://www.python.org/ftp/python/$ver/python-$ver-embed-amd64.zip" -OutFile $zip
Expand-Archive $zip -DestinationPath $dest -Force

# 启用 site-packages（embeddable 默认禁用）
$pth = Get-ChildItem "$dest/python*._pth" | Select-Object -First 1
(Get-Content $pth.FullName) -replace '^#\s*import site', 'import site' |
  ForEach-Object { $_ } | Set-Content $pth.FullName
Add-Content $pth.FullName "Lib\site-packages"

# 装 pip + pywin32
Write-Host "安装 pip + pywin32 + pillow..."
Invoke-WebRequest "https://bootstrap.pypa.io/get-pip.py" -OutFile "$env:TEMP/get-pip.py"
& "$dest/python.exe" "$env:TEMP/get-pip.py" --no-warn-script-location
& "$dest/python.exe" -m pip install pywin32 pillow --no-warn-script-location

# pywin32 的核心 DLL 要放到解释器旁边才能被找到（embeddable 不跑 postinstall）
Copy-Item "$dest/Lib/site-packages/pywin32_system32/*.dll" $dest -Force

# 验证
& "$dest/python.exe" -c "import win32com.client; import PIL; print('pywin32 + pillow OK')"
Write-Host "vendor/python 就绪（约 60MB）"
