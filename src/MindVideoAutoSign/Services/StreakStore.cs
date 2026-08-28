using System.Text.Json;
using System.Text.Json.Serialization;

namespace MindVideoAutoSign.Services;

/// <summary>
/// Persists the latest continuous check-in days for enabled accounts locally.
/// </summary>
public sealed class StreakStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly string _filePath;
    private readonly AccountCatalog _accounts;

    public StreakStore(AccountCatalog accounts)
    {
        _accounts = accounts ?? throw new ArgumentNullException(nameof(accounts));
        var folder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "MindVideo Auto Sign");
        Directory.CreateDirectory(folder);
        _filePath = Path.Combine(folder, "streaks.json");
    }

    public string Location => _filePath;

    public StreakSnapshot Load()
    {
        try
        {
            if (!File.Exists(_filePath))
                return new StreakSnapshot();

            var json = File.ReadAllText(_filePath);
            return JsonSerializer.Deserialize<StreakSnapshot>(json, JsonOptions) ?? new StreakSnapshot();
        }
        catch
        {
            return new StreakSnapshot();
        }
    }

    public void Save(StreakSnapshot snapshot)
    {
        snapshot.UpdatedAt = DateTimeOffset.Now;
        File.WriteAllText(_filePath, JsonSerializer.Serialize(snapshot, JsonOptions));
    }

    public void UpsertMany(IEnumerable<AccountStreakEntry> entries, string? source = null)
    {
        var snapshot = Load();
        if (!string.IsNullOrWhiteSpace(source))
            snapshot.Source = source;

        foreach (var entry in entries)
        {
            if (!_accounts.IsEnabled(entry.Account))
                continue;

            snapshot.Accounts[entry.Account.ToString()] = new AccountStreakEntry
            {
                Account = entry.Account,
                Label = entry.Label,
                Streak = entry.Streak,
                Status = entry.Status,
                TotalCredits = entry.TotalCredits,
                UpdatedAt = entry.UpdatedAt ?? DateTimeOffset.Now
            };
        }

        Save(snapshot);
    }
}

public sealed class StreakSnapshot
{
    public DateTimeOffset? UpdatedAt { get; set; }
    public string? Source { get; set; }
    public Dictionary<string, AccountStreakEntry> Accounts { get; set; } = new();
}

public sealed class AccountStreakEntry
{
    public int Account { get; set; }
    public string? Label { get; set; }
    public int? Streak { get; set; }
    public string? Status { get; set; }
    public int? TotalCredits { get; set; }
    public DateTimeOffset? UpdatedAt { get; set; }
}
