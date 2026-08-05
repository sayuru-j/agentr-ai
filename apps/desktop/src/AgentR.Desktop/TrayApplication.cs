using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Forms;
using AgentR.Worker.Agents;
using AgentR.Worker.Config;
using AgentR.Worker.Core;
using Application = System.Windows.Application;

namespace AgentR.Desktop;

internal sealed class TrayApplication : IDisposable
{
    private NotifyIcon? _notifyIcon;
    private AgentRelayWorker? _worker;
    private WebViewHostWindow? _settings;
    private WebViewHostWindow? _console;
    private UpdateCheckResult? _lastUpdate;
    private bool _sessionLocked;
    private ConnectionHint _connectionHint = new ConnectionOffline("Starting…");
    private WorkerStatus _status = WorkerStatus.Offline;
    private string _pairingCode = "--------";
    private int _pairedUsers;
    private bool _disposed;

    private Icon? _trayIconImage;
    private CancellationTokenSource? _uiCoalesceCts;
    private string? _consoleTaskId;
    private string? _consolePrompt;
    private string? _consoleCwd;
    private readonly List<object> _consoleLogBuffer = new();
    private const int ConsoleLogBufferMax = 500;

    public void Start()
    {
        EnsureDefaultConfig();
        CreateTray();
        StartWorker();
        ScheduleUiRefresh();

        // Warm WebView2 env (writable LocalAppData UDF) — no Opacity=0 window preload.
        _ = WebViewHostWindow.WarmEnvironmentAsync();

        var config = WorkerConfigStore.Load();
        var needsSetup =
            string.IsNullOrWhiteSpace(config.WorkerToken) ||
            config.WorkerToken.Contains("PASTE_", StringComparison.Ordinal) ||
            config.RelayUrl.Contains("localhost", StringComparison.OrdinalIgnoreCase) ||
            config.RelayUrl.Contains("example.com", StringComparison.OrdinalIgnoreCase) ||
            (!config.DryRun && !AgentCommandResolver.Resolve(config.AgentCommand, config.AgentBackend).Found);

        if (needsSetup || config.StartMinimized != true)
            OpenSettings();

        if (config.CheckUpdates != false)
            _ = RunUpdateCheckAsync(force: false);
    }

    public void OpenSettings()
    {
        Application.Current.Dispatcher.Invoke(() =>
        {
            EnsureSettingsWindow();
            _settings!.ShowAndActivate();
            BroadcastStatus();
        });
    }

    private void EnsureSettingsWindow()
    {
        if (_settings is not null) return;

        _settings = CreateSettingsWindow();
        _settings.Closed += (_, _) => _settings = null;
        _settings.UiReady += () => Application.Current.Dispatcher.Invoke(BroadcastStatus);
    }

    private WebViewHostWindow CreateSettingsWindow() =>
        new(
            "AgentR",
            UiPaths.SettingsHtml,
            width: 440,
            height: 760,
            minWidth: 380,
            minHeight: 560,
            background: "#ffffff",
            invoke: HandleBridgeAsync,
            hideOnClose: true);

    public void SetSessionLocked(bool locked)
    {
        _sessionLocked = locked;
        _worker?.UpdateSessionLock(locked);
        ScheduleUiRefresh();
    }

