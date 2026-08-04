using System.IO;
using System.Reflection;

namespace AgentR.Desktop;

internal static class UiPaths
{
    public static string AppDirectory =>
        Path.GetDirectoryName(Environment.ProcessPath)
        ?? AppContext.BaseDirectory;

    public static string UiDirectory
    {
        get
        {
            var candidates = new[]
            {
                Path.Combine(AppDirectory, "ui"),
                Path.Combine(AppContext.BaseDirectory, "ui"),
                Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "ui")),
            };
            foreach (var c in candidates)
            {
                if (File.Exists(Path.Combine(c, "index.html"))) return c;
            }
            return Path.Combine(AppDirectory, "ui");
        }
    }

    public static string SettingsHtml => Path.Combine(UiDirectory, "index.html");
    public static string ConsoleHtml => Path.Combine(UiDirectory, "console.html");

    public static string? LogoPath
    {
        get
        {
            foreach (var c in new[]
                     {
                         Path.Combine(UiDirectory, "logo.png"),
                         Path.Combine(AppDirectory, "ui", "logo.png"),
                     })
            {
                if (File.Exists(c)) return c;
            }
            return null;
        }
    }

    public static string AppVersion
    {
        get
        {
            var v = Assembly.GetExecutingAssembly().GetName().Version;
            return v is null ? "0.1.0" : $"{v.Major}.{v.Minor}.{v.Build}";
        }
    }
}
