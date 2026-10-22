# Brings the DSH desktop window to the foreground.
#
# Invoked by the toast's protocol activation (`dshnotify:focus`) through the
# handler that scripts\fix-toast-aumid.ps1 registers:
#   HKCU\Software\Classes\dshnotify\shell\open\command
#     -> powershell.exe … -File <this file> "%1"
#
# ASCII-only on purpose: Windows PowerShell reads a BOM-less script as the ANSI
# code page, so literal non-ASCII text here would be mangled.
$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@

$target = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1

if ($null -eq $target) {
  Write-Output 'NO-WINDOW'
  exit 0
}

$handle = $target.MainWindowHandle
if ([DshWin]::IsIconic($handle)) { [DshWin]::ShowWindowAsync($handle, 9) | Out-Null }  # SW_RESTORE
[DshWin]::ShowWindowAsync($handle, 5) | Out-Null                                        # SW_SHOW

# Windows refuses SetForegroundWindow from a process that does not own the
# foreground window unless the two threads are attached; attach, raise, detach.
$foreground = [DshWin]::GetForegroundWindow()
$foregroundPid = [uint32]0
$foregroundThread = [DshWin]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
$currentThread = [DshWin]::GetCurrentThreadId()

if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
  [DshWin]::AttachThreadInput($currentThread, $foregroundThread, $true) | Out-Null
  [DshWin]::SetForegroundWindow($handle) | Out-Null
  [DshWin]::AttachThreadInput($currentThread, $foregroundThread, $false) | Out-Null
} else {
  [DshWin]::SetForegroundWindow($handle) | Out-Null
}

Write-Output ("FOCUSED pid=" + $target.Id)
