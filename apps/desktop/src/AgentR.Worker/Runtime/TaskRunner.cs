using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using AgentR.Protocol;
using AgentR.Worker.Context;

namespace AgentR.Worker.Runtime;

public sealed class RunTaskOptions
{
    public string TaskId { get; set; } = "";
    public string Prompt { get; set; } = "";
    public string Cwd { get; set; } = "";
    public string AgentCommand { get; set; } = "agent";
    public AgentBackend AgentBackend { get; set; } = AgentBackend.Cursor;
    public string AgentModel { get; set; } = "auto";
    public bool DryRun { get; set; }
    public ProjectGuardrails? Guardrails { get; set; }
    public double MaxRuntimeMinutes { get; set; }
    public ResumeMode? ResumeMode { get; set; }
    public ResumeContext? ResumeContext { get; set; }
    public required Func<string, string, RiskTier, Task<bool>> RequestApproval { get; set; }
    public required Action<string, string> OnLog { get; set; }
    public Action<string>? OnAgentThreadId { get; set; }
}

public sealed class TaskRunResult
{
    public int ExitCode { get; set; }
    public string? AgentThreadId { get; set; }
    public string LogText { get; set; } = "";
}

public sealed class TaskRunner
{
    private Process? _child;
    private bool _killed;
    private CancellationTokenSource? _runtimeCts;

    public async Task<TaskRunResult> RunAsync(RunTaskOptions opts, CancellationToken ct = default)
    {
        var log = new StringBuilder();
        void OnLog(string stream, string chunk)
        {
            log.Append(chunk);
            opts.OnLog(stream, chunk);
        }

        if (opts.Guardrails?.ReadOnly == true || opts.DryRun)
        {
            var code = await RunDryAsync(opts, OnLog, ct).ConfigureAwait(false);
            return new TaskRunResult { ExitCode = code, LogText = log.ToString() };
        }

        var model = string.IsNullOrWhiteSpace(opts.AgentModel)
            ? (opts.AgentBackend == AgentBackend.Codex ? "gpt-5.4" : "auto")
            : opts.AgentModel.Trim();
        var prompt = ResolvePrompt(opts);
        var args = opts.AgentBackend == AgentBackend.Codex
            ? CodexCli.BuildArgs(opts.Cwd, model, prompt, opts.AgentCommand, opts.ResumeMode, opts.ResumeContext)
            : CursorCli.BuildArgs(opts.Cwd, model, prompt, opts.AgentCommand, opts.ResumeMode, opts.ResumeContext);

        string? threadId = null;
        void CaptureThread(string id)
        {
            threadId ??= id;
            opts.OnAgentThreadId?.Invoke(id);
        }

        Process child;
        try
        {
            child = Agents.AgentProcessLauncher.Start(opts.AgentCommand, args, opts.Cwd);
        }
        catch (Exception ex)
        {
            OnLog("stderr", $"\n[agent-relay] Failed to spawn: {ex.Message}\n");
            return new TaskRunResult { ExitCode = 1, LogText = log.ToString() };
        }

        _child = child;
        ILineDecoder decoder = opts.AgentBackend == AgentBackend.Codex
            ? new CodexJsonlDecoder(CaptureThread)
            : new CursorStreamJsonDecoder(CaptureThread);

        if (opts.MaxRuntimeMinutes > 0)
        {
            _runtimeCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            _ = Task.Delay(TimeSpan.FromMinutes(opts.MaxRuntimeMinutes), _runtimeCts.Token).ContinueWith(_ =>
            {
                if (!_runtimeCts.IsCancellationRequested)
                {
                    OnLog("stderr", $"\n[agent-relay] Max runtime ({opts.MaxRuntimeMinutes} min) exceeded — cancelling\n");
                    Cancel();
                }
            }, TaskScheduler.Default);
        }

        var stdoutTask = PumpAsync(child.StandardOutput, "stdout", decoder, opts, OnLog, ct);
        var stderrTask = PumpAsync(child.StandardError, "stderr", null, opts, OnLog, ct);
        await Task.WhenAll(stdoutTask, stderrTask).ConfigureAwait(false);
        await child.WaitForExitAsync(ct).ConfigureAwait(false);
        _runtimeCts?.Cancel();

        foreach (var leftover in decoder.Flush())
            OnLog("stdout", leftover);

        var exit = _killed ? 130 : child.ExitCode;
        _child = null;
        return new TaskRunResult
        {
            ExitCode = exit,
            AgentThreadId = threadId,
            LogText = log.ToString(),
        };
    }

