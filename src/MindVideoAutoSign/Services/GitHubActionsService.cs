using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MindVideoAutoSign.Services;

public sealed class GitHubActionsService
{
    private const string Workflow = "mindvideo-daily-checkin.yml";
    private const int AccountSlots = 33;

    public Task TriggerAsync(string repository) =>
        RunGhAsync(["workflow", "run", Workflow, "--repo", repository, "--ref", "main"]);

    public async Task<string> GetRepositoryAsync()
    {
        var output = await RunGhAsync(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
        return output.Trim();
    }

    public async Task SetSecretAsync(string repository, string secretName, string value)
    {
        using var process = CreateGhProcess(["secret", "set", secretName, "--repo", repository]);
        if (!process.Start())
            throw new InvalidOperationException("無法啟動 GitHub CLI (gh)。請先安裝並執行 gh auth login。");

        await process.StandardInput.WriteAsync(value);
        process.StandardInput.Close();

        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var error = await stderr;
        _ = await stdout;

        if (process.ExitCode != 0)
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(error) ? "更新 GitHub Secret 失敗。" : error.Trim());
    }

    public async Task<WorkflowRunInfo?> GetLatestAsync(string repository)
    {
        var json = await RunGhAsync([
            "run", "list",
            "--workflow", Workflow,
            "--repo", repository,
            "--limit", "1",
            "--json", "databaseId,status,conclusion,createdAt,updatedAt,url"
        ]);
        return JsonSerializer.Deserialize<List<WorkflowRunInfo>>(json, JsonOptions)?.FirstOrDefault();
    }

    public async Task<IReadOnlyList<WorkflowAccountStatus>> GetAccountStatusesAsync(string repository, long runId)
    {
        var output = await RunGhAsync([
            "run", "view", runId.ToString(CultureInfo.InvariantCulture),
            "--repo", repository,
            "--log"
        ]);

        var rows = ParseAccountRows(output);
        return Enumerable.Range(1, AccountSlots)
            .Select(number => rows.GetValueOrDefault(number)
                ?? new WorkflowAccountStatus(number, $"account-{number}", "尚未設定 GitHub Secret", null, false, false))
            .ToArray();
    }

    private static Dictionary<int, WorkflowAccountStatus> ParseAccountRows(string output)
    {
        var rows = new Dictionary<int, WorkflowAccountStatus>();

        // Job Summary / markdown table:
        // | 1 | checkin-1-goldshoot0720 | ✅ checked_in | +10 | 1234 | 5 | new today |
        foreach (Match match in Regex.Matches(
                     output,
                     @"^\s*\|\s*(?<number>\d+)\s*\|\s*(?<alias>[^|]+)\|\s*(?<status>[^|]+)\|\s*(?<reward>[^|]*)\|\s*(?<total>[^|]*)\|\s*(?<streak>[^|]*)\|\s*(?<note>[^|]*)\|",
                     RegexOptions.Multiline))
        {
            AddRow(rows, match.Groups["number"].Value, match.Groups["alias"].Value, match.Groups["status"].Value, match.Groups["streak"].Value);
        }

        // Console table line:
        // - #1 checkin-1-goldshoot0720: checked_in | Δ +10 | total 1234 | note
        foreach (Match match in Regex.Matches(
                     output,
                     @"^\s*-\s*#(?<number>\d+)\s+(?<alias>[^:]+):\s*(?<status>[^\|]+)",
                     RegexOptions.Multiline))
        {
            var numberText = match.Groups["number"].Value;
            if (!int.TryParse(numberText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number))
                continue;
            if (rows.ContainsKey(number)) continue;

            var status = match.Groups["status"].Value.Trim();
            var streakMatch = Regex.Match(match.Value, @"streak\s+(?<streak>\d+)", RegexOptions.IgnoreCase);
            int? streak = streakMatch.Success && int.TryParse(streakMatch.Groups["streak"].Value, out var s) ? s : null;
            // Prefer streak from nearby "total X | streak Y" patterns if present later in log.
            AddRow(rows, numberText, match.Groups["alias"].Value, status, streak?.ToString() ?? string.Empty);
        }

        // Markdown streak-friendly lines sometimes printed as:
        // - #01 alias: ✅ ... | 連續 12 |
        foreach (Match match in Regex.Matches(
                     output,
                     @"-\s*#(?<number>\d+)\s+(?<alias>[^:\r\n]+):\s*.*?\|\s*連續\s+(?<days>\d+)\s*\|",
                     RegexOptions.Multiline))
        {
            var numberText = match.Groups["number"].Value;
            if (!int.TryParse(numberText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number))
                continue;

            var alias = match.Groups["alias"].Value.Trim();
            var days = int.Parse(match.Groups["days"].Value, CultureInfo.InvariantCulture);
            rows[number] = new WorkflowAccountStatus(number, alias, "已簽到", days, true, true);
        }

        return rows;
    }

