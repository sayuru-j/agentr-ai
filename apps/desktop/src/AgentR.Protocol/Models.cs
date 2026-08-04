using System.Text.Json;
using System.Text.Json.Serialization;

namespace AgentR.Protocol;

public static class ProtocolConstants
{
    public const string Version = "0.3.0";
    public const string WsPath = "/ws";
}

public static class JsonDefaults
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNameCaseInsensitive = true,
        WriteIndented = false,
    };

    static JsonDefaults()
    {
        Options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
    }
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum TaskStatus
{
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ResumeMode
{
    Continue,
    Fresh,
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum AgentBackend
{
    Cursor,
    Codex,
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum RiskTier
{
    Block,
    Approve,
    Allow,
}

public sealed class ConversationRef
{
    public string ServiceUrl { get; set; } = "";
    public string ConversationId { get; set; } = "";
    public string? ActivityId { get; set; }
    public string? TenantId { get; set; }
}

public sealed class TaskFile
{
    public string Name { get; set; } = "";
    public string DataBase64 { get; set; } = "";
    public string? MimeType { get; set; }
}

public sealed class ResumeContext
{
    public string ParentTaskId { get; set; } = "";
    public string? AgentThreadId { get; set; }
    public string? LogSummary { get; set; }
    public string? PriorPrompt { get; set; }
}

public class CliDiagnosisSummary
{
    public bool Ok { get; set; }
    public string? Version { get; set; }
    public List<string>? Errors { get; set; }
    public List<string>? Warnings { get; set; }
}

public sealed class ProjectGuardrails
{
    public bool? ReadOnly { get; set; }
    public bool? RequireApproval { get; set; }
    public double? MaxRuntimeMinutes { get; set; }
    public List<string>? DenyPatterns { get; set; }
    public List<string>? AllowPatterns { get; set; }
    public bool? BlockWhenLocked { get; set; }
}

public sealed class ProjectMeta
{
    public string Alias { get; set; } = "";
    public Dictionary<string, string>? Prompts { get; set; }
    public ProjectGuardrails? Guardrails { get; set; }
}

public sealed class ProjectDisk
{
    public string Alias { get; set; } = "";
    public string Path { get; set; } = "";
    public long? FreeBytes { get; set; }
    public long? TotalBytes { get; set; }
    public string? Error { get; set; }
}

public sealed class RiskMatch
{
    public string Command { get; set; } = "";
    public string Reason { get; set; } = "";
    public RiskTier Tier { get; set; } = RiskTier.Approve;
}
