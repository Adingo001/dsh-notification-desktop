# Makes Windows accept toasts for the Desktop app's AppUserModelID, and
# registers the `dshnotify:` protocol the toast's click activates.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-toast-aumid.ps1
#
# Why the AUMID matters: Electron on Windows delivers a renderer
# `new Notification()` through the ToastNotificationManager under an
# AppUserModelID. The DSH desktop shell never calls `app.setAppUserModelId`, so
# Chromium falls back to `electron.app.<ProductName>`; Windows records the
# notification against that AUMID (see
# HKCU\...\Notifications\Settings\electron.app.DeepSeek Harness) but drops the
# toast, because the AUMID resolves to no registered app.
#
# Why the protocol matters: a toast click must be able to reach the app. The
# package's toast carries activationType="protocol" launch="dshnotify:focus", so
# the click runs this registration, which raises the window through
# scripts\focus.ps1. Foreground activation would instead need a registered
# ToastActivatorCLSID COM server, and nothing in this shell provides one.
#
# Reversible: `-Remove` deletes both keys again.
param(
  [string]$Aumid = 'electron.app.DeepSeek Harness',
  [string]$DisplayName = 'DeepSeek Harness',
  [string]$IconPath = 'D:\ai\DeepSeek Harness.exe',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$key = "HKCU:\Software\Classes\AppUserModelId\$Aumid"
$protocolKey = 'HKCU:\Software\Classes\dshnotify'
$focusScript = Join-Path $PSScriptRoot 'focus.ps1'

if ($Remove) {
  foreach ($target in @($key, $protocolKey)) {
    if (Test-Path $target) { Remove-Item $target -Recurse -Force; Write-Host "removed $target" }
    else { Write-Host "nothing to remove at $target" }
  }
  return
}

New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name 'DisplayName' -Value $DisplayName -Type String
if (Test-Path $IconPath) {
  Set-ItemProperty -Path $key -Name 'IconUri' -Value $IconPath -Type String
} else {
  Write-Host "note: icon not found at $IconPath; skipping IconUri"
}

# The protocol handler points at this checkout's focus.ps1, so re-run this
# script after moving the plugin directory.
if (-not (Test-Path $focusScript)) { throw "focus script not found: $focusScript" }
# The handler must not flash a console window. A console program (powershell.exe)
# always creates one before it can hide itself, so prefer the compiled
# windowless launcher; without a C# compiler, fall back to wscript (a GUI host)
# running the PowerShell helper hidden.
$launcher = Join-Path $PSScriptRoot 'focus-dsh.exe'
$launcherSource = Join-Path $PSScriptRoot 'focus-dsh.cs'
$vbsLauncher = Join-Path $PSScriptRoot 'focus-dsh.vbs'
$compiler = @(
  Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$command = $null
if ($null -ne $compiler -and (Test-Path $launcherSource)) {
  & $compiler /nologo /target:winexe /optimize+ /out:$launcher $launcherSource 2>&1 | Out-Null
  if (Test-Path $launcher) {
    $command = '"{0}" "%1"' -f $launcher
    Write-Host "launcher   : compiled $launcher"
  }
}
if ($null -eq $command) {
  $vbs = 'CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{0}"" ""%1""", 0, False' -f $focusScript
  Set-Content -Path $vbsLauncher -Value $vbs -Encoding ASCII
  $command = 'wscript.exe //nologo "{0}" "%1"' -f $vbsLauncher
  Write-Host "launcher   : no C# compiler found; using wscript -> focus.ps1"
}

New-Item -Path "$protocolKey\shell\open\command" -Force | Out-Null
Set-Item -Path $protocolKey -Value 'URL:DeepSeek Harness notification focus'
Set-ItemProperty -Path $protocolKey -Name 'URL Protocol' -Value ''
Set-Item -Path "$protocolKey\shell\open\command" -Value $command

$check = Get-ItemProperty $key
Write-Host "registered : $key"
Write-Host "DisplayName: $($check.DisplayName)"
if ($null -ne $check.IconUri) { Write-Host "IconUri    : $($check.IconUri)" }
Write-Host "protocol   : dshnotify: -> $command"
Write-Host ""
Write-Host 'Now send a message with the window in the background (or turn off "only in background" in the settings page).'
Write-Host 'Clicking the toast should bring the app back to the front.'
