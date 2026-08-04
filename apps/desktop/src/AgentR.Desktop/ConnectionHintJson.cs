using System.Text.Json.Nodes;
using AgentR.Worker.Core;

namespace AgentR.Desktop;

internal static class ConnectionHintJson
{
    public static JsonObject ToJson(ConnectionHint hint) => hint switch
    {
        ConnectionOk ok => new JsonObject
        {
            ["kind"] = "ok",
            ["detail"] = ok.Detail,
        },
        ConnectionConnecting c => new JsonObject
        {
            ["kind"] = "connecting",
            ["detail"] = c.Detail,
        },
        ConnectionReconnecting r => new JsonObject
        {
            ["kind"] = "reconnecting",
            ["attempt"] = r.Attempt,
            ["inMs"] = r.InMs,
            ["reason"] = r.Reason,
        },
        ConnectionUnauthorized u => new JsonObject
        {
            ["kind"] = "unauthorized",
            ["message"] = u.Message,
        },
        ConnectionRePair p => new JsonObject
        {
            ["kind"] = "re_pair",
            ["message"] = p.Message,
            ["pairingCode"] = p.PairingCode,
        },
        ConnectionOffline o => new JsonObject
        {
            ["kind"] = "offline",
            ["reason"] = o.Reason,
        },
        _ => new JsonObject { ["kind"] = "offline", ["reason"] = "Unknown" },
    };
}
