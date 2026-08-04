using System.Collections.Concurrent;
using AgentR.Protocol;
using AgentR.Worker.Agents;
using AgentR.Worker.Config;
using AgentR.Worker.Context;
using AgentR.Worker.Display;
using AgentR.Worker.IO;
using AgentR.Worker.Net;
using AgentR.Worker.Runtime;
using TaskStatus = AgentR.Protocol.TaskStatus;

namespace AgentR.Worker.Core;

public enum WorkerStatus { Offline, Connecting, Online, Busy }

public abstract record ConnectionHint;

public sealed record ConnectionOk(string? Detail = null) : ConnectionHint;
public sealed record ConnectionConnecting(string? Detail = null) : ConnectionHint;
public sealed record ConnectionReconnecting(int Attempt, int InMs, string Reason) : ConnectionHint;
public sealed record ConnectionUnauthorized(string Message) : ConnectionHint;
public sealed record ConnectionRePair(string Message, string PairingCode) : ConnectionHint;
public sealed record ConnectionOffline(string Reason) : ConnectionHint;

public sealed class AgentRelayWorker
{
    private WorkerConfig _config;
    private readonly RelayWebSocketClient _client = new();
    private CancellationTokenSource? _lifecycleCts;
    private bool _stopped = true;
    private bool _authBlocked;
    private WorkerStatus _status = WorkerStatus.Offline;
    private string _pairingCode = GeneratePairingCode();
    private int _pairedUsers;
    private bool _wasOnline;
    private int _pairedBeforeDisconnect;
    private int _reconnectAttempt;
    private string _lastDisconnectReason = "";
    private int _backoffMs = 1000;
    private bool _sessionLocked;
    private AgentDiagnosis _diagnosis;
    private readonly ConcurrentDictionary<string, TaskRunner> _runners = new();
    private readonly ConcurrentDictionary<string, TaskCompletionSource<bool>> _approvals = new();
    private readonly Queue<QueuedTask> _queue = new();
    private readonly object _queueLock = new();
    private bool _draining;

    private sealed class QueuedTask
    {
        public required string TaskId { get; init; }
        public required string Prompt { get; set; }
        public string? ProjectAlias { get; init; }
        public List<TaskFile>? Files { get; init; }
        public string? AgentModel { get; init; }
        public string? ConversationId { get; init; }
        public ResumeMode? ResumeMode { get; init; }
        public ResumeContext? ResumeContext { get; init; }
    }

    public AgentRelayWorker(WorkerConfig config)
    {
        _config = config;
        _diagnosis = AgentCliDiagnoser.Diagnose(config.AgentCommand, config.AgentBackend);
        _client.MessageReceived += OnMessageAsync;
        _client.Closed += OnClosed;
        _client.Error += ex => Error?.Invoke(ex);
    }

    public event Action<WorkerStatus>? StatusChanged;
    public event Action<string>? PairingCodeChanged;
    public event Action<int>? PairedUsersChanged;
    public event Action<ConnectionHint>? ConnectionChanged;
    public event Action<string>? Log;
    public event Action<Exception>? Error;
    public event Action<string>? Unauthorized;
    public event Action<string, string, string>? TaskStarted; // id, prompt, cwd
    public event Action<string, string, string>? TaskLogReceived; // id, stream, chunk
    public event Action<string, int>? TaskEnded;

    public string PairingCode => _pairingCode;
    public int PairedUsers => _pairedUsers;
    public WorkerStatus Status => _status;
    public bool SessionLocked => _sessionLocked;
    public AgentDiagnosis Diagnosis => _diagnosis;
    public WorkerConfig Config => _config;

    public void UpdateConfig(WorkerConfig config)
    {
        _config = config;
        RefreshDiagnosis();
    }

    public void UpdateSessionLock(bool locked) => _sessionLocked = locked;

