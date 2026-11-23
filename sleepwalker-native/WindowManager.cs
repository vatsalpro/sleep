using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace SleepwalkerNative;

public class WindowInfo
{
    public long Hwnd { get; set; }
    public string Title { get; set; } = string.Empty;
    public int ProcessId { get; set; }
    public string ProcessName { get; set; } = string.Empty;
    public int Left { get; set; }
    public int Top { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
}

public static class WindowManager
{
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    public static void DumpWindows()
    {
        EnsureInputDesktopAttached();
        EnumWindows((hWnd, lParam) =>
        {
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            GetWindowThreadProcessId(hWnd, out uint pid);
            string pName = "";
            try { pName = Process.GetProcessById((int)pid).ProcessName; } catch {}
            if (pName.Contains("note", StringComparison.OrdinalIgnoreCase) || pName.Contains("calc", StringComparison.OrdinalIgnoreCase) || sb.ToString().Contains("note", StringComparison.OrdinalIgnoreCase))
            {
                Console.WriteLine($"HWND: {hWnd.ToInt64()} | PID: {pid} ({pName}) | Title: '{sb}' | Visible: {IsWindowVisible(hWnd)}");
            }
            return true;
        }, IntPtr.Zero);
    }
    public static IntPtr FindWindowForProcess(string processName)
    {
        EnsureInputDesktopAttached();
        string clean = processName.Trim();
        if (clean.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            clean = clean[..^4];

        IntPtr foundHwnd = IntPtr.Zero;

        EnumWindows((hWnd, lParam) =>
        {
            if (IsWindowVisible(hWnd))
            {
                var sb = new StringBuilder(256);
                GetWindowText(hWnd, sb, 256);
                string title = sb.ToString();

                GetWindowThreadProcessId(hWnd, out uint pid);
                string procName = "";
                try { procName = Process.GetProcessById((int)pid).ProcessName; } catch {}

                bool matchProc = string.Equals(procName, clean, StringComparison.OrdinalIgnoreCase) ||
                                 procName.Contains(clean, StringComparison.OrdinalIgnoreCase);
                bool matchTitle = !string.IsNullOrEmpty(title) && title.Contains(clean, StringComparison.OrdinalIgnoreCase);

                if (matchProc || matchTitle)
                {
                    foundHwnd = hWnd;
                    return false; // Found match, stop enumeration
                }
            }
            return true;
        }, IntPtr.Zero);

        return foundHwnd;
    }

    [DllImport("user32.dll")]
    public static extern bool AllowSetForegroundWindow(int dwProcessId);

    [DllImport("user32.dll")]
    public static extern bool LockSetForegroundWindow(uint uLockCode);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);

    private const int ASFW_ANY = -1;
    private const uint LSFW_UNLOCK = 2;
    private const uint SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;
    private const uint SPIF_SENDCHANGE = 0x02;

    public static void UnlockForeground()
    {
        try
        {
            AllowSetForegroundWindow(ASFW_ANY);
            LockSetForegroundWindow(LSFW_UNLOCK);
            SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, IntPtr.Zero, SPIF_SENDCHANGE);
        }
        catch {}
    }

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const byte VK_MENU = 0x12;

    public static bool ForceForegroundWindow(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero) return false;
        EnsureInputDesktopAttached();

