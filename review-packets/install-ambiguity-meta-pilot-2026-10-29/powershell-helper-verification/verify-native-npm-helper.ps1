param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$FakeNpmPath,
  [Parameter(Mandatory = $true)][string]$WorkingDirectory
)

$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($InstallerPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'Could not parse the committed installer.' }
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-NpmCi' }, $true)
if (-not $definition) { throw 'Committed Invoke-NpmCi helper was not found.' }
$npm = Get-Command $FakeNpmPath -ErrorAction Stop
Invoke-Expression $definition.Extent.Text

$expectedPreference = $ErrorActionPreference
$expectedLocation = (Get-Location).Path
$env:FAKE_NPM_EXIT = '0'
Invoke-NpmCi $WorkingDirectory 'application'
if ($ErrorActionPreference -ne $expectedPreference) { throw 'ErrorActionPreference changed after npm exit 0.' }
if ((Get-Location).Path -ne $expectedLocation) { throw 'Working directory changed after npm exit 0.' }

$env:FAKE_NPM_EXIT = '23'
$failure = $null
try { Invoke-NpmCi $WorkingDirectory 'application' }
catch { $failure = $_.Exception.Message }
if ($failure -notmatch 'Pinned application dependency install failed \(exit 23\)') {
  throw "npm exit 23 did not propagate accurately: $failure"
}
if ($ErrorActionPreference -ne $expectedPreference) { throw 'ErrorActionPreference changed after npm exit 23.' }
if ((Get-Location).Path -ne $expectedLocation) { throw 'Working directory changed after npm exit 23.' }

Write-Output 'PASS: stderr with exit 0 was accepted.'
Write-Output 'PASS: stderr with exit 23 failed with exit 23.'
Write-Output 'PASS: ErrorActionPreference and working directory were restored after both outcomes.'
