using System.Collections.ObjectModel;
using System.Windows.Input;
using MindVideoAutoSign.Models;
using MindVideoAutoSign.Services;

namespace MindVideoAutoSign.ViewModels;

public sealed class MainViewModel : ObservableObject
{
    private readonly FileAccountStore _store;
    private readonly MindVideoApiService _api;
    private AccountViewModel? _selectedAccount;
    private bool _isBusy;
    private string _activity = "準備就緒。先新增一個 MindVideo 帳號開始。";

    public MainViewModel(FileAccountStore store, MindVideoApiService api)
    {
        _store = store;
        _api = api;
        AddAccountCommand = new AsyncCommand(AddAccountAsync);
        RemoveAccountCommand = new AsyncCommand(RemoveAccountAsync, () => SelectedAccount is not null && !IsBusy);
        SaveCommand = new AsyncCommand(SaveAsync, () => !IsBusy);
        RefreshCommand = new AsyncCommand(RefreshSelectedAsync, () => SelectedAccount is not null && !IsBusy);
        CheckInCommand = new AsyncCommand(CheckInSelectedAsync, () => SelectedAccount is not null && !IsBusy);
        CheckAllCommand = new AsyncCommand(CheckAllAsync, () => Accounts.Any() && !IsBusy);
        _ = LoadAsync();
    }

    public ObservableCollection<AccountViewModel> Accounts { get; } = [];
    public AccountViewModel? SelectedAccount { get => _selectedAccount; set { if (Set(ref _selectedAccount, value)) NotifyCommands(); } }
    public bool IsBusy { get => _isBusy; private set { if (Set(ref _isBusy, value)) NotifyCommands(); } }
    public string Activity { get => _activity; private set => Set(ref _activity, value); }
    public string AccountCount => $"{Accounts.Count} 個帳號";
    public ICommand AddAccountCommand { get; }
    public ICommand RemoveAccountCommand { get; }
    public ICommand SaveCommand { get; }
    public ICommand RefreshCommand { get; }
    public ICommand CheckInCommand { get; }
    public ICommand CheckAllCommand { get; }

    private async Task LoadAsync()
    {
        try
        {
            var profiles = await _store.LoadAsync();
            foreach (var profile in profiles) Accounts.Add(new AccountViewModel(profile));
            SelectedAccount = Accounts.FirstOrDefault();
            Activity = profiles.Count == 0 ? "本機尚未儲存帳號。新增帳號後貼上 Token。" : $"已從本機載入 {profiles.Count} 個帳號。";
            Raise(nameof(AccountCount));
        }
        catch (Exception ex) { Activity = $"無法讀取本機設定：{ex.Message}"; }
    }

    private async Task AddAccountAsync()
    {
        var account = new AccountViewModel(new AccountProfile { Name = $"MindVideo {Accounts.Count + 1}" });
        Accounts.Add(account); SelectedAccount = account; Raise(nameof(AccountCount));
        await SaveAsync();
    }
    private async Task RemoveAccountAsync()
    {
        if (SelectedAccount is null) return;
        Accounts.Remove(SelectedAccount); SelectedAccount = Accounts.FirstOrDefault(); Raise(nameof(AccountCount));
        await SaveAsync();
    }
    private async Task SaveAsync()
    {
        try { await _store.SaveAsync(Accounts.Select(a => a.ToProfile())); Activity = "已儲存至本機設定檔。"; }
        catch (Exception ex) { Activity = $"儲存失敗：{ex.Message}"; }
    }
    private async Task RefreshSelectedAsync()
    {
        if (SelectedAccount is null) return;
        await ExecuteAsync(SelectedAccount, false);
    }
    private async Task CheckInSelectedAsync()
    {
        if (SelectedAccount is null) return;
        await ExecuteAsync(SelectedAccount, true);
    }
    private async Task CheckAllAsync()
    {
        IsBusy = true; Activity = "正在依序處理所有帳號…";
        try { foreach (var account in Accounts.Where(a => !string.IsNullOrWhiteSpace(a.Token))) await ExecuteCoreAsync(account, true); }
        finally { IsBusy = false; Activity = "全部帳號已處理完畢。"; }
    }
    private async Task ExecuteAsync(AccountViewModel account, bool checkin)
    {
        IsBusy = true;
        try { await ExecuteCoreAsync(account, checkin); }
        finally { IsBusy = false; }
    }
    private async Task ExecuteCoreAsync(AccountViewModel account, bool checkin)
    {
        if (string.IsNullOrWhiteSpace(account.Token)) { account.Apply(new(CheckinStatus.Failed, "請先貼上 Token")); return; }
        account.Status = CheckinStatus.Checking; account.Message = checkin ? "正在確認與簽到…" : "正在取得狀態…"; Activity = $"正在處理「{account.Name}」…";
        var result = checkin ? await _api.CheckInAsync(account.ToProfile()) : await _api.RefreshAsync(account.ToProfile());
        account.Apply(result); Activity = $"{account.Name}：{result.Message}";
    }
    private void NotifyCommands()
    {
        foreach (var command in new[] { RemoveAccountCommand, SaveCommand, RefreshCommand, CheckInCommand, CheckAllCommand }.OfType<AsyncCommand>()) command.RaiseCanExecuteChanged();
    }
}

public sealed class AsyncCommand(Func<Task> action, Func<bool>? canExecute = null) : ICommand
{
    public event EventHandler? CanExecuteChanged;
    public bool CanExecute(object? parameter) => canExecute?.Invoke() ?? true;
    public async void Execute(object? parameter) { if (CanExecute(parameter)) await action(); }
    public void RaiseCanExecuteChanged() => CanExecuteChanged?.Invoke(this, EventArgs.Empty);
}