    public void Cancel()
    {
        _killed = true;
        try { _runtimeCts?.Cancel(); } catch { /* ignore */ }
        if (_child is { HasExited: false })
        {
            try { _child.Kill(entireProcessTree: true); } catch { /* ignore */ }
        }
    }

    private async Task PumpAsync(
        StreamReader reader,
        string stream,
        ILineDecoder? decoder,
        RunTaskOptions opts,
        Action<string, string> onLog,
        CancellationToken ct)
    {
        var buf = new char[4096];
        while (!ct.IsCancellationRequested)
        {
            int n;
            try { n = await reader.ReadAsync(buf.AsMemory(0, buf.Length), ct).ConfigureAwait(false); }
            catch { break; }
            if (n <= 0) break;
            var chunk = new string(buf, 0, n);
            var pieces = decoder is not null ? decoder.Push(chunk) : [chunk];
            foreach (var piece in pieces)
            {
                onLog(stream, piece);
                foreach (var line in piece.Split('\n'))
                {
                    var risk = RiskMatcher.MatchRiskWithGuardrails(line, opts.Guardrails);
                    if (risk is null) continue;
                    if (risk.Tier == RiskTier.Block)
                    {
                        onLog("stderr", $"\n[agent-relay] Blocked: {risk.Command}\n");
                        Cancel();
                        return;
                    }
                    var approved = await opts.RequestApproval(risk.Command, risk.Reason, RiskTier.Approve)
                        .ConfigureAwait(false);
                    if (!approved)
                    {
                        onLog("stderr", $"\n[agent-relay] Rejected: {risk.Command}\n");
                        Cancel();
                        return;
                    }
                    onLog("stdout", $"\n[agent-relay] Approved: {risk.Command}\n");
                }
            }
        }
    }

    private static async Task<int> RunDryAsync(RunTaskOptions opts, Action<string, string> onLog, CancellationToken ct)
    {
        onLog("stdout", $"[dry-run] Backend: {opts.AgentBackend.ToString().ToLowerInvariant()}\n");
        onLog("stdout", $"[dry-run] Starting task in {opts.Cwd}\n");
        onLog("stdout", $"[dry-run] Prompt: {opts.Prompt}\n");
        if (opts.Prompt.Contains("npm install", StringComparison.OrdinalIgnoreCase) ||
            opts.Prompt.Contains("--approve-test"))
        {
            var ok = await opts.RequestApproval("npm install", "Package install/uninstall modifies node_modules", RiskTier.Approve)
                .ConfigureAwait(false);
            if (!ok)
            {
                onLog("stderr", "[dry-run] Approval rejected — aborting\n");
                return 1;
            }
            onLog("stdout", "[dry-run] Approval granted — continuing\n");
        }
        foreach (var w in "[dry-run] Streaming sample output from AgentR…\n".Split(' '))
        {
            onLog("stdout", w.EndsWith('\n') ? w : w + " ");
            await Task.Delay(40, ct).ConfigureAwait(false);
        }
        onLog("stdout", "[dry-run] Done.\n");
        return 0;
    }

    private static string ResolvePrompt(RunTaskOptions opts)
    {
        var body = opts.Prompt.Trim();
        if (opts.ResumeMode == ResumeMode.Continue && opts.ResumeContext is not null)
        {
            var profile = CodexCli.DetectProfile(opts.AgentCommand);
            var help = ReadHelp(opts.AgentCommand, opts.AgentBackend);
            var hasNative = opts.AgentBackend == AgentBackend.Codex
                ? !string.IsNullOrEmpty(opts.ResumeContext.AgentThreadId) &&
                  (!string.IsNullOrEmpty(profile.ResumeFlag) || !string.IsNullOrEmpty(profile.ThreadFlag))
                : !string.IsNullOrEmpty(opts.ResumeContext.AgentThreadId) &&
                  help.Contains("--resume", StringComparison.Ordinal);
            if (!hasNative)
            {
                body = TaskContextStore.BuildResumePrompt(
                    opts.ResumeContext.PriorPrompt,
                    opts.ResumeContext.LogSummary,
                    body);
            }
        }
        return body + "\n\nReply in Markdown.";
    }

