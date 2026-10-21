# Makes Windows accept toasts for the Desktop app's AppUserModelID.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-toast-aumid.ps1
#
# Why this exists: Electron on Windows delivers a renderer `new Notification()`
# through the ToastNotificationManager under an AppUserModelID. The DSH desktop
# shell never calls `app.setAppUserModelId`, so Chromium falls back to
# `electron.app.<ProductName>`; Windows records the notification against that
# AUMID (see HKCU\...\Notifications\Settings\electron.app.DeepSeek Harness) but
# drops the toast, because the AUMID resolves to no registered app.
#
# Registering the AUMID under HKCU\Software\Classes\AppUserModelId gives it a
# display name and an icon, which is what the toast platform needs to present and
# keep it. Reversible: `-Remove` deletes the key again.
param(
  [string]$Aumid = 'electron.app.DeepSeek Harness',
  [string]$DisplayName = 'DeepSeek Harness',
  [string]$IconPath = 'D:\ai\DeepSeek Harness.exe',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$key = "HKCU:\Software\Classes\AppUserModelId\$Aumid"

if ($Remove) {
  if (Test-Path $key) { Remove-Item $key -Recurse -Force; Write-Host "removed $key" }
  else { Write-Host "nothing to remove at $key" }
  return
}

New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name 'DisplayName' -Value $DisplayName -Type String
if (Test-Path $IconPath) {
  Set-ItemProperty -Path $key -Name 'IconUri' -Value $IconPath -Type String
} else {
  Write-Host "note: icon not found at $IconPath; skipping IconUri"
}

$check = Get-ItemProperty $key
Write-Host "registered : $key"
Write-Host "DisplayName: $($check.DisplayName)"
if ($null -ne $check.IconUri) { Write-Host "IconUri    : $($check.IconUri)" }
Write-Host ""
Write-Host 'Now send a message with the window in the background (or turn off "only in background" in the settings page).'
