using System.Text;

namespace SleepwalkerNative;

public class Program
{
    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetProcessWindowStation();

    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetThreadDesktop(uint dwThreadId);

    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);

    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetThreadDesktop(IntPtr hDesktop);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool EnumThreadWindows(uint dwThreadId, WindowManager.EnumWindowsProc lpfn, IntPtr lParam);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool EnumDesktopWindows(IntPtr hDesktop, WindowManager.EnumWindowsProc lpfn, IntPtr lParam);

    public static async Task<int> Main(string[] args)
    {
        // Support CLI test / status flags if invoked outside Chrome stdio
        if (args.Length > 0 && (args[0] == "--version" || args[0] == "-v"))
        {
            Console.WriteLine("SleepwalkerNative 2.0.0");
            return 0;
        }

        if (args.Length > 0 && args[0] == "--activate-notepad")
        {
            IntPtr hDesk = OpenInputDesktop(0, false, 0x01FF);
            Console.WriteLine($"OpenInputDesktop returned: {hDesk.ToInt64()}");
            int winCount = 0;
            IntPtr notepadHwnd = IntPtr.Zero;
            EnumDesktopWindows(hDesk, (hWnd, lParam) =>
            {
                winCount++;
                var sb = new StringBuilder(256);
                WindowManager.GetWindowText(hWnd, sb, 256);
                WindowManager.GetWindowThreadProcessId(hWnd, out uint pid);
                string title = sb.ToString();
                string pName = "";
                try { pName = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
                var classSb = new StringBuilder(256);
                GetClassName(hWnd, classSb, 256);
                string cName = classSb.ToString();
                uint pId = pid;
                if (pId == 35820 || (notepadHwnd == IntPtr.Zero && pName.ToLower().Contains("note")))
                {
                    Console.WriteLine($"EXACT NOTEPAD MATCH: HWND: {hWnd.ToInt64()} Class: '{cName}' Title: '{title}'");
                    notepadHwnd = hWnd;
                }
                else if (!string.IsNullOrWhiteSpace(title) && (title.Contains("Chrome") || title.Contains("Brave") || title.Contains("Antigravity") || title.Contains("Notepad")))
                {
                    Console.WriteLine($"WINDOW: HWND: {hWnd.ToInt64()} PID: {pid} ({pName}) Title: '{title}'");
                }
                return true;
            }, IntPtr.Zero);
            Console.WriteLine($"Total windows on desktop: {winCount}");
            if (notepadHwnd != IntPtr.Zero)
            {
                bool act = WindowManager.ForceForegroundWindow(notepadHwnd);
                Console.WriteLine($"ForceForegroundWindow returned: {act}");
                System.Threading.Thread.Sleep(500);
                var actWin = WindowManager.GetActiveWindow();
                Console.WriteLine($"Active window is now: [{actWin.Hwnd}] {actWin.ProcessName} - '{actWin.Title}'");
            }
            return 0;
        }
        if (args.Length > 0 && args[0] == "--inspect-notepad")
        {
            WindowManager.EnsureInputDesktopAttached();
            var procs = System.Diagnostics.Process.GetProcessesByName("Notepad");
            Console.WriteLine($"Found {procs.Length} Notepad processes");
            foreach (var p in procs)
            {
                p.Refresh();
                Console.WriteLine($"PID: {p.Id}, MainWindowHandle: {p.MainWindowHandle.ToInt64()}");
                if (p.MainWindowHandle != IntPtr.Zero)
                {
                    WindowManager.GetWindowRect(p.MainWindowHandle, out var r);
                    Console.WriteLine($"Rect: ({r.Left}, {r.Top}, {r.Right}, {r.Bottom})");
                    bool fg = WindowManager.ForceForegroundWindow(p.MainWindowHandle);
                    Console.WriteLine($"ForceForegroundWindow: {fg}");
                }
            }
            System.Threading.Thread.Sleep(500);
            var active = WindowManager.GetActiveWindow();
            Console.WriteLine($"Active window: [{active.Hwnd}] {active.ProcessName} - '{active.Title}'");
            return 0;
        }
        if (args.Length > 1 && args[0] == "--screenshot")
        {
            WindowManager.EnsureInputDesktopAttached();
            var res = ScreenCapture.CaptureDesktop(args[1]);
            if (res.Success)
            {
                Console.WriteLine($"Screenshot saved: {args[1]} ({res.Width}x{res.Height})");
                return 0;
            }
            else
            {
                Console.Error.WriteLine($"Screenshot error: {res.Error}");
                return 1;
            }
        }
        if (args.Length > 0 && args[0] == "--diag")
        {
            WindowManager.EnsureInputDesktopAttached();
            var screen = MouseController.GetVirtualScreenMetrics();
            bool gotPos = MouseController.GetCursorPos(out var pos);
            int lastErr = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
            var active = WindowManager.GetActiveWindow();
            Console.WriteLine($"Virtual Screen: {screen.width}x{screen.height} at ({screen.left}, {screen.top})");
            Console.WriteLine($"GetCursorPos returned: {gotPos}, Error: {lastErr}, Pos: ({pos.X}, {pos.Y})");
            Console.WriteLine($"INPUT struct size: {System.Runtime.InteropServices.Marshal.SizeOf(typeof(MouseController.INPUT))}");
            Console.WriteLine($"Active Window: [{active.Hwnd}] {active.ProcessName} - '{active.Title}'");
            return 0;
        }

        // Set up binary stdio for Chrome Native Messaging protocol
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = Encoding.UTF8;

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (sender, e) =>
        {
            e.Cancel = true;
            cts.Cancel();
        };

        using var inputStream = Console.OpenStandardInput();
        using var outputStream = Console.OpenStandardOutput();

        var host = new NativeMessagingHost(inputStream, outputStream);
        await host.RunAsync(cts.Token);

        return 0;
    }
}