    private static string ReadHelp(string command, AgentBackend backend)
    {
        try
        {
            var cmd = Agents.AgentCommandResolver.StripQuotes(command) ?? command;
            var args = backend == AgentBackend.Codex
                ? (IReadOnlyList<string>)["exec", "--help"]
                : ["--help"];
            return Agents.AgentProcessLauncher.RunCapturing(cmd, args);
        }
        catch { return ""; }
    }

    public static string BuildTaskSummary(string logText, int exitCode)
    {
        var lines = logText.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim())
            .Where(l => l.Length > 0 && !l.StartsWith("[agent") && !l.StartsWith("[codex]"))
            .TakeLast(3)
            .ToList();
        var tail = string.Join(" · ", lines);
        if (tail.Length > 200) tail = tail[..200];
        if (exitCode == 0) return string.IsNullOrEmpty(tail) ? "Completed successfully" : tail;
        if (exitCode == 130) return "Cancelled";
        return string.IsNullOrEmpty(tail) ? $"Failed with exit code {exitCode}" : tail;
    }
}

internal interface ILineDecoder
{
    IEnumerable<string> Push(string chunk);
    IEnumerable<string> Flush();
}

internal sealed class CursorStreamJsonDecoder(Action<string>? onSessionId) : ILineDecoder
{
    private string _buffer = "";
    private bool _seenPartial;
    private string? _sessionId;

    public IEnumerable<string> Push(string chunk)
    {
        _buffer += chunk;
        var lines = _buffer.Split('\n');
        _buffer = lines[^1];
        var outList = new List<string>();
        for (var i = 0; i < lines.Length - 1; i++)
        {
            var t = DecodeLine(lines[i]);
            if (t is not null) outList.Add(t);
        }
        return outList;
    }

    public IEnumerable<string> Flush()
    {
        if (string.IsNullOrWhiteSpace(_buffer)) return [];
        var t = DecodeLine(_buffer);
        _buffer = "";
        return t is null ? [] : [t];
    }

    private string? DecodeLine(string line)
    {
        var trimmed = line.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;
        if (trimmed[0] != '{') return line.EndsWith('\n') ? line : line + "\n";
        try
        {
            using var doc = JsonDocument.Parse(trimmed);
            var root = doc.RootElement;
            var type = root.TryGetProperty("type", out var t) ? t.GetString() : null;
            if (type == "system" && root.TryGetProperty("subtype", out var st) && st.GetString() == "init")
            {
                foreach (var key in new[] { "session_id", "conversation_id", "thread_id" })
                {
                    if (root.TryGetProperty(key, out var sid) && sid.ValueKind == JsonValueKind.String)
                    {
                        Capture(sid.GetString()!);
                        break;
                    }
                }
                var model = root.TryGetProperty("model", out var m) ? m.GetString() ?? "?" : "?";
                return $"[agent] {model}\n";
            }
            if (type == "assistant")
            {
                var text = ExtractAssistantText(root);
                if (string.IsNullOrEmpty(text)) return null;
                if (root.TryGetProperty("model_call_id", out _)) return null;
                if (root.TryGetProperty("timestamp_ms", out _))
                {
                    _seenPartial = true;
                    return text;
                }
                if (_seenPartial) return null;
                return text;
            }
            if (type == "tool_call" && root.TryGetProperty("subtype", out var sub) && sub.GetString() == "started")
            {
                var name = "tool";
                if (root.TryGetProperty("tool_call", out var tc) && tc.ValueKind == JsonValueKind.Object)
                {
                    foreach (var p in tc.EnumerateObject())
                    {
                        name = p.Name.Replace("ToolCall", "");
                        break;
                    }
                }
                return $"\n⚙ {name}…\n";
            }
            if (type == "result" && root.TryGetProperty("is_error", out var err) && err.GetBoolean())
                return $"\n[error] {(root.TryGetProperty("result", out var r) ? r.ToString() : "failed")}\n";
        }
        catch
        {
            return line + "\n";
        }
        return null;
    }

    private void Capture(string id)
    {
        if (_sessionId is null)
        {
            _sessionId = id;
            onSessionId?.Invoke(id);
        }
    }

    private static string ExtractAssistantText(JsonElement root)
    {
        if (!root.TryGetProperty("message", out var msg)) return "";
        if (!msg.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array)
            return "";
        var sb = new StringBuilder();
        foreach (var c in content.EnumerateArray())
        {
            if (c.TryGetProperty("type", out var ty) && ty.GetString() == "text" &&
                c.TryGetProperty("text", out var tx))
                sb.Append(tx.GetString());
        }
        return sb.ToString();
    }
}

