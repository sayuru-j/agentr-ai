using System.Net.Http;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace AgentR.Desktop;

public sealed class UpdateCheckResult
{
    public bool Checked { get; set; }
    public bool UpdateAvailable { get; set; }
    public string LocalVersion { get; set; } = "";
    public string? RemoteVersion { get; set; }
    public string? ReleaseUrl { get; set; }
    public string? PortableUrl { get; set; }
    public string? Error { get; set; }
}

public static class UpdateChecker
{
    private const string DefaultRepo = "sayuru-j/agentr-ai";
    private static readonly HttpClient Http = new();

    public static bool IsNewerVersion(string remote, string local)
    {
        static int[] Parse(string v) =>
            Regex.Replace(v, @"^v", "", RegexOptions.IgnoreCase)
                .Split(['.', '+', '-'], StringSplitOptions.RemoveEmptyEntries)
                .Take(3)
                .Select(p => int.TryParse(p, out var n) ? n : 0)
                .Concat(Enumerable.Repeat(0, 3))
                .Take(3)
                .ToArray();

        var a = Parse(remote);
        var b = Parse(local);
        for (var i = 0; i < 3; i++)
        {
            var d = a[i] - b[i];
            if (d != 0) return d > 0;
        }
        return false;
    }

    public static async Task<UpdateCheckResult> CheckGithubReleaseUpdateAsync(
        string localVersion,
        string? repo = null,
        CancellationToken ct = default)
    {
        repo ??= Environment.GetEnvironmentVariable("AGENTR_GITHUB_REPO") ?? DefaultRepo;
        localVersion = Regex.Replace(localVersion, @"^v", "", RegexOptions.IgnoreCase);
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{repo}/releases/latest");
            req.Headers.TryAddWithoutValidation("Accept", "application/vnd.github+json");
            req.Headers.TryAddWithoutValidation("User-Agent", "AgentR-desktop");
            using var res = await Http.SendAsync(req, ct).ConfigureAwait(false);
            if ((int)res.StatusCode == 404)
            {
                return new UpdateCheckResult
                {
                    Checked = true,
                    LocalVersion = localVersion,
                    Error = "No GitHub releases yet",
                };
            }
            if (!res.IsSuccessStatusCode)
            {
                return new UpdateCheckResult
                {
                    Checked = true,
                    LocalVersion = localVersion,
                    Error = $"GitHub HTTP {(int)res.StatusCode}",
                };
            }

            await using var stream = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
            var root = doc.RootElement;
            var remoteVersion = Regex.Replace(root.TryGetProperty("tag_name", out var tag) ? tag.GetString() ?? "" : "", @"^v", "", RegexOptions.IgnoreCase);
            if (string.IsNullOrEmpty(remoteVersion))
            {
                return new UpdateCheckResult
                {
                    Checked = true,
                    LocalVersion = localVersion,
                    Error = "Release has no tag",
                };
            }

            string? portableUrl = null;
            if (root.TryGetProperty("assets", out var assets) && assets.ValueKind == JsonValueKind.Array)
            {
                foreach (var a in assets.EnumerateArray())
                {
                    var name = a.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
                    if (Regex.IsMatch(name, "portable", RegexOptions.IgnoreCase))
                    {
                        portableUrl = a.TryGetProperty("browser_download_url", out var u) ? u.GetString() : null;
                        break;
                    }
                }
            }

            return new UpdateCheckResult
            {
                Checked = true,
                UpdateAvailable = IsNewerVersion(remoteVersion, localVersion),
                LocalVersion = localVersion,
                RemoteVersion = remoteVersion,
                ReleaseUrl = root.TryGetProperty("html_url", out var html) ? html.GetString() : null,
                PortableUrl = portableUrl,
            };
        }
        catch (Exception ex)
        {
            return new UpdateCheckResult
            {
                Checked = false,
                LocalVersion = localVersion,
                Error = ex.Message,
            };
        }
    }
}
