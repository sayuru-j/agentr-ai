using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Jpeg;
using SixLabors.ImageSharp.Processing;
using Image = SixLabors.ImageSharp.Image;
using Rectangle = System.Drawing.Rectangle;

namespace AgentR.Worker.Display;

public sealed class DisplayState
{
    public bool Locked { get; set; }
    public bool Woke { get; set; }
    public string? Detail { get; set; }
}

public static class WindowsDisplayService
{
    public static bool IsWorkstationLocked()
    {
        try
        {
            return Process.GetProcessesByName("LogonUI").Length > 0;
        }
        catch { return false; }
    }

    public static DisplayState PrepareForScreenshot()
    {
        if (IsWorkstationLocked())
        {
            return new DisplayState
            {
                Locked = true,
                Detail = "Windows session is locked. Unlock the PC, then retry /ss or /sshq.",
            };
        }
        try
        {
            // Nudge displays awake
            keybd_event(0x91, 0, 0, UIntPtr.Zero);
            keybd_event(0x91, 0, 2, UIntPtr.Zero);
            Thread.Sleep(50);
            keybd_event(0x91, 0, 0, UIntPtr.Zero);
            keybd_event(0x91, 0, 2, UIntPtr.Zero);
            return new DisplayState { Woke = true, Detail = "woke displays" };
        }
        catch
        {
            return new DisplayState();
        }
    }

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}

public sealed class ScreenshotShot
{
    public string Name { get; set; } = "";
    public string MimeType { get; set; } = "image/jpeg";
    public string Label { get; set; } = "";
    public byte[] Buffer { get; set; } = [];
}

public static class DesktopScreenshotService
{
    public static List<ScreenshotShot> CaptureAll(string quality)
    {
        var shots = new List<ScreenshotShot>();
        if (!OperatingSystem.IsWindows()) return shots;

        var screens = System.Windows.Forms.Screen.AllScreens;
        var i = 0;
        foreach (var screen in screens)
        {
            i++;
            var bounds = screen.Bounds;
            using var bmp = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(bounds.Location, System.Drawing.Point.Empty, bounds.Size);
            }

            using var msBmp = new MemoryStream();
            bmp.Save(msBmp, ImageFormat.Png);
            msBmp.Position = 0;

            using var image = Image.Load(msBmp);
            var maxW = quality == "hq" ? 3840 : 1600;
            var q = quality == "hq" ? 98 : 72;
            if (image.Width > maxW)
            {
                var h = (int)(image.Height * (maxW / (double)image.Width));
                image.Mutate(x => x.Resize(maxW, h));
            }
            using var outMs = new MemoryStream();
            image.Save(outMs, new JpegEncoder { Quality = q });
            shots.Add(new ScreenshotShot
            {
                Name = $"display-{i}.jpg",
                Label = $"Display {i} ({bounds.Width}×{bounds.Height})",
                Buffer = outMs.ToArray(),
            });
        }
        return shots;
    }
}
