$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$previewProfile = Join-Path ([System.IO.Path]::GetTempPath()) 'copilot-usage-mock-vscode'
$env:COPILOT_USAGE_PREVIEW = '1'
& code.cmd --new-window --disable-extensions "--extensionDevelopmentPath=$projectRoot" "--user-data-dir=$previewProfile"
if ($LASTEXITCODE -ne 0) {
    throw "VS Code preview launch failed with exit code $LASTEXITCODE."
}
