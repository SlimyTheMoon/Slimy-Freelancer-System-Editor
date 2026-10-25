# Freelancer mod installer - made by the Freelancer System Editor.
# Works with Windows PowerShell 5.1 (Windows 10/11) and PowerShell 7.
#   install.cmd   [Freelancer folder]   install the mod (backs up every file it replaces)
#   uninstall.cmd [Freelancer folder]   put every file back exactly as it was
#   check.cmd     [Freelancer folder]   only report what installing would do
# Backups and the install record live in <Freelancer>\mod_backups\<mod id>\.
param(
  [ValidateSet('install', 'uninstall', 'check')][string]$Action = 'install',
  [string]$GameDir = '',
  [switch]$Force,
  [switch]$Yes
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$mod = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $here 'mod.json') | ConvertFrom-Json
$sep = [IO.Path]::DirectorySeparatorChar

function Say([string]$t, [string]$c = 'Gray') { Write-Host $t -ForegroundColor $c }
function PathIn([string]$root, [string]$rel) { return [IO.Path]::Combine($root, ($rel -replace '[\\/]', $sep)) }
function HashOf([string]$p) { if (Test-Path -LiteralPath $p -PathType Leaf) { return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() } return $null }
function IsFL([string]$d) { return $d -and (Test-Path -LiteralPath (PathIn $d 'EXE/Freelancer.exe')) -and (Test-Path -LiteralPath (PathIn $d 'DATA')) }
function Ask([string]$q) { if ($Yes) { return $true }; $a = Read-Host "$q [y/N]"; return ($a -match '^(y|yes|j|ja)$') }

function FindFreelancer {
  if ($GameDir) {
    if (IsFL $GameDir) { return (Resolve-Path -LiteralPath $GameDir).Path }
    throw "This is not a Freelancer folder (no EXE\Freelancer.exe and DATA): $GameDir"
  }
  $cands = New-Object System.Collections.ArrayList
  # the package unpacked inside (or next to) the Freelancer folder
  $p = $here; for ($i = 0; $i -lt 4 -and $p; $i++) { [void]$cands.Add($p); $p = Split-Path -Parent $p }
  foreach ($k in 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Microsoft Games\Freelancer\1.0', 'HKLM:\SOFTWARE\Microsoft\Microsoft Games\Freelancer\1.0') {
    try { $v = (Get-ItemProperty -Path $k -ErrorAction Stop).AppPath; if ($v) { [void]$cands.Add($v); [void]$cands.Add((Split-Path -Parent $v)) } } catch { }
  }
  foreach ($d in @("${env:ProgramFiles(x86)}\Microsoft Games\Freelancer", "$env:ProgramFiles\Microsoft Games\Freelancer", "C:\Games\Freelancer", "C:\Freelancer",
                   "$env:USERPROFILE\Desktop\Freelancer HD Edition", "C:\Freelancer HD Edition", "C:\Games\Freelancer HD Edition", "$env:LOCALAPPDATA\Freelancer HD Edition")) { [void]$cands.Add($d) }
  foreach ($d in $cands) { if (IsFL $d) { return (Resolve-Path -LiteralPath $d).Path } }
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = 'Select your Freelancer folder (the one that contains DATA and EXE)'
    if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK -and (IsFL $dlg.SelectedPath)) { return $dlg.SelectedPath }
  } catch { }
  throw 'Freelancer folder not found. Run it with the folder, e.g.:  install.cmd "C:\Games\Freelancer"'
}

