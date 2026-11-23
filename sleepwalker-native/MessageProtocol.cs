using System.Text.Json;
using System.Text.Json.Serialization;

namespace SleepwalkerNative;

public class NativeRequest
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; set; } = string.Empty;

    [JsonPropertyName("action")]
    public string Action { get; set; } = string.Empty;

    [JsonPropertyName("target")]
    public NativeTarget? Target { get; set; }

    [JsonPropertyName("windowIdentity")]
    public WindowIdentity? WindowIdentity { get; set; }

    [JsonPropertyName("timeoutMs")]
    public int TimeoutMs { get; set; } = 5000;

    [JsonPropertyName("cancellationToken")]
    public string? CancellationToken { get; set; }
}

public class NativeTarget
{
    [JsonPropertyName("x")]
    public int? X { get; set; }

    [JsonPropertyName("y")]
    public int? Y { get; set; }

    [JsonPropertyName("deltaX")]
    public int? DeltaX { get; set; }

    [JsonPropertyName("deltaY")]
    public int? DeltaY { get; set; }

    [JsonPropertyName("startX")]
    public int? StartX { get; set; }

    [JsonPropertyName("startY")]
    public int? StartY { get; set; }

    [JsonPropertyName("endX")]
    public int? EndX { get; set; }

    [JsonPropertyName("endY")]
    public int? EndY { get; set; }

    [JsonPropertyName("button")]
    public string? Button { get; set; } // "left", "right", "middle"

    [JsonPropertyName("durationMs")]
    public int? DurationMs { get; set; }

    [JsonPropertyName("steps")]
    public int? Steps { get; set; }

    [JsonPropertyName("text")]
    public string? Text { get; set; }

    [JsonPropertyName("key")]
    public string? Key { get; set; }

    [JsonPropertyName("modifiers")]
    public List<string>? Modifiers { get; set; } // "Ctrl", "Alt", "Shift", "Win"

    [JsonPropertyName("delayMs")]
    public int? DelayMs { get; set; }
}

public class WindowIdentity
{
    [JsonPropertyName("expectedProcessName")]
    public string? ExpectedProcessName { get; set; }

    [JsonPropertyName("expectedTitleContains")]
    public string? ExpectedTitleContains { get; set; }

    [JsonPropertyName("hwnd")]
    public long? Hwnd { get; set; }
}

public class NativeResponse
{
    [JsonPropertyName("requestId")]
    public string RequestId { get; set; } = string.Empty;

    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("status")]
    public string Status { get; set; } = "COMPLETED";

    [JsonPropertyName("result")]
    public object? Result { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    [JsonPropertyName("executionTimeMs")]
    public double ExecutionTimeMs { get; set; }

    public static NativeResponse CreateSuccess(string requestId, object? result, double executionTimeMs) =>
        new()
        {
            RequestId = requestId,
            Success = true,
            Status = "COMPLETED",
            Result = result,
            ExecutionTimeMs = executionTimeMs
        };

    public static NativeResponse CreateError(string requestId, string status, string error, double executionTimeMs) =>
        new()
        {
            RequestId = requestId,
            Success = false,
            Status = status,
            Error = error,
            ExecutionTimeMs = executionTimeMs
        };
}

public static class ProtocolValidator
{
    private static readonly HashSet<string> AllowedActions = new(StringComparer.OrdinalIgnoreCase)
    {
        "ping",
        "get_active_window",
        "mouse_move",
        "mouse_click",
        "mouse_double_click",
        "mouse_right_click",
        "mouse_down",
        "mouse_up",
        "mouse_drag",
        "mouse_scroll",
        "type_text",
        "press_key",
        "key_combination",
        "activate_window",
        "launch_process",
        "capture_screenshot",
        "read_application_text",
        "emergency_stop"
    };

    public static (bool isValid, string? error) ValidateRequest(NativeRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.RequestId))
            return (false, "requestId is required");

        if (string.IsNullOrWhiteSpace(request.Action))
            return (false, "action is required");

        if (!AllowedActions.Contains(request.Action))
            return (false, $"Action '{request.Action}' is not permitted in allowlist");

        if (request.TimeoutMs < 50 || request.TimeoutMs > 60000)
            return (false, "timeoutMs must be between 50 and 60000");

        if (request.Target?.Text != null && request.Target.Text.Length > 2000)
            return (false, "target.text exceeds maximum allowed length of 2000 characters");

        return (true, null);
    }
}
