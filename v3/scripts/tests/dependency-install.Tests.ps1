param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot '..\dev-windows.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path $launcher).Path, [ref]$tokens, [ref]$parseErrors
)
if ($parseErrors.Count) { throw 'Launcher syntax errors' }
$ensureFunction = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Ensure-PythonPackage'
}, $true)
. ([scriptblock]::Create($ensureFunction.Extent.Text))
function Write-Info($Message) {}
function Start-Process {
    param($FilePath, $ArgumentList, $WorkingDirectory, [switch]$Wait,
          [switch]$PassThru, $WindowStyle, [switch]$NoNewWindow)
    $script:Calls.Add(($ArgumentList -join ' '))
    if ($script:ExitCodes.Count -eq 0) { throw 'Unexpected process request' }
    return [pscustomobject]@{ ExitCode = $script:ExitCodes.Dequeue() }
}

$runDirectory = Join-Path $OutputDirectory ([Guid]::NewGuid().ToString('N'))
$cases = @(
    @{ Name='unchanged'; Ready=0; Install=$false; Missing=$false; Changed=$false; Pip=0; Verify=0; Fails=$false },
    @{ Name='changed'; Ready=0; Install=$true; Missing=$false; Changed=$true; Pip=0; Verify=0; Fails=$false },
    @{ Name='missing-stamp'; Ready=0; Install=$true; Missing=$true; Changed=$false; Pip=0; Verify=0; Fails=$false },
    @{ Name='import-failed'; Ready=1; Install=$true; Missing=$false; Changed=$false; Pip=0; Verify=0; Fails=$false },
    @{ Name='pip-failed'; Ready=0; Install=$true; Missing=$false; Changed=$true; Pip=1; Verify=0; Fails=$true },
    @{ Name='verify-failed'; Ready=0; Install=$true; Missing=$false; Changed=$true; Pip=0; Verify=1; Fails=$true }
)
foreach ($case in $cases) {
    $script:PythonApiDir = Join-Path $runDirectory $case.Name
    New-Item -ItemType Directory -Path $PythonApiDir -Force | Out-Null
    $project = Join-Path $PythonApiDir 'pyproject.toml'
    $stamp = Join-Path $PythonApiDir '.editable-install.stamp'
    Set-Content $project '[project]' -Encoding UTF8
    if (-not $case.Missing) {
        Set-Content $stamp 'original-stamp' -Encoding UTF8
        (Get-Item $stamp).LastWriteTimeUtc = [DateTime]::UtcNow.AddHours(-1)
    }
    (Get-Item $project).LastWriteTimeUtc = [DateTime]::UtcNow.AddHours($(if ($case.Changed) { 0 } else { -2 }))
    $script:Calls = New-Object 'System.Collections.Generic.List[string]'
    $script:ExitCodes = New-Object 'System.Collections.Generic.Queue[int]'
    $ExitCodes.Enqueue($case.Ready)
    if ($case.Install) { $ExitCodes.Enqueue($case.Pip); $ExitCodes.Enqueue($case.Verify) }
    $failed = $false
    try { Ensure-PythonPackage 'fake-python.exe' } catch { $failed = $true }
    if ($failed -ne $case.Fails) { throw "$($case.Name): unexpected success/failure" }
    $pipCalls = @($Calls | Where-Object { $_ -match 'pip install' }).Count
    if ($pipCalls -ne [int]$case.Install) { throw "$($case.Name): install decision mismatch" }
    if ($case.Fails -or -not $case.Install) {
        if ((Get-Content $stamp -Raw).Trim() -ne 'original-stamp') { throw "$($case.Name): failed/skipped install changed stamp" }
    } else {
        if ((Get-Content $stamp -Raw).Trim() -eq 'original-stamp') { throw "$($case.Name): successful install did not stamp" }
        if ($Calls.Count -ne 3) { throw "$($case.Name): install must be verified before stamping" }
    }
    Write-Output "PASS $($case.Name) (all processes mocked)"
}
