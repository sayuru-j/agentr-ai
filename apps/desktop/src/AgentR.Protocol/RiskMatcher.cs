using System.Text.RegularExpressions;

namespace AgentR.Protocol;

public static class RiskMatcher
{
    private static readonly (Regex Pattern, string Reason)[] Patterns =
    [
        (new Regex(@"\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?-?[rR]\b", RegexOptions.Compiled), "Destructive recursive delete"),
        (new Regex(@"\bgit\s+reset\s+--hard\b", RegexOptions.IgnoreCase | RegexOptions.Compiled), "Hard reset discards local changes"),
        (new Regex(@"\bgit\s+push\s+.*--force\b", RegexOptions.IgnoreCase | RegexOptions.Compiled), "Force push rewrites remote history"),
        (new Regex(@"\bnpm\s+(install|ci|uninstall)\b", RegexOptions.IgnoreCase | RegexOptions.Compiled), "Package install/uninstall modifies node_modules"),
        (new Regex(@"\bpnpm\s+(install|add|remove|i)\b", RegexOptions.IgnoreCase | RegexOptions.Compiled), "Package install/uninstall modifies dependencies"),
        (new Regex(@"\byarn\s+(install|add|remove)\b", RegexOptions.IgnoreCase | RegexOptions.Compiled), "Package install/uninstall modifies dependencies"),
        (new Regex(@"\bsudo\b", RegexOptions.IgnoreCase | RegexOptions.Compiled), "Elevated privileges requested"),
        (new Regex(@"\b(drop|truncate)\s+table\b", RegexOptions.IgnoreCase | RegexOptions.Compiled), "Destructive database operation"),
        (new Regex(@"\bformat\s+[a-z]:\b", RegexOptions.IgnoreCase | RegexOptions.Compiled), "Disk format command"),
        (new Regex(@"\bdel\s+/[sS]\b", RegexOptions.Compiled), "Recursive delete on Windows"),
        (new Regex(@"\brmdir\s+/[sS]\b", RegexOptions.IgnoreCase | RegexOptions.Compiled), "Recursive directory remove on Windows"),
    ];

    public static RiskMatch? MatchRiskCommand(string line)
    {
        var trimmed = line.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;
        foreach (var (pattern, reason) in Patterns)
        {
            if (pattern.IsMatch(trimmed))
                return new RiskMatch { Command = trimmed, Reason = reason, Tier = RiskTier.Approve };
        }
        return null;
    }

    public static RiskMatch? MatchRiskWithGuardrails(string line, ProjectGuardrails? guardrails)
    {
        var trimmed = line.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;

        if (guardrails?.AllowPatterns is { Count: > 0 } allow)
        {
            foreach (var raw in allow)
            {
                if (TryMatch(raw, trimmed)) return null;
            }
        }

        if (guardrails?.DenyPatterns is { Count: > 0 } deny)
        {
            foreach (var raw in deny)
            {
                if (TryMatch(raw, trimmed))
                    return new RiskMatch { Command = trimmed, Reason = "Blocked by project deny rule", Tier = RiskTier.Block };
            }
        }

        var baseMatch = MatchRiskCommand(trimmed);
        if (baseMatch is not null) return baseMatch;

        if (guardrails?.RequireApproval == true)
        {
            return new RiskMatch
            {
                Command = trimmed,
                Reason = "Project requires approval for all shell commands",
                Tier = RiskTier.Approve,
            };
        }

        return null;
    }

    private static bool TryMatch(string pattern, string input)
    {
        try
        {
            return Regex.IsMatch(input, pattern, RegexOptions.IgnoreCase);
        }
        catch
        {
            return false;
        }
    }
}
