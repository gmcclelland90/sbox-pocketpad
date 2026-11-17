# Copies the PocketPad s&box library into a game project's Libraries folder.
#   powershell -ExecutionPolicy Bypass -File tools\install-library.ps1 -Project "C:\path\to\mygame"
param(
    [Parameter(Mandatory = $true)][string]$Project
)
$ErrorActionPreference = "Stop"
$source = Join-Path $PSScriptRoot "..\sbox"
$projectPath = (Resolve-Path -LiteralPath $Project).Path
if (-not (Get-ChildItem -LiteralPath $projectPath -Filter *.sbproj -File)) {
    throw "No .sbproj found in $projectPath. Point -Project at your s&box project folder."
}
$target = Join-Path $projectPath "Libraries\pocketpad"
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $source "pocketpad.sbproj") -Destination $target
Copy-Item -LiteralPath (Join-Path $source "Code") -Destination $target -Recurse
Write-Host "PocketPad library copied to $target"
