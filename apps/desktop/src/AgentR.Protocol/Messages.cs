using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace AgentR.Protocol;

/// <summary>Discriminated protocol messages keyed by <c>type</c>.</summary>
public abstract class RelayMessage
{
    [JsonPropertyName("type")]
    public abstract string Type { get; }

    public string ToJson() => JsonSerializer.Serialize(this, GetType(), JsonDefaults.Options);

    public static RelayMessage? Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("type", out var typeEl))
            return null;
        var type = typeEl.GetString();
        return type switch
        {
            "worker.hello" => JsonSerializer.Deserialize<WorkerHello>(json, JsonDefaults.Options),
            "worker.queue" => JsonSerializer.Deserialize<WorkerQueue>(json, JsonDefaults.Options),
            "worker.config" => JsonSerializer.Deserialize<WorkerConfigMessage>(json, JsonDefaults.Options),
            "worker.pong" => JsonSerializer.Deserialize<WorkerPong>(json, JsonDefaults.Options),
            "task.log" => JsonSerializer.Deserialize<TaskLog>(json, JsonDefaults.Options),
            "task.approval_request" => JsonSerializer.Deserialize<TaskApprovalRequest>(json, JsonDefaults.Options),
            "task.status" => JsonSerializer.Deserialize<TaskStatusMessage>(json, JsonDefaults.Options),
            "task.artifact" => JsonSerializer.Deserialize<TaskArtifact>(json, JsonDefaults.Options),
            "file.result" => JsonSerializer.Deserialize<FileResult>(json, JsonDefaults.Options),
            "task.create" => JsonSerializer.Deserialize<TaskCreate>(json, JsonDefaults.Options),
            "screenshot.capture" => JsonSerializer.Deserialize<ScreenshotCapture>(json, JsonDefaults.Options),
            "task.approval_response" => JsonSerializer.Deserialize<TaskApprovalResponse>(json, JsonDefaults.Options),
            "task.cancel" => JsonSerializer.Deserialize<TaskCancel>(json, JsonDefaults.Options),
            "worker.set_config" => JsonSerializer.Deserialize<WorkerSetConfig>(json, JsonDefaults.Options),
            "worker.ping" => JsonSerializer.Deserialize<WorkerPing>(json, JsonDefaults.Options),
            "file.get" => JsonSerializer.Deserialize<FileGet>(json, JsonDefaults.Options),
            "server.ack" => JsonSerializer.Deserialize<ServerAck>(json, JsonDefaults.Options),
            _ => null,
        };
    }
}

public sealed class WorkerHello : RelayMessage
{
    public override string Type => "worker.hello";
    public string Hostname { get; set; } = "";
    public string Version { get; set; } = ProtocolConstants.Version;
    public List<string> Repos { get; set; } = [];
    public string? PairingCode { get; set; }
    public string? AgentModel { get; set; }
    public AgentBackend? AgentBackend { get; set; }
    public bool? SessionLocked { get; set; }
    public int? QueueDepth { get; set; }
    public List<string>? QueueTaskIds { get; set; }
    public CliDiagnosisSummary? CliDiagnosis { get; set; }
    public Dictionary<string, string>? GlobalPrompts { get; set; }
    public List<ProjectMeta>? ProjectMeta { get; set; }
}

public sealed class WorkerQueue : RelayMessage
{
    public override string Type => "worker.queue";
    public string? RunningTaskId { get; set; }
    public List<string> QueuedTaskIds { get; set; } = [];
}

public sealed class WorkerConfigMessage : RelayMessage
{
    public override string Type => "worker.config";
    public string AgentModel { get; set; } = "auto";
}

public sealed class WorkerPong : RelayMessage
{
    public override string Type => "worker.pong";
    public string RequestId { get; set; } = "";
    public long SentAt { get; set; }
    public List<ProjectDisk>? Projects { get; set; }
    public bool? SessionLocked { get; set; }
    public int? QueueDepth { get; set; }
    public List<string>? QueueTaskIds { get; set; }
}