internal sealed class CodexJsonlDecoder(Action<string>? onThreadId) : ILineDecoder
{
    private string _buffer = "";

    public IEnumerable<string> Push(string chunk)
    {
        _buffer += chunk;
        var lines = _buffer.Split('\n');
        _buffer = lines[^1];
        var outList = new List<string>();
        for (var i = 0; i < lines.Length - 1; i++)
        {
            var t = DecodeLine(lines[i]);
            if (t is not null) outList.Add(t);
        }
        return outList;
    }

    public IEnumerable<string> Flush()
    {
        if (string.IsNullOrWhiteSpace(_buffer)) return [];
        var t = DecodeLine(_buffer);
        _buffer = "";
        return t is null ? [] : [t];
    }

    private string? DecodeLine(string line)
    {
        var trimmed = line.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;
        if (trimmed[0] != '{') return line.EndsWith('\n') ? line : line + "\n";
        try
        {
            using var doc = JsonDocument.Parse(trimmed);
            return Format(doc.RootElement);
        }
        catch
        {
            return line + "\n";
        }
    }

    private string? Format(JsonElement ev)
    {
        var type = ev.TryGetProperty("type", out var t) ? t.GetString() ?? "" : "";
        if (type == "thread.started")
        {
            var id = Pick(ev, "thread_id", "id");
            if (id is not null) onThreadId?.Invoke(id);
            return id is not null ? $"[codex] thread {id}\n" : "[codex] started\n";
        }
        if (type == "turn.started") return "[codex] turn…\n";
        if (type is "turn.failed" or "error")
            return $"\n[error] {Pick(ev, "error", "message") ?? "failed"}\n";
        if (type.StartsWith("item."))
        {
            var item = ev.TryGetProperty("item", out var it) ? it : ev;
            var itemType = item.TryGetProperty("type", out var ity) ? ity.GetString() ?? "" :
                item.TryGetProperty("item_type", out var ity2) ? ity2.GetString() ?? "" : "";
            var text = Pick(item, "text", "message", "content", "output");
            if (itemType.Contains("message") || itemType == "assistant")
            {
                if (type.EndsWith(".delta") && text is not null) return text;
                if ((type.EndsWith(".completed") || type == "item.completed") && text is not null)
                    return text.EndsWith('\n') ? text : text + "\n";
            }
            if (itemType.Contains("command") || itemType.Contains("tool") || itemType.Contains("execution"))
            {
                if (type.EndsWith(".started"))
                    return $"\n⚙ {Pick(item, "command", "name", "tool", "title") ?? "command"}…\n";
                if (type.EndsWith(".completed") && text is not null)
                    return text.EndsWith('\n') ? text : text + "\n";
            }
            if (type.EndsWith(".started") && !string.IsNullOrEmpty(itemType))
                return $"\n⚙ {itemType}…\n";
        }
        if (ev.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object)
            return Format(data);
        return null;
    }

    private static string? Pick(JsonElement el, params string[] keys)
    {
        foreach (var k in keys)
        {
            if (!el.TryGetProperty(k, out var v)) continue;
            if (v.ValueKind == JsonValueKind.String)
            {
                var s = v.GetString();
                if (!string.IsNullOrWhiteSpace(s)) return s;
            }
            else if (v.ValueKind == JsonValueKind.Object && v.TryGetProperty("message", out var msg))
            {
                var s = msg.GetString();
                if (!string.IsNullOrWhiteSpace(s)) return s;
            }
        }
        return null;
    }
}

public static class CursorCli
{
    public static List<string> BuildArgs(
        string cwd, string model, string prompt, string agentCommand,
        ResumeMode? resumeMode, ResumeContext? resumeContext)
    {
        var args = new List<string>
        {
            "--print", "--output-format", "stream-json", "--stream-partial-output",
            "--trust", "--force", "--model", model, $"--workspace={cwd}",
        };
        if (resumeMode == ResumeMode.Continue &&
            !string.IsNullOrEmpty(resumeContext?.AgentThreadId) &&
            HelpHas(agentCommand, "--resume"))
        {
            args.Add("--resume");
            args.Add(resumeContext!.AgentThreadId!);
        }
        args.Add(prompt);
        return args;
    }

