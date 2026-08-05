using System.Collections.ObjectModel;
using System.Windows.Input;
using MindVideoAutoSign.Models;
using MindVideoAutoSign.Services;

namespace MindVideoAutoSign.ViewModels;

public sealed class MainViewModel : ObservableObject
{
    private readonly FileAccountStore _store;
    private readonly MindVideoApiService _api;
    private readonly GitHubActionsService _github = new();
    private AccountViewModel? _selectedAccount;
    private bool _isBusy;
    private string _activity = "準備就緒。請先更新 GitHub Actions 執行結果。";
    private string _repository = "huang1988pioneer/AutoSignMindVideo";
    private string _latestRunStatus = "尚未讀取";
    private string _latestRunTime = "—";
    private string _latestRunUrl = "尚未有工作流程連結";
    private string _configuredAccounts = "—";

    public MainViewModel(FileAccountStore store, MindVideoApiService api)
    {
        _store = store; _api = api;
        AddAccountCommand = new AsyncCommand(AddAccountAsync, () => !IsBusy);
        RemoveAccountCommand = new AsyncCommand(RemoveAccountAsync, () => SelectedAccount is not null && !IsBusy);
        SaveCommand = new AsyncCommand(SaveAsync, () => !IsBusy);
        RefreshCommand = new AsyncCommand(RefreshSelectedAsync, () => SelectedAccount is not null && !IsBusy);
        CheckInCommand = new AsyncCommand(CheckInSelectedAsync, () => SelectedAccount is not null && !IsBusy);
        CheckAllCommand = new AsyncCommand(CheckAllAsync, () => Accounts.Any() && !IsBusy);
        TriggerWorkflowCommand = new AsyncCommand(TriggerWorkflowAsync, () => !IsBusy && !string.IsNullOrWhiteSpace(Repository));
        RefreshWorkflowCommand = new AsyncCommand(RefreshWorkflowAsync, () => !IsBusy && !string.IsNullOrWhiteSpace(Repository));
        _ = LoadAsync();
    }

    public ObservableCollection<AccountViewModel> Accounts { get; } = [];
    public ObservableCollection<WorkflowAccountViewModel> WorkflowAccounts { get; } = [];
    public AccountViewModel? SelectedAccount { get => _selectedAccount; set { if (Set(ref _selectedAccount, value)) NotifyCommands(); } }
    public bool IsBusy { get => _isBusy; private set { if (Set(ref _isBusy, value)) NotifyCommands(); } }
    public string Activity { get => _activity; private set => Set(ref _activity, value); }
    public string Repository { get => _repository; set { if (Set(ref _repository, value)) NotifyCommands(); } }
    public string LatestRunStatus { get => _latestRunStatus; private set => Set(ref _latestRunStatus, value); }
    public string LatestRunTime { get => _latestRunTime; private set => Set(ref _latestRunTime, value); }
    public string LatestRunUrl { get => _latestRunUrl; private set => Set(ref _latestRunUrl, value); }
    public string ConfiguredAccounts { get => _configuredAccounts; private set => Set(ref _configuredAccounts, value); }
    public string AccountCount => $"{Accounts.Count} 個";
    public ICommand AddAccountCommand { get; }
    public ICommand RemoveAccountCommand { get; }
    public ICommand SaveCommand { get; }
    public ICommand RefreshCommand { get; }
    public ICommand CheckInCommand { get; }
    public ICommand CheckAllCommand { get; }
    public ICommand TriggerWorkflowCommand { get; }
    public ICommand RefreshWorkflowCommand { get; }

    private async Task LoadAsync()
    {
        try
        {
            var profiles = await _store.LoadAsync();
            foreach (var profile in profiles) Accounts.Add(new AccountViewModel(profile));
            SelectedAccount = Accounts.FirstOrDefault();
            Activity = profiles.Count == 0 ? "尚未建立本機帳號；GitHub Actions 可直接使用 Repository Secrets。" : $"已載入 {profiles.Count} 個本機帳號。";
            Raise(nameof(AccountCount));
        }
        catch (Exception ex) { Activity = $"無法讀取本機設定：{ex.Message}"; }
    }

    private async Task TriggerWorkflowAsync() => await RunWorkflowOperation(async () =>
    {
        await _github.TriggerAsync(Repository.Trim());
        Activity = "已要求 GitHub Actions 執行 MindVideo 簽到；完成後請按「更新執行結果」。";
    });

