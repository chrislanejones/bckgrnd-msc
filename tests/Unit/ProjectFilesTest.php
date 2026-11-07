<?php

declare(strict_types=1);

namespace Tests\Unit;

use App\Support\Music\Library;
use App\Support\Project\Contract;
use App\Support\Project\ProjectFiles;
use PHPUnit\Framework\TestCase;

final class ProjectFilesTest extends TestCase
{
    private string $dir;
    protected function setUp(): void { $this->dir = sys_get_temp_dir().'/bckgrnd café '.bin2hex(random_bytes(6)); mkdir($this->dir, 0700); }
    protected function tearDown(): void { chmod($this->dir, 0700); foreach ([...glob($this->dir.'/*'), ...glob($this->dir.'/.file-links*')] as $file) unlink($file); rmdir($this->dir); }
    private function snapshot(int $revision): array
    {
        return ['format' => 'bckgrnd-msc/snapshot', 'version' => 1, 'id' => 'release-test', 'revision' => $revision,
            'savedAt' => '2026-11-06T00:00:00.000Z', 'renderer' => 'project-renderer-1',
            'source' => ['trackId' => 'warehouse', 'sha256' => str_repeat('a', 64)],
            'project' => json_decode(json_encode(Contract::fromTrack(Library::findOrFail('warehouse'))), true)];
    }
    public function test_revisions_recovery_and_reopening_preserve_empty_maps(): void
    {
        $store = new ProjectFiles($this->dir); $first = $this->snapshot(1);
        $store->write($first, 0); $store->write($this->snapshot(2), null);
        $reopened = new ProjectFiles($this->dir);
        $record = $reopened->records()[0];
        $this->assertSame(1, $record->current->revision);
        $this->assertSame(2, $record->recovery->revision);
        $this->assertInstanceOf(\stdClass::class, $record->current->project->patterns);
        $reopened->write($this->snapshot(2), 1);
        $record = $reopened->records()[0];
        $this->assertSame(1, $record->previous->revision); $this->assertSame(2, $record->current->revision);
        $this->assertFalse(isset($record->recovery));
    }
    public function test_stale_save_cannot_replace_committed_revision(): void
    {
        $store = new ProjectFiles($this->dir); $store->write($this->snapshot(2), 0);
        try { $store->write($this->snapshot(3), 1); $this->fail('Stale save accepted'); }
        catch (\RuntimeException $e) { $this->assertStringContainsString('another window', $e->getMessage()); }
        $this->assertSame(2, $store->records()[0]->current->revision);
    }
    public function test_failed_write_keeps_previous_bytes(): void
    {
        $store = new ProjectFiles($this->dir); $store->write($this->snapshot(1), 0);
        $path = $this->dir.'/release-test.json'; $before = file_get_contents($path); chmod($this->dir, 0500);
        try { @$store->write($this->snapshot(2), 1); $this->fail('Read-only folder unexpectedly writable'); }
        catch (\RuntimeException $e) { $this->assertNotEmpty($e->getMessage()); }
        finally { chmod($this->dir, 0700); }
        $this->assertSame($before, file_get_contents($path));
    }
    public function test_save_keeps_the_file_a_project_was_saved_as_current(): void
    {
        $file = $this->dir.'/song.bckgrnd';
        $store = new ProjectFiles($this->dir); $first = $this->snapshot(1);
        $this->assertNull($store->updateLinkedFile($first), 'Never saved as a file, so nothing to update');
        ProjectFiles::saveFile($file, $first); $store->linkFile($first['id'], $file);
        $this->assertSame([], $store->records(), 'The link is not a project');

        $reopened = new ProjectFiles($this->dir);
        $this->assertSame($file, $reopened->updateLinkedFile($this->snapshot(2)));
        $this->assertSame(2, json_decode(file_get_contents($file))->revision);
        $this->assertInstanceOf(\stdClass::class, json_decode(file_get_contents($file))->project->patterns);
        $this->assertSame(1, json_decode(file_get_contents($file.'.bak'))->revision);

        // A moved file is a clear failure, never a silent "saved" or a new copy somewhere odd.
        unlink($file);
        try { $reopened->updateLinkedFile($this->snapshot(3)); $this->fail('Missing file accepted'); }
        catch (\RuntimeException $e) { $this->assertStringContainsString('Save As', $e->getMessage()); }
        $this->assertFileDoesNotExist($file);

        // Deleting the project forgets the link and leaves the person's file alone.
        ProjectFiles::saveFile($file, $first); $reopened->remove($first['id']);
        $this->assertNull($reopened->linkedFile($first['id']));
        $this->assertFileExists($file);
    }
    public function test_unknown_versions_and_invalid_patterns_fail_before_write(): void
    {
        $store = new ProjectFiles($this->dir);
        foreach ([['version' => 99], ['renderer' => 'future'], ['id' => '../escape']] as $change) {
            try { $store->write(array_replace($this->snapshot(1), $change), 0); $this->fail('Bad snapshot accepted'); }
            catch (\RuntimeException) { $this->assertSame([], $store->records()); }
        }
    }
}
