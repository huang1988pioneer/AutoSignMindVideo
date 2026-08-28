using System.Text.Json;
using MindVideoAutoSign.Models;

namespace MindVideoAutoSign.Services;

/// <summary>
/// The single account seam shared by the desktop UI and workflow-facing services.
/// Enabled account numbers are stable Secret slots; retiring an account never
/// renumbers the remaining tokens.
/// </summary>
public sealed class AccountCatalog
{
    public const int DefaultSlotCount = 33;

    private readonly Dictionary<int, AccountDefinition> _byNumber;

    private AccountCatalog(int slotCount, IEnumerable<AccountDefinition> accounts, string source)
    {
        SlotCount = slotCount;
        Source = source;
        EnabledAccounts = accounts.OrderBy(account => account.Number).ToArray();
        _byNumber = EnabledAccounts.ToDictionary(account => account.Number);
    }

    public int SlotCount { get; }
    public string Source { get; }
    public IReadOnlyList<AccountDefinition> EnabledAccounts { get; }
    public int EnabledCount => EnabledAccounts.Count;

    public bool IsEnabled(int number) => _byNumber.ContainsKey(number);

    public AccountDefinition? Find(int number) =>
        _byNumber.GetValueOrDefault(number);

    public string LabelFor(int number) =>
        Find(number)?.Label ?? $"account-{number}";

    public static AccountCatalog Load() => Load(FindWorkspace());

    public static AccountCatalog Load(string workspace)
    {
        var source = new[]
            {
                Path.Combine(workspace, "accounts.json"),
                Path.Combine(AppContext.BaseDirectory, "accounts.json")
            }
            .Select(Path.GetFullPath)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault(File.Exists);

        if (source is null)
            throw new FileNotFoundException("找不到帳號設定檔 accounts.json。", Path.Combine(workspace, "accounts.json"));

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(source));
            return Parse(document.RootElement, source);
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException($"帳號設定檔格式錯誤：{source}", ex);
        }
    }

    private static AccountCatalog Parse(JsonElement root, string source)
    {
        if (root.ValueKind != JsonValueKind.Object)
            throw Invalid(source, "根節點必須是 JSON 物件。");

        var entries = ReadEntries(root, source);
        var inferredMax = entries.Count == 0 ? 0 : entries.Max(entry => entry.Number);
        var slotCount = TryGetProperty(root, "slotCount", out var slotElement) ||
                        TryGetProperty(root, "slot_count", out slotElement)
            ? ReadPositiveInt(slotElement, source, "slotCount")
            : Math.Max(DefaultSlotCount, inferredMax);

        if (slotCount < inferredMax)
            throw Invalid(source, $"slotCount {slotCount} 小於最高帳號編號。");

        var numbers = new HashSet<int>();
        var labels = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var accounts = new List<AccountDefinition>();
        foreach (var entry in entries)
        {
            if (entry.Number > slotCount)
                throw Invalid(source, $"帳號 #{entry.Number} 超過 slotCount {slotCount}。");
            if (!numbers.Add(entry.Number))
                throw Invalid(source, $"帳號編號重複：#{entry.Number}。");
            if (string.IsNullOrWhiteSpace(entry.Label))
                throw Invalid(source, $"帳號 #{entry.Number} 缺少名稱。");

            var label = entry.Label.Trim();
            if (label.Contains('\n') || label.Contains('\r') || label.Contains('[') || label.Contains(']'))
                throw Invalid(source, $"帳號 #{entry.Number} 名稱含有不支援的字元。");
            if (!labels.Add(label))
                throw Invalid(source, $"帳號名稱重複：{label}。");
            accounts.Add(new AccountDefinition(entry.Number, label));
        }

        if (accounts.Count == 0)
            throw Invalid(source, "至少要啟用一個帳號。");

        return new AccountCatalog(slotCount, accounts, source);
    }

    private static List<(int Number, string Label)> ReadEntries(JsonElement root, string source)
    {
        if (TryGetProperty(root, "accounts", out var accounts))
        {
            if (accounts.ValueKind == JsonValueKind.Array)
            {
                var entries = new List<(int Number, string Label)>();
                foreach (var item in accounts.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.Object ||
                        !TryGetProperty(item, "number", out var numberElement) ||
                        !TryGetProperty(item, "label", out var labelElement))
                        throw Invalid(source, "accounts 陣列的每筆資料都需要 number 與 label。");

                    entries.Add((
                        ReadPositiveInt(numberElement, source, "account number"),
                        labelElement.GetString() ?? string.Empty));
                }
                return entries;
            }

            if (accounts.ValueKind == JsonValueKind.Object)
                return ReadObjectEntries(accounts, source);

            throw Invalid(source, "accounts 必須是陣列或物件。");
        }

        // Backward compatibility with the original { "1": "label" } file.
        return ReadObjectEntries(root, source);
    }

    private static List<(int Number, string Label)> ReadObjectEntries(JsonElement objectElement, string source)
    {
        var entries = new List<(int Number, string Label)>();
        foreach (var property in objectElement.EnumerateObject())
        {
            if (!int.TryParse(property.Name, out var number))
                continue;
            if (number < 1)
                throw Invalid(source, $"帳號編號必須是正整數：{property.Name}。");
            if (property.Value.ValueKind != JsonValueKind.String)
                throw Invalid(source, $"帳號 #{number} 的名稱必須是字串。");
            entries.Add((number, property.Value.GetString() ?? string.Empty));
        }
        if (entries.Count == 0)
            throw Invalid(source, "找不到任何數字帳號設定。");
        return entries;
    }

    private static int ReadPositiveInt(JsonElement element, string source, string field)
    {
        int value;
        if (element.ValueKind == JsonValueKind.Number && element.TryGetInt32(out var numeric))
            value = numeric;
        else if (element.ValueKind == JsonValueKind.String && int.TryParse(element.GetString(), out var text))
            value = text;
        else
            throw Invalid(source, $"{field} 必須是正整數。");

        if (value < 1)
            throw Invalid(source, $"{field} 必須是正整數。");
        return value;
    }

    private static bool TryGetProperty(JsonElement element, string name, out JsonElement value)
    {
        if (element.TryGetProperty(name, out value)) return true;
        foreach (var property in element.EnumerateObject())
        {
            if (property.NameEquals(name) || string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase))
            {
                value = property.Value;
                return true;
            }
        }
        value = default;
        return false;
    }

    private static InvalidOperationException Invalid(string source, string message) =>
        new($"帳號設定檔無效（{source}）：{message}");

    private static string FindWorkspace()
    {
        foreach (var start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            for (var directory = new DirectoryInfo(start); directory is not null; directory = directory.Parent)
            {
                if (File.Exists(Path.Combine(directory.FullName, "accounts.json")))
                    return directory.FullName;
            }
        }
        return Environment.CurrentDirectory;
    }
}
