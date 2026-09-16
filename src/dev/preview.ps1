$ErrorActionPreference = 'Stop'
$projectRoot = "$PSScriptRoot\..\.."
& code.cmd --new-window "--extensionDevelopmentPath=$projectRoot"
if ($LASTEXITCODE -ne 0) {
    throw "VS Code preview launch failed with exit code $LASTEXITCODE."
}
