using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using MindVideoAutoSign.Models;

namespace MindVideoAutoSign.Services;

public sealed class MindVideoApiService
{
    private const string BaseUrl = "https://api-app.mindvideo.ai/api/";
    private static readonly HttpClient Client = new() { Timeout = TimeSpan.FromSeconds(30) };

    public async Task<CheckinResult> CheckInAsync(AccountProfile account, CancellationToken cancellationToken = default)
    {
        try
        {
            var before = await FetchRecordAsync(account.Token, cancellationToken);
            if (before.CanCheckin == false)
                return Result(CheckinStatus.AlreadyDone, "今天已簽到", before, 0);

            await SendAsync(account.Token, "checkin", HttpMethod.Post, cancellationToken);
            Record? after = null;
            for (var attempt = 0; attempt < 4; attempt++)
            {
                await Task.Delay(TimeSpan.FromSeconds(1.2), cancellationToken);
                after = await FetchRecordAsync(account.Token, cancellationToken);
                if (after.CanCheckin == false) break;
            }

            if (after?.CanCheckin != false)
                return Result(CheckinStatus.Failed, "簽到狀態尚未確認，請稍後重新整理", after ?? before);

            int? delta = after.TotalCredits.HasValue && before.TotalCredits.HasValue
                ? after.TotalCredits.Value - before.TotalCredits.Value : null;
            return Result(CheckinStatus.CheckedIn, delta is > 0 ? $"簽到完成，獲得 {delta} 點" : "簽到完成", after, delta);
        }
        catch (ApiException ex) when (ex.StatusCode == HttpStatusCode.Unauthorized)
        {
            return new(CheckinStatus.Failed, "Token 已失效，請更新後再試");
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            return new(CheckinStatus.Failed, $"無法完成簽到：{ex.Message}");
        }
    }

    public async Task<CheckinResult> RefreshAsync(AccountProfile account, CancellationToken cancellationToken = default)
    {
        try
        {
            var record = await FetchRecordAsync(account.Token, cancellationToken);
            return Result(record.CanCheckin == false ? CheckinStatus.AlreadyDone : CheckinStatus.Ready,
                record.CanCheckin == false ? "今天已簽到" : "可進行簽到", record);
        }
        catch (ApiException ex) when (ex.StatusCode == HttpStatusCode.Unauthorized)
        {
            return new(CheckinStatus.Failed, "Token 已失效，請更新後再試");
        }
        catch (Exception ex)
        {
            return new(CheckinStatus.Failed, $"無法取得狀態：{ex.Message}");
        }
    }

    private static CheckinResult Result(CheckinStatus status, string message, Record? record, int? delta = null) =>
        new(status, message, record?.TotalCredits, record?.CurrentDay, delta);

    private static async Task<Record> FetchRecordAsync(string token, CancellationToken ct)
    {
        using var document = await SendAsync(token, "checkin/records", HttpMethod.Get, ct);
        var root = Data(document.RootElement);
        return new Record(
            GetBool(root, "can_checkin_today"),
            GetInt(root, "total_credits"),
            ExtractStreak(root));
    }

    /// <summary>Prefer API <c>current_day</c>; accept a few alternate field names.</summary>
    private static int? ExtractStreak(JsonElement root)
    {
        foreach (var name in new[]
                 {
                     "current_day", "continuous_days", "continuous_day", "checkin_days",
                     "check_in_days", "sign_days", "streak_days", "streak", "days"
                 })
        {
            var value = GetInt(root, name);
            if (value is >= 0) return value;
        }
        return null;
    }

    private static async Task<JsonDocument> SendAsync(string token, string path, HttpMethod method, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, BaseUrl + path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.TryAddWithoutValidation("i-lang", "zh-TW");
        request.Headers.TryAddWithoutValidation("i-version", "1.0.8");
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        using var response = await Client.SendAsync(request, ct);
        var body = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode) throw new ApiException(response.StatusCode, response.ReasonPhrase ?? "API request failed");
        var document = JsonDocument.Parse(string.IsNullOrWhiteSpace(body) ? "{}" : body);
        if (document.RootElement.TryGetProperty("code", out var code) && code.GetInt32() != 0)
        {
            var message = document.RootElement.TryGetProperty("message", out var msg) ? msg.GetString() : "MindVideo API error";
            document.Dispose();
            throw new ApiException(HttpStatusCode.BadRequest, message ?? "MindVideo API error");
        }
        return document;
    }

    private static JsonElement Data(JsonElement root) => root.TryGetProperty("data", out var data) ? data : root;
    private static int? GetInt(JsonElement root, string name) => root.TryGetProperty(name, out var value) && value.TryGetInt32(out var result) ? result : null;
    private static bool? GetBool(JsonElement root, string name) => root.TryGetProperty(name, out var value) ? value.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, JsonValueKind.Number when value.TryGetInt32(out var n) => n != 0, _ => null } : null;

    private sealed record Record(bool? CanCheckin, int? TotalCredits, int? CurrentDay);
    private sealed class ApiException(HttpStatusCode statusCode, string message) : Exception(message) { public HttpStatusCode StatusCode { get; } = statusCode; }
}
