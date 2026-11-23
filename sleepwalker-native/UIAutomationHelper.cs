using System.Diagnostics;
using System.Windows.Automation;

namespace SleepwalkerNative;

public static class UIAutomationHelper
{
    public static IntPtr FindNotepadWindow()
    {
        var root = AutomationElement.RootElement;
        if (root == null) return IntPtr.Zero;

        // Search by ProcessId first
        var procs = Process.GetProcessesByName("Notepad");
        foreach (var p in procs)
        {
            try
            {
                var pCond = new PropertyCondition(AutomationElement.ProcessIdProperty, p.Id);
                var win = root.FindFirst(TreeScope.Children, pCond);
                if (win != null && win.Current.NativeWindowHandle != 0)
                {
                    return new IntPtr(win.Current.NativeWindowHandle);
                }
            }
            catch {}
        }

        // Search by ClassName or Name
        try
        {
            var cond = new OrCondition(
                new PropertyCondition(AutomationElement.ClassNameProperty, "Notepad"),
                new PropertyCondition(AutomationElement.NameProperty, "Notepad")
            );
            var element = root.FindFirst(TreeScope.Children, cond);
            if (element != null && element.Current.NativeWindowHandle != 0)
            {
                return new IntPtr(element.Current.NativeWindowHandle);
            }
        }
        catch {}

        return IntPtr.Zero;
    }

    public static (bool Success, string Text, string? Error, long Hwnd, string ControlType) ReadNotepadText()
    {
        try
        {
            var root = AutomationElement.RootElement;
            if (root == null)
                return (false, string.Empty, "UIAutomation RootElement is null", 0, string.Empty);

            AutomationElement? notepadElement = null;

            var procs = Process.GetProcessesByName("Notepad");
            foreach (var p in procs)
            {
                try
                {
                    var pCond = new PropertyCondition(AutomationElement.ProcessIdProperty, p.Id);
                    var win = root.FindFirst(TreeScope.Children, pCond);
                    if (win != null)
                    {
                        notepadElement = win;
                        break;
                    }
                }
                catch {}
            }

            if (notepadElement == null)
            {
                var cond = new OrCondition(
                    new PropertyCondition(AutomationElement.ClassNameProperty, "Notepad"),
                    new PropertyCondition(AutomationElement.NameProperty, "Notepad")
                );
                notepadElement = root.FindFirst(TreeScope.Children, cond);
            }

            if (notepadElement == null)
            {
                return (false, string.Empty, "Notepad window not found in UIAutomation tree", 0, string.Empty);
            }

            long npHwnd = notepadElement.Current.NativeWindowHandle;

            // Search for Document or Edit element
            var docCond = new OrCondition(
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit)
            );

            var editElement = notepadElement.FindFirst(TreeScope.Descendants, docCond);
            if (editElement == null)
            {
                return (false, string.Empty, "Document or Edit control not found inside Notepad", npHwnd, string.Empty);
            }

            string ctrlType = editElement.Current.ControlType.ProgrammaticName;

            // Try TextPattern
            if (editElement.TryGetCurrentPattern(TextPattern.Pattern, out var tpObj) && tpObj is TextPattern tp)
            {
                string content = tp.DocumentRange.GetText(-1);
                return (true, content, null, npHwnd, ctrlType);
            }

            // Try ValuePattern
            if (editElement.TryGetCurrentPattern(ValuePattern.Pattern, out var vpObj) && vpObj is ValuePattern vp)
            {
                string content = vp.Current.Value;
                return (true, content, null, npHwnd, ctrlType);
            }

            return (false, string.Empty, "Neither TextPattern nor ValuePattern is supported on Notepad editor control", npHwnd, ctrlType);
        }
        catch (Exception ex)
        {
            return (false, string.Empty, ex.Message, 0, string.Empty);
        }
    }
}