    public void RefreshDiagnosis() =>
        _diagnosis = AgentCliDiagnoser.Diagnose(_config.AgentCommand, _config.AgentBackend);

    public ConnectionHint GetConnectionHint()
    {
        if (_authBlocked)
            return new ConnectionUnauthorized("Relay rejected the worker token. Paste WORKER_TOKEN from the VM and Save & connect.");
        if (_status == WorkerStatus.Connecting)
            return new ConnectionConnecting("Dialing the relay…");
        if (_status is WorkerStatus.Online or WorkerStatus.Busy)
            return new ConnectionOk();
        if (_lifecycleCts is not null && !_stopped && !_authBlocked && _status == WorkerStatus.Offline && _reconnectAttempt > 0)
            return new ConnectionReconnecting(_reconnectAttempt, _backoffMs, _lastDisconnectReason);
        return new ConnectionOffline(string.IsNullOrEmpty(_lastDisconnectReason) ? "Not connected" : _lastDisconnectReason);
    }

    public void Start()
    {
        _stopped = false;
        _lifecycleCts = new CancellationTokenSource();
        _ = ConnectLoopAsync(_lifecycleCts.Token);
    }

    public void Stop()
    {
        _stopped = true;
        try { _lifecycleCts?.Cancel(); } catch { /* ignore */ }
        foreach (var r in _runners.Values) r.Cancel();
        _runners.Clear();
        lock (_queueLock) _queue.Clear();
        _ = _client.DisconnectAsync();
        SetStatus(WorkerStatus.Offline);
    }

    public void Reconnect()
    {
        _authBlocked = false;
        _reconnectAttempt = 0;
        _backoffMs = 1000;
        ConnectionChanged?.Invoke(new ConnectionConnecting("Manual reconnect…"));
        _ = _client.DisconnectAsync();
        _lifecycleCts?.Cancel();
        _lifecycleCts = new CancellationTokenSource();
        _ = ConnectLoopAsync(_lifecycleCts.Token);
    }

