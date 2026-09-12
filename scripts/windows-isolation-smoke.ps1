# Exercise only two uniquely named profiles and processes started by this script.
# No downloads, no user document writes, and no process-name based termination.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [string]$OutputDirectory = (Join-Path ([IO.Path]::GetTempPath()) ('markwrite-isolation-' + [guid]::NewGuid().ToString('N')))
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Executable = (Resolve-Path -LiteralPath $Executable).Path
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Smoke output directory must be new; existing files will not be modified' }
$null = New-Item -ItemType Directory -Path $OutputDirectory
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MarkwriteIsolationWindow {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
}
'@
$utf8 = [Text.UTF8Encoding]::new($false)
$launched = [Collections.Generic.List[Diagnostics.Process]]::new()
$cases = @()
function Start-Isolated($case, $restore = $false) {
  $launchArguments = '--markwrite-window {0} -- "{1}"' -f $case.Id, $case.Path
  if ($restore) { $launchArguments = '--markwrite-window {0} --' -f $case.Id }
  $process = Start-Process -FilePath $Executable -ArgumentList $launchArguments -PassThru
  $launched.Add($process)
  return $process
}
function Wait-Window($process, $name) {
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while ([DateTime]::UtcNow -lt $deadline) {
    $process.Refresh()
    if ($process.HasExited) { throw "Process $($process.Id) exited before displaying $name (exit $($process.ExitCode))" }
    if ($process.MainWindowHandle -ne [IntPtr]::Zero -and $process.MainWindowTitle -ceq "$name — Markwrite") { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Process $($process.Id) did not show document title $name; got '$($process.MainWindowTitle)'"
}
function Get-ComparableDocumentPath([string]$filePath) {
  # Rust canonicalize emits extended Windows paths; preserve UNC server/share roots.
  if ($filePath.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
    $filePath = '\\' + $filePath.Substring(8)
  } elseif ($filePath.StartsWith('\\?\', [StringComparison]::Ordinal)) {
    $filePath = $filePath.Substring(4)
  }
  return [IO.Path]::GetFullPath($filePath)
}
function Read-Session($case) {
  try {
    $value = Get-Content -LiteralPath $case.Session -Raw -Encoding utf8 | ConvertFrom-Json
    $expectedPath = Get-ComparableDocumentPath $case.Path
    $document = @($value.docs | Where-Object {
      [string]::Equals((Get-ComparableDocumentPath $_.path), $expectedPath, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($document.Count -eq 1 -and $document[0].content -ceq $case.Content -and $document[0].saved -ceq $case.Content) { return $value }
  } catch { }
  return $null
}
function Wait-Session($case) {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $deadline) {
    $value = Read-Session $case
    if ($null -ne $value) { return $value }
    Start-Sleep -Milliseconds 250
  }
  throw "The correct document was not persisted to independent session $($case.Session)"
}
function Close-Normally($process) {
  $process.Refresh()
  if ($process.HasExited -or $process.MainWindowHandle -eq [IntPtr]::Zero) { throw 'Cannot request close on an exited or windowless process' }
  if (-not [MarkwriteIsolationWindow]::PostMessage($process.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Native WM_CLOSE request failed' }
  if (-not $process.WaitForExit(20000)) { throw "Native close did not exit process $($process.Id)" }
  if ($process.ExitCode -ne 0) { throw "Normal close returned $($process.ExitCode)" }
}
try {
  foreach ($label in @('A', 'B')) {
    $id = [guid]::NewGuid().ToString('N')
    $name = "$label 中文 document with spaces.md"
    $path = Join-Path $OutputDirectory $name
    $content = "# Independent window $label`r`n`r`nOriginal UTF-8 document 中文. Never save during this read-only test.`r`n"
    [IO.File]::WriteAllText($path, $content, $utf8)
    $profileDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "app.markwrite.desktop.window.w$id"
    if (Test-Path -LiteralPath $profileDirectory) { throw 'Generated profile already exists; refusing reuse' }
    $null = New-Item -ItemType Directory -Path $profileDirectory
    [IO.File]::WriteAllText((Join-Path $profileDirectory 'window-settings.json'), '{"language":"en","defaultMode":"read","autosave":false,"followFileParent":false}', $utf8)
    $case = [pscustomobject]@{ Id = $id; Name = $name; Path = $path; Content = $content.Replace("`r`n", "`n"); Profile = $profileDirectory; Session = (Join-Path $profileDirectory 'session.json'); Hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash; Modified = (Get-Item -LiteralPath $path).LastWriteTimeUtc.Ticks; Process = $null }
    $case.Process = Start-Isolated $case
    $cases += $case
    Wait-Window $case.Process $name
    $null = Wait-Session $case
  }
  if ($cases[0].Process.Id -eq $cases[1].Process.Id) { throw 'Both windows share a process' }
  # Stop only the exact process object returned by our Start-Process call.
  $cases[0].Process.Kill()
  if (-not $cases[0].Process.WaitForExit(10000)) { throw 'Test process A did not terminate' }
  $aBefore = [IO.File]::ReadAllBytes($cases[0].Session)
  $cases[1].Process.Refresh()
  if ($cases[1].Process.HasExited) { throw 'Terminating A also terminated B' }
  Wait-Window $cases[1].Process $cases[1].Name
  Close-Normally $cases[1].Process
  $null = Wait-Session $cases[1]
  if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($cases[0].Session)) -cne [Convert]::ToBase64String($aBefore)) { throw 'B modified A recovery data' }
  $reopened = @()
  foreach ($case in $cases) {
    $process = Start-Isolated $case $true
    $reopened += $process.Id
    Wait-Window $process $case.Name
    $null = Wait-Session $case
    Close-Normally $process
    if ((Get-FileHash -LiteralPath $case.Path -Algorithm SHA256).Hash -cne $case.Hash -or (Get-Item -LiteralPath $case.Path).LastWriteTimeUtc.Ticks -ne $case.Modified) { throw 'Reading changed original file bytes or modification time' }
    Copy-Item -LiteralPath $case.Session -Destination (Join-Path $OutputDirectory "$($case.Id)-session.json")
  }
  $result = [ordered]@{ passed = $true; test = 'installed-windows-independent-processes'; firstPids = @($cases | ForEach-Object { $_.Process.Id }); reopenedPids = $reopened; killedPid = $cases[0].Process.Id; survivorClosedNormally = $true; documentTitlesVerified = $true; bothSessionsRetained = $true; sourceHashesAndMtimesUnchanged = $true; profilePaths = @($cases | ForEach-Object { $_.Profile }); scope = 'Actual installed executable and native windows, separate CLI profiles; Linux smoke additionally covers real typed draft recovery.' }
  $result | ConvertTo-Json -Depth 8 | Tee-Object -FilePath (Join-Path $OutputDirectory 'result.json')
} finally {
  foreach ($process in $launched) {
    $process.Refresh()
    if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(10000) }
  }
  # Keep disposable profiles and snapshots for debugging; never remove user profiles.
}
