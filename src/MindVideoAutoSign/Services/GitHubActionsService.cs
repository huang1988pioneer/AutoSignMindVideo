using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace MindVideoAutoSign.Services;

public sealed class GitHubActionsService
{
    private const string Workflow = "mindvideo-daily-checkin.yml";
    private const string ReportArtifactName = "mindvideo-checkin-report";
    private readonly AccountCatalog _accounts;

    public GitHubActionsService(AccountCatalog accounts)
    {
        _accounts = accounts ?? throw new ArgumentNullException(nameof(accounts));
    }

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
        var runs = await GetRecentRunsAsync(repository, 1);
        return runs.FirstOrDefault();
    }

    public async Task<IReadOnlyList<WorkflowRunInfo>> GetRecentRunsAsync(string repository, int limit = 100)
    {
        var safeLimit = Math.Clamp(limit, 1, 1000);
        var json = await RunGhAsync([
            "run", "list",
            "--workflow", Workflow,
            "--repo", repository,
            "--limit", safeLimit.ToString(CultureInfo.InvariantCulture),
            "--json", "databaseId,status,conclusion,createdAt,updatedAt,url"
        ]);
        return JsonSerializer.Deserialize<List<WorkflowRunInfo>>(json, JsonOptions) ?? [];
    }

    public static WorkflowActionSummary SummarizeRuns(
        IEnumerable<WorkflowRunInfo> runs,
        TimeZoneInfo timeZone)
    {
        ArgumentNullException.ThrowIfNull(runs);
        ArgumentNullException.ThrowIfNull(timeZone);

        var completed = runs
            .Where(IsCompleted)
            .OrderByDescending(ActionTime)
            .ToArray();
        var lastSuccess = completed.FirstOrDefault(IsSuccessful);
        var lastFailure = completed.FirstOrDefault(IsFailure);

        var consecutiveSuccessDays = 0;
        var latestCompleted = completed.FirstOrDefault();
        if (latestCompleted is not null && IsSuccessful(latestCompleted))
        {
            var successfulDays = completed
                .Where(IsSuccessful)
                .Select(run => LocalDate(run, timeZone))
                .ToHashSet();
            var day = LocalDate(latestCompleted, timeZone);
            while (successfulDays.Contains(day))
            {
                consecutiveSuccessDays++;
                day = day.AddDays(-1);
            }
        }

        return new WorkflowActionSummary(
            lastSuccess is null ? null : ActionTime(lastSuccess),
            lastFailure is null ? null : ActionTime(lastFailure),
            consecutiveSuccessDays);
    }

    public async Task<IReadOnlyList<WorkflowAccountStatus>> GetAccountStatusesAsync(string repository, long runId)
    {
        // Prefer the structured summary artifact — it always has streak/status and avoids
        // brittle log-prefix parsing across matrix jobs.
        var fromArtifact = await TryLoadFromReportArtifactAsync(repository, runId);
        if (fromArtifact.Count > 0)
            return FillSlots(fromArtifact);

        var output = await RunGhAsync([
            "run", "view", runId.ToString(CultureInfo.InvariantCulture),
            "--repo", repository,
            "--log"
        ]);

        return FillSlots(ParseAccountRows(output));
    }

    private async Task<Dictionary<int, WorkflowAccountStatus>> TryLoadFromReportArtifactAsync(
        string repository,
        long runId)
    {
        var tempRoot = Path.Combine(
            Path.GetTempPath(),
            "MindVideoAutoSign",
            "run-report",
            runId.ToString(CultureInfo.InvariantCulture),
            Guid.NewGuid().ToString("N"));

        try
        {
            Directory.CreateDirectory(tempRoot);
            await RunGhAsync([
                "run", "download",
                runId.ToString(CultureInfo.InvariantCulture),
                "--repo", repository,
                "-n", ReportArtifactName,
                "-D", tempRoot
            ]);

            var jsonPath = Directory
                .EnumerateFiles(tempRoot, "checkin-daily-summary.json", SearchOption.AllDirectories)
                .FirstOrDefault();
            if (jsonPath is null)
                return new Dictionary<int, WorkflowAccountStatus>();

            var json = await File.ReadAllTextAsync(jsonPath);
            var report = JsonSerializer.Deserialize<CheckinDailySummaryReport>(json, JsonOptions);
            if (report?.Rows is null || report.Rows.Count == 0)
                return new Dictionary<int, WorkflowAccountStatus>();

            var rows = new Dictionary<int, WorkflowAccountStatus>();
            foreach (var item in report.Rows)
            {
                if (item.Account is not int number || !_accounts.IsEnabled(number))
                    continue;

                var alias = !string.IsNullOrWhiteSpace(item.Label)
                    ? item.Label.Trim()
                    : CleanAlias(item.Name ?? $"account-{number}");
                var status = NormalizeStatus(item.Status ?? string.Empty);
                var streak = item.Streak;
                var configured = !IsSkipped(status) &&
                                 !string.Equals(item.Status, "skipped", StringComparison.OrdinalIgnoreCase);
                var successful = configured &&
                                 !status.Contains("fail", StringComparison.OrdinalIgnoreCase) &&
                                 !status.Contains("失敗", StringComparison.Ordinal);

                rows[number] = new WorkflowAccountStatus(number, alias, status, streak, successful, configured);
            }

            return rows;
        }
        catch
        {
            // Fall back to log parsing when artifact is missing or download fails.
            return new Dictionary<int, WorkflowAccountStatus>();
        }
        finally
        {
            try
            {
                if (Directory.Exists(tempRoot))
                    Directory.Delete(tempRoot, recursive: true);
            }
            catch
            {
                // best-effort cleanup
            }
        }
    }

    private IReadOnlyList<WorkflowAccountStatus> FillSlots(Dictionary<int, WorkflowAccountStatus> rows) =>
        _accounts.EnabledAccounts
            .Select(account => rows.GetValueOrDefault(account.Number) is { } row
                ? string.IsNullOrWhiteSpace(row.Alias) ||
                  string.Equals(row.Alias, $"account-{account.Number}", StringComparison.OrdinalIgnoreCase)
                    ? row with { Alias = account.Label }
                    : row
                : new WorkflowAccountStatus(account.Number, account.Label, "尚未設定 GitHub Secret", null, false, false))
            .ToArray();

    internal Dictionary<int, WorkflowAccountStatus> ParseAccountRows(string output)
    {
        var rows = new Dictionary<int, WorkflowAccountStatus>();

        // gh run view --log prefixes every line with: jobName + stepName + ISO timestamp + "Z "
        // Example:
        // daily-summaryBuild daily summary...2026-08-05T18:44:44.2246071Z | 1 | checkin-1-x | ☑️ already_done | +2 | 352 | 1 | note |
        // So match the markdown table cells anywhere on the line (not only at ^).
        foreach (Match match in Regex.Matches(
                     output,
                     @"\|\s*(?<number>\d+)\s*\|\s*(?<alias>[^|\r\n]+)\|\s*(?<status>[^|\r\n]+)\|\s*(?<reward>[^|\r\n]*)\|\s*(?<total>[^|\r\n]*)\|\s*(?<streak>[^|\r\n]*)\|\s*(?<note>[^|\r\n]*)\|"))
        {
            AddRow(
                rows,
                match.Groups["number"].Value,
                match.Groups["alias"].Value,
                match.Groups["status"].Value,
                match.Groups["streak"].Value);
        }

        // Console table line (no streak column in current summarize script):
        // - #4 checkin-4-feng33feng35feng3: checked_in | Δ +10 | total 1234 | note
        foreach (Match match in Regex.Matches(
                     output,
                     @"-\s*#(?<number>\d+)\s+(?<alias>[^:\r\n]+):\s*(?<status>[^\|\r\n]+)"))
        {
            var numberText = match.Groups["number"].Value;
            if (!int.TryParse(numberText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number))
                continue;
            if (rows.ContainsKey(number)) continue;

            var status = match.Groups["status"].Value.Trim();
            var streakMatch = Regex.Match(match.Value, @"streak\s+(?<streak>\d+)", RegexOptions.IgnoreCase);
            int? streak = streakMatch.Success && int.TryParse(streakMatch.Groups["streak"].Value, out var s) ? s : null;
            AddRow(rows, numberText, match.Groups["alias"].Value, status, streak?.ToString() ?? string.Empty);
        }

        // Markdown streak-friendly lines sometimes printed as:
        // - #01 alias: ✅ ... | 連續 12 |
        foreach (Match match in Regex.Matches(
                     output,
                     @"-\s*#(?<number>\d+)\s+(?<alias>[^:\r\n]+):\s*.*?\|\s*連續\s+(?<days>\d+)\s*\|"))
        {
            var numberText = match.Groups["number"].Value;
            if (!int.TryParse(numberText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number))
                continue;

            var alias = match.Groups["alias"].Value.Trim();
            var days = int.Parse(match.Groups["days"].Value, CultureInfo.InvariantCulture);
            if (rows.TryGetValue(number, out var existing) && existing.Streak is not null)
                continue;

            if (!_accounts.IsEnabled(number)) continue;
            rows[number] = new WorkflowAccountStatus(number, CleanAlias(alias), "已簽到", days, true, true);
        }

        // Skipped section: No secret / token: **#14, 15, 16, 17, ...**
        foreach (Match match in Regex.Matches(
                     output,
                     @"No secret\s*/\s*token:\s*\*?\*?#?(?<ids>[\d,\s]+)\*?\*?",
                     RegexOptions.IgnoreCase))
        {
            foreach (Match id in Regex.Matches(match.Groups["ids"].Value, @"\d+"))
            {
                if (!int.TryParse(id.Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number))
                    continue;
                if (rows.ContainsKey(number)) continue;
                if (!_accounts.IsEnabled(number)) continue;
                rows[number] = new WorkflowAccountStatus(
                    number,
                    $"account-{number}",
                    "略過（未設定 Secret）",
                    null,
                    false,
                    false);
            }
        }

        return rows;
    }

    private void AddRow(
        Dictionary<int, WorkflowAccountStatus> rows,
        string numberText,
        string aliasRaw,
        string statusRaw,
        string streakRaw)
    {
        if (!int.TryParse(numberText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number))
            return;
        if (!_accounts.IsEnabled(number))
            return;

        // Header / metric rows must not overwrite real account data.
        var statusProbe = statusRaw.Trim();
        if (statusProbe.Equals("Status", StringComparison.OrdinalIgnoreCase) ||
            statusProbe.Equals("---", StringComparison.Ordinal) ||
            statusProbe.StartsWith("---", StringComparison.Ordinal) ||
            statusProbe.Equals("Count", StringComparison.OrdinalIgnoreCase))
            return;

        var alias = CleanAlias(aliasRaw);
        var status = NormalizeStatus(statusRaw);
        int? streak = int.TryParse(streakRaw.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var s)
            ? s
            : null;
        var configured = !IsSkipped(status);
        var successful = configured &&
                         !status.Contains("fail", StringComparison.OrdinalIgnoreCase) &&
                         !status.Contains("失敗", StringComparison.Ordinal);

        // Prefer a row that already has streak if we parse duplicates.
        if (rows.TryGetValue(number, out var existing) &&
            existing.Streak is not null &&
            streak is null)
            return;

        rows[number] = new WorkflowAccountStatus(number, alias, status, streak, successful, configured);
    }

    private static string CleanAlias(string alias)
    {
        var text = alias.Trim();
        // checkin-4-feng33feng35feng3 → feng33feng35feng3
        var match = Regex.Match(text, @"^checkin-\d+-(.+)$", RegexOptions.IgnoreCase);
        if (match.Success) return match.Groups[1].Value.Trim();

        // MINDVIDEO_TOKEN1 → account-1 style fallback handled by caller
        match = Regex.Match(text, @"^MINDVIDEO_TOKEN(\d+)$", RegexOptions.IgnoreCase);
        if (match.Success) return $"account-{match.Groups[1].Value}";

        return text;
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

    private static bool IsCompleted(WorkflowRunInfo run) =>
        string.Equals(run.Status, "completed", StringComparison.OrdinalIgnoreCase);

    private static bool IsSuccessful(WorkflowRunInfo run) =>
        IsCompleted(run) && string.Equals(run.Conclusion, "success", StringComparison.OrdinalIgnoreCase);

    private static bool IsFailure(WorkflowRunInfo run)
    {
        if (!IsCompleted(run)) return false;
        var conclusion = run.Conclusion?.Trim();
        return !string.IsNullOrWhiteSpace(conclusion) &&
               !string.Equals(conclusion, "success", StringComparison.OrdinalIgnoreCase) &&
               !string.Equals(conclusion, "neutral", StringComparison.OrdinalIgnoreCase) &&
               !string.Equals(conclusion, "skipped", StringComparison.OrdinalIgnoreCase);
    }

    private static DateTimeOffset ActionTime(WorkflowRunInfo run) => run.UpdatedAt ?? run.CreatedAt;

    private static DateOnly LocalDate(WorkflowRunInfo run, TimeZoneInfo timeZone) =>
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(ActionTime(run), timeZone).DateTime);

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        NumberHandling = JsonNumberHandling.AllowReadingFromString
    };

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

    private sealed class CheckinDailySummaryReport
    {
        public List<CheckinDailySummaryRow>? Rows { get; set; }
    }

    private sealed class CheckinDailySummaryRow
    {
        public int? Account { get; set; }
        public string? Name { get; set; }
        public string? Label { get; set; }
        public string? Status { get; set; }
        public int? Streak { get; set; }
    }
}

public sealed record WorkflowRunInfo(
    long DatabaseId,
    string Status,
    string? Conclusion,
    DateTimeOffset CreatedAt,
    DateTimeOffset? UpdatedAt,
    string Url);

public sealed record WorkflowActionSummary(
    DateTimeOffset? LastSuccessAt,
    DateTimeOffset? LastFailureAt,
    int ConsecutiveSuccessDays);

public sealed record WorkflowAccountStatus(
    int Number,
    string Alias,
    string Status,
    int? Streak,
    bool IsSuccessful,
    bool IsConfigured);
