using System.Text.Json;
using MindVideoAutoSign.Models;

namespace MindVideoAutoSign.Services;

public sealed class FileAccountStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
    private readonly string _filePath;

    public FileAccountStore()
    {
        var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MindVideo Auto Sign");
        Directory.CreateDirectory(folder);
        _filePath = Path.Combine(folder, "accounts.json");
    }

    public async Task<List<AccountProfile>> LoadAsync()
    {
        if (!File.Exists(_filePath)) return [];
        await using var stream = File.OpenRead(_filePath);
        return await JsonSerializer.DeserializeAsync<List<AccountProfile>>(stream, JsonOptions) ?? [];
    }

    public async Task SaveAsync(IEnumerable<AccountProfile> accounts)
    {
        await using var stream = File.Create(_filePath);
        await JsonSerializer.SerializeAsync(stream, accounts, JsonOptions);
    }

    public string Location => _filePath;
}
