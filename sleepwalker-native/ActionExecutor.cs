using System.Diagnostics;

namespace SleepwalkerNative;

public static class ActionExecutor
{
    public static async Task<NativeResponse> ExecuteAsync(NativeRequest request, CancellationToken externalCt = default)
    {
        var stopwatch = Stopwatch.StartNew();

        // Ensure thread is attached to the active user input desktop
        WindowManager.EnsureInputDesktopAttached();

        // 1. Validate request structure and allowlist
        var (isValid, validationError) = ProtocolValidator.ValidateRequest(request);
        if (!isValid)
        {
            return NativeResponse.CreateError(request.RequestId, "INVALID_REQUEST", validationError ?? "Invalid request", stopwatch.Elapsed.TotalMilliseconds);
        }

        // 2. Handle emergency stop / reset
        if (string.Equals(request.Action, "emergency_stop", StringComparison.OrdinalIgnoreCase))
        {
            SafetyController.TriggerEmergencyStop("Explicit emergency_stop action requested");
            return NativeResponse.CreateSuccess(request.RequestId, new { message = "Emergency stop triggered successfully" }, stopwatch.Elapsed.TotalMilliseconds);
        }

        if (SafetyController.IsEmergencyStopped)
        {
            return NativeResponse.CreateError(request.RequestId, "EMERGENCY_STOP", "Cannot execute action: System is in EMERGENCY_STOP state. Send reset or restart.", stopwatch.Elapsed.TotalMilliseconds);
        }

        // 3. Coordinate bounds validation
        var (coordsValid, coordError) = SafetyController.ValidateCoordinates(request.Target?.X, request.Target?.Y);
        if (!coordsValid)
        {
            return NativeResponse.CreateError(request.RequestId, "FAILED", coordError ?? "Coordinate out of bounds", stopwatch.Elapsed.TotalMilliseconds);
        }

        // 4. Foreground window verification for input actions
        bool isInputAction = request.Action.StartsWith("mouse_", StringComparison.OrdinalIgnoreCase) ||
                             request.Action.StartsWith("type_", StringComparison.OrdinalIgnoreCase) ||
                             request.Action.StartsWith("press_", StringComparison.OrdinalIgnoreCase) ||
                             string.Equals(request.Action, "key_combination", StringComparison.OrdinalIgnoreCase);

        if (isInputAction && request.WindowIdentity != null)
        {
            var (windowMatches, mismatchReason) = WindowManager.VerifyForegroundWindow(request.WindowIdentity);
            if (!windowMatches)
            {
                return NativeResponse.CreateError(request.RequestId, "WINDOW_MISMATCH", mismatchReason ?? "Foreground window mismatch", stopwatch.Elapsed.TotalMilliseconds);
            }
        }

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(externalCt);
        cts.CancelAfter(request.TimeoutMs);

        try
        {
            object? result = null;

            switch (request.Action.ToLowerInvariant())
            {
                case "ping":
                    var screen = MouseController.GetVirtualScreenMetrics();
                    var pos = MouseController.GetCurrentCursorPosition();
                    result = new
                    {
                        pong = true,
                        timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                        cursor = new { pos.X, pos.Y },
                        virtualScreen = new { screen.left, screen.top, screen.width, screen.height }
                    };
                    break;

                case "get_active_window":
                    var activeWin = WindowManager.GetActiveWindow();
                    result = activeWin;
                    break;

                case "mouse_move":
                    if (request.Target?.X == null || request.Target?.Y == null)
                        throw new ArgumentException("mouse_move requires target.x and target.y");
                    int duration = request.Target.DurationMs ?? 120;
                    int steps = request.Target.Steps ?? 12;
                    await MouseController.MoveCursorSmoothlyAsync(request.Target.X.Value, request.Target.Y.Value, duration, steps, cts.Token);
                    var endPos = MouseController.GetCurrentCursorPosition();
                    result = new { finalPosition = new { endPos.X, endPos.Y } };
                    break;

                case "mouse_click":
                    await MouseController.ClickAsync(request.Target?.X, request.Target?.Y, request.Target?.Button ?? "left", 25, cts.Token);
                    var clickPos = MouseController.GetCurrentCursorPosition();
                    result = new { clicked = true, position = new { clickPos.X, clickPos.Y }, button = request.Target?.Button ?? "left" };
                    break;

                case "mouse_double_click":
                    await MouseController.DoubleClickAsync(request.Target?.X, request.Target?.Y, cts.Token);
                    var dclickPos = MouseController.GetCurrentCursorPosition();
                    result = new { doubleClicked = true, position = new { dclickPos.X, dclickPos.Y } };
                    break;

                case "mouse_right_click":
                    await MouseController.RightClickAsync(request.Target?.X, request.Target?.Y, cts.Token);
                    var rclickPos = MouseController.GetCurrentCursorPosition();
                    result = new { rightClicked = true, position = new { rclickPos.X, rclickPos.Y } };
                    break;

                case "mouse_down":
                    MouseController.MouseDown(request.Target?.Button ?? "left");
                    result = new { mouseDown = true, button = request.Target?.Button ?? "left" };
                    break;

                case "mouse_up":
                    MouseController.MouseUp(request.Target?.Button ?? "left");
                    result = new { mouseUp = true, button = request.Target?.Button ?? "left" };
                    break;

                case "mouse_drag":
                    if (request.Target?.StartX == null || request.Target?.StartY == null ||
                        request.Target?.EndX == null || request.Target?.EndY == null)
                    {
                        throw new ArgumentException("mouse_drag requires startX, startY, endX, and endY");
                    }
                    int dragDuration = request.Target.DurationMs ?? 300;
                    await MouseController.DragAsync(request.Target.StartX.Value, request.Target.StartY.Value, request.Target.EndX.Value, request.Target.EndY.Value, dragDuration, cts.Token);
                    var dragEndPos = MouseController.GetCurrentCursorPosition();
                    result = new { dragged = true, finalPosition = new { dragEndPos.X, dragEndPos.Y } };
                    break;

                case "mouse_scroll":
                    int dy = request.Target?.DeltaY ?? 0;
                    int dx = request.Target?.DeltaX ?? 0;
                    MouseController.Scroll(dy, dx);
                    result = new { scrolled = true, deltaX = dx, deltaY = dy };
                    break;

                case "type_text":
                    string text = request.Target?.Text ?? string.Empty;
                    int delay = request.Target?.DelayMs ?? 20;
                    await KeyboardController.TypeTextAsync(text, delay, cts.Token);
                    result = new { typed = true, characterCount = text.Length };
                    break;

                case "press_key":
                    if (string.IsNullOrEmpty(request.Target?.Key))
                        throw new ArgumentException("press_key requires target.key");
                    await KeyboardController.PressKeyAsync(request.Target.Key, request.Target.Modifiers, cts.Token);
                    result = new { key = request.Target.Key, pressed = true };
                    break;

                case "key_combination":
                    if (string.IsNullOrEmpty(request.Target?.Key))
                        throw new ArgumentException("key_combination requires target.key");
                    var mods = request.Target.Modifiers ?? new List<string>();
                    await KeyboardController.KeyCombinationAsync(mods, request.Target.Key, cts.Token);
                    result = new { combination = $"{string.Join("+", mods)}+{request.Target.Key}", success = true };
                    break;

                case "activate_window":
                    bool activated = false;
                    IntPtr targetHwnd = IntPtr.Zero;
                    if (request.WindowIdentity?.Hwnd.HasValue == true && request.WindowIdentity.Hwnd.Value != 0)
                    {
                        targetHwnd = new IntPtr(request.WindowIdentity.Hwnd.Value);
                        activated = WindowManager.ActivateWindow(request.WindowIdentity.Hwnd.Value);
                    }
                    else if (!string.IsNullOrWhiteSpace(request.WindowIdentity?.ExpectedProcessName))
                    {
                        if (request.WindowIdentity.ExpectedProcessName.Contains("note", StringComparison.OrdinalIgnoreCase))
                        {
                            targetHwnd = UIAutomationHelper.FindNotepadWindow();
                            if (targetHwnd != IntPtr.Zero)
                            {
                                activated = WindowManager.ForceForegroundWindow(targetHwnd);
                            }
                        }
                        if (!activated)
                        {
                            activated = WindowManager.ActivateProcess(request.WindowIdentity.ExpectedProcessName);
                        }
                    }
                    await Task.Delay(300, cts.Token);
                    var curActive = WindowManager.GetActiveWindow();
                    result = new { activated, targetHwnd = targetHwnd.ToInt64(), activeWindow = curActive };
                    break;

                case "read_application_text":
                    var readRes = UIAutomationHelper.ReadNotepadText();
                    result = new
                    {
                        readSuccess = readRes.Success,
                        text = readRes.Text,
                        error = readRes.Error,
                        hwnd = readRes.Hwnd,
                        controlType = readRes.ControlType
                    };
                    break;

                case "launch_process":
                    WindowManager.UnlockForeground();
                    string procToLaunch = request.Target?.Text ?? "notepad.exe";
                    var psi = new ProcessStartInfo(procToLaunch) { UseShellExecute = true };
                    var proc = Process.Start(psi);
                    if (proc != null)
                    {
                        try { WindowManager.AllowSetForegroundWindow(proc.Id); } catch {}
                    }
                    await Task.Delay(1000, cts.Token);
                    var activeAfterLaunch = WindowManager.GetActiveWindow();
                    result = new { launched = proc != null, processId = proc?.Id, activeWindow = activeAfterLaunch };
                    break;

                case "capture_screenshot":
                    string outPath = request.Target?.Text ?? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, $"screenshot_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.png");
                    var capRes = ScreenCapture.CaptureDesktop(outPath);
                    if (!capRes.Success)
                        throw new InvalidOperationException($"Screen capture failed: {capRes.Error}");
                    result = new
                    {
                        screenshotPath = outPath,
                        width = capRes.Width,
                        height = capRes.Height,
                        timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                        activeWindow = WindowManager.GetActiveWindow()
                    };
                    break;

                default:
                    return NativeResponse.CreateError(request.RequestId, "INVALID_REQUEST", $"Unhandled action: {request.Action}", stopwatch.Elapsed.TotalMilliseconds);
            }

            stopwatch.Stop();
            return NativeResponse.CreateSuccess(request.RequestId, result, stopwatch.Elapsed.TotalMilliseconds);
        }
        catch (OperationCanceledException)
        {
            stopwatch.Stop();
            return NativeResponse.CreateError(request.RequestId, "TIMEOUT", $"Action '{request.Action}' timed out after {request.TimeoutMs}ms", stopwatch.Elapsed.TotalMilliseconds);
        }
        catch (Exception ex)
        {
            stopwatch.Stop();
            return NativeResponse.CreateError(request.RequestId, "FAILED", ex.Message, stopwatch.Elapsed.TotalMilliseconds);
        }
        finally
        {
            // Always ensure modifier keys are cleared
            KeyboardController.ReleaseAllModifiers();
        }
    }
}
