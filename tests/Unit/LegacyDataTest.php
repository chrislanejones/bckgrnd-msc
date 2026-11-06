<?php

declare(strict_types=1);

namespace Tests\Unit;

use App\Support\Project\LegacyData;
use PHPUnit\Framework\TestCase;

final class LegacyDataTest extends TestCase
{
    public function test_old_identity_files_survive_migration_and_existing_copies_are_not_replaced(): void
    {
        $root = sys_get_temp_dir().'/bckgrnd legacy café '.bin2hex(random_bytes(5));
        $source = $root.'/dev.floor.stemmachine/storage/app/projects';
        $destination = $root.'/new-app/legacy-imports';
        mkdir($source, 0700, true);
        $original = '{"version":1,"name":"Original café"}';
        file_put_contents($source.'/project.json', $original);
        try {
            LegacyData::preserve($root, $destination);
            $copy = $destination.'/dev.floor.stemmachine/storage-app-projects/project.json';
            $this->assertSame($original, file_get_contents($copy));
            file_put_contents($source.'/project.json', '{"name":"Later old-app edit"}');
            LegacyData::preserve($root, $destination);
            $this->assertSame($original, file_get_contents($copy));
            $this->assertSame('{"name":"Later old-app edit"}', file_get_contents($source.'/project.json'));
        } finally {
            $files = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
            foreach ($files as $file) { $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname()); }
            rmdir($root);
        }
    }
}
