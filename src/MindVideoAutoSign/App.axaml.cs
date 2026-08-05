using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using MindVideoAutoSign.Services;
using MindVideoAutoSign.ViewModels;

namespace MindVideoAutoSign;

public partial class App : Application
{
    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            var store = new FileAccountStore();
            desktop.MainWindow = new MainWindow
            {
                DataContext = new MainViewModel(store, new MindVideoApiService())
            };
        }
        base.OnFrameworkInitializationCompleted();
    }
}
