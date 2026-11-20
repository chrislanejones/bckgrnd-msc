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
    public function test_saving_a_file_keeps_its_permissions_and_follows_a_symlink(): void
    {
        $file = $this->dir.'/shared.bckgrnd'; $old = umask(0022);
        try {
            ProjectFiles::saveFile($file, $this->snapshot(1));
            $this->assertSame(0644, fileperms($file) & 0777, 'A new file gets ordinary permissions, not 0600');
            chmod($file, 0664);
            ProjectFiles::saveFile($file, $this->snapshot(2));
            $this->assertSame(0664, fileperms($file) & 0777, 'Saving again keeps the permissions the person set');
            $this->assertSame(2, json_decode(file_get_contents($file))->revision);

            $link = $this->dir.'/link.bckgrnd'; symlink($file, $link);
            ProjectFiles::saveFile($link, $this->snapshot(3));
            $this->assertTrue(is_link($link), 'The symlink is still a symlink');
            $this->assertSame(3, json_decode(file_get_contents($file))->revision, 'The file it points to was updated');
            $this->assertSame(2, json_decode(file_get_contents($file.'.bak'))->revision);
        } finally { umask($old); }
    }
    public function test_an_exported_file_gets_ordinary_permissions_and_the_store_stays_private(): void
    {
        $wav = $this->dir.'/mix.wav'; $old = umask(0022);
        try {
            ProjectFiles::writeChosenFile($wav, 'RIFF one');
            $this->assertSame(0644, fileperms($wav) & 0777, 'A new export gets ordinary permissions, not 0600');
            chmod($wav, 0664);
            ProjectFiles::writeChosenFile($wav, 'RIFF two');
            $this->assertSame(0664, fileperms($wav) & 0777, 'Exporting over a file keeps the permissions the person set');
            $this->assertSame('RIFF two', file_get_contents($wav));

            $link = $this->dir.'/link.wav'; symlink($wav, $link);
            ProjectFiles::writeChosenFile($link, 'RIFF three');
            $this->assertTrue(is_link($link), 'The symlink is still a symlink');
            $this->assertSame('RIFF three', file_get_contents($wav), 'The file it points to was updated');

            (new ProjectFiles($this->dir))->write($this->snapshot(1), 0);
            $this->assertSame(0600, fileperms($this->dir.'/release-test.json') & 0777, 'The app\'s own store stays private');
        } finally { umask($old); }
    }
    public function test_unknown_versions_and_invalid_patterns_fail_before_write(): void
    {
        $store = new ProjectFiles($this->dir);
        foreach ([['version' => 99], ['renderer' => 'future'], ['id' => '../escape']] as $change) {
            try { $store->write(array_replace($this->snapshot(1), $change), 0); $this->fail('Bad snapshot accepted'); }
            catch (\RuntimeException) { $this->assertSame([], $store->records()); }
        }
    }
    /** A snapshot saved before Night 8: the same shape with a version 3 project. */
    private function v3Snapshot(int $revision): array
    {
        $s = $this->snapshot($revision);
        $s['project']['version'] = 3;
        foreach ($s['project']['scenes']['slots'] as $i => $scene) unset($s['project']['scenes']['slots'][$i]['crash']);
        return $s;
    }
    public function test_a_version_3_snapshot_still_validates_and_saves_as_version_4(): void
    {
        $old = $this->v3Snapshot(1);
        ProjectFiles::validate($old);
        $store = new ProjectFiles($this->dir); $store->write($old, 0);
        $current = $store->records()[0]->current->project;
        $this->assertSame(4, $current->version, 'writers always write v4');
        foreach ($current->scenes->slots as $scene) $this->assertFalse($scene->crash);
    }
    public function test_saving_keeps_the_older_v3_revision_byte_for_byte(): void
    {
        // A v3 record written by the previous app, exactly as it wrote it.
        $old = $this->v3Snapshot(1);
        $legacy = json_encode(['current' => $old], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        // `{}` the way the old writer stored it, not PHP's `[]`.
        $legacy = str_replace(['"patterns": []', '"events": []'], ['"patterns": {}', '"events": {}'], $legacy);
        file_put_contents($this->dir.'/release-test.json', $legacy);
        $before = json_decode($legacy);

        // A recovery copy (written while editing, before any Save) leaves it alone.
        $store = new ProjectFiles($this->dir); $store->write($this->snapshot(2), null);
        $record = $store->records()[0];
        $this->assertEquals($before->current, $record->current, 'the saved v3 revision is untouched by a recovery write');
        $this->assertSame(3, $record->current->project->version);
        $this->assertSame(4, $record->recovery->project->version);

        // Save: the new revision is v4 and the v3 one becomes `previous`, still v3.
        $with = $this->snapshot(2); $with['project']['scenes']['slots'][3]['crash'] = true;
        $store->write($with, 1);
        $record = $store->records()[0];
        $this->assertEquals($before->current, $record->previous);
        $this->assertSame(3, $record->previous->project->version);
        $this->assertSame(4, $record->current->project->version);
        $this->assertTrue($record->current->project->scenes->slots[3]->crash, 'the crash round-trips through the store');
        $this->assertInstanceOf(\stdClass::class, $record->previous->project->patterns, 'empty maps stay maps');
    }
    public function test_saving_over_a_v3_file_keeps_it_as_bak_and_writes_v4(): void
    {
        $file = $this->dir.'/older.bckgrnd.json';
        file_put_contents($file, json_encode($this->v3Snapshot(1), JSON_PRETTY_PRINT));
        $original = file_get_contents($file);
        ProjectFiles::saveFile($file, $this->snapshot(2));
        $this->assertSame($original, file_get_contents($file.'.bak'), 'the original v3 file is kept, byte for byte');
        $this->assertSame(4, json_decode(file_get_contents($file))->project->version);
    }
    public function test_a_future_project_version_is_refused_by_name(): void
    {
        $future = $this->snapshot(1); $future['project']['version'] = 5;
        try { ProjectFiles::validate($future); $this->fail('A version 5 project was accepted'); }
        catch (\RuntimeException $e) { $this->assertStringContainsString('Project version 5 is newer than this app understands (4)', $e->getMessage()); }
    }
    public function test_a_v3_snapshot_that_carries_crash_or_was_repaired_is_refused(): void
    {
        $carrying = $this->v3Snapshot(1); $carrying['project']['scenes']['slots'][0]['crash'] = false;
        $clamped = $this->v3Snapshot(1); $clamped['project']['params']['fx.filter'] = 9;
        foreach ([$carrying, $clamped] as $bad) {
            try { ProjectFiles::validate($bad); $this->fail('A non-canonical v3 snapshot was accepted'); }
            catch (\InvalidArgumentException|\RuntimeException $e) { $this->assertNotEmpty($e->getMessage()); }
        }
    }
}
