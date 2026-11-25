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
 *
 * Fill styles (Night 9): `styles()` gives four fills in a fixed order, Classic (the
 * fill above, unchanged), Simple, Busy and Syncopated, each tagged with its `style`.
 * They travel beside the track as `fillStyles`, not inside it: the track is a saved
 * project's source and is hashed (frontend/lib/snapshot.ts), so it stays byte for byte
 * what it was and no saved project reads as made against a changed library. The host
 * hands the four to the engine as the track's fills and picks one by its index.
 */
final class Fills
{
    /** Steps in one bar. */
    public const BAR = 16;

    /** The lanes a fill may replace. */
    public const LANES = ['kick', 'clap', 'hat', 'hatOpen'];

    /** Fill styles, in the order `styles()` returns them: the index the engine is sent. */
    public const STYLES = ['classic', 'simple', 'busy', 'syncopated'];

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
     * The four fill styles for a track, in `STYLES` order. Classic is `forTrack()`'s fill
     * with its style added; the others change only the second half of the same groove
     * bar, in the same four lanes, and nothing in them is louder than that lane's own
     * loudest hit anywhere in the track. Deep and lo-fi are kept softer and shorter.
     *
     * @return list<array{id: string, name: string, style: string, kick: list<float>, clap: list<float>, hat: list<float>, hatOpen: list<float>}>
     */
    public static function styles(Track $track): array
    {
        $classic = self::forTrack($track)[0];
        $bar = [];
        $peak = [];
        foreach (self::LANES as $lane) {
            $bar[$lane] = array_map('floatval', array_slice($track->{$lane}, Phrase::GROOVE_STEPS - self::BAR, self::BAR));
            $peak[$lane] = (float) max(array_map('floatval', $track->{$lane}));
        }
        $kind = match ($track->kind) {
            'deep', 'lofi' => $track->kind,
            default => 'house',
        };

        return [
            ['id' => $classic['id'], 'name' => $classic['name'], 'style' => 'classic', ...array_intersect_key($classic, array_flip(self::LANES))],
            self::tag('simple', 'Simple', self::simple($bar, $peak)),
            self::tag('busy', 'Busy', self::busy($bar, $peak, $kind)),
            self::tag('syncopated', 'Syncopated', self::syncopated($bar, $peak, $kind)),
        ];
    }

    /**
     * Simple: less than Classic. Kick and clap play as written; the closed hats thin
     * out over the last beat and one open hat hangs on step 14.
     *
     * @param  array<string, list<float>>  $bar
     * @param  array<string, float>  $peak
     * @return array<string, list<float>>
     */
    private static function simple(array $bar, array $peak): array
    {
        $hat = $bar['hat'];
        $open = $bar['hatOpen'];
        $hat[12] = round($hat[12] * 0.6, 2);
        foreach ([13, 14, 15] as $step) {
            $hat[$step] = 0.0;
        }
        foreach ([12, 13, 15] as $step) {
            $open[$step] = 0.0;
        }
        $open[14] = max($open[14], self::vel($peak['hatOpen'], 0.8));

        return ['kick' => $bar['kick'], 'clap' => $bar['clap'], 'hat' => $hat, 'hatOpen' => $open];
    }

    /**
     * Busy: more than Classic. A clap roll rises in sixteenths up to the next downbeat
     * (the last two beats in house and acid, a beat and a half in deep, the last beat
     * in lo-fi), the kick keeps only steps 8 and 12, and the hats drop out under it.
     *
     * @param  array<string, list<float>>  $bar
     * @param  array<string, float>  $peak
     * @return array<string, list<float>>
     */
    private static function busy(array $bar, array $peak, string $kind): array
    {
        [$from, $low, $high] = match ($kind) {
            'deep' => [10, 0.45, 0.85],
            'lofi' => [12, 0.4, 0.7],
            default => [8, 0.45, 1.0],
        };
        $kick = $bar['kick'];
        $clap = $bar['clap'];
        $hat = $bar['hat'];
        $open = $bar['hatOpen'];
        for ($step = 8; $step < self::BAR; $step++) {
            $kick[$step] = in_array($step, [8, 12], true) ? ($bar['kick'][$step] > 0 ? $bar['kick'][$step] : $peak['kick']) : 0.0;
        }
        $span = self::BAR - 1 - $from;
        for ($step = $from; $step < self::BAR; $step++) {
            $clap[$step] = self::vel($peak['clap'], $low + ($high - $low) * ($step - $from) / $span);
            $hat[$step] = 0.0;
            $open[$step] = 0.0;
        }

        return ['kick' => $kick, 'clap' => $clap, 'hat' => $hat, 'hatOpen' => $open];
    }

    /**
     * Syncopated: the second half of the bar in 3 + 3 + 2. The kick takes steps 8, 11
     * and 14, the claps answer off the beat on 10, 13 and 15 (the backbeat on 12 sits
     * out), and an open hat lands on the offbeat at 10.
     *
     * @param  array<string, list<float>>  $bar
     * @param  array<string, float>  $peak
     * @return array<string, list<float>>
     */
    private static function syncopated(array $bar, array $peak, string $kind): array
    {
        $claps = match ($kind) {
            'deep' => [10 => 0.5, 13 => 0.7, 15 => 0.85],
            'lofi' => [10 => 0.4, 13 => 0.55, 15 => 0.7],
            default => [10 => 0.6, 13 => 0.8, 15 => 0.95],
        };
        $kick = $bar['kick'];
        $clap = $bar['clap'];
        $hat = $bar['hat'];
        $open = $bar['hatOpen'];
        for ($step = 8; $step < self::BAR; $step++) {
            $kick[$step] = match ($step) {
                8 => $bar['kick'][8] > 0 ? $bar['kick'][8] : $peak['kick'],
                11, 14 => self::vel($peak['kick'], 0.9),
                default => 0.0,
            };
            if ($step > 8) {
                $clap[$step] = isset($claps[$step]) ? self::vel($peak['clap'], $claps[$step]) : 0.0;
            }
            $open[$step] = $step === 10 ? self::vel($peak['hatOpen'], 0.9) : 0.0;
        }
        $hat[10] = 0.0;

        return ['kick' => $kick, 'clap' => $clap, 'hat' => $hat, 'hatOpen' => $open];
    }

    /** A share of a lane's peak, rounded to two places: never above the peak. */
    private static function vel(float $peak, float $share): float
    {
        return min($peak, round($peak * $share, 2));
    }

    /**
     * @param  array<string, list<float>>  $lanes
     * @return array{id: string, name: string, style: string, kick: list<float>, clap: list<float>, hat: list<float>, hatOpen: list<float>}
     */
    private static function tag(string $style, string $name, array $lanes): array
    {
        return ['id' => $style, 'name' => $name, 'style' => $style, 'kick' => $lanes['kick'], 'clap' => $lanes['clap'], 'hat' => $lanes['hat'], 'hatOpen' => $lanes['hatOpen']];
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
