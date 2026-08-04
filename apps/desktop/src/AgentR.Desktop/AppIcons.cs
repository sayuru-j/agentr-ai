using System.Drawing;
using System.IO;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using DrawingIcon = System.Drawing.Icon;

namespace AgentR.Desktop;

internal static class AppIcons
{
    private static ImageSource? _windowIcon;
    private static DrawingIcon? _trayIcon;

    public static string? LogoPngPath
    {
        get
        {
            foreach (var c in CandidateFiles("logo.png"))
            {
                if (File.Exists(c)) return c;
            }
            return null;
        }
    }

    public static string? LogoIcoPath
    {
        get
        {
            foreach (var c in CandidateFiles("logo.ico"))
            {
                if (File.Exists(c)) return c;
            }
            return null;
        }
    }

    public static ImageSource? WindowIcon
    {
        get
        {
            if (_windowIcon is not null) return _windowIcon;
            var path = LogoIcoPath ?? LogoPngPath;
            if (path is null) return null;
            try
            {
                var bmp = new BitmapImage();
                bmp.BeginInit();
                bmp.CacheOption = BitmapCacheOption.OnLoad;
                bmp.UriSource = new Uri(path, UriKind.Absolute);
                bmp.EndInit();
                bmp.Freeze();
                _windowIcon = bmp;
                return _windowIcon;
            }
            catch
            {
                return null;
            }
        }
    }

    public static DrawingIcon LoadTrayIcon()
    {
        if (_trayIcon is not null) return (DrawingIcon)_trayIcon.Clone();

        try
        {
            var ico = LogoIcoPath;
            if (ico is not null)
            {
                using var full = new DrawingIcon(ico);
                _trayIcon = new DrawingIcon(full, 16, 16);
                return (DrawingIcon)_trayIcon.Clone();
            }

            var png = LogoPngPath;
            if (png is not null)
            {
                using var bmp = new Bitmap(png);
                using var small = new Bitmap(bmp, new System.Drawing.Size(16, 16));
                var hIcon = small.GetHicon();
                using var temp = DrawingIcon.FromHandle(hIcon);
                _trayIcon = (DrawingIcon)temp.Clone();
                return (DrawingIcon)_trayIcon.Clone();
            }
        }
        catch
        {
            // fall through
        }

        return (DrawingIcon)SystemIcons.Application.Clone();
    }

    private static IEnumerable<string> CandidateFiles(string fileName)
    {
        var appDir = Path.GetDirectoryName(Environment.ProcessPath) ?? AppContext.BaseDirectory;
        yield return Path.Combine(appDir, "assets", fileName);
        yield return Path.Combine(AppContext.BaseDirectory, "assets", fileName);
        yield return Path.Combine(appDir, "ui", fileName);
        yield return Path.Combine(AppContext.BaseDirectory, "ui", fileName);
        yield return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "assets", fileName));
        yield return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "ui", fileName));
        yield return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "packages", "assets", fileName));
    }
}