    private void StartWorker()
    {
        var config = AutoPersistResolvedAgent(WorkerConfigStore.Load());
        LoginItemSettings.Apply(config.OpenAtLogin == true);

        _worker = new AgentRelayWorker(config);
        _worker.StatusChanged += s =>
        {
            _status = s;
            Application.Current.Dispatcher.Invoke(ScheduleUiRefresh);
        };
        _worker.PairingCodeChanged += code =>
        {
            _pairingCode = code;
            Application.Current.Dispatcher.Invoke(ScheduleUiRefresh);
        };
        _worker.PairedUsersChanged += count =>
        {
            _pairedUsers = count;
            Application.Current.Dispatcher.Invoke(ScheduleUiRefresh);
        };
        _worker.ConnectionChanged += hint =>
        {
            _connectionHint = hint;
            Application.Current.Dispatcher.Invoke(() =>
            {
                ScheduleUiRefresh();
                if (hint is ConnectionRePair)
                {
                    ShowBalloon("AgentR — re-pair needed", ((ConnectionRePair)hint).Message);
                    OpenSettings();
                }
                else if (hint is ConnectionReconnecting { Attempt: 1 } r)
                {
                    var relayish = System.Text.RegularExpressions.Regex.IsMatch(r.Reason, "restart|going away|unexpectedly", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                    ShowBalloon(
                        relayish ? "AgentR — relay restarted?" : "AgentR — reconnecting",
                        r.Reason);
                }
            });
        };
        _worker.Unauthorized += message =>
        {
            Application.Current.Dispatcher.Invoke(() =>
            {
                ShowBalloon("AgentR — unauthorized", "Worker token rejected. Paste the VM WORKER_TOKEN and Save & connect.");
                OpenSettings();
            });
            Debug.WriteLine($"[tray] {message}");
        };
        _worker.Log += line => Debug.WriteLine($"[tray] {line}");
        _worker.Error += ex => Debug.WriteLine($"[tray] {ex.Message}");
        _worker.TaskStarted += (id, prompt, cwd) =>
            Application.Current.Dispatcher.Invoke(() => OnTaskStarted(id, prompt, cwd));
        _worker.TaskLogReceived += (id, stream, chunk) =>
            Application.Current.Dispatcher.Invoke(() => OnTaskLog(id, stream, chunk));
        _worker.TaskEnded += (id, exitCode) =>
            Application.Current.Dispatcher.Invoke(() => OnTaskEnded(id, exitCode));

        _worker.Start();
        _pairingCode = _worker.PairingCode;
        _connectionHint = _worker.GetConnectionHint();
        _status = _worker.Status;
    }

    private void OnTaskStarted(string taskId, string prompt, string cwd)
    {
        _consoleTaskId = taskId;
        _consolePrompt = prompt;
        _consoleCwd = cwd;
        _consoleLogBuffer.Clear();
        // Console stays hidden unless the user already opened it (or opens from tray).
        if (_console is { IsVisible: true })
            PostConsoleInit();
    }

    private void OnTaskLog(string taskId, string stream, string chunk)
    {
        var payload = new { type = "console:log", payload = new { taskId, stream, chunk } };
        if (_console is { IsVisible: true })
            _console.Post(payload);
        else
        {
            _consoleLogBuffer.Add(payload);
            if (_consoleLogBuffer.Count > ConsoleLogBufferMax)
                _consoleLogBuffer.RemoveRange(0, _consoleLogBuffer.Count - ConsoleLogBufferMax);
        }
    }

    private void OnTaskEnded(string taskId, int exitCode)
    {
        var payload = new { type = "console:end", payload = new { taskId, exitCode } };
        if (_console is { IsVisible: true })
            _console.Post(payload);
        else
            _consoleLogBuffer.Add(payload);
    }

    private void PostConsoleInit()
    {
        if (_console is null || _consoleTaskId is null) return;
        _console.Post(new
        {
            type = "console:init",
            payload = new { taskId = _consoleTaskId, prompt = _consolePrompt, cwd = _consoleCwd },
        });
        foreach (var msg in _consoleLogBuffer)
            _console.Post(msg);
        _consoleLogBuffer.Clear();
    }

    private void OpenConsole()
    {
        if (_console is null)
        {
            _console = new WebViewHostWindow(
                "AgentR Console",
                UiPaths.ConsoleHtml,
                width: 720,
                height: 480,
                minWidth: 420,
                minHeight: 280,
                background: "#16181c",
                invoke: HandleBridgeAsync,
                hideOnClose: true);
            _console.Closed += (_, _) => _console = null;
            _console.UiReady += () => Application.Current.Dispatcher.Invoke(PostConsoleInit);
        }

        _console.ShowAndActivate();
        if (_console.IsReady)
            PostConsoleInit();
    }

    private void CreateTray()
    {
        _trayIconImage = AppIcons.LoadTrayIcon();
        _notifyIcon = new NotifyIcon
        {
            Text = "AgentR",
            Visible = true,
            Icon = _trayIconImage,
        };
        _notifyIcon.DoubleClick += (_, _) => OpenSettings();
    }

    private void ScheduleUiRefresh()
    {
        _uiCoalesceCts?.Cancel();
        var cts = new CancellationTokenSource();
        _uiCoalesceCts = cts;
        _ = CoalesceUiRefreshAsync(cts.Token);
    }

    private async Task CoalesceUiRefreshAsync(CancellationToken ct)
    {
        try
        {
            await Task.Delay(120, ct).ConfigureAwait(true);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        if (ct.IsCancellationRequested) return;
        RebuildMenu();
    }

    private void RebuildMenu()
    {
        if (_notifyIcon is null) return;
        var updateLabel = _lastUpdate?.UpdateAvailable == true
            ? $"Update available (v{_lastUpdate.RemoteVersion})…"
            : "Check for updates…";

        var menu = new ContextMenuStrip();
        menu.Items.Add(new ToolStripMenuItem($"AgentR — {JsonUi.StatusName(_status)}{(_sessionLocked ? " · locked" : "")}")
        {
            Enabled = false,
        });
        menu.Items.Add(new ToolStripMenuItem($"Pairing: /pair {_pairingCode}", null, (_, _) =>
        {
            ShowBalloon("AgentR pairing code", $"In Teams send: /pair {_pairingCode}");
        }));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Open AgentR…", null, (_, _) => OpenSettings()));
        menu.Items.Add(new ToolStripMenuItem("Agent console…", null, (_, _) => OpenConsole()));
        menu.Items.Add(new ToolStripMenuItem("Reconnect", null, (_, _) => _worker?.Reconnect()));
        menu.Items.Add(new ToolStripMenuItem(updateLabel, null, async (_, _) =>
        {
            if (_lastUpdate?.UpdateAvailable == true)
            {
                var url = _lastUpdate.PortableUrl ?? _lastUpdate.ReleaseUrl;
                if (!string.IsNullOrEmpty(url))
                    Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            else
            {
                await RunUpdateCheckAsync(force: true).ConfigureAwait(true);
            }
        }));
        menu.Items.Add(new ToolStripMenuItem("Open config folder", null, (_, _) =>
        {
            WorkerPaths.EnsureConfigDir();
            Process.Start(new ProcessStartInfo
            {
                FileName = WorkerPaths.ConfigDir,
                UseShellExecute = true,
            });
        }));
        menu.Items.Add(new ToolStripMenuItem("Export config…", null, (_, _) => ExportConfig()));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Quit", null, (_, _) =>
        {
            _worker?.Stop();
            Application.Current.Shutdown();
        }));

        _notifyIcon.ContextMenuStrip = menu;
        _notifyIcon.Text = Truncate($"AgentR ({JsonUi.StatusName(_status)}) — /pair {_pairingCode}", 63);
        BroadcastStatus();
    }

    private void BroadcastStatus()
    {
        var payload = BuildStatusPayload();
        _settings?.Post(new { type = "status:changed", payload });
    }

    private object BuildStatusPayload() => new
    {
        status = JsonUi.StatusName(_status),
        pairingCode = _pairingCode,
        pairedUsers = _pairedUsers,
        checklist = BuildChecklist(),
        update = _lastUpdate,
        sessionLocked = _sessionLocked,
        connection = ConnectionHintJson.ToJson(_connectionHint),
        version = UiPaths.AppVersion,
        packaged = true,
    };

    private object BuildChecklist()
    {
        var config = WorkerConfigStore.Load();
        var tokenSet = !string.IsNullOrWhiteSpace(config.WorkerToken) &&
                       !config.WorkerToken.Contains("PASTE_", StringComparison.Ordinal);
        var agent = AgentCommandResolver.Resolve(config.AgentCommand, config.AgentBackend);
        var diagnosis = AgentCliDiagnoser.Diagnose(config.AgentCommand, config.AgentBackend);
        var agentFound = config.DryRun || agent.Found;
        var relayOk = _status is WorkerStatus.Online or WorkerStatus.Busy;
        var paired = _pairedUsers > 0;
        return new
        {
            relayOk,
            tokenSet,
            agentFound,
            paired,
            agent,
            diagnosis,
            allOk = relayOk && tokenSet && agentFound && diagnosis.Ok && paired,
        };
    }

    private async Task<object?> HandleBridgeAsync(string method, object?[] args)
    {
        return method switch
        {
            "getConfig" => AutoPersistResolvedAgent(WorkerConfigStore.Load()),
            "saveConfig" => SaveConfig(args),
            "exportConfig" => ExportConfig(),
            "getStatus" => BuildStatusPayload(),
            "getChecklist" => BuildChecklist(),
            "resolveAgent" => ResolveAgent(args),
            "diagnoseAgent" => DiagnoseAgent(args),
            "checkUpdates" => await RunUpdateCheckAsync(force: true).ConfigureAwait(true),
            "openUpdate" => OpenUpdate(),
            "reconnect" => Reconnect(),
            "pickFolder" => PickFolder(),
            // windowMinimize / windowClose / windowDrag are handled by WebViewHostWindow.
            _ => throw new InvalidOperationException($"Unknown bridge method: {method}"),
        };
    }

    private object SaveConfig(object?[] args)
    {
        if (args.Length == 0 || args[0] is not JsonElement el)
            throw new InvalidOperationException("Config payload required");

        var current = WorkerConfigStore.Load();
        var next = JsonUi.MergeConfig(current, el);
        if (string.IsNullOrWhiteSpace(next.RelayUrl))
            throw new InvalidOperationException("Relay URL is required");
        if (string.IsNullOrWhiteSpace(next.WorkerToken))
            throw new InvalidOperationException("Worker token is required");

        var fallback = WorkerConfigStore.DefaultCommand(next.AgentBackend);
        next.AgentCommand = AgentCommandResolver.PreferResolved(
            string.IsNullOrWhiteSpace(next.AgentCommand) ? fallback : next.AgentCommand,
            next.AgentBackend);
        WorkerConfigStore.Save(next);
        LoginItemSettings.Apply(next.OpenAtLogin == true);
        _worker?.UpdateConfig(next);
        _worker?.RefreshDiagnosis();
        _worker?.Reconnect();
        BroadcastStatus();
        if (next.CheckUpdates == true)
            _ = RunUpdateCheckAsync(force: false);
        return next;
    }

    private static object ResolveAgent(object?[] args)
    {
        var config = WorkerConfigStore.Load();
        var configured = config.AgentCommand;
        var backend = config.AgentBackend;
        if (args.Length > 0 && args[0] is JsonElement a0)
        {
            if (a0.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(a0.GetString()))
                configured = a0.GetString()!.Trim();
            else if (a0.ValueKind == JsonValueKind.Object)
            {
                if (a0.TryGetProperty("configured", out var c) && c.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(c.GetString()))
                    configured = c.GetString()!.Trim();
                if (a0.TryGetProperty("backend", out var b))
                    backend = JsonUi.ParseBackend(b.GetString(), backend);
            }
        }
        if (args.Length > 1 && args[1] is JsonElement a1 && a1.ValueKind == JsonValueKind.String)
            backend = JsonUi.ParseBackend(a1.GetString(), backend);
        return AgentCommandResolver.Resolve(configured, backend);
    }

    private static object DiagnoseAgent(object?[] args)
    {
        var config = WorkerConfigStore.Load();
        var configured = config.AgentCommand;
        var backend = config.AgentBackend;
        if (args.Length > 0 && args[0] is JsonElement a0 && a0.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(a0.GetString()))
            configured = a0.GetString()!.Trim();
        if (args.Length > 1 && args[1] is JsonElement a1)
            backend = JsonUi.ParseBackend(a1.GetString(), backend);
        return AgentCliDiagnoser.Diagnose(configured, backend);
    }

    private object Reconnect()
    {
        _worker?.Reconnect();
        return new { ok = true };
    }

    private object OpenUpdate()
    {
        var url = _lastUpdate?.PortableUrl ?? _lastUpdate?.ReleaseUrl;
        if (!string.IsNullOrEmpty(url))
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        return new { ok = !string.IsNullOrEmpty(url) };
    }

    private object? PickFolder()
    {
        using var dlg = new FolderBrowserDialog
        {
            Description = "Select project folder",
            UseDescriptionForTitle = true,
        };
        return dlg.ShowDialog() == DialogResult.OK ? dlg.SelectedPath : null;
    }

    private object ExportConfig()
    {
        WorkerPaths.EnsureConfigDir();
        if (!File.Exists(WorkerPaths.ConfigPath))
            return new { ok = false, error = "No config.json yet — Save & connect first." };

        var stamp = DateTime.UtcNow.ToString("yyyy-MM-dd");
        using var dlg = new SaveFileDialog
        {
            Title = "Export AgentR config",
            FileName = $"agent-relay-config-{stamp}.json",
            Filter = "JSON|*.json",
            InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
        };
        if (dlg.ShowDialog() != DialogResult.OK || string.IsNullOrEmpty(dlg.FileName))
            return new { ok = false, error = "Cancelled" };
        try
        {
            File.Copy(WorkerPaths.ConfigPath, dlg.FileName, overwrite: true);
            return new { ok = true, path = dlg.FileName };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }

    private async Task<UpdateCheckResult> RunUpdateCheckAsync(bool force)
    {
        var config = WorkerConfigStore.Load();
        if (!force && config.CheckUpdates == false)
        {
            _lastUpdate = new UpdateCheckResult
            {
                Checked = false,
                LocalVersion = UiPaths.AppVersion,
                Error = "Update checks disabled",
            };
            Application.Current.Dispatcher.Invoke(RebuildMenu);
            return _lastUpdate;
        }

        _lastUpdate = await UpdateChecker.CheckGithubReleaseUpdateAsync(UiPaths.AppVersion).ConfigureAwait(true);
        Application.Current.Dispatcher.Invoke(() =>
        {
            RebuildMenu();
            if (_lastUpdate.UpdateAvailable)
            {
                ShowBalloon(
                    "AgentR update available",
                    $"v{_lastUpdate.RemoteVersion} is out (you have v{_lastUpdate.LocalVersion}).");
            }
        });
        return _lastUpdate;
    }

    private static WorkerConfig AutoPersistResolvedAgent(WorkerConfig config)
    {
        var preferred = AgentCommandResolver.PreferResolved(config.AgentCommand, config.AgentBackend);
        if (preferred == config.AgentCommand) return config;
        config.AgentCommand = preferred;
        WorkerConfigStore.Save(config);
        return config;
    }

    private static void EnsureDefaultConfig()
    {
        WorkerPaths.EnsureConfigDir();
        if (!File.Exists(WorkerPaths.ConfigPath))
        {
            var cfg = WorkerConfigStore.Default();
            cfg.DryRun = true;
            WorkerConfigStore.Save(cfg);
        }
    }

    private void ShowBalloon(string title, string body)
    {
        try
        {
            _notifyIcon?.ShowBalloonTip(5000, title, body, ToolTipIcon.Info);
        }
        catch
        {
            // ignore
        }
    }

    private static string Truncate(string value, int max) =>
        value.Length <= max ? value : value[..(max - 1)] + "…";

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { _uiCoalesceCts?.Cancel(); } catch { /* ignore */ }
        _uiCoalesceCts?.Dispose();
        _worker?.Stop();
        if (_notifyIcon is not null)
        {
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
        }
        _trayIconImage?.Dispose();
        try { _settings?.ForceClose(); } catch { /* ignore */ }
        try { _console?.ForceClose(); } catch { /* ignore */ }
    }
}
