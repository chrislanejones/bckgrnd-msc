<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Support\Project\ProjectFiles;
use Illuminate\Http\Request;
use Native\Desktop\Dialog;
use Native\Desktop\Facades\Shell;

final class NativeProjectController
{
    public function handle(Request $request, string $action)
    {
        abort_unless(config('nativephp-internal.running'), 404);
        $secret = (string) config('nativephp-internal.secret');
        abort_unless($secret !== '' && hash_equals(hash_hmac('sha256', 'bckgrnd-projects', $secret), (string) $request->header('X-Bckgrnd-Token')), 403);
        if ($request->header('Origin')) abort_unless($request->header('Origin') === $request->getSchemeAndHttpHost(), 403);
        abort_if(strlen($request->getContent()) > 128 * 1024 * 1024, 413);
        $root = storage_path('app/projects');
        $files = new ProjectFiles($root);
        try {
            switch ($action) {
                case 'list': return response()->json($files->records());
                case 'write':
                    $data = $request->validate(['snapshot' => 'required|array', 'expectedRevision' => 'required|integer|min:0']);
                    $files->write($data['snapshot'], $data['expectedRevision']);
                    return response()->json(['ok' => true]);
                case 'recover':
                    $data = $request->validate(['snapshot' => 'required|array']);
                    $files->write($data['snapshot'], null);
                    return response()->json(['ok' => true]);
                case 'remove':
                    $files->remove((string) $request->input('id'));
                    return response()->json(['ok' => true]);
                case 'open':
                    $path = Dialog::new()->asSheet('main')->title('Open Project')->filter('bckgrnd project', ['json'])->open();
                    if (!$path) return response()->json(['cancelled' => true]);
                    abort_unless(is_string($path) && is_file($path) && filesize($path) < 16 * 1024 * 1024, 422);
                    return response()->json(['document' => json_decode(file_get_contents($path), false, flags: JSON_THROW_ON_ERROR)]);
                case 'save-file':
                    $s = $request->input('snapshot'); ProjectFiles::validate($s);
                    $s['project'] = \App\Support\Project\Contract::migrate($s['project']);
                    $path = Dialog::new()->asSheet('main')->title('Save Project As')->filter('bckgrnd project', ['json'])->save();
                    if (!$path) return response()->json(['cancelled' => true]);
                    if (is_file($path) && !copy($path, $path.'.bak')) throw new \RuntimeException('Cannot back up the existing project file.');
                    ProjectFiles::atomicWrite($path, json_encode($s, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
                    return response()->json(['path' => $path]);
                case 'export':
                    $wav = $request->getContent();
                    abort_unless(substr($wav, 0, 4) === 'RIFF' && substr($wav, 8, 4) === 'WAVE', 422);
                    $path = Dialog::new()->asSheet('main')->title('Export WAV')->filter('WAV audio', ['wav'])->save();
                    if (!$path) return response()->json(['cancelled' => true]);
                    ProjectFiles::atomicWrite($path, $wav);
                    ProjectFiles::atomicWrite(storage_path('app/last-export.json'), json_encode(['path' => $path], JSON_THROW_ON_ERROR));
                    return response()->json(['path' => $path]);
                case 'reveal':
                    $path = storage_path('app/last-export.json');
                    if (!is_file($path)) throw new \RuntimeException('Export a WAV first.');
                    Shell::showInFolder(json_decode(file_get_contents($path), true, flags: JSON_THROW_ON_ERROR)['path']);
                    return response()->json(['ok' => true]);
                case 'recovery-folder':
                    if (!is_dir($root)) mkdir($root, 0700, true);
                    Shell::openFile(storage_path('app'));
                    return response()->json(['ok' => true]);
                case 'diagnostics':
                    return response()->json(['php' => PHP_VERSION, 'storage' => storage_path(), 'projectRoot' => $root]);
                default: abort(404);
            }
        } catch (\Throwable $e) { return response()->json(['message' => $e->getMessage()], 422); }
    }
}
