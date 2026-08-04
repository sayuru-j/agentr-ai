using System.Threading;
using System.Windows;
using Microsoft.Win32;

namespace AgentR.Desktop;

public partial class App : System.Windows.Application
{
    private const string MutexName = "Local\\AgentR.Desktop.SingleInstance";
    private Mutex? _mutex;
    private TrayApplication? _tray;
    private EventWaitHandle? _secondInstanceSignal;
    private RegisteredWaitHandle? _secondInstanceWait;

    private void OnStartup(object sender, StartupEventArgs e)
    {
        _mutex = new Mutex(true, MutexName, out var createdNew);
        if (!createdNew)
        {
            try
            {
                using var signal = EventWaitHandle.OpenExisting("Local\\AgentR.Desktop.ShowSettings");
                signal.Set();
            }
            catch
            {
                // ignore
            }
            Shutdown();
            return;
        }

        _secondInstanceSignal = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\AgentR.Desktop.ShowSettings");
        _secondInstanceWait = ThreadPool.RegisterWaitForSingleObject(
            _secondInstanceSignal,
            (_, _) => Dispatcher.Invoke(() => _tray?.OpenSettings()),
            null,
            -1,
            false);

        ShutdownMode = ShutdownMode.OnExplicitShutdown;
        SystemEvents.SessionSwitch += OnSessionSwitch;

        _tray = new TrayApplication();
        _tray.Start();
    }

    private void OnSessionSwitch(object sender, SessionSwitchEventArgs e)
    {
        if (e.Reason is SessionSwitchReason.SessionLock or SessionSwitchReason.SessionUnlock)
        {
            var locked = e.Reason == SessionSwitchReason.SessionLock;
            Dispatcher.Invoke(() => _tray?.SetSessionLocked(locked));
        }
    }

    private void OnExit(object sender, ExitEventArgs e)
    {
        SystemEvents.SessionSwitch -= OnSessionSwitch;
        _secondInstanceWait?.Unregister(null);
        _secondInstanceSignal?.Dispose();
        _tray?.Dispose();
        try { _mutex?.ReleaseMutex(); } catch { /* ignore */ }
        _mutex?.Dispose();
    }
}
