using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Shell;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace AgentR.Desktop;

internal sealed class WebViewHostWindow : Window
{
    private const int WmNcLButtonDown = 0xA1;
    private const int HtCaption = 0x2;

    private static CoreWebView2Environment? SharedEnvironment;
    private static readonly SemaphoreSlim EnvLock = new(1, 1);

    private readonly WebView2 _webView = new() { Margin = new Thickness(0) };
    private readonly string _htmlPath;
    private readonly Func<string, object?[], Task<object?>> _invoke;
    private readonly bool _hideOnClose;
    private bool _ready;
    private bool _forceClose;

    public WebViewHostWindow(
        string title,
        string htmlPath,
        double width,
        double height,
        double minWidth,
        double minHeight,
        string background,
        Func<string, object?[], Task<object?>> invoke,
        bool hideOnClose = true)
    {
        Title = title;
        Width = width;
        Height = height;
        MinWidth = minWidth;
        MinHeight = minHeight;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.CanResize;
        SnapsToDevicePixels = true;
        UseLayoutRounding = true;
        Background = (System.Windows.Media.Brush)new System.Windows.Media.BrushConverter().ConvertFromString(background)!;
        Content = _webView;
        _htmlPath = htmlPath;
        _invoke = invoke;
        _hideOnClose = hideOnClose;

        // Kill the default caption strip that shows above frameless + resizable windows.
        WindowChrome.SetWindowChrome(this, new WindowChrome
        {
            CaptionHeight = 0,
            CornerRadius = new CornerRadius(0),
            GlassFrameThickness = new Thickness(0),
            ResizeBorderThickness = new Thickness(6),
            UseAeroCaptionButtons = false,
        });

        Closing += OnClosing;
        Loaded += async (_, _) => await InitAsync();
    }

    public bool IsReady => _ready;

    /// <summary>Destroy the window for real (app shutdown).</summary>
    public void ForceClose()
    {
        _forceClose = true;
        Close();
    }

    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (_hideOnClose && !_forceClose)
        {
            e.Cancel = true;
            Hide();
        }
    }

    private static async Task<CoreWebView2Environment> GetSharedEnvironmentAsync()
    {
        if (SharedEnvironment is not null) return SharedEnvironment;
        await EnvLock.WaitAsync().ConfigureAwait(true);
        try
        {
            SharedEnvironment ??= await CoreWebView2Environment.CreateAsync().ConfigureAwait(true);
            return SharedEnvironment;
        }
        finally
        {
            EnvLock.Release();
        }
    }

    private async Task InitAsync()
    {
        if (_ready) return;
        var env = await GetSharedEnvironmentAsync().ConfigureAwait(true);
        await _webView.EnsureCoreWebView2Async(env).ConfigureAwait(true);
        _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
        await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(AgentrBridgeScript.Source)
            .ConfigureAwait(true);
        _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
        var uri = new Uri(Path.GetFullPath(_htmlPath)).AbsoluteUri;
        _webView.CoreWebView2.Navigate(uri);
        _ready = true;
    }

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            var raw = e.TryGetWebMessageAsString();
            if (string.IsNullOrWhiteSpace(raw))
                raw = e.WebMessageAsJson;

            using var doc = System.Text.Json.JsonDocument.Parse(raw);
            var root = doc.RootElement;
            if (!root.TryGetProperty("id", out var idEl) || !root.TryGetProperty("method", out var methodEl))
                return;

            var id = idEl.GetString() ?? "";
            var method = methodEl.GetString() ?? "";
            object?[] args = [];
            if (root.TryGetProperty("args", out var argsEl) && argsEl.ValueKind == System.Text.Json.JsonValueKind.Array)
            {
                args = argsEl.EnumerateArray().Select(a => (object?)a.Clone()).ToArray();
            }

            try
            {
                var result = method switch
                {
                    "windowDrag" => BeginDrag(),
                    "windowMinimize" => MinimizeAndAck(),
                    "windowClose" => HideOrClose(),
                    _ => await _invoke(method, args).ConfigureAwait(true),
                };
                Post(new { id, result });
            }
            catch (Exception ex)
            {
                Post(new { id, error = ex.Message });
            }
        }
        catch
        {
            // ignore malformed messages
        }
    }

    private object? BeginDrag()
    {
        // Win32 caption drag works from async webview messages; WPF DragMove often does not.
        var hwnd = new WindowInteropHelper(this).Handle;
        if (hwnd == IntPtr.Zero) return null;
        ReleaseCapture();
        SendMessage(hwnd, WmNcLButtonDown, (IntPtr)HtCaption, IntPtr.Zero);
        return null;
    }

    private object? MinimizeAndAck()
    {
        WindowState = WindowState.Minimized;
        return null;
    }

    private object? HideOrClose()
    {
        if (_hideOnClose)
            Hide();
        else
            Close();
        return null;
    }

    public void Post(object payload)
    {
        if (!_ready || _webView.CoreWebView2 is null) return;
        var json = System.Text.Json.JsonSerializer.Serialize(payload, JsonUi.Options);
        Dispatcher.Invoke(() =>
        {
            try { _webView.CoreWebView2?.PostWebMessageAsJson(json); }
            catch { /* ignore */ }
        });
    }

    public void Minimize() => WindowState = WindowState.Minimized;

    public void ShowAndActivate()
    {
        if (WindowState == WindowState.Minimized)
            WindowState = WindowState.Normal;
        Show();
        Activate();
    }

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
}

