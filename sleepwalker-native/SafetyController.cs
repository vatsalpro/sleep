namespace SleepwalkerNative;

public static class SafetyController
{
    private static volatile bool _emergencyStopped = false;

    public static bool IsEmergencyStopped => _emergencyStopped;

    public static void TriggerEmergencyStop(string reason = "Emergency stop invoked")
    {
        _emergencyStopped = true;
        try
        {
            MouseController.ReleaseHeldButtons();
            KeyboardController.ReleaseAllModifiers();
        }
        catch
        {
            // Best-effort cleanup
        }
    }

    public static void ResetEmergencyStop()
    {
        _emergencyStopped = false;
    }

    public static (bool valid, string? error) ValidateCoordinates(int? x, int? y)
    {
        if (!x.HasValue && !y.HasValue)
            return (true, null);

        var (vLeft, vTop, vWidth, vHeight) = MouseController.GetVirtualScreenMetrics();
        int vRight = vLeft + vWidth;
        int vBottom = vTop + vHeight;

        if (x.HasValue && (x.Value < vLeft || x.Value > vRight))
        {
            return (false, $"X coordinate {x.Value} is outside virtual screen bounds [{vLeft}, {vRight}]");
        }

        if (y.HasValue && (y.Value < vTop || y.Value > vBottom))
        {
            return (false, $"Y coordinate {y.Value} is outside virtual screen bounds [{vTop}, {vBottom}]");
        }

        return (true, null);
    }
}
