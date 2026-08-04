using System.Net.Security;
using System.Net.WebSockets;
using System.Text;
using AgentR.Protocol;

namespace AgentR.Worker.Net;

public sealed class RelayWebSocketClient : IAsyncDisposable
{
    private ClientWebSocket? _ws;
    private CancellationTokenSource? _receiveCts;
    private readonly SemaphoreSlim _sendLock = new(1, 1);

    public bool IsConnected => _ws?.State == WebSocketState.Open;

    public event Func<RelayMessage, Task>? MessageReceived;
    public event Action<int, string>? Closed;
    public event Action<Exception>? Error;

    public async Task ConnectAsync(string relayUrl, string token, bool tlsInsecure, CancellationToken ct = default)
    {
        await DisconnectAsync().ConfigureAwait(false);

        var url = AppendToken(relayUrl, token);
        var ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("Authorization", $"Bearer {token}");
        ws.Options.SetRequestHeader("X-AgentR-Token", token);
        if (tlsInsecure)
        {
            ws.Options.RemoteCertificateValidationCallback = static (_, _, _, _) => true;
        }

        await ws.ConnectAsync(new Uri(url), ct).ConfigureAwait(false);
        _ws = ws;
        _receiveCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        _ = Task.Run(() => ReceiveLoopAsync(_receiveCts.Token));
    }

    public async Task SendAsync(RelayMessage message, CancellationToken ct = default)
    {
        if (_ws is null || _ws.State != WebSocketState.Open) return;
        var bytes = Encoding.UTF8.GetBytes(message.ToJson());
        await _sendLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await _ws.SendAsync(bytes, WebSocketMessageType.Text, true, ct).ConfigureAwait(false);
        }
        finally
        {
            _sendLock.Release();
        }
    }

    public async Task DisconnectAsync()
    {
        try { _receiveCts?.Cancel(); } catch { /* ignore */ }
        _receiveCts?.Dispose();
        _receiveCts = null;
        if (_ws is not null)
        {
            try
            {
                if (_ws.State == WebSocketState.Open)
                    await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None);
            }
            catch { /* ignore */ }
            _ws.Dispose();
            _ws = null;
        }
    }

    private async Task ReceiveLoopAsync(CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        var ms = new MemoryStream();
        try
        {
            while (!ct.IsCancellationRequested && _ws is { State: WebSocketState.Open })
            {
                var result = await _ws.ReceiveAsync(buffer, ct).ConfigureAwait(false);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    var code = (int)(_ws.CloseStatus ?? WebSocketCloseStatus.Empty);
                    Closed?.Invoke(code, _ws.CloseStatusDescription ?? "");
                    break;
                }
                ms.Write(buffer, 0, result.Count);
                if (!result.EndOfMessage) continue;
                var json = Encoding.UTF8.GetString(ms.ToArray());
                ms.SetLength(0);
                var msg = RelayMessage.Parse(json);
                if (msg is not null && MessageReceived is not null)
                    await MessageReceived(msg).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) { /* normal */ }
        catch (Exception ex)
        {
            Error?.Invoke(ex);
            Closed?.Invoke(1006, ex.Message);
        }
    }

    private static string AppendToken(string relayUrl, string token)
    {
        try
        {
            var uri = new Uri(relayUrl);
            var qb = new UriBuilder(uri);
            var existing = qb.Query.TrimStart('?');
            var tokenParam = "token=" + Uri.EscapeDataString(token);
            qb.Query = string.IsNullOrEmpty(existing) ? tokenParam : existing + "&" + tokenParam;
            return qb.Uri.ToString();
        }
        catch
        {
            var join = relayUrl.Contains('?') ? "&" : "?";
            return $"{relayUrl}{join}token={Uri.EscapeDataString(token)}";
        }
    }

    public async ValueTask DisposeAsync() => await DisconnectAsync();
}