internal static class AgentrBridgeScript
{
    public const string Source = """
(() => {
  if (window.agentr) return;
  const pending = new Map();
  let nextId = 1;
  const statusCbs = [];
  const consoleInitCbs = [];
  const consoleLogCbs = [];
  const consoleEndCbs = [];

  function invoke(method, args) {
    const id = String(nextId++);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      chrome.webview.postMessage(JSON.stringify({ id, method, args: args || [] }));
    });
  }

  chrome.webview.addEventListener('message', (e) => {
    let msg = e.data;
    if (typeof msg === 'string') {
      try { msg = JSON.parse(msg); } catch { return; }
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'status:changed') {
      statusCbs.forEach((cb) => { try { cb(msg.payload); } catch {} });
      return;
    }
    if (msg.type === 'console:init') {
      consoleInitCbs.forEach((cb) => { try { cb(msg.payload); } catch {} });
      return;
    }
    if (msg.type === 'console:log') {
      consoleLogCbs.forEach((cb) => { try { cb(msg.payload); } catch {} });
      return;
    }
    if (msg.type === 'console:end') {
      consoleEndCbs.forEach((cb) => { try { cb(msg.payload); } catch {} });
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
    }
  });

  function unsub(list, cb) {
    return () => {
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  }

  window.agentr = {
    getConfig: () => invoke('getConfig'),
    saveConfig: (config) => invoke('saveConfig', [config]),
    exportConfig: () => invoke('exportConfig'),
    getStatus: () => invoke('getStatus'),
    getChecklist: () => invoke('getChecklist'),
    resolveAgent: (configured, backend) => invoke('resolveAgent', [configured, backend]),
    diagnoseAgent: (configured, backend) => invoke('diagnoseAgent', [configured, backend]),
    checkUpdates: () => invoke('checkUpdates'),
    openUpdate: () => invoke('openUpdate'),
    reconnect: () => invoke('reconnect'),
    pickFolder: () => invoke('pickFolder'),
    windowDrag: () => invoke('windowDrag'),
    windowMinimize: () => invoke('windowMinimize'),
    windowClose: () => invoke('windowClose'),
    onStatus: (cb) => { statusCbs.push(cb); return unsub(statusCbs, cb); },
    onConsoleInit: (cb) => { consoleInitCbs.push(cb); return unsub(consoleInitCbs, cb); },
    onConsoleLog: (cb) => { consoleLogCbs.push(cb); return unsub(consoleLogCbs, cb); },
    onConsoleEnd: (cb) => { consoleEndCbs.push(cb); return unsub(consoleEndCbs, cb); },
  };

  function wireDrag(root) {
    if (!root) return;
    root.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button, a, input, select, textarea, label, .titlebar-controls, .bar-controls, [data-no-drag]')) return;
      window.agentr.windowDrag();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    wireDrag(document.querySelector('.titlebar-drag') || document.querySelector('.titlebar'));
    wireDrag(document.querySelector('.bar-drag') || document.querySelector('.bar'));
  });
})();
""";
}
