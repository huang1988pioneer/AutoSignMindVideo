using MindVideoAutoSign.Models;

namespace MindVideoAutoSign.ViewModels;

public sealed class AccountViewModel(AccountProfile profile) : ObservableObject
{
    private string _name = profile.Name;
    private string _token = profile.Token;
    private CheckinStatus _status = CheckinStatus.Ready;
    private string _message = "尚未查詢";
    private int? _totalCredits;
    private int? _streak;

    public string Id => profile.Id;
    public string Name { get => _name; set => Set(ref _name, value); }
    public string Token { get => _token; set { if (Set(ref _token, value)) Raise(nameof(MaskedToken)); } }
    public string MaskedToken => string.IsNullOrWhiteSpace(Token) ? "尚未設定 Token" : $"••••••••{Token[^Math.Min(4, Token.Length)..]}";
    public CheckinStatus Status { get => _status; set { if (Set(ref _status, value)) { Raise(nameof(StatusLabel)); Raise(nameof(StatusBrush)); } } }
    public string Message { get => _message; set => Set(ref _message, value); }
    public int? TotalCredits { get => _totalCredits; set => Set(ref _totalCredits, value); }
    public int? Streak { get => _streak; set => Set(ref _streak, value); }
    public string CreditsLabel => TotalCredits?.ToString("N0") ?? "—";
    public string StreakLabel => Streak is null ? "尚未取得" : $"{Streak} 天";
    public string StatusLabel => Status switch { CheckinStatus.CheckedIn => "簽到成功", CheckinStatus.AlreadyDone => "今日已簽到", CheckinStatus.Checking => "處理中", CheckinStatus.Failed => "失敗", _ => "待查詢" };
    public string StatusBrush => Status switch { CheckinStatus.CheckedIn => "#007C78", CheckinStatus.AlreadyDone => "#527FAF", CheckinStatus.Checking => "#7A5A16", CheckinStatus.Failed => "#B64040", _ => "#516987" };
    public AccountProfile ToProfile() => new() { Id = Id, Name = Name.Trim(), Token = Token.Trim() };
    public void Apply(CheckinResult result) { Status = result.Status; Message = result.Message; TotalCredits = result.TotalCredits; Streak = result.Streak; Raise(nameof(CreditsLabel)); Raise(nameof(StreakLabel)); }
}