function RemoveEmptyBackupDir([string]$fl) {
  $d = PathIn $fl 'mod_backups'
  if ((Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $d -Force }
}

function GameRunning {
  $p = Get-Process -Name 'Freelancer', 'FLServer' -ErrorAction SilentlyContinue
  return [bool]$p
}

# what installing would do with every file
function Plan([string]$fl) {
  $out = @()
  foreach ($f in $mod.files) {
    $dst = PathIn $fl $f.path
    $cur = HashOf $dst
    if (-not $cur) { if ($f.original) { $st = 'missing' } else { $st = 'add' } }
    elseif ($cur -eq $f.sha256) { $st = 'same' }
    elseif (-not $f.original) { $st = 'exists' }
    elseif ($cur -eq $f.original) { $st = 'replace' }
    else { $st = 'changed' }
    $out += [pscustomobject]@{ path = $f.path; status = $st; current = $cur; target = $f.sha256 }
  }
  return $out
}

function ShowPlan($plan) {
  $groups = $plan | Group-Object status
  foreach ($g in $groups) {
    $label = @{ add = 'new files'; replace = 'files replaced (as expected)'; same = 'already up to date'; changed = 'files that differ from the version this mod was made for'; missing = 'files the mod expects but your game does not have'; exists = 'files the mod adds that already exist' }[$g.Name]
    $col = 'Gray'; if ($g.Name -in @('changed', 'missing', 'exists')) { $col = 'Yellow' }
    Say ("  {0,4}  {1}" -f $g.Count, $label) $col
    if ($g.Name -in @('changed', 'missing', 'exists')) { foreach ($x in ($g.Group | Select-Object -First 12)) { Say ("          " + $x.path) 'DarkYellow' }; if ($g.Count -gt 12) { Say ("          ... and {0} more" -f ($g.Count - 12)) 'DarkYellow' } }
  }
}

function DoInstall([string]$fl) {
  $bk = PathIn $fl ("mod_backups/" + $mod.id); $recPath = PathIn $bk 'install.json'
  if (Test-Path -LiteralPath $recPath) {
    $prev = Get-Content -Raw -Encoding UTF8 -LiteralPath $recPath | ConvertFrom-Json
    if (-not $Force) { throw ("{0} {1} is already installed (since {2}). Run uninstall.cmd first, or install.cmd with -Force to reinstall." -f $prev.name, $prev.version, $prev.installed) }
    # reinstall: put the originals back first, so the backups stay the true originals
    Say ("Reinstalling: removing {0} {1} first." -f $prev.name, $prev.version) 'Cyan'
    $saveYes = $script:Yes; $script:Yes = $true; try { DoUninstall $fl } finally { $script:Yes = $saveYes }
  }
  $plan = Plan $fl
  Say ''; Say 'What will happen:' 'Cyan'; ShowPlan $plan
  $odd = @($plan | Where-Object { $_.status -in @('changed', 'missing', 'exists') })
  if ($odd.Count -gt 0) {
    Say ''
    Say 'Some files are not the ones this mod was made for (another mod, an update or a different Freelancer version).' 'Yellow'
    Say 'Installing replaces them anyway; uninstall puts them back exactly. The mod may not work as intended.' 'Yellow'
    if (-not (Ask 'Install anyway?')) { Say 'Nothing was changed.' 'Green'; return }
  } elseif (-not (Ask ("Install {0} {1}?" -f $mod.name, $mod.version))) { Say 'Nothing was changed.' 'Green'; return }

  $rec = [ordered]@{ format = 'fl-mod-install/1'; id = $mod.id; name = $mod.name; version = $mod.version; installed = (Get-Date).ToString('s'); gameDir = $fl; files = @() }
  New-Item -ItemType Directory -Force -Path (PathIn $bk 'files') | Out-Null
  $done = 0
  try {
    foreach ($x in $plan) {
      $dst = PathIn $fl $x.path; $src = PathIn $here ("files/" + $x.path)
      $entry = [ordered]@{ path = $x.path; before = $x.current; after = $x.target; action = 'added' }
      if ($x.current) {
        $b = PathIn $bk ("files/" + $x.path)
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $b) | Out-Null
        Copy-Item -LiteralPath $dst -Destination $b -Force
        $entry.action = 'replaced'
      }
      $rec.files += $entry   # recorded before copying, so a failure below is rolled back too
      if ($x.status -ne 'same') {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
        Copy-Item -LiteralPath $src -Destination $dst -Force
        if ((HashOf $dst) -ne $x.target) { throw "Copy check failed for $($x.path)" }
      }
      $done++
    }
  } catch {
    # undo what was done so far
    Say ("Install failed: " + $_.Exception.Message) 'Red'; Say 'Putting back the files changed so far...' 'Yellow'
    foreach ($e in $rec.files) { $dst = PathIn $fl $e.path; if ($e.action -eq 'replaced') { Copy-Item -LiteralPath (PathIn $bk ("files/" + $e.path)) -Destination $dst -Force } elseif (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Force } }
    Remove-Item -LiteralPath $bk -Recurse -Force -ErrorAction SilentlyContinue
    RemoveEmptyBackupDir $fl
    throw
  }
  ($rec | ConvertTo-Json -Depth 5) | Set-Content -Encoding UTF8 -LiteralPath $recPath
  Say ''; Say ("Installed {0} {1}: {2} files. Backups are in {3}" -f $mod.name, $mod.version, $done, $bk) 'Green'
  Say 'To remove the mod again, run uninstall.cmd.' 'Green'
}