    private async Task RefreshWorkflowAsync() => await RunWorkflowOperation(async () =>
    {
        var run = await _github.GetLatestAsync(Repository.Trim());
        if (run is null)
        {
            LatestRunStatus = "尚無執行紀錄"; LatestRunTime = "—"; LatestRunUrl = "尚未有工作流程連結";
            WorkflowAccounts.Clear(); ConfiguredAccounts = "—"; Activity = "找不到此工作流程的執行紀錄。"; return;
        }
        LatestRunStatus = string.IsNullOrWhiteSpace(run.Conclusion) ? run.Status : run.Conclusion!;
        LatestRunTime = (run.UpdatedAt ?? run.CreatedAt).ToLocalTime().ToString("MM/dd HH:mm");
        LatestRunUrl = run.Url;
        WorkflowAccounts.Clear();
        if (!string.Equals(run.Status, "completed", StringComparison.OrdinalIgnoreCase))
        {
            ConfiguredAccounts = "工作流程執行中";
            Activity = "工作流程尚未完成；完成後再更新即可取得連續簽到天數。";
            return;
        }
        var statuses = await _github.GetAccountStatusesAsync(Repository.Trim(), run.DatabaseId);
        foreach (var status in statuses) WorkflowAccounts.Add(new WorkflowAccountViewModel(status));
        var configured = statuses.Count(status => status.Status != "尚未設定 GitHub Secret");
        ConfiguredAccounts = $"{configured} 個";
        Activity = $"已讀取最新執行結果：{configured} 個帳號已設定，連續簽到天數來自工作流程報表。";
    });

    private async Task RunWorkflowOperation(Func<Task> operation)
    {
        IsBusy = true;
        try { await operation(); }
        catch (Exception ex) { Activity = $"GitHub Actions 無法完成：{ex.Message}"; }
        finally { IsBusy = false; }
    }

    private async Task AddAccountAsync() { var account = new AccountViewModel(new AccountProfile { Name = $"MindVideo {Accounts.Count + 1}" }); Accounts.Add(account); SelectedAccount = account; Raise(nameof(AccountCount)); await SaveAsync(); }
    private async Task RemoveAccountAsync() { if (SelectedAccount is null) return; Accounts.Remove(SelectedAccount); SelectedAccount = Accounts.FirstOrDefault(); Raise(nameof(AccountCount)); await SaveAsync(); }
    private async Task SaveAsync() { try { await _store.SaveAsync(Accounts.Select(a => a.ToProfile())); Activity = "本機帳號設定已儲存。"; } catch (Exception ex) { Activity = $"儲存失敗：{ex.Message}"; } }
    private async Task RefreshSelectedAsync() { if (SelectedAccount is not null) await ExecuteAsync(SelectedAccount, false); }
    private async Task CheckInSelectedAsync() { if (SelectedAccount is not null) await ExecuteAsync(SelectedAccount, true); }
    private async Task CheckAllAsync()
    {
        IsBusy = true; Activity = "正在逐一直接簽到本機帳號…";
        try { foreach (var account in Accounts.Where(a => !string.IsNullOrWhiteSpace(a.Token))) await ExecuteCoreAsync(account, true); }
        finally { IsBusy = false; Activity = "本機帳號簽到完成。"; }
    }
    private async Task ExecuteAsync(AccountViewModel account, bool checkin) { IsBusy = true; try { await ExecuteCoreAsync(account, checkin); } finally { IsBusy = false; } }
    private async Task ExecuteCoreAsync(AccountViewModel account, bool checkin)
    {
        if (string.IsNullOrWhiteSpace(account.Token)) { account.Apply(new(CheckinStatus.Failed, "請先設定 MindVideo Token")); return; }
        account.Status = CheckinStatus.Checking; account.Message = checkin ? "正在簽到…" : "正在更新狀態…"; Activity = $"正在處理 {account.Name}…";
        var result = checkin ? await _api.CheckInAsync(account.ToProfile()) : await _api.RefreshAsync(account.ToProfile());
        account.Apply(result); Activity = $"{account.Name}：{result.Message}";
    }
    private void NotifyCommands() { foreach (var command in new[] { AddAccountCommand, RemoveAccountCommand, SaveCommand, RefreshCommand, CheckInCommand, CheckAllCommand, TriggerWorkflowCommand, RefreshWorkflowCommand }.OfType<AsyncCommand>()) command.RaiseCanExecuteChanged(); }
}

public sealed class WorkflowAccountViewModel(WorkflowAccountStatus status)
{
    public string Number => $"帳號 {status.Number:00}";
    public string Alias => status.Alias;
    public string Status => status.Status;
    public string Streak => status.Streak is null ? "—" : $"{status.Streak} 天";
    public string StatusBrush => status.IsSuccessful ? "#007C78" : "#7A5A16";
}

public sealed class AsyncCommand(Func<Task> action, Func<bool>? canExecute = null) : ICommand
{
    public event EventHandler? CanExecuteChanged;
    public bool CanExecute(object? parameter) => canExecute?.Invoke() ?? true;
    public async void Execute(object? parameter) { if (CanExecute(parameter)) await action(); }
    public void RaiseCanExecuteChanged() => CanExecuteChanged?.Invoke(this, EventArgs.Empty);
}
