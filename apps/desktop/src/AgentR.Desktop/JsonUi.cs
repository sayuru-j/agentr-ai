using System.Text.Json;
using System.Text.Json.Serialization;
using AgentR.Protocol;
using AgentR.Worker.Config;

namespace AgentR.Desktop;

internal static class JsonUi
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNameCaseInsensitive = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public static string StatusName(AgentR.Worker.Core.WorkerStatus status) => status switch
    {
        AgentR.Worker.Core.WorkerStatus.Offline => "offline",
        AgentR.Worker.Core.WorkerStatus.Connecting => "connecting",
        AgentR.Worker.Core.WorkerStatus.Online => "online",
        AgentR.Worker.Core.WorkerStatus.Busy => "busy",
        _ => "offline",
    };

    public static AgentBackend ParseBackend(string? value, AgentBackend fallback = AgentBackend.Cursor)
    {
        if (string.Equals(value, "codex", StringComparison.OrdinalIgnoreCase))
            return AgentBackend.Codex;
        if (string.Equals(value, "cursor", StringComparison.OrdinalIgnoreCase))
            return AgentBackend.Cursor;
        return fallback;
    }

    public static WorkerConfig MergeConfig(WorkerConfig current, JsonElement partial)
    {
        var next = Clone(current);
        if (partial.TryGetProperty("relayUrl", out var u) && u.ValueKind == JsonValueKind.String)
            next.RelayUrl = u.GetString()?.Trim() ?? next.RelayUrl;
        if (partial.TryGetProperty("workerToken", out var t) && t.ValueKind == JsonValueKind.String)
            next.WorkerToken = t.GetString()?.Trim() ?? "";
        if (partial.TryGetProperty("agentBackend", out var b))
            next.AgentBackend = ParseBackend(b.GetString(), next.AgentBackend);
        if (partial.TryGetProperty("agentCommand", out var ac) && ac.ValueKind == JsonValueKind.String)
            next.AgentCommand = ac.GetString()?.Trim() ?? next.AgentCommand;
        if (partial.TryGetProperty("agentModel", out var am) && am.ValueKind == JsonValueKind.String)
            next.AgentModel = am.GetString()?.Trim() ?? next.AgentModel;
        if (partial.TryGetProperty("dryRun", out var dr))
            next.DryRun = dr.ValueKind == JsonValueKind.True;
        if (partial.TryGetProperty("tlsInsecure", out var tls))
            next.TlsInsecure = tls.ValueKind == JsonValueKind.True;
        if (partial.TryGetProperty("openAtLogin", out var ol))
            next.OpenAtLogin = ol.ValueKind == JsonValueKind.True;
        if (partial.TryGetProperty("startMinimized", out var sm))
            next.StartMinimized = sm.ValueKind == JsonValueKind.True;
        if (partial.TryGetProperty("checkUpdates", out var cu))
            next.CheckUpdates = cu.ValueKind == JsonValueKind.True;
        if (partial.TryGetProperty("blockTasksWhenLocked", out var bl))
            next.BlockTasksWhenLocked = bl.ValueKind == JsonValueKind.True;
        if (partial.TryGetProperty("includeGitContext", out var ig))
            next.IncludeGitContext = ig.ValueKind == JsonValueKind.True;
        if (partial.TryGetProperty("approvalScreenshot", out var aps))
            next.ApprovalScreenshot = aps.ValueKind == JsonValueKind.True;
        if (partial.TryGetProperty("maxRuntimeMinutes", out var mr) && mr.TryGetDouble(out var mrd))
            next.MaxRuntimeMinutes = mrd;
        if (partial.TryGetProperty("prompts", out var prompts))
            next.Prompts = WorkerConfigStore.ParsePrompts(prompts);
        if (partial.TryGetProperty("projects", out var projects))
            next.Projects = WorkerConfigStore.ParseProjects(projects);
        return next;
    }

    private static WorkerConfig Clone(WorkerConfig c) => new()
    {
        RelayUrl = c.RelayUrl,
        WorkerToken = c.WorkerToken,
        Projects = c.Projects.ToDictionary(kv => kv.Key, kv => new ProjectEntry
        {
            Path = kv.Value.Path,
            AgentModel = kv.Value.AgentModel,
            DryRun = kv.Value.DryRun,
            Prompts = kv.Value.Prompts is null ? null : new Dictionary<string, string>(kv.Value.Prompts),
            Guardrails = kv.Value.Guardrails,
        }, StringComparer.OrdinalIgnoreCase),
        AgentBackend = c.AgentBackend,
        AgentCommand = c.AgentCommand,
        AgentModel = c.AgentModel,
        DryRun = c.DryRun,
        TlsInsecure = c.TlsInsecure,
        OpenAtLogin = c.OpenAtLogin,
        StartMinimized = c.StartMinimized,
        CheckUpdates = c.CheckUpdates,
        BlockTasksWhenLocked = c.BlockTasksWhenLocked,
        IncludeGitContext = c.IncludeGitContext,
        MaxRuntimeMinutes = c.MaxRuntimeMinutes,
        ApprovalScreenshot = c.ApprovalScreenshot,
        Prompts = c.Prompts is null ? null : new Dictionary<string, string>(c.Prompts),
    };
}