    private static bool HelpHas(string command, string flag)
    {
        try
        {
            var cmd = Agents.AgentCommandResolver.StripQuotes(command) ?? command;
            var text = Agents.AgentProcessLauncher.RunCapturing(cmd, ["--help"]);
            return text.Contains(flag, StringComparison.Ordinal);
        }
        catch { return false; }
    }
}

public sealed class CodexCliProfile
{
    public bool JsonOutput { get; set; }
    public bool SkipGitRepoCheck { get; set; }
    public bool ConfigApprovalNever { get; set; }
    public bool ModelShort { get; set; }
    public bool ModelLong { get; set; }
    public bool ModelConfig { get; set; }
    public bool CdShort { get; set; }
    public bool CdLong { get; set; }
    public string? Sandbox { get; set; }
    public string? ResumeFlag { get; set; }
    public string? ThreadFlag { get; set; }
}

public static class CodexCli
{
    private static readonly Dictionary<string, CodexCliProfile> Cache = new();

    public static CodexCliProfile DetectProfile(string agentCommand)
    {
        var key = Agents.AgentCommandResolver.StripQuotes(agentCommand) ?? "codex";
        if (Cache.TryGetValue(key, out var cached)) return cached;
        var help = ReadExecHelp(key);
        var profile = new CodexCliProfile
        {
            JsonOutput = Regex.IsMatch(help, @"--json\b"),
            SkipGitRepoCheck = Regex.IsMatch(help, @"--skip-git-repo-check\b"),
            ConfigApprovalNever = Regex.IsMatch(help, @"(?:--config\b|-c,)"),
            ModelShort = Regex.IsMatch(help, @"-m,\s*--model\b"),
            ModelLong = Regex.IsMatch(help, @"--model\s+<MODEL>", RegexOptions.IgnoreCase),
            ModelConfig = Regex.IsMatch(help, @"(?:--config\b|-c,)"),
            CdShort = Regex.IsMatch(help, @"-C,\s*--cd\b"),
            CdLong = Regex.IsMatch(help, @"--cd\s+<DIR>", RegexOptions.IgnoreCase),
        };
        if (help.Contains("workspace-write")) profile.Sandbox = "workspace-write";
        else if (Regex.IsMatch(help, @"enabled,\s*disabled", RegexOptions.IgnoreCase) ||
                 help.Contains("[possible values: enabled"))
            profile.Sandbox = "enabled";
        if (Regex.IsMatch(help, @"--resume\b")) profile.ResumeFlag = "--resume";
        else if (Regex.IsMatch(help, @"-t,\s*--thread")) profile.ThreadFlag = "-t";
        else if (Regex.IsMatch(help, @"--thread\b")) profile.ThreadFlag = "--thread";
        Cache[key] = profile;
        return profile;
    }

    public static List<string> BuildArgs(
        string cwd, string model, string prompt, string agentCommand,
        ResumeMode? resumeMode, ResumeContext? resumeContext)
    {
        var profile = DetectProfile(agentCommand);
        var args = new List<string> { "exec" };
        if (profile.JsonOutput) args.Add("--json");
        if (profile.SkipGitRepoCheck) args.Add("--skip-git-repo-check");
        if (profile.Sandbox is not null) { args.Add("--sandbox"); args.Add(profile.Sandbox); }
        if (profile.ConfigApprovalNever) { args.Add("-c"); args.Add("approval_policy=never"); }

        if (resumeMode == ResumeMode.Continue && !string.IsNullOrEmpty(resumeContext?.AgentThreadId))
        {
            if (profile.ResumeFlag is not null)
            {
                args.Add(profile.ResumeFlag);
                args.Add(resumeContext!.AgentThreadId!);
            }
            else if (profile.ThreadFlag is not null)
            {
                args.Add(profile.ThreadFlag);
                args.Add(resumeContext!.AgentThreadId!);
            }
        }

        if (profile.ModelShort) { args.Add("-m"); args.Add(model); }
        else if (profile.ModelLong) { args.Add("--model"); args.Add(model); }
        else if (profile.ModelConfig) { args.Add("-c"); args.Add($"model=\"{model}\""); }

        if (profile.CdShort) { args.Add("-C"); args.Add(cwd); }
        else if (profile.CdLong) { args.Add("--cd"); args.Add(cwd); }

        args.Add(prompt);
        return args;
    }

    private static string ReadExecHelp(string cmd)
    {
        try
        {
            return Agents.AgentProcessLauncher.RunCapturing(cmd, ["exec", "--help"]);
        }
        catch { return ""; }
    }
}
