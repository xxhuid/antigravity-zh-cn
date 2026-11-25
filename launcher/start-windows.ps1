param(
  [string]$AppPath = "",
  [int]$Port = 9222,
  [switch]$CreateShortcut,
  [switch]$Rebuild
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$LauncherJs = Join-Path $PSScriptRoot "launch.mjs"

if ($CreateShortcut) {
  $Desktop = [Environment]::GetFolderPath("Desktop")
  $ShortcutPath = Join-Path $Desktop "Antigravity (中文版).lnk"
  $WshShell = New-Object -ComObject WScript.Shell
  $Shortcut = $WshShell.CreateShortcut($ShortcutPath)
  $Shortcut.TargetPath = "powershell.exe"
  $Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
  $Shortcut.WorkingDirectory = $RepoRoot
  $Shortcut.Description = "Launch Google Antigravity with Chinese / Multi-Language UI"
  $Shortcut.Save()
  Write-Host "[OK] 已在桌面创建快捷方式: $ShortcutPath" -ForegroundColor Green
  exit 0
}

$NodeArgs = @($LauncherJs, "--port", "$Port")
if ($AppPath -ne "") {
  $NodeArgs += @("--app", $AppPath)
}
if ($Rebuild) {
  $NodeArgs += "--rebuild"
}

& node @NodeArgs
