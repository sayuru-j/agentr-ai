using AgentR.Protocol;
using AgentR.Worker.Agents;
using AgentR.Worker.Runtime;

namespace AgentR.Worker.Agents;

public sealed class AgentDiagnosis : CliDiagnosisSummary
{
    public string Command { get; set; } = "";
    public AgentBackend Backend { get; set; }
    public Dictionary<string, object?>? Profile { get; set; }
}

public static class AgentCliDiagnoser
{
    public static AgentDiagnosis Diagnose(string configured, AgentBackend backend)
    {
        var resolved = AgentCommandResolver.Resolve(configured, backend);
        var errors = new List<string>();
        var warnings = new List<string>();
        if (!resolved.Found)
        {
            errors.Add($"{backend.ToString().ToLowerInvariant()} CLI not found ({resolved.Source})");
            return new AgentDiagnosis
            {
                Ok = false,
                Command = resolved.Command,
                Backend = backend,
                Errors = errors,
            };
        }

        if (!AgentCommandResolver.CommandMatchesBackend(backend, resolved.Command))
            errors.Add($"Configured path looks like the wrong backend for {backend.ToString().ToLowerInvariant()}");

        var version = RunVersion(resolved.Command, backend);
        if (string.IsNullOrEmpty(version)) warnings.Add("Could not read CLI version");

        var help = ReadHelp(resolved.Command, backend);
        if (string.IsNullOrWhiteSpace(help))
            errors.Add("CLI --help returned empty (binary may not run)");

        var profile = new Dictionary<string, object?>();
        if (backend == AgentBackend.Codex)
        {
            var p = CodexCli.DetectProfile(resolved.Command);
            profile["jsonOutput"] = p.JsonOutput;
            profile["sandbox"] = p.Sandbox;
            profile["resumeFlag"] = p.ResumeFlag;
            if (!p.JsonOutput) warnings.Add("Codex CLI may not support --json output");
        }

        return new AgentDiagnosis
        {
            Ok = errors.Count == 0,
            Command = resolved.Command,
            Backend = backend,
            Version = string.IsNullOrEmpty(version) ? null : version,
            Errors = errors.Count > 0 ? errors : null,
            Warnings = warnings.Count > 0 ? warnings : null,
            Profile = profile,
        };
    }

    public static CliDiagnosisSummary ToSummary(AgentDiagnosis d) => new()
    {
        Ok = d.Ok,
        Version = d.Version,
        Errors = d.Errors,
        Warnings = d.Warnings,
    };

    private static string RunVersion(string cmd, AgentBackend backend)
    {
        try
        {
            var text = AgentProcessLauncher.RunCapturing(cmd, ["--version"]).Trim();
            return string.IsNullOrEmpty(text) ? "" : text.Split('\n')[0].Trim();
        }
        catch { return ""; }
    }

    private static string ReadHelp(string cmd, AgentBackend backend)
    {
        try
        {
            var args = backend == AgentBackend.Codex
                ? (IReadOnlyList<string>)["exec", "--help"]
                : ["--help"];
            return AgentProcessLauncher.RunCapturing(cmd, args);
        }
        catch { return ""; }
    }
}
