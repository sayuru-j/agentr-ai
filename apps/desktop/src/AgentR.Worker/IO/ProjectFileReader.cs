namespace AgentR.Worker.IO;

public sealed class ProjectFileResult
{
    public bool Ok { get; set; }
    public string? Error { get; set; }
    public string? Name { get; set; }
    public string? RelativePath { get; set; }
    public string? MimeType { get; set; }
    public int SizeBytes { get; set; }
    public string? Delivery { get; set; }
    public string? Text { get; set; }
    public bool Truncated { get; set; }
    public string? DataBase64 { get; set; }
}

public static class ProjectFileReader
{
    public const int MaxBytes = 1_500_000;
    public const int InlineChars = 12_000;

    private static readonly HashSet<string> SkipDirs = new(StringComparer.OrdinalIgnoreCase)
    {
        ".git", "node_modules", "dist", "build", ".next", "target", "bin", "obj",
    };

    public static ProjectFileResult Read(string root, string query)
    {
        try
        {
            var fullRoot = Path.GetFullPath(root);
            if (!Directory.Exists(fullRoot))
                return Fail($"Project folder missing: {fullRoot}");

            var resolved = Resolve(fullRoot, query);
            if (resolved is null)
                return Fail($"No file matching `{query}`");

            var rel = Path.GetRelativePath(fullRoot, resolved).Replace('\\', '/');
            var bytes = File.ReadAllBytes(resolved);
            if (bytes.Length > MaxBytes)
                return Fail($"File too large ({bytes.Length} B; max {MaxBytes})");

            var name = Path.GetFileName(resolved);
            var mime = MimeFromName(name);
            var isText = IsLikelyText(bytes);
            if (isText)
            {
                var text = System.Text.Encoding.UTF8.GetString(bytes);
                var truncated = text.Length > InlineChars;
                return new ProjectFileResult
                {
                    Ok = true,
                    Name = name,
                    RelativePath = rel,
                    MimeType = mime,
                    SizeBytes = bytes.Length,
                    Delivery = "inline",
                    Text = truncated ? text[..InlineChars] : text,
                    Truncated = truncated,
                    DataBase64 = Convert.ToBase64String(bytes),
                };
            }

            return new ProjectFileResult
            {
                Ok = true,
                Name = name,
                RelativePath = rel,
                MimeType = mime,
                SizeBytes = bytes.Length,
                Delivery = "download",
                DataBase64 = Convert.ToBase64String(bytes),
            };
        }
        catch (Exception ex)
        {
            return Fail(ex.Message);
        }
    }

    private static ProjectFileResult Fail(string error) => new() { Ok = false, Error = error };

    private static string? Resolve(string root, string query)
    {
        var q = query.Trim().Replace('/', Path.DirectorySeparatorChar);
        if (string.IsNullOrEmpty(q)) return null;
        var direct = Path.GetFullPath(Path.Combine(root, q));
        if (!direct.StartsWith(root, StringComparison.OrdinalIgnoreCase)) return null;
        if (File.Exists(direct)) return direct;

        var baseName = Path.GetFileName(q);
        if (string.IsNullOrEmpty(baseName)) return null;
        foreach (var hit in EnumerateFiles(root).Where(f =>
                     string.Equals(Path.GetFileName(f), baseName, StringComparison.OrdinalIgnoreCase)))
            return hit;
        return null;
    }

    private static IEnumerable<string> EnumerateFiles(string dir, int depth = 0)
    {
        if (depth > 12) yield break;
        IEnumerable<string> files;
        IEnumerable<string> dirs;
        try
        {
            files = Directory.EnumerateFiles(dir);
            dirs = Directory.EnumerateDirectories(dir);
        }
        catch { yield break; }

        foreach (var f in files) yield return f;
        foreach (var d in dirs)
        {
            var name = Path.GetFileName(d);
            if (SkipDirs.Contains(name)) continue;
            foreach (var nested in EnumerateFiles(d, depth + 1))
                yield return nested;
        }
    }

    private static bool IsLikelyText(byte[] bytes)
    {
        var n = Math.Min(bytes.Length, 8000);
        for (var i = 0; i < n; i++)
        {
            var b = bytes[i];
            if (b == 0) return false;
            if (b < 9) return false;
        }
        return true;
    }

    private static string MimeFromName(string name) =>
        Path.GetExtension(name).ToLowerInvariant() switch
        {
            ".json" => "application/json",
            ".md" => "text/markdown",
            ".ts" or ".tsx" or ".js" or ".jsx" or ".cs" or ".py" or ".txt" => "text/plain",
            ".html" => "text/html",
            ".css" => "text/css",
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".pdf" => "application/pdf",
            _ => "application/octet-stream",
        };
}
