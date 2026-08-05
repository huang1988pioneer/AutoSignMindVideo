namespace MindVideoAutoSign.Models;

public enum CheckinStatus { Ready, Checking, CheckedIn, AlreadyDone, Failed }

public sealed record CheckinResult(
    CheckinStatus Status,
    string Message,
    int? TotalCredits = null,
    int? Streak = null,
    int? CreditDelta = null);
