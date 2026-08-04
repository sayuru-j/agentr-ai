using System.Text.Json;
using System.Text.Json.Serialization;

namespace AgentR.Worker.Context;

public sealed class TaskContextEntry
{
    public string TaskId { get; set; } = "";
    public string ConversationId { get; set; } = "";
    public string? ProjectAlias { get; set; }
    public string? AgentThreadId { get; set; }
    public string Prompt { get; set; } = "";
    public string LogSummary { get; set; } = "";
    public int? ExitCode { get; set; }
    public long FinishedAt { get; set; }
}

public static class TaskContextStore
{
    private const int MaxEntries = 200;

    private sealed class Store
    {
        public List<TaskContextEntry> Entries { get; set; } = [];
    }

    public static void Save(TaskContextEntry entry)
    {
        var store = Load();
        store.Entries.RemoveAll(e =>
            e.ConversationId == entry.ConversationId && e.ProjectAlias == entry.ProjectAlias);
        store.Entries.Insert(0, entry);
        if (store.Entries.Count > MaxEntries)
            store.Entries = store.Entries.Take(MaxEntries).ToList();
        Persist(store);
    }

    public static TaskContextEntry? Get(string conversationId, string? projectAlias = null)
    {
        var store = Load();
        if (!string.IsNullOrEmpty(projectAlias))
            return store.Entries.FirstOrDefault(e =>
                e.ConversationId == conversationId && e.ProjectAlias == projectAlias);
        return store.Entries.FirstOrDefault(e => e.ConversationId == conversationId);
    }

    public static string SummarizeLogs(IEnumerable<string> logs, int maxLen = 2000)
    {
        var text = string.Concat(logs).Trim();
        if (text.Length <= maxLen) return text;
        return "…\n" + text[^maxLen..];
    }

    public static string BuildResumePrompt(string? priorPrompt, string? logSummary, string userPrompt)
    {
        var parts = new List<string> { "## Continue from previous task" };
        if (!string.IsNullOrWhiteSpace(priorPrompt))
            parts.Add($"Previous prompt: {priorPrompt}");
        if (!string.IsNullOrWhiteSpace(logSummary))
            parts.Add($"Previous output (tail):\n```\n{logSummary}\n```");
        parts.Add("## New instruction");
        parts.Add(string.IsNullOrWhiteSpace(userPrompt) ? "Continue where you left off." : userPrompt.Trim());
        return string.Join("\n\n", parts);
    }

    private static Store Load()
    {
        var path = Config.WorkerPaths.TaskContextPath;
        if (!File.Exists(path)) return new Store();
        try
        {
            return JsonSerializer.Deserialize<Store>(File.ReadAllText(path), Options) ?? new Store();
        }
        catch
        {
            return new Store();
        }
    }

    private static void Persist(Store store)
    {
        Config.WorkerPaths.EnsureConfigDir();
        File.WriteAllText(Config.WorkerPaths.TaskContextPath, JsonSerializer.Serialize(store, Options) + "\n");
    }

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}