    private async Task ConnectLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && !_stopped && !_authBlocked)
        {
            var token = _config.WorkerToken.Trim();
            if (string.IsNullOrEmpty(token) || token.Contains("PASTE_"))
            {
                SetStatus(WorkerStatus.Offline);
                Unauthorized?.Invoke("Worker token missing or still a placeholder.");
                return;
            }

            SetStatus(WorkerStatus.Connecting);
            ConnectionChanged?.Invoke(new ConnectionConnecting("Dialing the relay…"));
            Log?.Invoke($"Connecting to {_config.RelayUrl}…");
            try
            {
                await _client.ConnectAsync(_config.RelayUrl, token, _config.TlsInsecure == true, ct)
                    .ConfigureAwait(false);
                _backoffMs = 1000;
                _reconnectAttempt = 0;
                SetStatus(_runners.Count > 0 ? WorkerStatus.Busy : WorkerStatus.Online);
                Log?.Invoke(_wasOnline ? "Reconnected to relay" : "Connected");
                PairingCodeChanged?.Invoke(_pairingCode);
                ConnectionChanged?.Invoke(new ConnectionOk(_wasOnline ? "Reconnected after relay drop" : null));
                await _client.SendAsync(BuildHello(), ct).ConfigureAwait(false);
                await SendQueueSnapshotAsync(ct).ConfigureAwait(false);

                // Stay until closed
                while (_client.IsConnected && !ct.IsCancellationRequested)
                    await Task.Delay(500, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                Error?.Invoke(ex);
                _lastDisconnectReason = ex.Message;
            }

            if (_stopped || _authBlocked || ct.IsCancellationRequested) break;
            _wasOnline = true;
            SetStatus(WorkerStatus.Offline);
            _reconnectAttempt++;
            var wait = _backoffMs;
            _backoffMs = Math.Min(_backoffMs * 2, 30_000);
            ConnectionChanged?.Invoke(new ConnectionReconnecting(_reconnectAttempt, wait, _lastDisconnectReason));
            Log?.Invoke($"{_lastDisconnectReason} — reconnecting in {wait / 1000}s…");
            try { await Task.Delay(wait, ct).ConfigureAwait(false); } catch { break; }
        }
    }

    private void OnClosed(int code, string reason)
    {
        _lastDisconnectReason = code switch
        {
            4001 => "Unauthorized (bad worker token)",
            4000 => "Relay replaced this worker connection",
            1001 => "Relay going away (restart?)",
            1006 => "Relay closed unexpectedly (restart or network)",
            1000 => "Clean disconnect",
            _ => string.IsNullOrEmpty(reason) ? $"Disconnected (code {code})" : reason,
        };
        _pairedBeforeDisconnect = _pairedUsers;
        Log?.Invoke($"Disconnected ({code}) {_lastDisconnectReason}");
        SetStatus(WorkerStatus.Offline);
        if (code == 4001)
        {
            _authBlocked = true;
            var message = "Relay rejected the worker token (unauthorized). Copy WORKER_TOKEN from the VM and Save & connect again.";
            ConnectionChanged?.Invoke(new ConnectionUnauthorized(message));
            Unauthorized?.Invoke(message);
        }
    }

    private async Task OnMessageAsync(RelayMessage msg)
    {
        switch (msg)
        {
            case ServerAck ack:
                if (!string.IsNullOrEmpty(ack.PairingCode))
                {
                    _pairingCode = ack.PairingCode;
                    PairingCodeChanged?.Invoke(_pairingCode);
                }
                if (ack.PairedUsers is int pu)
                {
                    var prev = _pairedUsers;
                    _pairedUsers = pu;
                    PairedUsersChanged?.Invoke(pu);
                    if (_wasOnline && _pairedBeforeDisconnect > 0 && pu == 0 && prev == 0)
                    {
                        ConnectionChanged?.Invoke(new ConnectionRePair(
                            "Relay has no paired Teams users. Send /pair with the code from the tray.",
                            _pairingCode));
                    }
                    else if (ack.Message is "connected" or "pairing-updated")
                    {
                        if (pu > 0 || !_wasOnline)
                            ConnectionChanged?.Invoke(new ConnectionOk());
                    }
                }
                _wasOnline = true;
                Log?.Invoke($"Server ack: {ack.Message}");
                break;

            case WorkerPing ping:
                await _client.SendAsync(new WorkerPong
                {
                    RequestId = ping.RequestId,
                    SentAt = ping.SentAt,
                    Projects = ProjectDiskProbe.Probe(_config.Projects),
                    SessionLocked = _sessionLocked,
                    QueueDepth = _runners.Count + QueueCount(),
                    QueueTaskIds = QueueIds(),
                }).ConfigureAwait(false);
                break;

            case TaskCreate create:
                Enqueue(new QueuedTask
                {
                    TaskId = create.TaskId,
                    Prompt = create.Prompt,
                    ProjectAlias = create.ProjectAlias,
                    Files = create.Files,
                    AgentModel = create.AgentModel,
                    ConversationId = create.Conversation.ConversationId,
                    ResumeMode = create.ResumeMode,
                    ResumeContext = create.ResumeContext,
                });
                break;

            case WorkerSetConfig set:
                if (!string.IsNullOrWhiteSpace(set.AgentModel))
                {
                    _config.AgentModel = set.AgentModel.Trim();
                    try { WorkerConfigStore.Save(_config); }
                    catch (Exception ex) { Error?.Invoke(ex); }
                    await _client.SendAsync(new WorkerConfigMessage { AgentModel = _config.AgentModel })
                        .ConfigureAwait(false);
                    Log?.Invoke($"Model set to {_config.AgentModel}");
                }
                break;

            case ScreenshotCapture shot:
                await HandleScreenshotAsync(shot.RequestId, shot.Quality).ConfigureAwait(false);
                break;

            case FileGet fileGet:
                HandleFileGet(fileGet);
                break;

            case TaskApprovalResponse resp:
                if (_approvals.TryRemove(resp.ApprovalId, out var tcs))
                    tcs.TrySetResult(resp.Decision == "approve");
                break;

            case TaskCancel cancel:
                await HandleCancelAsync(cancel.TaskId).ConfigureAwait(false);
                break;
        }
    }

    private void Enqueue(QueuedTask task)
    {
        lock (_queueLock) _queue.Enqueue(task);
        var busy = _draining || !_runners.IsEmpty;
        if (busy)
        {
            var pos = QueueCount();
            _ = _client.SendAsync(new TaskStatusMessage
            {
                TaskId = task.TaskId,
                Status = TaskStatus.Queued,
                Message = $"Queued (#{pos})",
                QueuePosition = pos,
            });
            SetStatus(WorkerStatus.Busy);
        }
        _ = SendQueueSnapshotAsync();
        _ = DrainQueueAsync();
    }

    private async Task DrainQueueAsync()
    {
        if (_draining) return;
        _draining = true;
        try
        {
            while (!_stopped)
            {
                QueuedTask? next;
                lock (_queueLock)
                {
                    if (_queue.Count == 0) break;
                    next = _queue.Dequeue();
                }
                await ReannounceQueueAsync().ConfigureAwait(false);
                await SendQueueSnapshotAsync().ConfigureAwait(false);
                await RunTaskAsync(next!).ConfigureAwait(false);
            }
        }
        finally
        {
            _draining = false;
            if (QueueCount() > 0 && !_stopped) _ = DrainQueueAsync();
            else if (_client.IsConnected && _runners.IsEmpty) SetStatus(WorkerStatus.Online);
            await SendQueueSnapshotAsync().ConfigureAwait(false);
        }
    }

    private async Task RunTaskAsync(QueuedTask task)
    {
        var project = ResolveProject(task.ProjectAlias);
        var cwd = project is null ? null : WorkerConfigStore.ProjectPath(project);
        if (string.IsNullOrEmpty(cwd))
        {
            await _client.SendAsync(new TaskStatusMessage
            {
                TaskId = task.TaskId,
                Status = TaskStatus.Failed,
                Message = $"Unknown project alias: {task.ProjectAlias}",
            }).ConfigureAwait(false);
            return;
        }

        if (IsLockedBlocked(project))
        {
            await _client.SendAsync(new TaskStatusMessage
            {
                TaskId = task.TaskId,
                Status = TaskStatus.Failed,
                Message = "Windows session is locked. Unlock the PC, then retry your task.",
            }).ConfigureAwait(false);
            return;
        }

        var prompt = task.Prompt;
        if (task.Files is { Count: > 0 })
        {
            try
            {
                var (dir, paths) = TaskInboxWriter.Write(cwd, task.Files);
                var names = paths.Select(p => p[(dir.Length + 1)..]);
                prompt = $"Files saved under `.agentr-inbox/`:\n{string.Join("\n", names.Select(n => $"- {n}"))}\n\n{prompt}";
                Log?.Invoke($"Wrote {paths.Count} file(s) → {dir}");
            }
            catch (Exception ex)
            {
                await _client.SendAsync(new TaskStatusMessage
                {
                    TaskId = task.TaskId,
                    Status = TaskStatus.Failed,
                    Message = $"Failed to save attachments: {ex.Message}",
                }).ConfigureAwait(false);
                return;
            }
        }

        if (_config.IncludeGitContext != false)
        {
            var git = GitContextProvider.Get(cwd);
            if (git is not null) prompt = GitContextProvider.FormatBlock(git) + prompt;
        }

        var guardrails = WorkerConfigStore.ResolveGuardrails(_config, project);
        var dryRun = guardrails?.ReadOnly == true ||
                     (project?.DryRun ?? _config.DryRun);
        var model = (task.AgentModel ?? project?.AgentModel ?? _config.AgentModel)?.Trim()
            ?? WorkerConfigStore.DefaultModel(_config.AgentBackend);
        var maxRuntime = WorkerConfigStore.ResolveMaxRuntimeMinutes(_config, project);
        var gitCtx = GitContextProvider.Get(cwd);

        SetStatus(WorkerStatus.Busy);
        await _client.SendAsync(new TaskStatusMessage { TaskId = task.TaskId, Status = TaskStatus.Running })
            .ConfigureAwait(false);
        TaskStarted?.Invoke(task.TaskId, prompt, cwd);

        var runner = new TaskRunner();
        _runners[task.TaskId] = runner;
        string? capturedThread = null;

        var result = await runner.RunAsync(new RunTaskOptions
        {
            TaskId = task.TaskId,
            Prompt = prompt,
            Cwd = cwd,
            AgentBackend = _config.AgentBackend,
            AgentCommand = AgentCommandResolver.PreferResolved(_config.AgentCommand, _config.AgentBackend),
            AgentModel = model,
            DryRun = dryRun,
            Guardrails = guardrails,
            MaxRuntimeMinutes = maxRuntime,
            ResumeMode = task.ResumeMode,
            ResumeContext = task.ResumeContext,
            OnAgentThreadId = id => capturedThread = id,
            OnLog = (stream, chunk) =>
            {
                TaskLogReceived?.Invoke(task.TaskId, stream, chunk);
                _ = _client.SendAsync(new TaskLog
                {
                    TaskId = task.TaskId,
                    Stream = stream,
                    Chunk = chunk,
                    Ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                });
            },
            RequestApproval = async (command, reason, _tier) =>
            {
                var approvalId = Guid.NewGuid().ToString("N");
                string? screenshotUrl = null;
                if (_config.ApprovalScreenshot == true)
                {
                    try
                    {
                        var display = WindowsDisplayService.PrepareForScreenshot();
                        if (!display.Locked)
                        {
                            var shots = DesktopScreenshotService.CaptureAll("preview");
                            var upload = await ArtifactUploader.UploadAsync(
                                _config.RelayUrl, _config.WorkerToken, approvalId, shots,
                                _config.TlsInsecure == true).ConfigureAwait(false);
                            if (upload.Ok && upload.Urls is { Count: > 0 })
                                screenshotUrl = upload.Urls[0];
                        }
                    }
                    catch { /* optional */ }
                }

                await _client.SendAsync(new TaskApprovalRequest
                {
                    TaskId = task.TaskId,
                    ApprovalId = approvalId,
                    Command = command,
                    Reason = reason,
                    ProjectAlias = task.ProjectAlias,
                    Cwd = cwd,
                    GitBranch = gitCtx?.Branch,
                    GitDirty = gitCtx?.Dirty,
                    ScreenshotUrl = screenshotUrl,
                }).ConfigureAwait(false);

                var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                _approvals[approvalId] = tcs;
                var completed = await Task.WhenAny(tcs.Task, Task.Delay(TimeSpan.FromMinutes(10)))
                    .ConfigureAwait(false);
                if (completed != tcs.Task)
                {
                    _approvals.TryRemove(approvalId, out _);
                    return false;
                }
                return await tcs.Task.ConfigureAwait(false);
            },
        }).ConfigureAwait(false);

        _runners.TryRemove(task.TaskId, out _);
        var exit = result.ExitCode;
        var threadId = result.AgentThreadId ?? capturedThread;
        var summary = TaskRunner.BuildTaskSummary(result.LogText, exit);
        TaskEnded?.Invoke(task.TaskId, exit);

        if (!string.IsNullOrEmpty(task.ConversationId))
        {
            TaskContextStore.Save(new TaskContextEntry
            {
                TaskId = task.TaskId,
                ConversationId = task.ConversationId,
                ProjectAlias = task.ProjectAlias,
                AgentThreadId = threadId,
                Prompt = task.Prompt,
                LogSummary = TaskContextStore.SummarizeLogs([result.LogText]),
                ExitCode = exit,
                FinishedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            });
        }

        await _client.SendAsync(new TaskStatusMessage
        {
            TaskId = task.TaskId,
            Status = exit == 0 ? TaskStatus.Succeeded : exit == 130 ? TaskStatus.Cancelled : TaskStatus.Failed,
            ExitCode = exit,
            Message = exit == 0 ? "Completed" : exit == 130 ? "Cancelled" : $"Exited with code {exit}",
            Summary = summary,
            AgentThreadId = threadId,
        }).ConfigureAwait(false);

        if (_client.IsConnected && QueueCount() == 0 && _runners.IsEmpty)
            SetStatus(WorkerStatus.Online);
    }

    private async Task HandleCancelAsync(string taskId)
    {
        lock (_queueLock)
        {
            var items = _queue.ToList();
            _queue.Clear();
            var removed = false;
            foreach (var t in items)
            {
                if (t.TaskId == taskId && !removed)
                {
                    removed = true;
                    continue;
                }
                _queue.Enqueue(t);
            }
            if (removed)
            {
                _ = _client.SendAsync(new TaskStatusMessage
                {
                    TaskId = taskId,
                    Status = TaskStatus.Cancelled,
                    Message = "Cancelled while queued",
                });
                _ = ReannounceQueueAsync();
                _ = SendQueueSnapshotAsync();
                return;
            }
        }

        if (_runners.TryGetValue(taskId, out var runner))
        {
            runner.Cancel();
            await _client.SendAsync(new TaskStatusMessage
            {
                TaskId = taskId,
                Status = TaskStatus.Cancelled,
                Message = "Cancelled by server",
            }).ConfigureAwait(false);
        }
    }

    private async Task HandleScreenshotAsync(string requestId, string quality)
    {
        SetStatus(WorkerStatus.Busy);
        try
        {
            var display = WindowsDisplayService.PrepareForScreenshot();
            if (display.Locked)
                throw new InvalidOperationException(display.Detail ?? "Windows session is locked.");
            if (display.Woke) Log?.Invoke($"Screenshot prep: {display.Detail}");
            var screens = DesktopScreenshotService.CaptureAll(quality == "hq" ? "hq" : "preview");
            Log?.Invoke($"Screenshot {quality} {requestId[..Math.Min(8, requestId.Length)]} — {screens.Count} display(s)");
            var result = await ArtifactUploader.UploadAsync(
                _config.RelayUrl, _config.WorkerToken, requestId, screens,
                _config.TlsInsecure == true).ConfigureAwait(false);
            if (!result.Ok) throw new InvalidOperationException(result.Error ?? "upload failed");
            Log?.Invoke("Screenshot upload complete");
        }
        catch (Exception ex)
        {
            Error?.Invoke(new Exception($"Screenshot failed: {ex.Message}", ex));
        }
        finally
        {
            SetStatus(_client.IsConnected ? WorkerStatus.Online : WorkerStatus.Offline);
        }
    }

    private void HandleFileGet(FileGet msg)
    {
        if (!_config.Projects.TryGetValue(msg.ProjectAlias, out var project))
        {
            _ = _client.SendAsync(new FileResult
            {
                RequestId = msg.RequestId,
                Ok = false,
                Error = $"Unknown project `{msg.ProjectAlias}`",
            });
            return;
        }
        var root = WorkerConfigStore.ProjectPath(project);
        var result = ProjectFileReader.Read(root, msg.RelativePath);
        if (!result.Ok)
        {
            _ = _client.SendAsync(new FileResult
            {
                RequestId = msg.RequestId,
                Ok = false,
                Error = result.Error,
            });
            return;
        }
        Log?.Invoke($"file.get {msg.ProjectAlias}:{result.RelativePath} ({result.Delivery}, {result.SizeBytes} B)");
        _ = _client.SendAsync(new FileResult
        {
            RequestId = msg.RequestId,
            Ok = true,
            Name = result.Name,
            RelativePath = result.RelativePath,
            MimeType = result.MimeType,
            SizeBytes = result.SizeBytes,
            Delivery = result.Delivery,
            Text = result.Delivery == "inline" ? result.Text : null,
            Truncated = result.Delivery == "inline" ? result.Truncated : null,
            DataBase64 = result.DataBase64,
        });
    }

    private WorkerHello BuildHello()
    {
        var running = _runners.Keys.FirstOrDefault();
        var queued = QueueIds().Where(id => id != running).ToList();
        return new WorkerHello
        {
            Hostname = Environment.MachineName,
            Version = ProtocolConstants.Version,
            Repos = _config.Projects.Keys.ToList(),
            PairingCode = _pairingCode,
            AgentModel = string.IsNullOrEmpty(_config.AgentModel) ? "auto" : _config.AgentModel,
            AgentBackend = _config.AgentBackend,
            SessionLocked = _sessionLocked,
            QueueDepth = _runners.Count + QueueCount(),
            QueueTaskIds = running is null ? queued : new List<string> { running }.Concat(queued).ToList(),
            CliDiagnosis = AgentCliDiagnoser.ToSummary(_diagnosis),
            GlobalPrompts = _config.Prompts,
            ProjectMeta = _config.Projects.Select(p => new ProjectMeta
            {
                Alias = p.Key,
                Prompts = p.Value.Prompts,
                Guardrails = p.Value.Guardrails,
            }).ToList(),
        };
    }

    private async Task SendQueueSnapshotAsync(CancellationToken ct = default)
    {
        await _client.SendAsync(new WorkerQueue
        {
            RunningTaskId = _runners.Keys.FirstOrDefault(),
            QueuedTaskIds = QueueIds().Where(id => !_runners.ContainsKey(id)).ToList(),
        }, ct).ConfigureAwait(false);
    }

    private async Task ReannounceQueueAsync()
    {
        List<QueuedTask> items;
        lock (_queueLock) items = _queue.ToList();
        for (var i = 0; i < items.Count; i++)
        {
            await _client.SendAsync(new TaskStatusMessage
            {
                TaskId = items[i].TaskId,
                Status = TaskStatus.Queued,
                Message = $"Queued (#{i + 1})",
                QueuePosition = i + 1,
            }).ConfigureAwait(false);
        }
    }

    private ProjectEntry? ResolveProject(string? alias)
    {
        if (string.IsNullOrEmpty(alias))
            return _config.Projects.Values.FirstOrDefault() ?? new ProjectEntry { Path = Directory.GetCurrentDirectory() };
        return _config.Projects.TryGetValue(alias, out var p) ? p : null;
    }

    private bool IsLockedBlocked(ProjectEntry? project)
    {
        if (project?.Guardrails?.BlockWhenLocked == true) return _sessionLocked;
        return _config.BlockTasksWhenLocked != false && _sessionLocked;
    }

    private int QueueCount()
    {
        lock (_queueLock) return _queue.Count;
    }

    private List<string> QueueIds()
    {
        lock (_queueLock)
            return _runners.Keys.Concat(_queue.Select(t => t.TaskId)).ToList();
    }

    private void SetStatus(WorkerStatus status)
    {
        _status = status;
        StatusChanged?.Invoke(status);
    }

    private static string GeneratePairingCode()
    {
        const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        var rng = Random.Shared;
        Span<char> chars = stackalloc char[8];
        for (var i = 0; i < chars.Length; i++)
            chars[i] = alphabet[rng.Next(alphabet.Length)];
        return new string(chars[..4]) + "-" + new string(chars[4..]);
    }
}
