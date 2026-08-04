using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using System.Windows.Shell;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Brushes = System.Windows.Media.Brushes;
using Button = System.Windows.Controls.Button;
using Color = System.Windows.Media.Color;
using Cursors = System.Windows.Input.Cursors;
using HorizontalAlignment = System.Windows.HorizontalAlignment;
using Orientation = System.Windows.Controls.Orientation;
using Point = System.Windows.Point;
using VerticalAlignment = System.Windows.VerticalAlignment;

namespace AgentR.Desktop;

internal sealed class WebViewHostWindow : Window
{
    private const int WmNcLButtonDown = 0xA1;
    private const int HtCaption = 0x2;

    private static CoreWebView2Environment? SharedEnvironment;
    private static readonly SemaphoreSlim EnvLock = new(1, 1);

    // Keep Visible — Collapsed WebView2 often stalls navigation / JS.
    private readonly WebView2 _webView = new() { Margin = new Thickness(0) };
    private readonly Grid _root = new();
    private readonly Border _loader;
    private readonly string _htmlPath;
    private readonly Func<string, object?[], Task<object?>> _invoke;
    private readonly bool _hideOnClose;
    private readonly TaskCompletionSource _readyTcs = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool _bridgeReady;
    private bool _uiReady;
    private bool _forceClose;
    private bool _initStarted;
    private bool _wantVisible;

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
        ShowInTaskbar = true;
        Background = BrushFrom(background);
        _htmlPath = htmlPath;
        _invoke = invoke;
        _hideOnClose = hideOnClose;

        WindowChrome.SetWindowChrome(this, new WindowChrome
        {
            CaptionHeight = 0,
            CornerRadius = new CornerRadius(0),
            GlassFrameThickness = new Thickness(0),
            ResizeBorderThickness = new Thickness(6),
            UseAeroCaptionButtons = false,
        });

        var accent = background.Equals("#16181c", StringComparison.OrdinalIgnoreCase) ? "#d7dbdf" : "#1a1917";
        _loader = BuildLoader(title, background, accent);
        _root.Children.Add(_webView);
        _root.Children.Add(_loader);
        Content = _root;

