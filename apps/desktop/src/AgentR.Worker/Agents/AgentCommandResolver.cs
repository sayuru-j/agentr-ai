using System.Diagnostics;
using System.Text;
using AgentR.Protocol;

namespace AgentR.Worker.Agents;

public sealed class ResolveAgentResult
{
    public string Command { get; set; } = "";
    public bool Found { get; set; }
    public string Source { get; set; } = "missing";
    public string? Detail { get; set; }
    public AgentBackend Backend { get; set; }
}

public static class AgentCommandResolver
{
    public static ResolveAgentResult Resolve(string configured, AgentBackend backend)
    {
        var fallback = backend == AgentBackend.Codex ? "codex" : "agent";
        var trimmed = StripQuotes(configured) ?? fallback;
        var names = BinaryNames(backend);

        if (LooksLikePath(trimmed) && File.Exists(trimmed) && CommandMatchesBackend(backend, trimmed))
        {
            return new ResolveAgentResult
            {
                Command = trimmed,
                Found = true,
                Source = "config",
                Detail = trimmed,
                Backend = backend,
            };
        }

        var onPath = FindOnPath(
            !LooksLikePath(trimmed) && trimmed != fallback
                ? new[] { trimmed }.Concat(names).ToArray()
                : names);
        if (onPath is not null)
        {
            return new ResolveAgentResult
            {
                Command = onPath,
                Found = true,
                Source = "path",
                Detail = onPath,
                Backend = backend,
            };
        }

        var local = FindInInstallDirs(backend);
        if (local is not null)
        {
            return new ResolveAgentResult
            {
                Command = local,
                Found = true,
                Source = "localappdata",
                Detail = local,
                Backend = backend,
            };
        }

        return new ResolveAgentResult
        {
            Command = LooksLikePath(trimmed) ? trimmed : fallback,
            Found = false,
            Source = "missing",
            Backend = backend,
        };
    }

    public static string PreferResolved(string configured, AgentBackend backend)
    {
        var fallback = backend == AgentBackend.Codex ? "codex" : "agent";
        var trimmed = StripQuotes(configured) ?? fallback;
        if (LooksLikePath(trimmed) && File.Exists(trimmed) && CommandMatchesBackend(backend, trimmed))
            return trimmed;
        var r = Resolve(trimmed, backend);
        return r.Found ? r.Command : fallback;
    }

    public static bool CommandMatchesBackend(AgentBackend backend, string command)
    {
        var trimmed = StripQuotes(command) ?? "";
        if (string.IsNullOrEmpty(trimmed)) return false;
        if (!LooksLikePath(trimmed))
        {
            var baseName = Path.GetFileName(trimmed).ToLowerInvariant();
            return backend == AgentBackend.Codex
                ? baseName is "codex" or "codex.cmd" or "codex.exe"
                : baseName.StartsWith("agent");
        }
        var lower = trimmed.Replace('\\', '/').ToLowerInvariant();
        if (backend == AgentBackend.Codex)
            return !lower.Contains("cursor-agent") && !System.Text.RegularExpressions.Regex.IsMatch(lower, @"[/\\]agent\.(cmd|exe|bat)$");
        return !System.Text.RegularExpressions.Regex.IsMatch(lower, @"[/\\]codex\.(cmd|exe|bat)$")
            || lower.Contains("cursor-agent");
    }

    public static string? StripQuotes(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return value;
        var t = value.Trim();
        if (t.Length >= 2 && ((t[0] == '"' && t[^1] == '"') || (t[0] == '\'' && t[^1] == '\'')))
            return t[1..^1].Trim();
        return t;
    }

    private static bool LooksLikePath(string value) =>
        Path.IsPathRooted(value) || value.Contains('/') || value.Contains('\\') ||
        (value.Length >= 2 && value[1] == ':');

    private static string[] BinaryNames(AgentBackend backend) =>
        backend == AgentBackend.Codex
            ? ["codex.cmd", "codex.exe", "codex.bat", "codex"]
            : ["agent.cmd", "agent.exe", "agent.bat", "agent"];

    private static string? FindOnPath(string[] names)
    {
        try
        {
            foreach (var name in names)
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "where.exe",
                    Arguments = name,
                    RedirectStandardOutput = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                using var p = Process.Start(psi);
                if (p is null) continue;
                var output = p.StandardOutput.ReadToEnd();
                p.WaitForExit(4000);
                foreach (var line in output.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries))
                {
                    var trimmed = line.Trim();
                    if (File.Exists(trimmed)) return trimmed;
                }
            }
        }
        catch { /* ignore */ }
        return null;
    }

    private static string? FindInInstallDirs(AgentBackend backend)
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var dirs = backend == AgentBackend.Codex
            ? new[]
            {
                Path.Combine(local, "Programs", "codex"),
                Path.Combine(local, "codex"),
                Path.Combine(appData, "npm"),
                Path.Combine(home, ".local", "bin"),
                Path.Combine(home, ".codex", "bin"),
            }
            : new[]
            {
                Path.Combine(local, "cursor-agent"),
                Path.Combine(local, "Programs", "cursor-agent"),
                Path.Combine(home, ".local", "bin"),
                Path.Combine(home, ".cursor-agent"),
            };

        var names = BinaryNames(backend);
        foreach (var dir in dirs)
        {
            foreach (var n in names)
            {
                var candidate = Path.Combine(dir, n);
                if (File.Exists(candidate)) return candidate;
            }
            var versions = Path.Combine(dir, "versions");
            if (!Directory.Exists(versions)) continue;
            try
            {
                foreach (var sub in Directory.GetDirectories(versions))
                {
                    foreach (var n in names)
                    {
                        var nested = Path.Combine(sub, n);
                        if (File.Exists(nested)) return nested;
                    }
                }
            }
            catch { /* ignore */ }
        }
        return null;
    }
}

public static class WindowsCmdQuoting
{
    public static string Quote(string arg)
    {
        var trimmed = arg.Trim();
        if (trimmed.Length >= 2 && trimmed.StartsWith('"') && trimmed.EndsWith('"'))
            return trimmed;
        if (!System.Text.RegularExpressions.Regex.IsMatch(trimmed, @"[ \t""&<>|^%!]"))
            return trimmed;
        return "\"" + trimmed.Replace("\"", "\"\"") + "\"";
    }
}

public static class AgentProcessLauncher
{
    public static Process Start(string agentCommand, IReadOnlyList<string> args, string cwd)
    {
        var command = AgentCommandResolver.StripQuotes(agentCommand) ?? agentCommand;
        var psi = new ProcessStartInfo
        {
            WorkingDirectory = cwd,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = false,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        // Windows .cmd paths with spaces: invoke via cmd.exe /c with quoted args
        if (OperatingSystem.IsWindows())
        {
            psi.FileName = "cmd.exe";
            var quoted = new List<string> { "/d", "/c", WindowsCmdQuoting.Quote(command) };
            quoted.AddRange(args.Select(WindowsCmdQuoting.Quote));
            psi.Arguments = string.Join(' ', quoted);
        }
        else
        {
            psi.FileName = command;
            foreach (var a in args) psi.ArgumentList.Add(a);
        }

        var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
        if (!proc.Start()) throw new InvalidOperationException("Failed to start agent process");
        return proc;
    }
}
