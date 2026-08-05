using System.Diagnostics;
using System.Text.Json;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;
using MindVideoAutoSign.Models;
using MindVideoAutoSign.Services;

namespace MindVideoAutoSign;

public partial class MainWindow : Window
{
    private const int AccountCount = 33;
    private readonly string _workspace = FindWorkspace();
    private readonly GitHubActionsService _github = new();
    private readonly MindVideoApiService _api = new();
    private readonly FileAccountStore _localTokens = new();
    private readonly ChromeProfileStore _chromeProfiles;
    private readonly Dictionary<int, TextBox> _aliasInputs = [];
    private readonly Dictionary<int, string> _aliases;
    private readonly Dictionary<int, string> _tokens = [];
    private readonly Dictionary<int, ChromeProfileConfig> _chromeByAccount = [];
    private bool _chromeUiLoading;

    public MainWindow()
    {
        InitializeComponent();
        try
        {
            _chromeProfiles = new ChromeProfileStore(_workspace);
            foreach (var pair in _chromeProfiles.LoadAll())
                _chromeByAccount[pair.Key] = pair.Value;

            _aliases = LoadAliases();
            if (AccountComboBox is not null)
            {
                AccountComboBox.ItemsSource = Enumerable.Range(1, AccountCount)
                    .Select(i =>
                    {
                        var alias = _aliases.GetValueOrDefault(i);
                        return string.IsNullOrWhiteSpace(alias) ? $"帳號 {i:00}" : $"帳號 {i:00} · {alias}";
                    })
                    .ToArray();
                if (AccountComboBox.SelectedIndex < 0)
                    AccountComboBox.SelectedIndex = 0;
            }

            BuildAliasList();
            if (ConfiguredMetric is not null)
                ConfiguredMetric.Text = $"{_aliases.Count(pair => !IsDefaultAlias(pair.Key, pair.Value))} 個別名";
            _ = LoadLocalTokensAsync();
            UpdateAccountDisplay();
        }
        catch (Exception ex)
        {
            // Keep window open with a visible error instead of process exit.
            if (LoginStatus is not null)
                LoginStatus.Text = $"介面初始化失敗：{ex.Message}";
            try
            {
                var folder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "MindVideo Auto Sign",
                    "logs");
                Directory.CreateDirectory(folder);
                File.AppendAllText(
                    Path.Combine(folder, "startup-crash.log"),
                    $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] MainWindow init{Environment.NewLine}{ex}{Environment.NewLine}{Environment.NewLine}");
            }
            catch
            {
                // ignore
            }
            throw;
        }
    }

    private int AccountNumber => Math.Max(1, AccountComboBox.SelectedIndex + 1);
    private string SecretName => $"MINDVIDEO_TOKEN{AccountNumber}";
    /// <summary>Preferred local capture path: mindvideo-token-01-alias.txt (alias suffix when set).</summary>
    private string TokenFile => GetPreferredTokenFilePath(AccountNumber);
    private static string AliasFile => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "MindVideoFlow",
        "account-aliases.json");

    private string LogsDir => Path.Combine(_workspace, "logs");

    /// <summary>
    /// Local token files use an account-alias suffix when available, e.g.
    /// <c>mindvideo-token-01-goldshoot0720.txt</c>. Falls back to
    /// <c>mindvideo-token-01.txt</c> when no alias is set.
    /// </summary>
    private string GetPreferredTokenFilePath(int accountNumber)
    {
        var prefix = $"mindvideo-token-{accountNumber:00}";
        var suffix = SanitizeFileSuffix(_aliases.GetValueOrDefault(accountNumber));
        var fileName = string.IsNullOrWhiteSpace(suffix)
            ? $"{prefix}.txt"
            : $"{prefix}-{suffix}.txt";
        return Path.Combine(LogsDir, fileName);
    }

    /// <summary>Find an existing token file for the account (suffix form preferred, then legacy).</summary>
    private string? FindExistingTokenFile(int accountNumber)
    {
        var preferred = GetPreferredTokenFilePath(accountNumber);
        if (File.Exists(preferred)) return preferred;

        if (!Directory.Exists(LogsDir)) return null;

        var prefix = $"mindvideo-token-{accountNumber:00}";
        // Prefer newest match among mindvideo-token-NN*.txt (covers alias renames + legacy).
        return Directory.EnumerateFiles(LogsDir, $"{prefix}*.txt")
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .FirstOrDefault();
    }

    private void ClearStaleTokenFiles(int accountNumber, string keepPath)
    {
        if (!Directory.Exists(LogsDir)) return;
        var prefix = $"mindvideo-token-{accountNumber:00}";
        foreach (var path in Directory.EnumerateFiles(LogsDir, $"{prefix}*.txt"))
        {
            if (string.Equals(path, keepPath, StringComparison.OrdinalIgnoreCase))
                continue;
            try { File.Delete(path); }
            catch { /* ignore locked/legacy */ }
        }
    }

    private static string? SanitizeFileSuffix(string? alias)
    {
        if (string.IsNullOrWhiteSpace(alias)) return null;
        var trimmed = alias.Trim();
        // Skip placeholder aliases like account-22
        if (System.Text.RegularExpressions.Regex.IsMatch(
                trimmed, @"^account[-_]?\d+$", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            return null;

        var invalid = Path.GetInvalidFileNameChars();
        var chars = trimmed
            .Select(c => invalid.Contains(c) || c is '/' or '\\' or ':' or ' ' ? '_' : c)
            .ToArray();
        var cleaned = new string(chars).Trim('_', '-', '.');
        // Collapse repeated underscores
        while (cleaned.Contains("__", StringComparison.Ordinal))
            cleaned = cleaned.Replace("__", "_", StringComparison.Ordinal);
        return string.IsNullOrWhiteSpace(cleaned) ? null : cleaned;
    }

    private void DashboardNavButton_OnClick(object? sender, RoutedEventArgs e) => ShowView(DashboardView);
    private void AccountsNavButton_OnClick(object? sender, RoutedEventArgs e) => ShowView(AccountsView);
    private void LoginNavButton_OnClick(object? sender, RoutedEventArgs e) => ShowView(LoginView);

    private void ShowView(Control view)
    {
        DashboardView.IsVisible = view == DashboardView;
        AccountsView.IsVisible = view == AccountsView;
        LoginView.IsVisible = view == LoginView;
        view.BringIntoView();
    }

    private void AccountComboBox_OnSelectionChanged(object? sender, SelectionChangedEventArgs e) =>
        UpdateAccountDisplay();

    private void UpdateAccountDisplay()
    {
        if (AccountComboBox is null || AccountComboBox.SelectedIndex < 0) return;
        if (SecretNameText is null || TokenBox is null) return;

        var label = _aliases.GetValueOrDefault(AccountNumber);
        var chrome = GetChromeConfig(AccountNumber);
        var dataDir = ChromeProfileStore.ResolveCdpUserDataDir(AccountNumber, chrome.UserDataDir);
        var chromeHint = $"CDP {Path.GetFileName(dataDir)}";
        SecretNameText.Text = string.IsNullOrWhiteSpace(label)
            ? $"{SecretName}  ·  {chromeHint}"
            : $"{SecretName}  ·  {label}  ·  {chromeHint}";
        TokenBox.Text = _tokens.GetValueOrDefault(AccountNumber) ?? string.Empty;
        if (CopyTokenButton is not null)
            CopyTokenButton.IsEnabled = !string.IsNullOrWhiteSpace(TokenBox.Text);
        if (PointsStatus is not null)
        {
            PointsStatus.Text = string.IsNullOrWhiteSpace(TokenBox.Text)
                ? "需要先設定此帳號的 Token。"
                : "已載入本機 Token，可讀取狀態或直接簽到。";
        }
        LoadChromeFields(chrome);
    }

    private ChromeProfileConfig GetChromeConfig(int accountNumber)
    {
        if (_chromeByAccount.TryGetValue(accountNumber, out var config))
            return config;
        return ChromeProfileStore.CreateDefault(accountNumber);
    }

    private void LoadChromeFields(ChromeProfileConfig config)
    {
        if (ChromeExeBox is null) return;
        _chromeUiLoading = true;
        try
        {
            ChromeExeBox.Text = config.ExecutablePath;
            ChromeProfileDirBox.Text = config.ProfileDirectory;
            ChromeUserDataBox.Text = ChromeProfileStore.ResolveCdpUserDataDir(AccountNumber, config.UserDataDir);
            ChromeCommandPreview.Text = ChromeProfileStore.FormatCommandPreview(config, AccountNumber);
        }
        finally
        {
            _chromeUiLoading = false;
        }
    }

    private ChromeProfileConfig ReadChromeFieldsFromUi()
    {
        var userData = string.IsNullOrWhiteSpace(ChromeUserDataBox.Text)
            ? null
            : ChromeUserDataBox.Text.Trim().Trim('"');
        if (ChromeProfileStore.IsForbiddenSystemChromeUserDataDir(userData))
            userData = ChromeProfileStore.DefaultCdpUserDataDir(AccountNumber);

        return new ChromeProfileConfig
        {
            ExecutablePath = string.IsNullOrWhiteSpace(ChromeExeBox.Text)
                ? ChromeProfileStore.DefaultExecutablePath
                : ChromeExeBox.Text.Trim().Trim('"'),
            ProfileDirectory = string.IsNullOrWhiteSpace(ChromeProfileDirBox.Text)
                ? ChromeProfileStore.DefaultProfileDirectory
                : ChromeProfileDirBox.Text.Trim().Trim('"'),
            UserDataDir = ChromeProfileStore.ResolveCdpUserDataDir(AccountNumber, userData)
        };
    }

    private void ChromeSettings_OnLostFocus(object? sender, RoutedEventArgs e)
    {
        if (_chromeUiLoading) return;
        var config = ReadChromeFieldsFromUi();
        _chromeByAccount[AccountNumber] = config;
        if (ChromeUserDataBox is not null)
            ChromeUserDataBox.Text = config.UserDataDir ?? ChromeProfileStore.DefaultCdpUserDataDir(AccountNumber);
        ChromeCommandPreview.Text = ChromeProfileStore.FormatCommandPreview(config, AccountNumber);
        SecretNameText.Text = BuildSecretNameText(config);
    }

    private string BuildSecretNameText(ChromeProfileConfig chrome)
    {
        var label = _aliases.GetValueOrDefault(AccountNumber);
        var dataDir = ChromeProfileStore.ResolveCdpUserDataDir(AccountNumber, chrome.UserDataDir);
        var chromeHint = $"CDP {Path.GetFileName(dataDir)}";
        return string.IsNullOrWhiteSpace(label)
            ? $"{SecretName}  ·  {chromeHint}"
            : $"{SecretName}  ·  {label}  ·  {chromeHint}";
    }

    private async void SaveChromeProfileButton_OnClick(object? sender, RoutedEventArgs e)
    {
        try
        {
            var config = ReadChromeFieldsFromUi();
            if (!File.Exists(config.ExecutablePath))
            {
                LoginStatus.Text = $"找不到 chrome.exe：{config.ExecutablePath}";
                return;
            }

            _chromeByAccount[AccountNumber] = config;
            await _chromeProfiles.SaveAccountAsync(AccountNumber, config);
            await _chromeProfiles.SyncWorkspaceFileAsync(_chromeByAccount, _aliases);
            ChromeUserDataBox.Text = config.UserDataDir;
            ChromeCommandPreview.Text = ChromeProfileStore.FormatCommandPreview(config, AccountNumber);
            SecretNameText.Text = BuildSecretNameText(config);
            LoginStatus.Text =
                $"已儲存帳號 {AccountNumber:00} 的 CDP 設定：{ChromeProfileStore.FormatCommandPreview(config, AccountNumber)}";
        }
        catch (Exception ex)
        {
            LoginStatus.Text = $"儲存 Chrome 設定失敗：{ex.Message}";
        }
    }

    private async void ResetChromeProfileButton_OnClick(object? sender, RoutedEventArgs e)
    {
        try
        {
            var config = ChromeProfileStore.CreateDefault(AccountNumber);
            _chromeByAccount[AccountNumber] = config;
            await _chromeProfiles.SaveAccountAsync(AccountNumber, config);
            await _chromeProfiles.SyncWorkspaceFileAsync(_chromeByAccount, _aliases);
            LoadChromeFields(config);
            SecretNameText.Text = BuildSecretNameText(config);
            LoginStatus.Text =
                $"已還原帳號 {AccountNumber:00} 預設：{ChromeProfileStore.FormatCommandPreview(config, AccountNumber)}";
        }
        catch (Exception ex)
        {
            LoginStatus.Text = $"還原 Chrome 預設失敗：{ex.Message}";
        }
    }

    private async Task LoadLocalTokensAsync()
    {
        try
        {
            var profiles = await _localTokens.LoadAsync();
            foreach (var profile in profiles)
            {
                if (TryParseAccountNumber(profile.Name, out var number) ||
                    TryParseAccountNumber(profile.Id, out number))
                {
                    if (!string.IsNullOrWhiteSpace(profile.Token))
                        _tokens[number] = profile.Token.Trim();
                    if (!string.IsNullOrWhiteSpace(profile.Name) && !profile.Name.StartsWith("MindVideo", StringComparison.Ordinal))
                        _aliases[number] = profile.Name.Trim();
                }
            }

            // Also load any previously captured token files (alias-suffix or legacy).
            for (var i = 1; i <= AccountCount; i++)
            {
                if (_tokens.ContainsKey(i)) continue;
                var file = FindExistingTokenFile(i);
                if (file is null) continue;
                var token = (await File.ReadAllTextAsync(file)).Trim();
                if (!string.IsNullOrWhiteSpace(token))
                    _tokens[i] = token;
            }

            UpdateAccountDisplay();
            RefreshAccountComboLabels();
        }
        catch (Exception ex)
        {
            LoginStatus.Text = $"讀取本機 Token 失敗：{ex.Message}";
        }
    }

    private async void StartLoginButton_OnClick(object? sender, RoutedEventArgs e)
    {
        StartLoginButton.IsEnabled = false;
        CopyTokenButton.IsEnabled = false;
        try
        {
            LoginStatus.Text = "正在確認 Node.js 相依套件與 Chromium…";
            await RunProcessAsync("npm", ["install"]);
            await RunProcessAsync("npx", ["playwright", "install", "chromium"]);

            var tokenFile = GetPreferredTokenFilePath(AccountNumber);
            Directory.CreateDirectory(Path.GetDirectoryName(tokenFile)!);
            ClearStaleTokenFiles(AccountNumber, tokenFile);
            if (File.Exists(tokenFile)) File.Delete(tokenFile);

            var chrome = ReadChromeFieldsFromUi();
            var cdpUserData = ChromeProfileStore.ResolveCdpUserDataDir(AccountNumber, chrome.UserDataDir);
            chrome.UserDataDir = cdpUserData;
            _chromeByAccount[AccountNumber] = chrome;
            await _chromeProfiles.SaveAccountAsync(AccountNumber, chrome);
            await _chromeProfiles.SyncWorkspaceFileAsync(_chromeByAccount, _aliases);
            Directory.CreateDirectory(cdpUserData);

            if (!File.Exists(chrome.ExecutablePath))
                throw new FileNotFoundException($"找不到 chrome.exe：{chrome.ExecutablePath}");

            LoginStatus.Text =
                $"將以獨立 CDP 設定檔啟動（非系統 Profile）：{ChromeProfileStore.FormatCommandPreview(chrome, AccountNumber)}。首次請 Google 登入；維持 ≥5 秒後擷取 Token → {Path.GetFileName(tokenFile)}。";

            // Never pass system --profile-directory for CDP. Chrome rejects default User Data.
            var captureArgs = new List<string>
            {
                "scripts/capture-token-gui.mjs",
                "--account", AccountNumber.ToString(),
                "--output", tokenFile,
                "--executable-path", chrome.ExecutablePath,
                "--user-data-dir", cdpUserData
            };

            await RunProcessAsync("node", captureArgs);

            if (!File.Exists(tokenFile))
                throw new InvalidOperationException(
                    "未找到已驗證的 Token 檔。請確認已在瀏覽器中完整登入 MindVideo（非僅停留在登入頁）。");

            var token = (await File.ReadAllTextAsync(tokenFile)).Trim();
            if (string.IsNullOrWhiteSpace(token))
                throw new InvalidOperationException("Token 檔是空的。");

            TokenBox.Text = token;
            _tokens[AccountNumber] = token;
            await PersistLocalTokensAsync();
            CopyTokenButton.IsEnabled = true;
            LoginStatus.Text =
                $"完成。已確認登入維持 ≥5 秒並擷取有效 Token（{MaskToken(token)}）→ {Path.GetFileName(tokenFile)}，可更新到 GitHub Secret {SecretName}。";
            PointsStatus.Text = "Token 已驗證就緒，可讀取狀態或直接簽到。";
        }
        catch (Exception ex)
        {
            LoginStatus.Text = $"登入狀態更新失敗：{ex.Message}";
        }
        finally
        {
            StartLoginButton.IsEnabled = true;
        }
    }

    private async void CopyTokenButton_OnClick(object? sender, RoutedEventArgs e)
    {
        var token = TokenBox.Text?.Trim();
        if (string.IsNullOrWhiteSpace(token))
        {
            LoginStatus.Text = "目前帳號尚未有可複製的 Token。";
            return;
        }

        if (Clipboard is { } clipboard)
            await clipboard.SetTextAsync(token);
        LoginStatus.Text = $"已複製 Token（{token.Length:N0} 字元）。請勿貼到公開聊天、Issue 或螢幕截圖。";
    }

    private async void CopySecretButton_OnClick(object? sender, RoutedEventArgs e)
    {
        if (Clipboard is { } clipboard)
            await clipboard.SetTextAsync(SecretName);
        LoginStatus.Text = $"已複製 {SecretName}。";
    }

    private async void SaveLocalButton_OnClick(object? sender, RoutedEventArgs e)
    {
        var token = TokenBox.Text?.Trim() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(token))
        {
            _tokens.Remove(AccountNumber);
        }
        else
        {
            _tokens[AccountNumber] = token;
        }

        try
        {
            await PersistLocalTokensAsync();
            CopyTokenButton.IsEnabled = !string.IsNullOrWhiteSpace(token);
            LoginStatus.Text = string.IsNullOrWhiteSpace(token)
                ? "已清除本機 Token。"
                : $"已儲存本機 Token（{MaskToken(token)}）。路徑：{_localTokens.Location}";
        }
        catch (Exception ex)
        {
            LoginStatus.Text = $"儲存本機 Token 失敗：{ex.Message}";
        }
    }

    private async void PushSecretButton_OnClick(object? sender, RoutedEventArgs e)
    {
        var token = TokenBox.Text?.Trim();
        if (string.IsNullOrWhiteSpace(token))
        {
            LoginStatus.Text = "請先貼上或擷取 Token，再更新 GitHub Secret。";
            return;
        }

        PushSecretButton.IsEnabled = false;
        try
        {
            LoginStatus.Text = $"正在更新 GitHub Secret {SecretName}…";
            var repository = await ResolveRepositoryAsync();
            await _github.SetSecretAsync(repository, SecretName, token);
            _tokens[AccountNumber] = token;
            await PersistLocalTokensAsync();
            LoginStatus.Text = $"已更新 {repository} 的 {SecretName}。";
        }
        catch (Exception ex)
        {
            LoginStatus.Text = $"更新 GitHub Secret 失敗：{ex.Message}";
        }
        finally
        {
            PushSecretButton.IsEnabled = true;
        }
    }

    private async void ReadStatusButton_OnClick(object? sender, RoutedEventArgs e)
    {
        await WithTokenActionAsync(ReadStatusButton, async token =>
        {
            PointsStatus.Text = "正在讀取 MindVideo 簽到狀態…";
            var result = await _api.RefreshAsync(new AccountProfile
            {
                Name = DisplayAlias(AccountNumber),
                Token = token
            });
            PointsStatus.Text =
                $"{result.Message} · 總點數 {Display(result.TotalCredits)} · 連續簽到 {Display(result.Streak)} 天";
        });
    }

    private async void LocalCheckInButton_OnClick(object? sender, RoutedEventArgs e)
    {
        await WithTokenActionAsync(LocalCheckInButton, async token =>
        {
            PointsStatus.Text = "正在直接簽到…";
            var result = await _api.CheckInAsync(new AccountProfile
            {
                Name = DisplayAlias(AccountNumber),
                Token = token
            });
            PointsStatus.Text =
                $"{result.Message} · 總點數 {Display(result.TotalCredits)} · 連續簽到 {Display(result.Streak)} 天";
        });
    }

    private async Task WithTokenActionAsync(Button button, Func<string, Task> action)
    {
        var token = TokenBox.Text?.Trim();
        if (string.IsNullOrWhiteSpace(token))
        {
            PointsStatus.Text = "需要先設定此帳號的 Token。";
            return;
        }

        button.IsEnabled = false;
        try
        {
            await action(token);
        }
        catch (Exception ex)
        {
            PointsStatus.Text = $"操作失敗：{ex.Message}";
        }
        finally
        {
            button.IsEnabled = true;
        }
    }

    private async void TriggerButton_OnClick(object? sender, RoutedEventArgs e)
    {
        await WithDashboardBusy(async () =>
        {
            DashboardStatus.Text = "正在觸發 MindVideo Daily Check-in…";
            var repository = await ResolveRepositoryAsync();
            await _github.TriggerAsync(repository);
            DashboardStatus.Text = "已送出簽到工作；稍後按「更新執行結果」查看狀態。";
        });
    }

    private async void RefreshButton_OnClick(object? sender, RoutedEventArgs e)
    {
        await WithDashboardBusy(async () =>
        {
            DashboardStatus.Text = "正在讀取 GitHub Actions…";
            var repository = await ResolveRepositoryAsync();
            var run = await _github.GetLatestAsync(repository);
            if (run is null)
            {
                RunMetric.Text = "尚無執行紀錄";
                StreakMetric.Text = "—";
                RunTimeMetric.Text = "—";
                ConfiguredMetric.Text = "—";
                AccountsPanel.Children.Clear();
                DashboardStatus.Text = "尚未找到 MindVideo Daily Check-in 執行紀錄。";
                return;
            }

            RunMetric.Text = string.IsNullOrWhiteSpace(run.Conclusion) ? run.Status : run.Conclusion!;
            RunTimeMetric.Text = TimeZoneInfo.ConvertTime(run.UpdatedAt ?? run.CreatedAt, GetTaipeiZone())
                .ToString("MM/dd HH:mm");

            if (!string.Equals(run.Status, "completed", StringComparison.OrdinalIgnoreCase))
            {
                ConfiguredMetric.Text = "執行中";
                StreakMetric.Text = "完成後再更新";
                AccountsPanel.Children.Clear();
                DashboardStatus.Text = $"工作流程尚未完成：{run.Url}";
                return;
            }

            var accounts = await _github.GetAccountStatusesAsync(repository, run.DatabaseId);
            var configured = accounts.Count(account => account.IsConfigured);
            var withStreak = accounts.Count(account => account.Streak is > 0);
            ConfiguredMetric.Text = $"{configured} 個";
            StreakMetric.Text = $"{withStreak} 個有連續天數 · {AccountCount - configured} 未設定";
            RenderAccounts(accounts);
            DashboardStatus.Text = $"最近執行：{run.Url}";
        });
    }

    private async Task WithDashboardBusy(Func<Task> action)
    {
        TriggerButton.IsEnabled = RefreshButton.IsEnabled = false;
        try
        {
            await action();
        }
        catch (Exception ex)
        {
            DashboardStatus.Text = $"GitHub Actions 操作失敗：{ex.Message}";
        }
        finally
        {
            TriggerButton.IsEnabled = RefreshButton.IsEnabled = true;
        }
    }

    private void RenderAccounts(IEnumerable<WorkflowAccountStatus> accounts)
    {
        AccountsPanel.Children.Clear();
        foreach (var account in accounts)
        {
            var localAlias = _aliases.GetValueOrDefault(account.Number);
            var alias = !string.IsNullOrWhiteSpace(localAlias) ? localAlias : account.Alias;

            var row = new Grid { ColumnDefinitions = new ColumnDefinitions("68,*,150,80") };
            row.Children.Add(new TextBlock
            {
                Text = $"#{account.Number:00}",
                FontWeight = FontWeight.SemiBold
            });

            var aliasBlock = new TextBlock
            {
                Text = alias,
                TextTrimming = TextTrimming.CharacterEllipsis
            };
            Grid.SetColumn(aliasBlock, 1);
            row.Children.Add(aliasBlock);

            var state = new TextBlock
            {
                Text = account.IsConfigured ? account.Status : "未設定",
                Foreground = account.IsConfigured
                    ? (account.IsSuccessful ? Brushes.SeaGreen : Brushes.IndianRed)
                    : Brushes.Gray,
                TextTrimming = TextTrimming.CharacterEllipsis
            };
            Grid.SetColumn(state, 2);
            row.Children.Add(state);

            var streak = new TextBlock
            {
                Text = account.Streak is null ? "—" : $"{account.Streak} 天",
                Foreground = account.Streak is > 0 ? Brushes.SeaGreen : Brushes.Gray,
                HorizontalAlignment = HorizontalAlignment.Right
            };
            Grid.SetColumn(streak, 3);
            row.Children.Add(streak);

            AccountsPanel.Children.Add(row);
        }
    }

    private void BuildAliasList()
    {
        for (var i = 1; i <= AccountCount; i++)
        {
            var box = new TextBox
            {
                Width = 350,
                Text = _aliases.GetValueOrDefault(i),
                Watermark = "帳號名稱（僅本機顯示）"
            };
            _aliasInputs[i] = box;

            var row = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Spacing = 12
            };
            row.Children.Add(new TextBlock
            {
                Text = $"帳號 {i:00}",
                Width = 72,
                VerticalAlignment = VerticalAlignment.Center
            });
            row.Children.Add(box);
            AliasPanel.Children.Add(row);
        }
    }

    private async void SaveAliasesButton_OnClick(object? sender, RoutedEventArgs e)
    {
        foreach (var (number, input) in _aliasInputs)
        {
            if (string.IsNullOrWhiteSpace(input.Text))
                _aliases.Remove(number);
            else
                _aliases[number] = input.Text.Trim();
        }

        Directory.CreateDirectory(Path.GetDirectoryName(AliasFile)!);
        await File.WriteAllTextAsync(AliasFile, JsonSerializer.Serialize(_aliases, new JsonSerializerOptions { WriteIndented = true }));
        RefreshAccountComboLabels();
        UpdateAccountDisplay();
        LoginStatus.Text = "已儲存帳號別名。";
        ConfiguredMetric.Text = $"{_aliases.Count(pair => !IsDefaultAlias(pair.Key, pair.Value))} 個別名";
    }

    private void RefreshAccountComboLabels()
    {
        var selected = AccountComboBox.SelectedIndex;
        AccountComboBox.ItemsSource = Enumerable.Range(1, AccountCount)
            .Select(i =>
            {
                var alias = _aliases.GetValueOrDefault(i);
                return string.IsNullOrWhiteSpace(alias) ? $"帳號 {i:00}" : $"帳號 {i:00} · {alias}";
            })
            .ToArray();
        AccountComboBox.SelectedIndex = Math.Clamp(selected, 0, AccountCount - 1);
    }

    private async Task PersistLocalTokensAsync()
    {
        var profiles = Enumerable.Range(1, AccountCount)
            .Where(number => _tokens.ContainsKey(number) && !string.IsNullOrWhiteSpace(_tokens[number]))
            .Select(number => new AccountProfile
            {
                Id = number.ToString(),
                Name = DisplayAlias(number),
                Token = _tokens[number]
            })
            .ToList();
        await _localTokens.SaveAsync(profiles);
    }

    private async Task<string> ResolveRepositoryAsync()
    {
        try
        {
            return await _github.GetRepositoryAsync();
        }
        catch
        {
            return "huang1988pioneer/AutoSignMindVideo";
        }
    }

    private string DisplayAlias(int number)
    {
        var alias = _aliases.GetValueOrDefault(number);
        return string.IsNullOrWhiteSpace(alias) ? $"account-{number}" : alias;
    }

    private async Task RunProcessAsync(string command, IEnumerable<string> args)
    {
        _ = await RunProcessCaptureAsync(command, args);
    }

    private async Task<string> RunProcessCaptureAsync(string command, IEnumerable<string> args)
    {
        var executable = NodeCommandPath(command);
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = executable,
                WorkingDirectory = _workspace,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = false
            }
        };
        foreach (var arg in args)
            process.StartInfo.ArgumentList.Add(arg);

        if (!process.Start())
            throw new InvalidOperationException($"無法啟動 {command}。");

        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var output = await outputTask;
        var error = await errorTask;
        if (process.ExitCode != 0)
        {
            // Prefer stderr, but keep stdout (CDP diagnostics are often on stdout).
            var combined = string.Join(
                "\n",
                new[] { error?.Trim(), output?.Trim() }.Where(part => !string.IsNullOrWhiteSpace(part)));
            throw new InvalidOperationException(combined.Truncate(4000));
        }
        return output;
    }

    private Dictionary<int, string> LoadAliases()
    {
        var aliases = LoadRepoAccountsJson();
        try
        {
            if (!File.Exists(AliasFile)) return aliases;
            var saved = JsonSerializer.Deserialize<Dictionary<int, string>>(File.ReadAllText(AliasFile)) ?? [];
            foreach (var (number, name) in saved)
                aliases[number] = name;
            return aliases;
        }
        catch (JsonException)
        {
            return aliases;
        }
    }

    private Dictionary<int, string> LoadRepoAccountsJson()
    {
        var aliases = new Dictionary<int, string>();
        var path = Path.Combine(_workspace, "accounts.json");
        if (!File.Exists(path)) return DefaultAliases();

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            foreach (var property in document.RootElement.EnumerateObject())
            {
                if (!int.TryParse(property.Name, out var number)) continue;
                var value = property.Value.GetString();
                if (!string.IsNullOrWhiteSpace(value))
                    aliases[number] = value.Trim();
            }
            return aliases.Count > 0 ? aliases : DefaultAliases();
        }
        catch
        {
            return DefaultAliases();
        }
    }

    private static Dictionary<int, string> DefaultAliases() => new()
    {
        [1] = "goldshoot0720",
        [2] = "abuhg17",
        [3] = "fengtuprinfo",
        [4] = "feng33feng35feng3",
        [5] = "chbondg2",
        [6] = "huang1988pioneer",
        [7] = "chbondg_outloook",
        [8] = "gaokaolevel3iptopscorer_outlook",
        [9] = "huang1988pioneer_outloook",
        [10] = "fengtuta_tuta",
        [11] = "fengfence_fence",
        [12] = "samafengtu",
        [13] = "fengtusama",
        [14] = "fengwithting0831",
        [15] = "fengwithfeng1127",
        [16] = "fengwithtu1127",
        [17] = "akaonda333",
        [18] = "fbussinesseng",
        [19] = "engdictatorf",
        [20] = "flottojackpoteng",
        [21] = "tushenbyfengbro"
    };

    private static bool IsDefaultAlias(int number, string alias) =>
        alias.Equals($"account-{number}", StringComparison.OrdinalIgnoreCase);

    private static bool TryParseAccountNumber(string? value, out int number)
    {
        number = 0;
        if (string.IsNullOrWhiteSpace(value)) return false;
        if (int.TryParse(value, out number) && number is >= 1 and <= AccountCount) return true;
        var match = System.Text.RegularExpressions.Regex.Match(value, @"(?:account[-_]?|MindVideo\s*)(?<n>\d+)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (match.Success && int.TryParse(match.Groups["n"].Value, out number) && number is >= 1 and <= AccountCount)
            return true;
        return false;
    }

    private static string FindWorkspace()
    {
        string? workspace = null;
        foreach (var start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
            {
                if (File.Exists(Path.Combine(dir.FullName, "package.json")) &&
                    (File.Exists(Path.Combine(dir.FullName, "checkin.js")) ||
                     File.Exists(Path.Combine(dir.FullName, "scripts", "capture-mindvideo-tokens.js"))))
                {
                    workspace = dir.FullName;
                }
            }
        }
        return workspace ?? Environment.CurrentDirectory;
    }

    private static TimeZoneInfo GetTaipeiZone()
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById("Taipei Standard Time"); }
        catch { return TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei"); }
    }

    private static string NodeCommandPath(string command)
    {
        if (!OperatingSystem.IsWindows()) return command;
        if (command == "node")
        {
            var nodeExecutable = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                "nodejs",
                "node.exe");
            return File.Exists(nodeExecutable) ? nodeExecutable : "node";
        }

        var systemCommand = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "nodejs",
            $"{command}.cmd");
        return File.Exists(systemCommand) ? systemCommand : $"{command}.cmd";
    }

    private static string MaskToken(string token) =>
        token.Length <= 16 ? "***" : $"{token[..6]}...{token[^6..]}";

    private static string Display(int? value) => value?.ToString() ?? "—";
}

internal static class StringExtensions
{
    public static string Truncate(this string value, int max) =>
        value.Length <= max ? value : value[..max] + "…";
}
