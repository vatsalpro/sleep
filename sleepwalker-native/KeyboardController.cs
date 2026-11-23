using System.Runtime.InteropServices;

namespace SleepwalkerNative;

public static class KeyboardController
{
    private const uint INPUT_KEYBOARD = 1;

    private const uint KEYEVENTF_KEYDOWN = 0x0000;
    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, MouseController.INPUT[] pInputs, int cbSize);

    private static readonly Dictionary<string, ushort> KeyMap = new(StringComparer.OrdinalIgnoreCase)
    {
        { "Enter", 0x0D },
        { "Return", 0x0D },
        { "Escape", 0x1B },
        { "Esc", 0x1B },
        { "Tab", 0x09 },
        { "Backspace", 0x08 },
        { "Delete", 0x2E },
        { "Del", 0x2E },
        { "Space", 0x20 },
        { "ArrowLeft", 0x25 },
        { "Left", 0x25 },
        { "ArrowUp", 0x26 },
        { "Up", 0x26 },
        { "ArrowRight", 0x27 },
        { "Right", 0x27 },
        { "ArrowDown", 0x28 },
        { "Down", 0x28 },
        { "Home", 0x24 },
        { "End", 0x23 },
        { "PageUp", 0x21 },
        { "PageDown", 0x22 },
        { "Control", 0x11 },
        { "Ctrl", 0x11 },
        { "Alt", 0x12 },
        { "Menu", 0x12 },
        { "Shift", 0x10 },
        { "Win", 0x5B },
        { "Windows", 0x5B },
        { "Meta", 0x5B },
        { "F1", 0x70 },
        { "F2", 0x71 },
        { "F3", 0x72 },
        { "F4", 0x73 },
        { "F5", 0x74 },
        { "F6", 0x75 },
        { "F7", 0x76 },
        { "F8", 0x77 },
        { "F9", 0x78 },
        { "F10", 0x79 },
        { "F11", 0x7A },
        { "F12", 0x7B },
    };

    public static ushort ResolveVkCode(string key)
    {
        if (KeyMap.TryGetValue(key, out ushort vk))
            return vk;

        if (key.Length == 1)
        {
            char c = char.ToUpperInvariant(key[0]);
            if (c >= 'A' && c <= 'Z') return (ushort)c;
            if (c >= '0' && c <= '9') return (ushort)c;
        }

        return 0;
    }

    private static ushort ResolveModifierVk(string modifier)
    {
        return modifier.ToLowerInvariant() switch
        {
            "ctrl" or "control" => 0x11,
            "alt" or "menu" => 0x12,
            "shift" => 0x10,
            "win" or "windows" or "meta" => 0x5B,
            _ => 0
        };
    }

    public static async Task TypeTextAsync(string text, int delayMs = 20, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(text))
            return;

        int charDelay = Math.Max(5, delayMs);

        foreach (char c in text)
        {
            cancellationToken.ThrowIfCancellationRequested();

            MouseController.INPUT[] down = new MouseController.INPUT[1];
            down[0].type = INPUT_KEYBOARD;
            down[0].mkhi.ki = new MouseController.KEYBDINPUT
            {
                wVk = 0,
                wScan = c,
                dwFlags = KEYEVENTF_UNICODE,
                time = 0,
                dwExtraInfo = IntPtr.Zero
            };
            SendInput(1, down, Marshal.SizeOf(typeof(MouseController.INPUT)));

            await Task.Delay(charDelay / 2, cancellationToken);

            MouseController.INPUT[] up = new MouseController.INPUT[1];
            up[0].type = INPUT_KEYBOARD;
            up[0].mkhi.ki = new MouseController.KEYBDINPUT
            {
                wVk = 0,
                wScan = c,
                dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                time = 0,
                dwExtraInfo = IntPtr.Zero
            };
            SendInput(1, up, Marshal.SizeOf(typeof(MouseController.INPUT)));

            await Task.Delay(charDelay / 2, cancellationToken);
        }
    }

    public static async Task PressKeyAsync(string key, List<string>? modifiers = null, CancellationToken cancellationToken = default)
    {
        ushort vk = ResolveVkCode(key);
        if (vk == 0)
        {
            // If single character not in VK map, fall back to Unicode typing
            if (key.Length == 1)
            {
                await TypeTextAsync(key, 20, cancellationToken);
                return;
            }
            throw new ArgumentException($"Unknown key identifier: '{key}'");
        }

        List<ushort> modifierVks = new();
        if (modifiers != null)
        {
            foreach (var mod in modifiers)
            {
                ushort modVk = ResolveModifierVk(mod);
                if (modVk != 0) modifierVks.Add(modVk);
            }
        }

        try
        {
            // 1. Press modifiers down
            foreach (var modVk in modifierVks)
            {
                SendVk(modVk, KEYEVENTF_KEYDOWN);
            }

            if (modifierVks.Count > 0)
                await Task.Delay(20, cancellationToken);

            // 2. Press target key down and up
            SendVk(vk, KEYEVENTF_KEYDOWN);
            await Task.Delay(25, cancellationToken);
            SendVk(vk, KEYEVENTF_KEYUP);
        }
        finally
        {
            // 3. Release modifiers in reverse order
            for (int i = modifierVks.Count - 1; i >= 0; i--)
            {
                SendVk(modifierVks[i], KEYEVENTF_KEYUP);
            }
        }
    }

    public static async Task KeyCombinationAsync(List<string> modifiers, string key, CancellationToken cancellationToken = default)
    {
        await PressKeyAsync(key, modifiers, cancellationToken);
    }

    private static void SendVk(ushort vk, uint flags)
    {
        MouseController.INPUT[] input = new MouseController.INPUT[1];
        input[0].type = INPUT_KEYBOARD;
        input[0].mkhi.ki = new MouseController.KEYBDINPUT
        {
            wVk = vk,
            wScan = 0,
            dwFlags = flags,
            time = 0,
            dwExtraInfo = IntPtr.Zero
        };
        SendInput(1, input, Marshal.SizeOf(typeof(MouseController.INPUT)));
    }

    public static void ReleaseAllModifiers()
    {
        ushort[] mods = { 0x11 /* Ctrl */, 0x12 /* Alt */, 0x10 /* Shift */, 0x5B /* Win */ };
        foreach (var vk in mods)
        {
            SendVk(vk, KEYEVENTF_KEYUP);
        }
    }
}
