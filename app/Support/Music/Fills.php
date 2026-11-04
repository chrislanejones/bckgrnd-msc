<?php

declare(strict_types=1);

namespace App\Support\Music;

/**
 * One-bar drum fills, prepared here so the engine never invents a pattern.
 *
 * A fill is the track's own phrase-ending groove bar with a small change on its last
 * beat, chosen by style: a clap roll for house and acid, a gap with an open hat for
 * deep, ghost notes for lo-fi. It replaces only the four drum lanes it lists (kick,
 * clap, hat, hatOpen) for one bar; every stem's level, cut and solo still apply in
 * the engine, so a fill can never unmute a stem. See docs/NIGHT3_PROTOCOL.md.
 *
 * Exported with every track as `fills`, so the static build has them too.
 */
final class Fills
{
    /** Steps in one bar. */
    public const BAR = 16;

    /** The lanes a fill may replace. */
    public const LANES = ['kick', 'clap', 'hat', 'hatOpen'];

    /**
     * The fills for a track: one, in Night 3.
     *
     * @return list<array{id: string, name: string, kick: list<float>, clap: list<float>, hat: list<float>, hatOpen: list<float>}>
     */
    public static function forTrack(Track $track): array
    {
        // The last bar of the four-bar groove, the one that already leads into a new
        // phrase, so the fill sounds like this track and not a generic drum break.
        $bar = [];
        foreach (self::LANES as $lane) {
            $bar[$lane] = array_map('floatval', array_slice($track->{$lane}, Phrase::GROOVE_STEPS - self::BAR, self::BAR));
        }

        return [match ($track->kind) {
            'deep' => self::space($bar),
            'lofi' => self::ghost($bar),
            default => self::roll($bar),
        }];
    }

    /**
     * House and acid: the kick sits out the last beat while the clap rolls up in
     * sixteenths into the next bar.
     *
     * @param  array<string, list<float>>  $bar
     * @return array{id: string, name: string, kick: list<float>, clap: list<float>, hat: list<float>, hatOpen: list<float>}
     */
    private static function roll(array $bar): array
    {
        $kick = $bar['kick'];
        $clap = $bar['clap'];
        $hat = $bar['hat'];
        $open = $bar['hatOpen'];
        foreach ([12 => 0.5, 13 => 0.6, 14 => 0.72, 15 => 0.85] as $step => $vel) {
            $kick[$step] = 0.0;
            $clap[$step] = max($clap[$step], $vel);
            $hat[$step] = 0.0;
            $open[$step] = 0.0;
        }

        return ['id' => 'roll', 'name' => 'Clap roll', 'kick' => $kick, 'clap' => $clap, 'hat' => $hat, 'hatOpen' => $open];
    }

    /**
     * Deep: a gap. The kick drops two hits on the last beat and an open hat hangs
     * over it, so the next downbeat lands harder without anything getting busier.
     *
     * @param  array<string, list<float>>  $bar
     * @return array{id: string, name: string, kick: list<float>, clap: list<float>, hat: list<float>, hatOpen: list<float>}
     */
    private static function space(array $bar): array
    {
        $kick = $bar['kick'];
        $hat = $bar['hat'];
        $open = $bar['hatOpen'];
        $kick[12] = 0.0;
        $kick[14] = 0.0;
        $hat[13] = 0.0;
        $hat[14] = 0.0;
        $hat[15] = 0.0;
        $open[14] = max($open[14], 0.55);

        return ['id' => 'space', 'name' => 'Space', 'kick' => $kick, 'clap' => $bar['clap'], 'hat' => $hat, 'hatOpen' => $open];
    }

    /**
     * Lo-fi: two soft ghost claps around the backbeat, nothing louder.
     *
     * @param  array<string, list<float>>  $bar
     * @return array{id: string, name: string, kick: list<float>, clap: list<float>, hat: list<float>, hatOpen: list<float>}
     */
    private static function ghost(array $bar): array
    {
        $clap = $bar['clap'];
        $clap[11] = max($clap[11], 0.3);
        $clap[15] = max($clap[15], 0.35);

        return ['id' => 'ghost', 'name' => 'Ghost notes', 'kick' => $bar['kick'], 'clap' => $clap, 'hat' => $bar['hat'], 'hatOpen' => $bar['hatOpen']];
    }
}
