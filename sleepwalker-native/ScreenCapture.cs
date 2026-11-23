using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace SleepwalkerNative;

public static class ScreenCapture
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetDesktopWindow();

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int nWidth, int nHeight);

    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr hObject);

    [DllImport("gdi32.dll")]
    private static extern bool BitBlt(IntPtr hdc, int nXDest, int nYDest, int nWidth, int nHeight, IntPtr hdcSrc, int nXSrc, int nYSrc, uint dwRop);

    private const uint SRCCOPY = 0x00CC0020;
    private const uint CAPTUREBLT = 0x40000000;

    public static (bool Success, string? Error, int Width, int Height) CaptureDesktop(string outputPath)
    {
        try
        {
            WindowManager.EnsureInputDesktopAttached();
            var screen = MouseController.GetVirtualScreenMetrics();
            int left = screen.left;
            int top = screen.top;
            int width = screen.width;
            int height = screen.height;

            if (width <= 0 || height <= 0)
            {
                width = 1920;
                height = 1080;
            }

            string? dir = Path.GetDirectoryName(outputPath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            // Primary method: GDI BitBlt directly from desktop window DC
            try
            {
                IntPtr hDesktop = GetDesktopWindow();
                IntPtr hSrcDC = GetDC(hDesktop);
                if (hSrcDC != IntPtr.Zero)
                {
                    IntPtr hDestDC = CreateCompatibleDC(hSrcDC);
                    IntPtr hBitmap = CreateCompatibleBitmap(hSrcDC, width, height);
                    IntPtr hOldBmp = SelectObject(hDestDC, hBitmap);

                    BitBlt(hDestDC, 0, 0, width, height, hSrcDC, left, top, SRCCOPY | CAPTUREBLT);

                    using (var bmp = Image.FromHbitmap(hBitmap))
                    {
                        bmp.Save(outputPath, ImageFormat.Png);
                    }

                    SelectObject(hDestDC, hOldBmp);
                    DeleteObject(hBitmap);
                    DeleteDC(hDestDC);
                    ReleaseDC(hDesktop, hSrcDC);

                    return (true, null, width, height);
                }
            }
            catch
            {
                // Fallback to CopyFromScreen
            }

            // Fallback method: Graphics.CopyFromScreen
            using var fallbackBmp = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(fallbackBmp))
            {
                g.CopyFromScreen(left, top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
            }
            fallbackBmp.Save(outputPath, ImageFormat.Png);
            return (true, null, width, height);
        }
        catch (Exception ex)
        {
            return (false, ex.Message, 0, 0);
        }
    }
}
