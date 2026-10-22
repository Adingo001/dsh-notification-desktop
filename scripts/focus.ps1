# Brings the DSH desktop window to the foreground.
#
# Invoked by the toast's protocol activation (`dshnotify:focus`) through the
# handler that scripts\fix-toast-aumid.ps1 registers:
#   HKCU\Software\Classes\dshnotify\shell\open\command
#     -> powershell.exe … -File <this file> "%1"
#
# Windows refuses to move the foreground to a process that neither owns the
# foreground window nor received the last input event, so one API call is not
# enough. Three strategies run in order of least disruption, and each one is
# verified against GetForegroundWindow before the next is tried:
#   1. attach to the foreground thread's input queue, then SetForegroundWindow;
#   2. SwitchToThisWindow (honours the request more aggressively);
#   3. minimize + restore, which grants the restored window activation rights.
#
# ASCII-only on purpose: Windows PowerShell reads a BOM-less script as the ANSI
# code page, so literal non-ASCII text here would be mangled.
#
# $Uri receives the "%1" the protocol handler appends (unused). $ProcessName
# exists so a hand test can target another app, and so a shell whose executable
# is named differently can be pointed at.
param(
  [string]$Uri = '',
  [string]$ProcessName = 'DeepSeek Harness'
)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
}
'@

$target = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1

if ($null -eq $target) {
  Write-Output 'NO-WINDOW'
  exit 0
}

$handle = $target.MainWindowHandle
$foregroundPid = [uint32]0
[void][DshWin]::GetWindowThreadProcessId([DshWin]::GetForegroundWindow(), [ref]$foregroundPid)
if ($foregroundPid -eq $target.Id -and -not [DshWin]::IsIconic($handle)) {
  Write-Output ("ALREADY-FOREGROUND pid=" + $target.Id)
  exit 0
}

if ([DshWin]::IsIconic($handle)) { [DshWin]::ShowWindowAsync($handle, 9) | Out-Null }  # SW_RESTORE
[DshWin]::ShowWindowAsync($handle, 5) | Out-Null                                        # SW_SHOW

function Test-Foreground([int]$pid) {
  $current = [uint32]0
  [void][DshWin]::GetWindowThreadProcessId([DshWin]::GetForegroundWindow(), [ref]$current)
  return ($current -eq $pid)
}

# Activation settles asynchronously: the foreground flips a few hundred
# milliseconds after the call, so poll instead of sampling once.
function Wait-Foreground([int]$pid, [int]$timeoutMs = 600) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    if (Test-Foreground $pid) { return $true }
    Start-Sleep -Milliseconds 60
  }
  return $false
}

# 1) attach the input queues, then raise.
$foreground = [DshWin]::GetForegroundWindow()
$foregroundThread = [DshWin]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
$currentThread = [DshWin]::GetCurrentThreadId()
if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
  [DshWin]::AttachThreadInput($currentThread, $foregroundThread, $true) | Out-Null
  [DshWin]::BringWindowToTop($handle) | Out-Null
  [DshWin]::SetForegroundWindow($handle) | Out-Null
  [DshWin]::AttachThreadInput($currentThread, $foregroundThread, $false) | Out-Null
} else {
  [DshWin]::SetForegroundWindow($handle) | Out-Null
}
if (Wait-Foreground $target.Id) { Write-Output ("FOCUSED attach pid=" + $target.Id); exit 0 }

# 2) SwitchToThisWindow.
[DshWin]::SwitchToThisWindow($handle, $true)
if (Wait-Foreground $target.Id) { Write-Output ("FOCUSED switch pid=" + $target.Id); exit 0 }

# 3) minimize + restore.
[DshWin]::ShowWindow($handle, 6) | Out-Null   # SW_MINIMIZE
Start-Sleep -Milliseconds 80
[DshWin]::ShowWindow($handle, 9) | Out-Null   # SW_RESTORE
[DshWin]::SetForegroundWindow($handle) | Out-Null
if (Wait-Foreground $target.Id 1500) { Write-Output ("FOCUSED restore pid=" + $target.Id); exit 0 }

# Activation can land after this process exits; report what was observed rather
# than claiming a failure the user may not see.
$observed = [uint32]0
[void][DshWin]::GetWindowThreadProcessId([DshWin]::GetForegroundWindow(), [ref]$observed)
Write-Output ("UNCONFIRMED pid=" + $target.Id + " foreground=" + $observed)
