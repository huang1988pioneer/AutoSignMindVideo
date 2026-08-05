namespace MindVideoAutoSign.Models;

public sealed class AccountProfile
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "未命名帳號";
    public string Token { get; set; } = string.Empty;
}
