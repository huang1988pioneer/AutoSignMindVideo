using MindVideoAutoSign.Models;

namespace MindVideoAutoSign.ViewModels;

public sealed class AccountViewModel(AccountProfile profile) : ObservableObject
{
    private string _name = profile.Name;
    private string _token = profile.Token;
    private CheckinStatus _status = CheckinStatus.Ready;
    private string _message = "尚未檢查";
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
    public string StreakLabel => Streak is null ? "—" : $"{Streak} 天";
    public string StatusLabel => Status switch { CheckinStatus.CheckedIn => "已簽到", CheckinStatus.AlreadyDone => "已完成", CheckinStatus.Checking => "處理中", CheckinStatus.Failed => "需要處理", _ => "待確認" };
    public string StatusBrush => Status switch { CheckinStatus.CheckedIn => "#7AE2C3", CheckinStatus.AlreadyDone => "#9CB0CF", CheckinStatus.Checking => "#F5C366", CheckinStatus.Failed => "#FF8B91", _ => "#9CB0CF" };

    public AccountProfile ToProfile() => new() { Id = Id, Name = Name.Trim(), Token = Token.Trim() };
    public void Apply(CheckinResult result)
    {
        Status = result.Status;
        Message = result.Message;
        TotalCredits = result.TotalCredits;
        Streak = result.Streak;
        Raise(nameof(CreditsLabel));
        Raise(nameof(StreakLabel));
    }
}
