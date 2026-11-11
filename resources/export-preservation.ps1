param(
  [Parameter(Mandatory=$true)][ValidateSet('Backup','Restore')][string]$Phase,
  [Parameter(Mandatory=$true)][string]$InstallDirectory,
  [Parameter(Mandatory=$true)][string]$BackupDirectory,
  [string]$PreviousUserDirectory = '',
  [string]$PreviousMachineDirectory = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
# ASCII source keeps Windows PowerShell 5.1 independent of BOM and codepage.
$exportName = -join (@(0x5BFC,0x51FA,0x6587,0x4EF6) | ForEach-Object { [char]$_ })
function FullPath([string]$Path) {
  if (-not [IO.Path]::IsPathRooted($Path) -or $Path -notmatch '^[A-Za-z]:\\') { throw 'Expected a local absolute path' }
  return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}
function AssertPlainPath([string]$Path) {
  $current = $Path
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked paths are not supported' }
    }
    $current = [IO.Path]::GetDirectoryName($current)
  }
}
function ChildPath([string]$Root, [string]$Relative) {
  if ([string]::IsNullOrEmpty($Relative) -or [IO.Path]::IsPathRooted($Relative) -or $Relative.Contains(':')) { throw 'Invalid relative path' }
  $full = FullPath ([IO.Path]::Combine($Root, $Relative))
  if (-not $full.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escapes its root' }
  AssertPlainPath $full
  return $full
}
function HashFile([string]$Path) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
  finally { $hash.Dispose(); $stream.Dispose() }
}
function Entries([string]$Root) {
  if (-not (Test-Path -LiteralPath $Root)) { return }
  AssertPlainPath $Root
  if (-not [IO.Directory]::Exists($Root)) { throw 'Export root is not a directory' }
  $pending = New-Object 'Collections.Generic.Stack[string]'
  $pending.Push($Root)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($entry in @(Get-ChildItem -LiteralPath $directory -Force)) {
      if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked exports are not supported' }
      $relative = $entry.FullName.Substring($Root.Length + 1)
      if ($entry.PSIsContainer) {
        [PSCustomObject]@{ path=$relative; kind='directory' }
        $pending.Push($entry.FullName)
      } else {
        [PSCustomObject]@{ path=$relative; kind='file'; bytes=$entry.Length; sha256=(HashFile $entry.FullName); modified=$entry.LastWriteTimeUtc.ToString('o'); attributes=[int]$entry.Attributes }
      }
    }
  }
}
function VerifyEntries([string]$Root, $Expected) {
  $actual = @{}
  foreach ($entry in @(Entries $Root)) { $actual[$entry.path] = $entry }
  if ($actual.Count -ne @($Expected).Count) { throw 'Export tree changed during preservation' }
  foreach ($entry in @($Expected)) {
    $value = $actual[$entry.path]
    if ($null -eq $value -or $value.kind -ne $entry.kind) { throw 'Export entry mismatch' }
    if ($entry.kind -eq 'file' -and ($value.sha256 -cne $entry.sha256 -or $value.bytes -ne $entry.bytes)) { throw 'Export hash mismatch' }
  }
}
try {
  $install = FullPath $InstallDirectory
  $backup = FullPath $BackupDirectory
  AssertPlainPath $install
  AssertPlainPath $backup
  if ($backup.Equals($install,[StringComparison]::OrdinalIgnoreCase) -or $backup.StartsWith($install+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Backup must be outside installation directory' }
  $contents = [IO.Path]::Combine($backup,'files')
  $manifestPath = [IO.Path]::Combine($backup,'manifest.json')
  if ($Phase -eq 'Backup') {
    if (Test-Path -LiteralPath $backup) { throw 'Backup already exists' }
    [void][IO.Directory]::CreateDirectory($contents)
    $sources = @{}
    foreach ($location in @($install,$PreviousUserDirectory,$PreviousMachineDirectory)) {
      if ([string]::IsNullOrWhiteSpace($location)) { continue }
      $root = [IO.Path]::Combine((FullPath $location),$exportName)
      if ($backup.StartsWith((FullPath $location)+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Backup overlaps a previous installation' }
      if (-not $sources.ContainsKey($root)) { $sources[$root] = @(Entries $root) }
    }
    $merged = @{}
    $hasExports = $false
    foreach ($root in @($sources.Keys)) {
      if ([IO.Directory]::Exists($root)) { $hasExports = $true }
      foreach ($entry in $sources[$root]) {
        if ($merged.ContainsKey($entry.path)) {
          $previous = $merged[$entry.path]
          if ($previous.kind -ne $entry.kind -or ($entry.kind -eq 'file' -and $previous.sha256 -cne $entry.sha256)) { throw 'Conflicting exports in different installations' }
          continue
        }
        $destination = ChildPath $contents $entry.path
        if ($entry.kind -eq 'directory') { [void][IO.Directory]::CreateDirectory($destination) }
        else {
          [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
          [IO.File]::Copy((ChildPath $root $entry.path),$destination,$false)
          if ((HashFile $destination) -cne $entry.sha256) { throw 'Backup hash mismatch' }
        }
        $merged[$entry.path] = $entry
      }
    }
    foreach ($root in @($sources.Keys)) { VerifyEntries $root $sources[$root] }
    $manifest = @{ schema=1; installDirectory=$install; hasExports=$hasExports; entries=@($merged.Values) }
    [IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding($false)))
    Write-Output 'backup_verified'
  } else {
    $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    if ($manifest.schema -ne 1 -or -not $install.Equals($manifest.installDirectory,[StringComparison]::OrdinalIgnoreCase)) { throw 'Backup belongs to another installation' }
    VerifyEntries $contents @($manifest.entries)
    if ($manifest.hasExports) {
      $targetRoot = [IO.Path]::Combine($install,$exportName)
      AssertPlainPath $targetRoot
      [void][IO.Directory]::CreateDirectory($targetRoot)
      foreach ($entry in @($manifest.entries)) {
        $destination = ChildPath $targetRoot $entry.path
        if ($entry.kind -eq 'directory') { [void][IO.Directory]::CreateDirectory($destination); continue }
        if (Test-Path -LiteralPath $destination) {
          if ((HashFile $destination) -cne $entry.sha256) { throw 'Refusing to overwrite an existing export' }
        } else {
          [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
          [IO.File]::Copy((ChildPath $contents $entry.path),$destination,$false)
        }
        if ((HashFile $destination) -cne $entry.sha256) { throw 'Restored export hash mismatch' }
        [IO.File]::SetLastWriteTimeUtc($destination,[DateTime]::Parse($entry.modified).ToUniversalTime())
        [IO.File]::SetAttributes($destination,[IO.FileAttributes]$entry.attributes)
      }
      foreach ($entry in @($manifest.entries)) {
        $path = ChildPath $targetRoot $entry.path
        if ($entry.kind -eq 'file' -and (HashFile $path) -cne $entry.sha256) { throw 'Final export verification failed' }
      }
    }
    [IO.File]::WriteAllText([IO.Path]::Combine($backup,'restored.ok'),[DateTime]::UtcNow.ToString('o'))
    Write-Output 'restore_verified_backup_retained'
  }
  exit 0
} catch {
  # Never remove the original exports or any partial/verified backup.
  Write-Output ('export_preservation_failed: ' + $_.Exception.Message)
  exit 21
}
