$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$targetScript = Join-Path $PSScriptRoot 'start_bot.ps1'
$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath 'AI-Plantgraphy3 Bot.lnk'
$workingDirectory = Join-Path $repoRoot 'bot'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = (Get-Command powershell.exe).Source
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$targetScript`""
$shortcut.WorkingDirectory = $workingDirectory
$shortcut.IconLocation = "$([System.Environment]::SystemDirectory)\\shell32.dll,70"
$shortcut.Save()

Write-Output "Created shortcut: $shortcutPath"