        // Simulate Alt press to bypass Windows SetForegroundWindow lock
        keybd_event(VK_MENU, 0, 0, 0);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);

        ShowWindow(hWnd, 9 /* SW_RESTORE */);
        BringWindowToTop(hWnd);
        bool success = SetForegroundWindow(hWnd);

        IntPtr foreWnd = GetForegroundWindow();
        if (foreWnd != hWnd)
        {
            uint foreThread = foreWnd != IntPtr.Zero ? GetWindowThreadProcessId(foreWnd, out _) : 0;
            uint targetThread = GetWindowThreadProcessId(hWnd, out _);
            uint currentThread = GetCurrentThreadId();

            if (foreThread != 0 && foreThread != currentThread)
                AttachThreadInput(currentThread, foreThread, true);
            if (targetThread != 0 && targetThread != currentThread)
                AttachThreadInput(currentThread, targetThread, true);

            ShowWindow(hWnd, 9 /* SW_RESTORE */);
            BringWindowToTop(hWnd);
            success = SetForegroundWindow(hWnd);

            if (targetThread != 0 && targetThread != currentThread)
                AttachThreadInput(currentThread, targetThread, false);
            if (foreThread != 0 && foreThread != currentThread)
                AttachThreadInput(currentThread, foreThread, false);
        }

        return success;
    }

    public static bool ActivateWindow(long hwnd)
    {
        if (hwnd == 0) return false;
        return ForceForegroundWindow((IntPtr)hwnd);
    }

    public static bool ActivateProcess(string processName)
    {
        EnsureInputDesktopAttached();
        IntPtr hwnd = FindWindowForProcess(processName);
        if (hwnd != IntPtr.Zero)
        {
            return ActivateWindow(hwnd.ToInt64());
        }

        string clean = processName.Trim();
        if (clean.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            clean = clean[..^4];

        var procs = Process.GetProcessesByName(clean);
        foreach (var p in procs)
        {
            try
            {
                p.Refresh();
                if (p.MainWindowHandle != IntPtr.Zero)
                {
                    return ActivateWindow(p.MainWindowHandle.ToInt64());
                }
            }
            catch {}
        }
        return false;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetThreadDesktop(IntPtr hDesktop);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr hDesktop);

    public static bool EnsureInputDesktopAttached()
    {
        try
        {
            IntPtr hDesk = OpenInputDesktop(0, false, 0x01FF);
            if (hDesk != IntPtr.Zero)
            {
                bool ok = SetThreadDesktop(hDesk);
                CloseDesktop(hDesk);
                return ok;
            }
        }
        catch
        {
            // Best effort
        }
        return false;
    }

    public static WindowInfo GetActiveWindow()
    {
        EnsureInputDesktopAttached();
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero)
        {
            return new WindowInfo { Hwnd = 0, Title = string.Empty, ProcessName = string.Empty };
        }

        var sb = new StringBuilder(512);
        GetWindowText(hwnd, sb, sb.Capacity);
        string title = sb.ToString();

        GetWindowThreadProcessId(hwnd, out uint pid);
        string processName = string.Empty;
        try
        {
            var proc = Process.GetProcessById((int)pid);
            processName = proc.ProcessName;
        }
        catch
        {
            // Process may have exited or privilege restriction
        }

        RECT rect;
        GetWindowRect(hwnd, out rect);

        return new WindowInfo
        {
            Hwnd = hwnd.ToInt64(),
            Title = title,
            ProcessId = (int)pid,
            ProcessName = processName,
            Left = rect.Left,
            Top = rect.Top,
            Width = Math.Max(0, rect.Right - rect.Left),
            Height = Math.Max(0, rect.Bottom - rect.Top)
        };
    }

    public static (bool matches, string? reason) VerifyForegroundWindow(WindowIdentity? identity)
    {
        if (identity == null)
            return (true, null);

        var current = GetActiveWindow();

        if (identity.Hwnd.HasValue && identity.Hwnd.Value != 0 && current.Hwnd != identity.Hwnd.Value)
        {
            return (false, $"Foreground window HWND mismatch: expected {identity.Hwnd.Value}, got {current.Hwnd} ({current.ProcessName}: '{current.Title}')");
        }

        if (!string.IsNullOrWhiteSpace(identity.ExpectedProcessName))
        {
            string expectedClean = identity.ExpectedProcessName.Trim();
            if (expectedClean.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                expectedClean = expectedClean[..^4];

            bool procMatch = string.Equals(current.ProcessName, expectedClean, StringComparison.OrdinalIgnoreCase) ||
                             current.ProcessName.Contains(expectedClean, StringComparison.OrdinalIgnoreCase);
            bool titleMatch = !string.IsNullOrEmpty(current.Title) &&
                              current.Title.Contains(expectedClean, StringComparison.OrdinalIgnoreCase);

            if (!procMatch && !titleMatch)
            {
                return (false, $"Foreground process mismatch: expected '{expectedClean}', got '{current.ProcessName}' ('{current.Title}')");
            }
        }

        if (!string.IsNullOrWhiteSpace(identity.ExpectedTitleContains))
        {
            if (!current.Title.Contains(identity.ExpectedTitleContains, StringComparison.OrdinalIgnoreCase))
            {
                return (false, $"Foreground window title mismatch: expected to contain '{identity.ExpectedTitleContains}', got '{current.Title}'");
            }
        }

        return (true, null);
    }
}