    private static void AddRow(
        Dictionary<int, WorkflowAccountStatus> rows,
        string numberText,
        string aliasRaw,
        string statusRaw,
        string streakRaw)
    {
        if (!int.TryParse(numberText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number))
            return;

        var alias = CleanAlias(aliasRaw);
        var status = NormalizeStatus(statusRaw);
        int? streak = int.TryParse(streakRaw.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var s) ? s : null;
        var configured = !IsSkipped(status);
        var successful = configured && !status.Contains("fail", StringComparison.OrdinalIgnoreCase) && !status.Contains("失敗", StringComparison.Ordinal);

        rows[number] = new WorkflowAccountStatus(number, alias, status, streak, successful, configured);
    }

    private static string CleanAlias(string alias)
    {
        var text = alias.Trim();
        // checkin-1-goldshoot0720 → goldshoot0720
        var match = Regex.Match(text, @"^checkin-\d+-(.+)$", RegexOptions.IgnoreCase);
        return match.Success ? match.Groups[1].Value.Trim() : text;
    }

    private static string NormalizeStatus(string status)
    {
        var text = status.Trim();
        text = Regex.Replace(text, @"^[✅☑️❌⏭️❔\s]+", string.Empty).Trim();

        if (text.Contains("checked_in", StringComparison.OrdinalIgnoreCase)) return "今日簽到";
        if (text.Contains("already_done", StringComparison.OrdinalIgnoreCase)) return "已簽過";
        if (text.Contains("skipped", StringComparison.OrdinalIgnoreCase)) return "略過（未設定 Secret）";
        if (text.Contains("failed", StringComparison.OrdinalIgnoreCase)) return "失敗";
        return text;
    }

    private static bool IsSkipped(string status) =>
        status.Contains("略過", StringComparison.Ordinal) ||
        status.Contains("skipped", StringComparison.OrdinalIgnoreCase) ||
        status.Contains("尚未設定", StringComparison.Ordinal);

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    private static async Task<string> RunGhAsync(IEnumerable<string> arguments)
    {
        using var process = CreateGhProcess(arguments, redirectInput: false);
        try
        {
            if (!process.Start())
                throw new InvalidOperationException("無法啟動 GitHub CLI (gh)。請先安裝並執行 gh auth login。");

            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
            var output = await stdout;
            var error = await stderr;
            if (process.ExitCode != 0)
                throw new InvalidOperationException(string.IsNullOrWhiteSpace(error)
                    ? "GitHub Actions 查詢失敗。請確認已安裝並登入 GitHub CLI：gh auth login"
                    : error.Trim());
            return output;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            throw new InvalidOperationException("找不到 GitHub CLI。請安裝 gh 後執行「gh auth login」。");
        }
    }

    private static Process CreateGhProcess(IEnumerable<string> arguments, bool redirectInput = true)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = "gh",
            UseShellExecute = false,
            RedirectStandardInput = redirectInput,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        foreach (var argument in arguments)
            startInfo.ArgumentList.Add(argument);
        return new Process { StartInfo = startInfo };
    }
}

public sealed record WorkflowRunInfo(
    long DatabaseId,
    string Status,
    string? Conclusion,
    DateTimeOffset CreatedAt,
    DateTimeOffset? UpdatedAt,
    string Url);

public sealed record WorkflowAccountStatus(
    int Number,
    string Alias,
    string Status,
    int? Streak,
    bool IsSuccessful,
    bool IsConfigured);
