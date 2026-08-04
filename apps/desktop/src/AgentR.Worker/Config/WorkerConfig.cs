using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using AgentR.Protocol;

namespace AgentR.Worker.Config;

public sealed class ProjectEntry
{
    public string Path { get; set; } = "";
    public string? AgentModel { get; set; }
    public bool? DryRun { get; set; }
    public Dictionary<string, string>? Prompts { get; set; }
    public ProjectGuardrails? Guardrails { get; set; }
}

public sealed class WorkerConfig
{
    public string RelayUrl { get; set; } = "wss://agent.example.com/ws";
    public string WorkerToken { get; set; } = "";
    public Dictionary<string, ProjectEntry> Projects { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    public AgentBackend AgentBackend { get; set; } = AgentBackend.Cursor;
    public string AgentCommand { get; set; } = "agent";
    public string AgentModel { get; set; } = "auto";
    public bool DryRun { get; set; }
    public bool? TlsInsecure { get; set; }
    public bool? OpenAtLogin { get; set; }
    public bool? StartMinimized { get; set; } = true;
    public bool? CheckUpdates { get; set; } = true;
    public bool? BlockTasksWhenLocked { get; set; } = true;
    public bool? IncludeGitContext { get; set; } = true;
    public double MaxRuntimeMinutes { get; set; }
    public bool? ApprovalScreenshot { get; set; }
    public Dictionary<string, string>? Prompts { get; set; }
}

public static class WorkerPaths
{
    public static string ConfigDir =>
        System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".agent-relay");

    public static string ConfigPath => System.IO.Path.Combine(ConfigDir, "config.json");
    public static string TaskContextPath => System.IO.Path.Combine(ConfigDir, "task-context.json");

    public static void EnsureConfigDir() => Directory.CreateDirectory(ConfigDir);
}

public static class WorkerConfigStore
{
    public static string DefaultCommand(AgentBackend backend) =>
        backend == AgentBackend.Codex ? "codex" : "agent";

    public static string DefaultModel(AgentBackend backend) =>
        backend == AgentBackend.Codex ? "gpt-5.4" : "auto";

    public static WorkerConfig Default() => new()
    {
        AgentBackend = AgentBackend.Cursor,
        AgentCommand = "agent",
        AgentModel = "auto",
        StartMinimized = true,
        CheckUpdates = true,
        BlockTasksWhenLocked = true,
        IncludeGitContext = true,
    };

    public static WorkerConfig Load(string? path = null)
    {
        path ??= WorkerPaths.ConfigPath;
        if (!File.Exists(path)) return Default();

        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var root = doc.RootElement;
        var cfg = Default();

        if (root.TryGetProperty("relayUrl", out var u)) cfg.RelayUrl = u.GetString()?.Trim() ?? cfg.RelayUrl;
        if (root.TryGetProperty("workerToken", out var t)) cfg.WorkerToken = t.GetString()?.Trim() ?? "";
        if (root.TryGetProperty("agentBackend", out var b) &&
            string.Equals(b.GetString(), "codex", StringComparison.OrdinalIgnoreCase))
            cfg.AgentBackend = AgentBackend.Codex;

        var fallbackCmd = DefaultCommand(cfg.AgentBackend);
        cfg.AgentCommand = StripQuotes(root.TryGetProperty("agentCommand", out var ac)
            ? ac.GetString() ?? fallbackCmd
            : fallbackCmd) ?? fallbackCmd;
        cfg.AgentModel = (root.TryGetProperty("agentModel", out var am)
            ? am.GetString()
            : null)?.Trim() ?? DefaultModel(cfg.AgentBackend);
        if (string.IsNullOrEmpty(cfg.AgentModel)) cfg.AgentModel = DefaultModel(cfg.AgentBackend);

        cfg.DryRun = root.TryGetProperty("dryRun", out var dr) && dr.ValueKind == JsonValueKind.True;
        cfg.TlsInsecure = GetBool(root, "tlsInsecure");
        cfg.OpenAtLogin = GetBool(root, "openAtLogin") ?? false;
        cfg.StartMinimized = GetBool(root, "startMinimized") ?? true;
        cfg.CheckUpdates = GetBool(root, "checkUpdates") ?? true;
        cfg.BlockTasksWhenLocked = GetBool(root, "blockTasksWhenLocked") ?? true;
        cfg.IncludeGitContext = GetBool(root, "includeGitContext") ?? true;
        cfg.ApprovalScreenshot = GetBool(root, "approvalScreenshot") ?? false;
        if (root.TryGetProperty("maxRuntimeMinutes", out var mr) && mr.TryGetDouble(out var mrd))
            cfg.MaxRuntimeMinutes = mrd;
        if (root.TryGetProperty("prompts", out var prompts))
            cfg.Prompts = CoercePrompts(prompts);
        if (root.TryGetProperty("projects", out var projects))
            cfg.Projects = CoerceProjects(projects);

        return cfg;
    }

