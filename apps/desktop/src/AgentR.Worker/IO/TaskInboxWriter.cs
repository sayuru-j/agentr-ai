using AgentR.Protocol;

namespace AgentR.Worker.IO;

public static class TaskInboxWriter
{
    public static (string Dir, List<string> Paths) Write(string cwd, IEnumerable<TaskFile> files)
    {
        var dir = Path.Combine(cwd, ".agentr-inbox");
        Directory.CreateDirectory(dir);
        var paths = new List<string>();
        var stamp = DateTime.UtcNow.ToString("o").Replace(':', '-').Replace('.', '-');
        foreach (var file in files)
        {
            var safe = Sanitize(Path.GetFileName(file.Name));
            var dest = Path.Combine(dir, $"{stamp}-{safe}");
            File.WriteAllBytes(dest, Convert.FromBase64String(file.DataBase64));
            paths.Add(dest);
        }
        return (dir, paths);
    }

    private static string Sanitize(string name)
    {
        var cleaned = System.Text.RegularExpressions.Regex.Replace(name, @"[^\w.\- ()[\]]+", "_");
        if (cleaned.Length > 160) cleaned = cleaned[..160];
        return string.IsNullOrEmpty(cleaned) ? "file.bin" : cleaned;
    }
}
