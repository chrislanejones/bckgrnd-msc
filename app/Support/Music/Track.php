<?php

declare(strict_types=1);

namespace App\Support\Music;

/**
 * A four-bar groove, before it is arranged into song form.
 *
 * Each lane is exactly four bars (64 steps). `Arranger` stretches the groove into
 * the intro / groove / break / drop shape the engine plays.
 */
final class Track
{
    /**
     * @param  array<int, float>  $kick
     * @param  array<int, float>  $clap
     * @param  array<int, float>  $hat
     * @param  array<int, float>  $hatOpen
     * @param  array<int, NoteEvent|null>  $bass
     * @param  array<int, NoteEvent|null>  $stab
     * @param  array<int, NoteEvent|null>  $lead
     * @param  array<int, NoteEvent|null>  $pad
     * @param  array<int, NoteEvent|null>  $arp
     * @param  array<string, float>  $mix  fader position per stem
     */
    public function __construct(
        public readonly string $id,
        public readonly string $name,
        public readonly string $detail,
        public readonly string $kind,
        public readonly float $bpm,
        public readonly float $swing,
        public readonly array $mix,
        public readonly array $kick,
        public readonly array $clap,
        public readonly array $hat,
        public readonly array $hatOpen,
        public readonly array $bass,
        public readonly array $stab,
        public readonly array $lead,
        public readonly array $pad,
        public readonly array $arp,
    ) {}

    /**
     * Arrange this groove into the full 16-bar arrangement the engine plays.
     */
    public function arrange(): ArrangedTrack
    {
        return (new Arranger($this))->build();
    }

    /**
     * Whether a stem has any content, so idle lanes can be skipped in the UI.
     */
    public function stemIsActive(string $stem): bool
    {
        $lane = match ($stem) {
            'kick' => $this->kick,
            'clap' => $this->clap,
            'hats' => array_map(
                static fn (float $c, float $o): float => $c + $o,
                $this->hat,
                $this->hatOpen,
            ),
            'bass', 'stab', 'lead', 'pad', 'arp' => $this->{$stem},
            default => throw new \InvalidArgumentException("unknown stem: {$stem}"),
        };

        foreach ($lane as $value) {
            if (is_array($value)) {
                if ($value !== null) {
                    return true;
                }
            } elseif ($value > 0.0) {
                return true;
            }
        }

        return false;
    }

    /**
     * Which steps of a bar are active on a stem, for the UI's step row.
     *
     * @return array<int, bool>
     */
    public function barActivity(string $stem, int $bar): array
    {
        $out = array_fill(0, Phrase::STEPS_PER_BAR, false);
        $start = $bar * Phrase::STEPS_PER_BAR;

        for ($i = 0; $i < Phrase::STEPS_PER_BAR; $i++) {
            $at = $start + $i;
            $out[$i] = match ($stem) {
                'kick' => ($this->kick[$at] ?? 0.0) > 0.0,
                'clap' => ($this->clap[$at] ?? 0.0) > 0.0,
                'hats' => ($this->hat[$at] ?? 0.0) > 0.0 || ($this->hatOpen[$at] ?? 0.0) > 0.0,
                'bass', 'stab', 'lead', 'pad', 'arp' => ($this->{$stem}[$at] ?? null) !== null,
                default => false,
            };
        }

        return $out;
    }
}