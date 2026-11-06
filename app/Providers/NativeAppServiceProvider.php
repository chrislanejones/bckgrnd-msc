<?php

declare(strict_types=1);

namespace App\Providers;

use Illuminate\Support\Facades\File;
use Native\Desktop\Contracts\ProvidesPhpIni;
use Native\Desktop\Facades\Menu;
use Native\Desktop\Facades\Window;

class NativeAppServiceProvider implements ProvidesPhpIni
{
    public function boot(): void
    {
        foreach (['app/projects', 'app/exports', 'framework/views', 'framework/cache', 'logs'] as $dir) {
            File::ensureDirectoryExists(storage_path($dir));
        }
        $appData = getenv('NATIVEPHP_APP_DATA_PATH');
        if ($appData) \App\Support\Project\LegacyData::preserve($appData, storage_path('app/legacy-imports'));
        Menu::create(
            Menu::make(
                Menu::label('Open Project', 'CmdOrCtrl+O')->event('bckgrnd.open'),
                Menu::label('Save', 'CmdOrCtrl+S')->event('bckgrnd.save'),
                Menu::label('Save As', 'CmdOrCtrl+Shift+S')->event('bckgrnd.saveAs'),
                Menu::label('Export WAV')->event('bckgrnd.export'),
                Menu::label('Reveal Export')->event('bckgrnd.reveal'),
                Menu::label('Open Recovery Folder')->event('bckgrnd.recovery'),
                Menu::quit('Quit bckgrnd-msc'),
            )->label('Project'),
            Menu::edit(), Menu::window(),
        );
        Window::open('main')->title('bckgrnd-msc')->width(1440)->height(1000)
            ->minWidth(390)->minHeight(640)->preventLeavePage()->suppressNewWindows()
            ->webPreferences(['nodeIntegration' => false, 'contextIsolation' => true, 'webSecurity' => true, 'sandbox' => true]);
    }

    public function phpIni(): array
    {
        return ['memory_limit' => '512M', 'upload_max_filesize' => '128M', 'post_max_size' => '128M'];
    }
}