public sealed class TaskLog : RelayMessage
{
    public override string Type => "task.log";
    public string TaskId { get; set; } = "";
    public string Stream { get; set; } = "stdout";
    public string Chunk { get; set; } = "";
    public long Ts { get; set; }
}

public sealed class TaskApprovalRequest : RelayMessage
{
    public override string Type => "task.approval_request";
    public string TaskId { get; set; } = "";
    public string ApprovalId { get; set; } = "";
    public string Command { get; set; } = "";
    public string Reason { get; set; } = "";
    public string? ProjectAlias { get; set; }
    public string? Cwd { get; set; }
    public string? GitBranch { get; set; }
    public bool? GitDirty { get; set; }
    public string? ScreenshotUrl { get; set; }
}

public sealed class TaskStatusMessage : RelayMessage
{
    public override string Type => "task.status";
    public string TaskId { get; set; } = "";
    public TaskStatus Status { get; set; }
    public string? Message { get; set; }
    public int? ExitCode { get; set; }
    public int? QueuePosition { get; set; }
    public string? Summary { get; set; }
    public string? AgentThreadId { get; set; }
}

public sealed class TaskArtifact : RelayMessage
{
    public override string Type => "task.artifact";
    public string TaskId { get; set; } = "";
    public string Name { get; set; } = "";
    public string MimeType { get; set; } = "image/jpeg";
    public string DataBase64 { get; set; } = "";
    public string Kind { get; set; } = "screenshot";
    public string? Label { get; set; }
}

public sealed class FileResult : RelayMessage
{
    public override string Type => "file.result";
    public string RequestId { get; set; } = "";
    public bool Ok { get; set; }
    public string? Error { get; set; }
    public string? Name { get; set; }
    public string? RelativePath { get; set; }
    public string? MimeType { get; set; }
    public int? SizeBytes { get; set; }
    public string? Delivery { get; set; }
    public string? Text { get; set; }
    public bool? Truncated { get; set; }
    public string? DataBase64 { get; set; }
}

public sealed class TaskCreate : RelayMessage
{
    public override string Type => "task.create";
    public string TaskId { get; set; } = "";
    public string Prompt { get; set; } = "";
    public string ThreadId { get; set; } = "";
    public string? ProjectAlias { get; set; }
    public ConversationRef Conversation { get; set; } = new();
    public List<TaskFile>? Files { get; set; }
    public string? AgentModel { get; set; }
    public string? ParentTaskId { get; set; }
    public ResumeMode? ResumeMode { get; set; }
    public ResumeContext? ResumeContext { get; set; }
}

public sealed class ScreenshotCapture : RelayMessage
{
    public override string Type => "screenshot.capture";
    public string RequestId { get; set; } = "";
    public string Quality { get; set; } = "preview";
}

public sealed class TaskApprovalResponse : RelayMessage
{
    public override string Type => "task.approval_response";
    public string TaskId { get; set; } = "";
    public string ApprovalId { get; set; } = "";
    public string Decision { get; set; } = "approve";
}

public sealed class TaskCancel : RelayMessage
{
    public override string Type => "task.cancel";
    public string TaskId { get; set; } = "";
}

public sealed class WorkerSetConfig : RelayMessage
{
    public override string Type => "worker.set_config";
    public string? AgentModel { get; set; }
}

public sealed class WorkerPing : RelayMessage
{
    public override string Type => "worker.ping";
    public string RequestId { get; set; } = "";
    public long SentAt { get; set; }
}

public sealed class FileGet : RelayMessage
{
    public override string Type => "file.get";
    public string RequestId { get; set; } = "";
    public string ProjectAlias { get; set; } = "";
    public string RelativePath { get; set; } = "";
}

public sealed class ServerAck : RelayMessage
{
    public override string Type => "server.ack";
    public string Message { get; set; } = "";
    public string? PairingCode { get; set; }
    public int? PairedUsers { get; set; }
}
