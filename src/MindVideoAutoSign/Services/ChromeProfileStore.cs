using System.Text.Json;

namespace MindVideoAutoSign.Services;

public sealed class ChromeProfileConfig
{
    /// <summary>chrome | firefox (edge treated as chrome/CDP).</summary>
    public string Browser { get; set; } = ChromeProfileStore.BrowserChrome;

    public string ExecutablePath { get; set; } = ChromeProfileStore.DefaultExecutablePath;

    /// <summary>
    /// Chrome: legacy label only (system Profile N is not used for CDP).
    /// Firefox: optional human note; real profile path is <see cref="UserDataDir"/>.
    /// </summary>
    public string ProfileDirectory { get; set; } = ChromeProfileStore.DefaultProfileDirectory;

    /// <summary>
    /// Chrome CDP: dedicated non-default user-data-dir (never system Chrome\User Data).
    /// Firefox Playwright: profile directory (dedicated by default).
    /// Null means resolve a per-account default under LocalAppData.
    /// </summary>
    public string? UserDataDir { get; set; }
}

public sealed class ChromeProfileStore
{
    public const string BrowserChrome = "chrome";
    public const string BrowserFirefox = "firefox";

    public const string DefaultExecutablePath =
        @"C:\Program Files\Google\Chrome\Application\chrome.exe";

