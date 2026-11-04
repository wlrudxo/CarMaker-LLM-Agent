$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot '..\dev-windows.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path $launcher).Path, [ref]$tokens, [ref]$parseErrors
)
if ($parseErrors.Count) { throw 'Launcher syntax errors' }

# Load only the shutdown function; never launch or stop the real app.
$stopFunction = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Stop-ProcessTree'
}, $true)
. ([scriptblock]::Create($stopFunction.Extent.Text))
function Start-Process {
    param($FilePath, $ArgumentList, [switch]$Wait, [switch]$PassThru, $WindowStyle)
    $script:captured = @($FilePath, $ArgumentList, $WindowStyle)
}
Stop-ProcessTree 424242
if ($captured[0] -ne 'taskkill.exe' -or $captured[1][1] -ne 424242 -or $captured[2] -ne 'Hidden') {
    throw 'Shutdown must target the requested process with a hidden helper'
}
Write-Output 'Launcher shutdown test passed (no process was stopped).'

$backendUrl = 'http://127.0.0.1:8010'
$electronAssignment = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
        $node.Left.Extent.Text -eq '$electronCmd'
}, $true)
. ([scriptblock]::Create($electronAssignment.Extent.Text))
$probeCmd = $electronCmd -replace 'npm run dev$', 'node -p "JSON.stringify([process.env.V3_FRONTEND_URL,process.env.V3_BACKEND_URL])"'
$urls = (& $env:ComSpec /d /s /c $probeCmd) | ConvertFrom-Json
if ($urls[0] -ne 'http://127.0.0.1:4173' -or $urls[1] -ne $backendUrl) {
    throw 'Launcher must not append spaces to Electron URLs'
}
Write-Output 'Launcher URL test passed (only a local Node probe was started).'
