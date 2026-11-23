using System.Runtime.InteropServices;

namespace SleepwalkerNative;

public static class MouseController
{
    private const int SM_XVIRTUALSCREEN = 76;
    private const int SM_YVIRTUALSCREEN = 77;
    private const int SM_CXVIRTUALSCREEN = 78;
    private const int SM_CYVIRTUALSCREEN = 79;

    private const uint INPUT_MOUSE = 0;

    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_HWHEEL = 0x1000;
    private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

    public const int WHEEL_DELTA = 120;

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public MOUSEKEYBDHARDWAREINPUT mkhi;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct MOUSEKEYBDHARDWAREINPUT
    {
        [FieldOffset(0)]
        public MOUSEINPUT mi;
        [FieldOffset(0)]
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    public static (int left, int top, int width, int height) GetVirtualScreenMetrics()
    {
        int left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        int top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        int height = GetSystemMetrics(SM_CYVIRTUALSCREEN);

        if (width <= 0) width = 1920;
        if (height <= 0) height = 1080;

        return (left, top, width, height);
    }

    public static POINT GetCurrentCursorPosition()
    {
        GetCursorPos(out POINT pt);
        return pt;
    }

    private static (int normX, int normY) ToAbsoluteNormalized(int pixelX, int pixelY)
    {
        var (vLeft, vTop, vWidth, vHeight) = GetVirtualScreenMetrics();

        // Formula for MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK:
        // Absolute coordinates are 0 to 65535 mapped across the virtual desktop rectangle.
        double normX = ((double)(pixelX - vLeft) * 65535.0) / (double)(vWidth - 1);
        double normY = ((double)(pixelY - vTop) * 65535.0) / (double)(vHeight - 1);

        int ix = (int)Math.Round(Math.Clamp(normX, 0, 65535));
        int iy = (int)Math.Round(Math.Clamp(normY, 0, 65535));

        return (ix, iy);
    }

    public static void SendRawMouseMove(int pixelX, int pixelY)
    {
        SetCursorPos(pixelX, pixelY);

        var (normX, normY) = ToAbsoluteNormalized(pixelX, pixelY);

        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].mkhi.mi = new MOUSEINPUT
        {
            dx = normX,
            dy = normY,
            mouseData = 0,
            dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
            time = 0,
            dwExtraInfo = IntPtr.Zero
        };

        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static async Task MoveCursorSmoothlyAsync(int targetX, int targetY, int durationMs = 150, int steps = 15, CancellationToken cancellationToken = default)
    {
        var current = GetCurrentCursorPosition();
        int startX = current.X;
        int startY = current.Y;

        if (startX == targetX && startY == targetY)
            return;

        if (durationMs <= 0 || steps <= 1)
        {
            SendRawMouseMove(targetX, targetY);
            return;
        }

        int stepCount = Math.Clamp(steps, 2, 50);
        int delayPerStep = Math.Max(5, durationMs / stepCount);

        for (int i = 1; i <= stepCount; i++)
        {
            cancellationToken.ThrowIfCancellationRequested();

            double t = (double)i / stepCount;
            // EaseInOutQuad curve
            double easeT = t < 0.5 ? 2.0 * t * t : -1.0 + (4.0 - 2.0 * t) * t;

            int currentStepX = (int)Math.Round(startX + (targetX - startX) * easeT);
            int currentStepY = (int)Math.Round(startY + (targetY - startY) * easeT);

            SendRawMouseMove(currentStepX, currentStepY);
            await Task.Delay(delayPerStep, cancellationToken);
        }

        // Final snap to target
        SendRawMouseMove(targetX, targetY);
    }

    public static async Task ClickAsync(int? x = null, int? y = null, string button = "left", int clickDelayMs = 25, CancellationToken cancellationToken = default)
    {
        if (x.HasValue && y.HasValue)
        {
            await MoveCursorSmoothlyAsync(x.Value, y.Value, 80, 10, cancellationToken);
        }

        uint downFlag = MOUSEEVENTF_LEFTDOWN;
        uint upFlag = MOUSEEVENTF_LEFTUP;

        if (string.Equals(button, "right", StringComparison.OrdinalIgnoreCase))
        {
            downFlag = MOUSEEVENTF_RIGHTDOWN;
            upFlag = MOUSEEVENTF_RIGHTUP;
        }
        else if (string.Equals(button, "middle", StringComparison.OrdinalIgnoreCase))
        {
            downFlag = MOUSEEVENTF_MIDDLEDOWN;
            upFlag = MOUSEEVENTF_MIDDLEUP;
        }

        INPUT[] downInput = new INPUT[1];
        downInput[0].type = INPUT_MOUSE;
        downInput[0].mkhi.mi = new MOUSEINPUT { dwFlags = downFlag };
        SendInput(1, downInput, Marshal.SizeOf(typeof(INPUT)));

        await Task.Delay(Math.Max(10, clickDelayMs), cancellationToken);

        INPUT[] upInput = new INPUT[1];
        upInput[0].type = INPUT_MOUSE;
        upInput[0].mkhi.mi = new MOUSEINPUT { dwFlags = upFlag };
        SendInput(1, upInput, Marshal.SizeOf(typeof(INPUT)));
    }

    public static async Task DoubleClickAsync(int? x = null, int? y = null, CancellationToken cancellationToken = default)
    {
        await ClickAsync(x, y, "left", 20, cancellationToken);
        await Task.Delay(40, cancellationToken);
        await ClickAsync(null, null, "left", 20, cancellationToken);
    }

    public static async Task RightClickAsync(int? x = null, int? y = null, CancellationToken cancellationToken = default)
    {
        await ClickAsync(x, y, "right", 25, cancellationToken);
    }

    public static void MouseDown(string button = "left")
    {
        uint downFlag = button.ToLowerInvariant() switch
        {
            "right" => MOUSEEVENTF_RIGHTDOWN,
            "middle" => MOUSEEVENTF_MIDDLEDOWN,
            _ => MOUSEEVENTF_LEFTDOWN
        };

        INPUT[] input = new INPUT[1];
        input[0].type = INPUT_MOUSE;
        input[0].mkhi.mi = new MOUSEINPUT { dwFlags = downFlag };
        SendInput(1, input, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void MouseUp(string button = "left")
    {
        uint upFlag = button.ToLowerInvariant() switch
        {
            "right" => MOUSEEVENTF_RIGHTUP,
            "middle" => MOUSEEVENTF_MIDDLEUP,
            _ => MOUSEEVENTF_LEFTUP
        };

        INPUT[] input = new INPUT[1];
        input[0].type = INPUT_MOUSE;
        input[0].mkhi.mi = new MOUSEINPUT { dwFlags = upFlag };
        SendInput(1, input, Marshal.SizeOf(typeof(INPUT)));
    }

    public static async Task DragAsync(int startX, int startY, int endX, int endY, int durationMs = 300, CancellationToken cancellationToken = default)
    {
        // 1. Move to start position
        await MoveCursorSmoothlyAsync(startX, startY, 80, 10, cancellationToken);
        await Task.Delay(30, cancellationToken);

        // 2. Mouse down
        MouseDown("left");
        await Task.Delay(50, cancellationToken);

        // 3. Move smoothly to end position
        await MoveCursorSmoothlyAsync(endX, endY, durationMs, 20, cancellationToken);
        await Task.Delay(50, cancellationToken);

        // 4. Mouse up
        MouseUp("left");
        await Task.Delay(20, cancellationToken);
    }

    public static void Scroll(int deltaY = 0, int deltaX = 0)
    {
        if (deltaY != 0)
        {
            INPUT[] input = new INPUT[1];
            input[0].type = INPUT_MOUSE;
            input[0].mkhi.mi = new MOUSEINPUT
            {
                dwFlags = MOUSEEVENTF_WHEEL,
                mouseData = (uint)deltaY
            };
            SendInput(1, input, Marshal.SizeOf(typeof(INPUT)));
        }

        if (deltaX != 0)
        {
            INPUT[] input = new INPUT[1];
            input[0].type = INPUT_MOUSE;
            input[0].mkhi.mi = new MOUSEINPUT
            {
                dwFlags = MOUSEEVENTF_HWHEEL,
                mouseData = (uint)deltaX
            };
            SendInput(1, input, Marshal.SizeOf(typeof(INPUT)));
        }
    }

    public static void ReleaseHeldButtons()
    {
        INPUT[] inputs = new INPUT[3];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].mkhi.mi = new MOUSEINPUT { dwFlags = MOUSEEVENTF_LEFTUP };
        inputs[1].type = INPUT_MOUSE;
        inputs[1].mkhi.mi = new MOUSEINPUT { dwFlags = MOUSEEVENTF_RIGHTUP };
        inputs[2].type = INPUT_MOUSE;
        inputs[2].mkhi.mi = new MOUSEINPUT { dwFlags = MOUSEEVENTF_MIDDLEUP };
        SendInput(3, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
}
