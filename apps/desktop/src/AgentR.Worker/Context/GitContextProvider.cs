using System.Diagnostics;

namespace AgentR.Worker.Context;

public sealed class GitContext
{
    public string? Branch { get; set; }
    public bool Dirty { get; set; }
    public string Summary { get; set; } = "";
}

public static class GitContextProvider
{
    public static GitContext? Get(string cwd)
    {
        var branch = Git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
        if (string.IsNullOrEmpty(branch)) return null;
        var status = Git(cwd, "status", "--porcelain");
        var dirty = !string.IsNullOrWhiteSpace(status);
        var count = dirty
            ? status!.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries).Length
            : 0;
        var summary = dirty
            ? $"branch: {branch} ({count} uncommitted change{(count == 1 ? "" : "s")})"
            : $"branch: {branch} (clean)";
        return new GitContext { Branch = branch, Dirty = dirty, Summary = summary };
    }

    public static string FormatBlock(GitContext ctx) => $"## Git context\n{ctx.Summary}\n\n";

    private static string? Git(string cwd, params string[] args)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "git",
                WorkingDirectory = cwd,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);
            using var p = Process.Start(psi);
            if (p is null) return null;
            if (!p.WaitForExit(3000)) { try { p.Kill(); } catch { } return null; }
            return p.ExitCode == 0 ? p.StandardOutput.ReadToEnd().Trim() : null;
        }
        catch { return null; }
    }
}