function DoUninstall([string]$fl) {
  $bk = PathIn $fl ("mod_backups/" + $mod.id); $recPath = PathIn $bk 'install.json'
  if (-not (Test-Path -LiteralPath $recPath)) { throw ("{0} is not installed in {1} (no {2})." -f $mod.name, $fl, $recPath) }
  $rec = Get-Content -Raw -Encoding UTF8 -LiteralPath $recPath | ConvertFrom-Json
  $files = @($rec.files)
  $touched = @($files | Where-Object { (HashOf (PathIn $fl $_.path)) -ne $_.after })
  Say ''; Say ("Uninstalling {0} {1} (installed {2}): {3} files." -f $rec.name, $rec.version, $rec.installed, $files.Count) 'Cyan'
  if ($touched.Count -gt 0) {
    Say 'These files were changed after the mod was installed (by you or another mod):' 'Yellow'
    foreach ($e in ($touched | Select-Object -First 12)) { Say ("          " + $e.path) 'DarkYellow' }
    Say 'They are kept as they are unless you answer yes (then they get the original back too).' 'Yellow'
    $restoreTouched = Ask 'Restore these too?'
  } else { $restoreTouched = $true; if (-not (Ask 'Uninstall?')) { Say 'Nothing was changed.' 'Green'; return } }
  $kept = 0
  [array]::Reverse($files)
  foreach ($e in $files) {
    $dst = PathIn $fl $e.path
    if (((HashOf $dst) -ne $e.after) -and -not $restoreTouched) { $kept++; continue }
    if ($e.action -eq 'replaced') { $b = PathIn $bk ("files/" + $e.path); New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null; Copy-Item -LiteralPath $b -Destination $dst -Force }
    elseif (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Force }
  }
  if ($kept -eq 0) { Remove-Item -LiteralPath $bk -Recurse -Force; RemoveEmptyBackupDir $fl; Say ("Removed {0}. Your files are as they were before." -f $rec.name) 'Green' }
  else { Say ("Removed {0}; {1} changed file(s) kept. Their originals stay in {2}." -f $rec.name, $kept, $bk) 'Yellow' }
}

try {
  Say ("{0} {1}{2}" -f $mod.name, $mod.version, $(if ($mod.author) { " by " + $mod.author } else { "" })) 'White'
  if ($mod.description) { Say $mod.description 'DarkGray' }
  $fl = FindFreelancer
  Say ("Freelancer folder: " + $fl)
  if ($Action -ne 'check' -and (GameRunning)) { throw 'Freelancer or FLServer is running. Close it first (Windows locks the files it uses).' }
  switch ($Action) {
    'check' { Say ''; Say 'Installing would do this:' 'Cyan'; ShowPlan (Plan $fl) }
    'install' { DoInstall $fl }
    'uninstall' { DoUninstall $fl }
  }
  exit 0
} catch {
  Say ''; Say ("ERROR: " + $_.Exception.Message) 'Red'
  exit 1
}
