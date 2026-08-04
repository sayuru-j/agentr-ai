using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using AgentR.Worker.Display;

namespace AgentR.Worker.Net;

public static class ArtifactUploader
{
    public static string HttpBaseFromRelayUrl(string relayUrl)
    {
        try
        {
            var u = new Uri(relayUrl);
            var builder = new UriBuilder(u)
            {
                Scheme = u.Scheme is "wss" ? "https" : u.Scheme is "ws" ? "http" : u.Scheme,
                Path = "",
                Query = "",
                Fragment = "",
            };
            return builder.Uri.ToString().TrimEnd('/');
        }
        catch
        {
            return relayUrl
                .Replace("wss:", "https:", StringComparison.OrdinalIgnoreCase)
                .Replace("ws:", "http:", StringComparison.OrdinalIgnoreCase)
                .Replace("/ws", "", StringComparison.OrdinalIgnoreCase)
                .TrimEnd('/');
        }
    }

    public static async Task<(bool Ok, string? Error, List<string>? Urls)> UploadAsync(
        string relayUrl,
        string workerToken,
        string taskId,
        IReadOnlyList<ScreenshotShot> screenshots,
        bool tlsInsecure = false,
        CancellationToken ct = default)
    {
        var baseUrl = HttpBaseFromRelayUrl(relayUrl);
        var url = $"{baseUrl}/api/artifacts";
        var handler = new HttpClientHandler();
        if (tlsInsecure)
            handler.ServerCertificateCustomValidationCallback = static (_, _, _, _) => true;

        using var client = new HttpClient(handler);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", workerToken);
        client.DefaultRequestHeaders.TryAddWithoutValidation("X-AgentR-Token", workerToken);

        var body = new
        {
            taskId,
            screenshots = screenshots.Select(s => new
            {
                name = s.Name,
                mimeType = s.MimeType,
                label = s.Label,
                dataBase64 = Convert.ToBase64String(s.Buffer),
            }),
        };

        using var res = await client.PostAsJsonAsync(url, body, ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode)
        {
            var text = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            return (false, $"HTTP {(int)res.StatusCode} {text[..Math.Min(200, text.Length)]}", null);
        }

        try
        {
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false));
            var urls = new List<string>();
            if (doc.RootElement.TryGetProperty("screenshots", out var shots))
            {
                foreach (var s in shots.EnumerateArray())
                {
                    if (s.TryGetProperty("url", out var u) && u.GetString() is { } sUrl)
                        urls.Add(sUrl);
                }
            }
            return (true, null, urls);
        }
        catch
        {
            return (true, null, null);
        }
    }
}