    public const string DefaultFirefoxExecutablePath =
        @"C:\Program Files\Mozilla Firefox\firefox.exe";

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
        Browser = BrowserChrome,
        ExecutablePath = DefaultExecutablePath,
        ProfileDirectory = DefaultProfileDirectory,
        UserDataDir = DefaultCdpUserDataDir(accountNumber)
    };

    public static ChromeProfileConfig CreateFirefoxDefault(int accountNumber = 1) => new()
    {
        Browser = BrowserFirefox,
        ExecutablePath = FindFirefoxExecutable() ?? DefaultFirefoxExecutablePath,
        ProfileDirectory = "firefox",
        UserDataDir = DefaultFirefoxProfileDir(accountNumber)
    };

    public static bool IsFirefox(ChromeProfileConfig? config) =>
        string.Equals(NormalizeBrowser(config?.Browser, config?.ExecutablePath), BrowserFirefox, StringComparison.OrdinalIgnoreCase);

    public static string NormalizeBrowser(string? browser, string? executablePath = null)
    {
        var b = (browser ?? string.Empty).Trim().ToLowerInvariant();
        if (b is "firefox" or "ff" or "mozilla") return BrowserFirefox;
        if (b is "chrome" or "chromium" or "edge" or "msedge" or "cdp") return BrowserChrome;

        var exe = (executablePath ?? string.Empty).ToLowerInvariant();
        if (exe.Contains("firefox", StringComparison.Ordinal)) return BrowserFirefox;
        return BrowserChrome;
    }

    public static string? FindFirefoxExecutable()
    {
        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Mozilla Firefox", "firefox.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Mozilla Firefox", "firefox.exe"),
            DefaultFirefoxExecutablePath
        };
        return candidates.FirstOrDefault(File.Exists);
    }

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

    /// <summary>Dedicated Firefox profile folder for Playwright persistent context.</summary>
    public static string DefaultFirefoxProfileDir(int accountNumber)
    {
        var root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "MindVideo Auto Sign",
            "firefox-profiles");
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

    /// <summary>True when path looks like a live Mozilla Firefox profiles tree (risk of lock/corruption).</summary>
    public static bool IsSystemFirefoxProfilesPath(string? dir)
    {
        if (string.IsNullOrWhiteSpace(dir)) return false;
        var normalized = Path.GetFullPath(dir.Trim().Trim('"'));
        return normalized.Contains($"{Path.DirectorySeparatorChar}Mozilla{Path.DirectorySeparatorChar}Firefox{Path.DirectorySeparatorChar}Profiles", StringComparison.OrdinalIgnoreCase);
    }

    public static string FirefoxSystemProfilesRoot()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "Mozilla", "Firefox", "Profiles");
    }

    public static bool IsFirefoxProcessRunning()
    {
        try
        {
            return System.Diagnostics.Process.GetProcessesByName("firefox").Length > 0;
        }
        catch
        {
            return false;
        }
    }

    public static string ParentLockPath(string profileDir) =>
        Path.Combine(profileDir, "parent.lock");

    /// <summary>
    /// Pre-flight for Firefox launch. Removes stale parent.lock when Firefox is not running.
    /// Throws with Traditional Chinese guidance when profile is actively locked.
    /// </summary>
    public static void PrepareFirefoxProfileOrThrow(string profileDir)
    {
        Directory.CreateDirectory(profileDir);
        var lockPath = ParentLockPath(profileDir);
        if (!File.Exists(lockPath)) return;

        if (IsFirefoxProcessRunning())
        {
            throw new InvalidOperationException(
                "Firefox profile 已被鎖定（parent.lock）。請先完全關閉 Firefox：\n" +
                "1) 關閉所有視窗\n" +
                "2) 工作管理員結束全部 firefox.exe\n" +
                "3) 再重試擷取 Token\n\n" +
                "更穩定：按「還原 Firefox 預設」改用專用英文路徑\n" +
                $"  {DefaultFirefoxProfileDir(1).Replace("account-01", "account-NN", StringComparison.Ordinal)}\n" +
                $"目前：{profileDir}");
        }

        try
        {
            File.Delete(lockPath);
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException(
                $"無法刪除殘留 parent.lock（Firefox 似乎已關閉）。請手動刪除：\n{lockPath}\n{ex.Message}");
        }
    }

    /// <summary>
    /// If exact path missing (encoding garble of 設定檔), resolve by profile id prefix under Profiles.
    /// e.g. hVesXz80.* matches the real folder name on disk.
    /// </summary>
    public static string ResolveExistingFirefoxProfile(string requested)
    {
        var full = Path.GetFullPath(requested.Trim().Trim('"'));
        if (Directory.Exists(full)) return full;

        var baseName = Path.GetFileName(full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        var prefix = baseName.Contains('.', StringComparison.Ordinal)
            ? baseName.Split('.')[0]
            : baseName;
        if (string.IsNullOrWhiteSpace(prefix) || prefix.Length < 3)
            return full;

        var root = FirefoxSystemProfilesRoot();
        if (!Directory.Exists(root)) return full;

        try
        {
            var match = Directory.EnumerateDirectories(root)
                .Select(Path.GetFileName)
                .FirstOrDefault(name =>
                    name is not null &&
                    (name.Equals(baseName, StringComparison.OrdinalIgnoreCase) ||
                     name.StartsWith(prefix + ".", StringComparison.OrdinalIgnoreCase) ||
                     name.Equals(prefix, StringComparison.OrdinalIgnoreCase)));
            if (!string.IsNullOrWhiteSpace(match))
                return Path.Combine(root, match);
        }
        catch
        {
            // ignore
        }

        return full;
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

    public static string ResolveFirefoxProfileDir(int accountNumber, string? requested)
    {
        if (string.IsNullOrWhiteSpace(requested))
            return DefaultFirefoxProfileDir(accountNumber);
        return ResolveExistingFirefoxProfile(requested);
    }

    public static string ResolveProfileDir(ChromeProfileConfig config, int accountNumber)
    {
        var cfg = Normalize(config, accountNumber);
        return IsFirefox(cfg)
            ? ResolveFirefoxProfileDir(accountNumber, cfg.UserDataDir)
            : ResolveCdpUserDataDir(accountNumber, cfg.UserDataDir);
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
                    browser = NormalizeBrowser(cfg.Browser, cfg.ExecutablePath),
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
                    ["browser"] = NormalizeBrowser(cfg.Browser, cfg.ExecutablePath),
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

        if (IsFirefox(cfg))
        {
            var profile = ResolveFirefoxProfileDir(accountNumber, cfg.UserDataDir);
            var profileArg = profile.Contains(' ', StringComparison.Ordinal) ? $"\"{profile}\"" : profile;
            return $"{exe} --profile {profileArg}  (Playwright firefox persistent)";
        }

        var userData = ResolveCdpUserDataDir(accountNumber, cfg.UserDataDir);
        var userDataArg = userData.Contains(' ', StringComparison.Ordinal) ? $"\"{userData}\"" : userData;
        return $"{exe} --remote-debugging-port=<port> --remote-allow-origins=* --user-data-dir={userDataArg}";
    }

    public static ChromeProfileConfig Normalize(ChromeProfileConfig config, int accountNumber = 1)
    {
        var browser = NormalizeBrowser(config.Browser, config.ExecutablePath);
        var exe = string.IsNullOrWhiteSpace(config.ExecutablePath)
            ? (browser == BrowserFirefox
                ? FindFirefoxExecutable() ?? DefaultFirefoxExecutablePath
                : DefaultExecutablePath)
            : config.ExecutablePath.Trim().Trim('"');
        browser = NormalizeBrowser(browser, exe);

        string? userData = string.IsNullOrWhiteSpace(config.UserDataDir)
            ? null
            : config.UserDataDir.Trim().Trim('"');

        if (browser == BrowserFirefox)
        {
            userData = ResolveFirefoxProfileDir(accountNumber, userData);
        }
        else
        {
            userData = ResolveCdpUserDataDir(accountNumber, userData);
        }

        return new ChromeProfileConfig
        {
            Browser = browser,
            ExecutablePath = exe,
            ProfileDirectory = string.IsNullOrWhiteSpace(config.ProfileDirectory)
                ? (browser == BrowserFirefox ? "firefox" : DefaultProfileDirectory)
                : config.ProfileDirectory.Trim().Trim('"'),
            UserDataDir = userData
        };
    }

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
                if (property.Value.TryGetProperty("browser", out var browserEl) &&
                    browserEl.ValueKind == JsonValueKind.String &&
                    !string.IsNullOrWhiteSpace(browserEl.GetString()))
                {
                    existing.Browser = browserEl.GetString()!.Trim();
                }
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

                // Infer browser from executable when not set.
                existing.Browser = NormalizeBrowser(existing.Browser, existing.ExecutablePath);
                target[account] = Normalize(existing, account);
            }
        }
        catch
        {
            // Ignore malformed config; UI falls back to defaults.
        }
    }
}
