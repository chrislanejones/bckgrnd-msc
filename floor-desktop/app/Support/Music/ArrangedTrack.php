<?php

declare(strict_types=1);

namespace App\Support\Music;

/**
 * The resolved 16-bar arrangement the engine plays.
 *
 * Serialises to exactly the JSON shape `floor_engine::Track` deserialises, so the
 * WASM side never has to know about song form or the library's note names.
 */
final class ArrangedTrack implements \JsonSerializable
{
    /**
     * @param  array<string, float>  $mix
     * @param  array<int, float>  $kick
     * @param  array<int, float>  $clap
     * @param  array<int, float>  $hat
     * @param  array<int, float>  $hatOpen
     * @param  array<int, NoteEvent|null>  $bass
     * @param  array<int, NoteEvent|null>  $stab
     * @param  array<int, NoteEvent|null>  $lead
     * @param  array<int, NoteEvent|null>  $pad
     * @param  array<int, NoteEvent|null>  $arp
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

    public function jsonSerialize(): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'detail' => $this->detail,
            'kind' => $this->kind,
            'bpm' => $this->bpm,
            'swing' => $this->swing,
            'mix' => $this->mix,
            'kick' => $this->kick,
            'clap' => $this->clap,
            'hat' => $this->hat,
            'hatOpen' => $this->hatOpen,
            'bass' => $this->bass,
            'stab' => $this->stab,
            'lead' => $this->lead,
            'pad' => $this->pad,
            'arp' => $this->arp,
        ];
    }

    public function toJson(): string
    {
        return json_encode($this->jsonSerialize(), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
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