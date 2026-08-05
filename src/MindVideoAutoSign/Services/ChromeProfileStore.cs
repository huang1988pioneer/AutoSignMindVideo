using System.Text.Json;

namespace MindVideoAutoSign.Services;

public sealed class ChromeProfileConfig
{
    public string ExecutablePath { get; set; } = ChromeProfileStore.DefaultExecutablePath;
    /// <summary>Legacy label only — not passed to CDP (Chrome forbids system profiles for remote debugging).</summary>
    public string ProfileDirectory { get; set; } = ChromeProfileStore.DefaultProfileDirectory;
    /// <summary>
    /// Dedicated non-default user-data-dir for CDP. Must NOT be the system Chrome\User Data path.
    /// Null means: resolve per-account under .browser-profiles/cdp-account-NN.
    /// </summary>
    public string? UserDataDir { get; set; }
}

public sealed class ChromeProfileStore
{
    public const string DefaultExecutablePath =
        @"C:\Program Files\Google\Chrome\Application\chrome.exe";

    public const string DefaultProfileDirectory = "Default";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private readonly string _userFilePath;
    private readonly string? _workspaceFilePath;

    public ChromeProfileStore(string? workspaceRoot = null)
    {
        var folder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "MindVideoFlow");
        Directory.CreateDirectory(folder);
        _userFilePath = Path.Combine(folder, "chrome-profiles.json");
        _workspaceFilePath = string.IsNullOrWhiteSpace(workspaceRoot)
            ? null
            : Path.Combine(workspaceRoot, "chrome-profiles.json");
    }

    public string Location => _userFilePath;

    public static ChromeProfileConfig CreateDefault(int accountNumber = 1) => new()
    {
        ExecutablePath = DefaultExecutablePath,
        ProfileDirectory = DefaultProfileDirectory,
        UserDataDir = DefaultCdpUserDataDir(accountNumber)
    };

    /// <summary>
    /// Chrome only enables remote debugging with a non-default user-data-dir.
    /// Never use %LOCALAPPDATA%\Google\Chrome\User Data here.
    /// </summary>
    public static string DefaultCdpUserDataDir(int accountNumber)
    {
        var root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "MindVideo Auto Sign",
            "chrome-cdp");
        return Path.Combine(root, $"account-{accountNumber:00}");
    }

    public static bool IsForbiddenSystemChromeUserDataDir(string? dir)
    {
        if (string.IsNullOrWhiteSpace(dir)) return false;
        var normalized = Path.GetFullPath(dir.Trim().Trim('"')).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var system = Path.GetFullPath(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Google", "Chrome", "User Data")).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (string.Equals(normalized, system, StringComparison.OrdinalIgnoreCase))
            return true;
        if (normalized.StartsWith(system + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            return true;
        return normalized.Contains($"{Path.DirectorySeparatorChar}Google{Path.DirectorySeparatorChar}Chrome{Path.DirectorySeparatorChar}User Data", StringComparison.OrdinalIgnoreCase);
    }

    public static string ResolveCdpUserDataDir(int accountNumber, string? requested)
    {
        if (string.IsNullOrWhiteSpace(requested))
            return DefaultCdpUserDataDir(accountNumber);
        var path = Path.GetFullPath(requested.Trim().Trim('"'));
        if (IsForbiddenSystemChromeUserDataDir(path))
            return DefaultCdpUserDataDir(accountNumber);
        return path;
    }

    public Dictionary<int, ChromeProfileConfig> LoadAll()
    {
        var result = new Dictionary<int, ChromeProfileConfig>();

        // Workspace template first (repo defaults), then user overrides.
        MergeFile(_workspaceFilePath, result);
        MergeFile(_userFilePath, result);
        return result;
    }

    public ChromeProfileConfig GetOrDefault(int accountNumber)
    {
        var all = LoadAll();
        return all.TryGetValue(accountNumber, out var config)
            ? Normalize(config, accountNumber)
            : CreateDefault(accountNumber);
    }

    public async Task SaveAccountAsync(int accountNumber, ChromeProfileConfig config)
    {
        var all = LoadAll();
        all[accountNumber] = Normalize(config, accountNumber);
        await SaveUserFileAsync(all);
    }

    public async Task SaveUserFileAsync(Dictionary<int, ChromeProfileConfig> all)
    {
        var payload = all.ToDictionary(
            pair => pair.Key.ToString(),
            pair =>
            {
                var cfg = Normalize(pair.Value, pair.Key);
                return new
                {
                    label = (string?)null,
                    browser = "chrome",
                    executablePath = cfg.ExecutablePath,
                    profileDirectory = cfg.ProfileDirectory,
                    userDataDir = cfg.UserDataDir
                };
            });

        Directory.CreateDirectory(Path.GetDirectoryName(_userFilePath)!);
        await File.WriteAllTextAsync(
            _userFilePath,
            JsonSerializer.Serialize(payload, JsonOptions));
    }

    /// <summary>
    /// Write current account mapping into workspace chrome-profiles.json so the
    /// Node capture script can read it when launched from the app.
    /// </summary>
    public async Task SyncWorkspaceFileAsync(Dictionary<int, ChromeProfileConfig> all, IReadOnlyDictionary<int, string>? labels = null)
    {
        if (string.IsNullOrWhiteSpace(_workspaceFilePath)) return;

        var payload = all.ToDictionary(
            pair => pair.Key.ToString(),
            pair =>
            {
                var cfg = Normalize(pair.Value, pair.Key);
                return new Dictionary<string, object?>
                {
                    ["label"] = labels is not null && labels.TryGetValue(pair.Key, out var label) ? label : null,
                    ["browser"] = "chrome",
                    ["executablePath"] = cfg.ExecutablePath,
                    ["profileDirectory"] = cfg.ProfileDirectory,
                    ["userDataDir"] = cfg.UserDataDir
                };
            });

        Directory.CreateDirectory(Path.GetDirectoryName(_workspaceFilePath)!);
        await File.WriteAllTextAsync(
            _workspaceFilePath,
            JsonSerializer.Serialize(payload, JsonOptions));
    }

    public static string FormatCommandPreview(ChromeProfileConfig config, int accountNumber = 1)
    {
        var cfg = Normalize(config, accountNumber);
        var exe = cfg.ExecutablePath.Contains(' ', StringComparison.Ordinal)
            ? $"\"{cfg.ExecutablePath}\""
            : cfg.ExecutablePath;
        var userData = ResolveCdpUserDataDir(accountNumber, cfg.UserDataDir);
        var userDataArg = userData.Contains(' ', StringComparison.Ordinal) ? $"\"{userData}\"" : userData;
        // CDP-compliant preview (no system profile-directory).
        return $"{exe} --remote-debugging-port=<port> --remote-allow-origins=* --user-data-dir={userDataArg}";
    }

    private static ChromeProfileConfig Normalize(ChromeProfileConfig config, int accountNumber = 1) => new()
    {
        ExecutablePath = string.IsNullOrWhiteSpace(config.ExecutablePath)
            ? DefaultExecutablePath
            : config.ExecutablePath.Trim().Trim('"'),
        ProfileDirectory = string.IsNullOrWhiteSpace(config.ProfileDirectory)
            ? DefaultProfileDirectory
            : config.ProfileDirectory.Trim().Trim('"'),
        UserDataDir = ResolveCdpUserDataDir(
            accountNumber,
            string.IsNullOrWhiteSpace(config.UserDataDir) ? null : config.UserDataDir.Trim().Trim('"'))
    };

    private static void MergeFile(string? path, Dictionary<int, ChromeProfileConfig> target)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return;

        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return;

            foreach (var property in doc.RootElement.EnumerateObject())
            {
                if (!int.TryParse(property.Name, out var account) || account < 1) continue;
                if (property.Value.ValueKind != JsonValueKind.Object) continue;

                var existing = target.GetValueOrDefault(account) ?? CreateDefault(account);
                if (property.Value.TryGetProperty("executablePath", out var exe) &&
                    exe.ValueKind == JsonValueKind.String &&
                    !string.IsNullOrWhiteSpace(exe.GetString()))
                {
                    existing.ExecutablePath = exe.GetString()!.Trim();
                }
                if (property.Value.TryGetProperty("profileDirectory", out var profile) &&
                    profile.ValueKind == JsonValueKind.String &&
                    !string.IsNullOrWhiteSpace(profile.GetString()))
                {
                    existing.ProfileDirectory = profile.GetString()!.Trim();
                }
                // Also accept "profile" alias.
                if (property.Value.TryGetProperty("profile", out var profileAlias) &&
                    profileAlias.ValueKind == JsonValueKind.String &&
                    !string.IsNullOrWhiteSpace(profileAlias.GetString()))
                {
                    existing.ProfileDirectory = profileAlias.GetString()!.Trim();
                }
                if (property.Value.TryGetProperty("userDataDir", out var userData))
                {
                    existing.UserDataDir = userData.ValueKind == JsonValueKind.String
                        ? userData.GetString()
                        : null;
                }

                target[account] = Normalize(existing, account);
            }
        }
        catch
        {
            // Ignore malformed config; UI falls back to defaults.
        }
    }
}
