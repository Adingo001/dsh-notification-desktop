// Windowless launcher for the toast's protocol activation.
//
// Compiled to focus-dsh.exe with /target:winexe, so it has the GUI subsystem and
// Windows never creates a console window for it — a `powershell -WindowStyle
// Hidden` handler always flashes one, because the console is created before
// PowerShell can hide its own window.
//
// Raises the DeepSeek Harness window: Windows refuses to hand the foreground to
// a process that neither owns it nor received the last input, so three
// strategies run in order and each is verified before the next is tried.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

internal static class Program
{
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);

    private const int SwShow = 5;
    private const int SwMinimize = 6;
    private const int SwRestore = 9;

    private static int Main(string[] args)
    {
        string processName = args.Length > 1 ? args[1] : "DeepSeek Harness";

        IntPtr handle = IntPtr.Zero;
        int pid = 0;
        foreach (Process candidate in Process.GetProcessesByName(processName))
        {
            if (candidate.MainWindowHandle == IntPtr.Zero) continue;
            handle = candidate.MainWindowHandle;
            pid = candidate.Id;
            break;
        }

        if (handle == IntPtr.Zero) return 1;

        if (IsIconic(handle)) ShowWindowAsync(handle, SwRestore);
        ShowWindowAsync(handle, SwShow);

        if (IsForeground(pid)) return 0;

        // 1) borrow the foreground thread's input queue, then raise.
        IntPtr foreground = GetForegroundWindow();
        uint foregroundPid;
        uint foregroundThread = GetWindowThreadProcessId(foreground, out foregroundPid);
        uint currentThread = GetCurrentThreadId();
        if (foregroundThread != 0 && foregroundThread != currentThread)
        {
            AttachThreadInput(currentThread, foregroundThread, true);
            BringWindowToTop(handle);
            SetForegroundWindow(handle);
            AttachThreadInput(currentThread, foregroundThread, false);
        }
        else
        {
            SetForegroundWindow(handle);
        }
        if (WaitForeground(pid, 600)) return 0;

        // 2) SwitchToThisWindow honours the request more aggressively.
        SwitchToThisWindow(handle, true);
        if (WaitForeground(pid, 600)) return 0;

        // 3) a restored window gets activation rights.
        ShowWindow(handle, SwMinimize);
        ShowWindow(handle, SwRestore);
        SetForegroundWindow(handle);
        WaitForeground(pid, 1500);
        return IsForeground(pid) ? 0 : 1;
    }

    private static bool IsForeground(int pid)
    {
        uint currentPid;
        GetWindowThreadProcessId(GetForegroundWindow(), out currentPid);
        return currentPid == pid;
    }

    private static bool WaitForeground(int pid, int timeoutMs)
    {
        int waited = 0;
        while (waited < timeoutMs)
        {
            if (IsForeground(pid)) return true;
            System.Threading.Thread.Sleep(60);
            waited += 60;
        }
        return false;
    }
}