    public static void Save(WorkerConfig config, string? path = null)
    {
        path ??= WorkerPaths.ConfigPath;
        WorkerPaths.EnsureConfigDir();
        var cleaned = new WorkerConfig
        {
            RelayUrl = config.RelayUrl.Trim(),
            WorkerToken = config.WorkerToken.Trim(),
            AgentBackend = config.AgentBackend,
            AgentCommand = StripQuotes(config.AgentCommand) ?? DefaultCommand(config.AgentBackend),
            AgentModel = string.IsNullOrWhiteSpace(config.AgentModel)
                ? DefaultModel(config.AgentBackend)
                : config.AgentModel.Trim(),
            DryRun = config.DryRun,
            TlsInsecure = config.TlsInsecure,
            OpenAtLogin = config.OpenAtLogin,
            StartMinimized = config.StartMinimized,
            CheckUpdates = config.CheckUpdates,
            BlockTasksWhenLocked = config.BlockTasksWhenLocked,
            IncludeGitContext = config.IncludeGitContext,
            MaxRuntimeMinutes = config.MaxRuntimeMinutes,
            ApprovalScreenshot = config.ApprovalScreenshot,
            Prompts = config.Prompts,
            Projects = config.Projects,
        };
        var json = JsonSerializer.Serialize(cleaned, new JsonSerializerOptions
        {
            WriteIndented = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
        });
        File.WriteAllText(path, json + "\n", Encoding.UTF8);
    }

    public static string ProjectPath(ProjectEntry? entry) => entry?.Path ?? "";

    public static ProjectGuardrails? ResolveGuardrails(WorkerConfig _, ProjectEntry? project) =>
        project?.Guardrails is null ? null : project.Guardrails;

    public static double ResolveMaxRuntimeMinutes(WorkerConfig config, ProjectEntry? project)
    {
        if (project?.Guardrails?.MaxRuntimeMinutes is double d && d > 0) return d;
        return config.MaxRuntimeMinutes;
    }

    public static Dictionary<string, ProjectEntry> ParseProjects(JsonElement raw) => CoerceProjects(raw);

    public static Dictionary<string, string>? ParsePrompts(JsonElement raw) => CoercePrompts(raw);

    private static bool? GetBool(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var el)) return null;
        return el.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null,
        };
    }

    private static string? StripQuotes(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return value;
        var t = value.Trim();
        if (t.Length >= 2 && ((t[0] == '"' && t[^1] == '"') || (t[0] == '\'' && t[^1] == '\'')))
            return t[1..^1].Trim();
        return t;
    }

    private static Dictionary<string, string>? CoercePrompts(JsonElement raw)
    {
        if (raw.ValueKind != JsonValueKind.Object) return null;
        var outDict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in raw.EnumerateObject())
        {
            if (p.Value.ValueKind == JsonValueKind.String)
            {
                var v = p.Value.GetString();
                if (!string.IsNullOrWhiteSpace(p.Name) && v is not null)
                    outDict[p.Name.Trim()] = v;
            }
        }
        return outDict.Count > 0 ? outDict : null;
    }

    private static Dictionary<string, ProjectEntry> CoerceProjects(JsonElement raw)
    {
        var outDict = new Dictionary<string, ProjectEntry>(StringComparer.OrdinalIgnoreCase);
        if (raw.ValueKind != JsonValueKind.Object) return outDict;
        foreach (var p in raw.EnumerateObject())
        {
            var key = p.Name.Trim();
            if (string.IsNullOrEmpty(key)) continue;
            if (p.Value.ValueKind == JsonValueKind.String)
            {
                var path = p.Value.GetString()?.Trim();
                if (!string.IsNullOrEmpty(path)) outDict[key] = new ProjectEntry { Path = path };
                continue;
            }
            if (p.Value.ValueKind != JsonValueKind.Object) continue;
            if (!p.Value.TryGetProperty("path", out var pathEl)) continue;
            var pathVal = pathEl.GetString()?.Trim();
            if (string.IsNullOrEmpty(pathVal)) continue;
            var entry = new ProjectEntry { Path = pathVal };
            if (p.Value.TryGetProperty("agentModel", out var m) && m.ValueKind == JsonValueKind.String)
                entry.AgentModel = m.GetString()?.Trim();
            if (p.Value.TryGetProperty("dryRun", out var dry))
                entry.DryRun = dry.ValueKind == JsonValueKind.True;
            if (p.Value.TryGetProperty("prompts", out var prompts))
                entry.Prompts = CoercePrompts(prompts);
            if (p.Value.TryGetProperty("guardrails", out var g))
                entry.Guardrails = JsonSerializer.Deserialize<ProjectGuardrails>(g.GetRawText(), JsonDefaults.Options);
            outDict[key] = entry;
        }
        return outDict;
    }
}