        Closing += OnClosing;
        ContentRendered += (_, _) => EnsureInitStarted();
        Loaded += (_, _) => EnsureInitStarted();
    }

    public bool IsReady => _uiReady;
    public Task WhenReady => _readyTcs.Task;

    public event Action? UiReady;

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
            _wantVisible = false;
        }
    }

    private void EnsureInitStarted()
    {
        if (_initStarted) return;
        _initStarted = true;
        _ = InitAsync();
    }

    /// <summary>Warm WebView behind the scenes without activating the window.</summary>
    public void PreloadHidden()
    {
        _wantVisible = false;
        ShowActivated = false;
        ShowInTaskbar = false;
        Opacity = 0;
        Show();
        EnsureInitStarted();
        _ = FinishPreloadAsync();
    }

    private async Task FinishPreloadAsync()
    {
        try { await WhenReady.ConfigureAwait(true); }
        catch { /* keep going */ }

        // If the user opened the window while we were preloading, leave it alone.
        if (_wantVisible) return;
        if (Opacity > 0.01 && IsVisible) return;

        Hide();
        Opacity = 1;
        ShowInTaskbar = true;
        ShowActivated = true;
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

    public static Task WarmEnvironmentAsync() => GetSharedEnvironmentAsync();

    private async Task InitAsync()
    {
        if (_uiReady) return;
        try
        {
            var env = await GetSharedEnvironmentAsync().ConfigureAwait(true);
            await _webView.EnsureCoreWebView2Async(env).ConfigureAwait(true);
            _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(AgentrBridgeScript.Source)
                .ConfigureAwait(true);
            _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
            // Allow bridge replies as soon as the host object path exists — page JS
            // starts calling getConfig/getStatus during load, before NavigationCompleted.
            _bridgeReady = true;

            var navDone = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            void OnNav(object? s, CoreWebView2NavigationCompletedEventArgs e)
            {
                _webView.CoreWebView2.NavigationCompleted -= OnNav;
                if (e.IsSuccess) navDone.TrySetResult();
                else navDone.TrySetException(new InvalidOperationException($"Navigation failed ({e.WebErrorStatus})"));
            }
            _webView.CoreWebView2.NavigationCompleted += OnNav;

            var uri = new Uri(System.IO.Path.GetFullPath(_htmlPath)).AbsoluteUri;
            _webView.CoreWebView2.Navigate(uri);
            await navDone.Task.ConfigureAwait(true);

            _loader.Visibility = Visibility.Collapsed;
            _uiReady = true;
            _readyTcs.TrySetResult();
            UiReady?.Invoke();
        }
        catch (Exception ex)
        {
            _readyTcs.TrySetException(ex);
            SetLoaderError(ex.Message);
        }
    }

    private void SetLoaderError(string message)
    {
        if (_loader.Child is not Grid grid) return;
        foreach (var child in grid.Children)
        {
            if (child is StackPanel panel)
            {
                foreach (var c in panel.Children)
                {
                    if (c is TextBlock tb && Equals(tb.Tag, "hint"))
                    {
                        tb.Text = "Failed to load UI: " + message;
                        return;
                    }
                }
            }
        }
    }

    private Border BuildLoader(string title, string background, string accent)
    {
        var bg = BrushFrom(background);
        var fg = BrushFrom(accent);
        var muted = new SolidColorBrush(Color.FromRgb(0x8a, 0x85, 0x7c));
        var barBg = background.Equals("#16181c", StringComparison.OrdinalIgnoreCase)
            ? BrushFrom("#16181c")
            : BrushFrom("#ffffff");
        var line = new SolidColorBrush(Color.FromRgb(0xe4, 0xe1, 0xda));

        var titleBar = new Border
        {
            Height = 44,
            Background = barBg,
            BorderBrush = line,
            BorderThickness = new Thickness(0, 0, 0, 1),
            VerticalAlignment = VerticalAlignment.Top,
            Cursor = Cursors.SizeAll,
        };
        titleBar.MouseLeftButtonDown += (_, e) =>
        {
            if (e.ChangedButton != MouseButton.Left) return;
            if (e.OriginalSource is DependencyObject d && FindAncestor<Button>(d) is not null) return;
            try { DragMove(); } catch { BeginDrag(); }
        };

        var titleRow = new DockPanel { Margin = new Thickness(14, 0, 6, 0) };
        var wordmark = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
        };
        wordmark.Children.Add(new TextBlock
        {
            Text = title,
            FontSize = 15,
            FontWeight = FontWeights.Bold,
            Foreground = fg,
            VerticalAlignment = VerticalAlignment.Center,
        });
        wordmark.Children.Add(new TextBlock
        {
            Text = "loading",
            Margin = new Thickness(10, 0, 0, 0),
            Padding = new Thickness(8, 2, 8, 2),
            FontSize = 11,
            Foreground = muted,
            Background = BrushFrom("#f7f6f3"),
            VerticalAlignment = VerticalAlignment.Center,
        });

        var controls = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Center,
        };
        controls.Children.Add(ChromeButton("─", () => WindowState = WindowState.Minimized));
        controls.Children.Add(ChromeButton("✕", () => HideOrClose(), isClose: true));
        DockPanel.SetDock(controls, Dock.Right);
        titleRow.Children.Add(controls);
        titleRow.Children.Add(wordmark);
        titleBar.Child = titleRow;

        var spinner = new Ellipse
        {
            Width = 28,
            Height = 28,
            StrokeThickness = 3,
            Stroke = muted,
        };
        var dash = new Ellipse
        {
            Width = 28,
            Height = 28,
            StrokeThickness = 3,
            Stroke = fg,
            StrokeDashArray = new DoubleCollection { 0.35, 0.65 },
            RenderTransformOrigin = new Point(0.5, 0.5),
            RenderTransform = new RotateTransform(),
        };
        var spin = new DoubleAnimation(0, 360, TimeSpan.FromSeconds(0.9))
        {
            RepeatBehavior = RepeatBehavior.Forever,
        };
        dash.RenderTransform.BeginAnimation(RotateTransform.AngleProperty, spin);

        var spinnerHost = new Grid { Width = 28, Height = 28, Margin = new Thickness(0, 0, 0, 14) };
        spinnerHost.Children.Add(spinner);
        spinnerHost.Children.Add(dash);

        var body = new StackPanel
        {
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
        };
        body.Children.Add(spinnerHost);
        body.Children.Add(new TextBlock
        {
            Tag = "hint",
            Text = "Starting AgentR…",
            FontSize = 13,
            Foreground = muted,
            HorizontalAlignment = HorizontalAlignment.Center,
        });

        var grid = new Grid { Background = bg };
        grid.Children.Add(body);
        grid.Children.Add(titleBar);

        return new Border
        {
            Child = grid,
            Background = bg,
        };
    }

    private static Button ChromeButton(string label, Action click, bool isClose = false)
    {
        var btn = new Button
        {
            Content = label,
            Width = 40,
            Height = 32,
            FontSize = 12,
            Background = Brushes.Transparent,
            BorderThickness = new Thickness(0),
            Foreground = isClose ? BrushFrom("#1a1917") : BrushFrom("#8a857c"),
            Cursor = Cursors.Hand,
            Focusable = false,
        };
        btn.Click += (_, _) => click();
        return btn;
    }

    private static T? FindAncestor<T>(DependencyObject? current) where T : DependencyObject
    {
        while (current is not null)
        {
            if (current is T match) return match;
            current = VisualTreeHelper.GetParent(current);
        }
        return null;
    }

    private static SolidColorBrush BrushFrom(string hex) =>
        (SolidColorBrush)new BrushConverter().ConvertFromString(hex)!;

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
                args = argsEl.EnumerateArray().Select(a => (object?)a.Clone()).ToArray();

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
        _wantVisible = false;
        if (_hideOnClose) Hide();
        else Close();
        return null;
    }

    public void Post(object payload)
    {
        // Bridge must work during page load — do not wait for the loader to hide.
        if (!_bridgeReady || _webView.CoreWebView2 is null) return;
        var json = System.Text.Json.JsonSerializer.Serialize(payload, JsonUi.Options);
        void Send()
        {
            try { _webView.CoreWebView2?.PostWebMessageAsJson(json); }
            catch { /* ignore */ }
        }
        if (Dispatcher.CheckAccess()) Send();
        else Dispatcher.Invoke(Send);
    }

    public void ShowAndActivate()
    {
        _wantVisible = true;
        Opacity = 1;
        ShowInTaskbar = true;
        ShowActivated = true;
        if (WindowState == WindowState.Minimized)
            WindowState = WindowState.Normal;
        Show();
        Activate();
        EnsureInitStarted();
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
