<?php

declare(strict_types=1);

namespace App\Support\Music;

/**
 * A pitched hit on a melodic lane.
 *
 * Notes are MIDI numbers so the engine can convert straight to frequency, and a
 * chord is just a list of them on one stem.
 */
final class NoteEvent implements \JsonSerializable
{
    /**
     * @param  list<int>  $notes  MIDI note numbers sounded together
     * @param  float  $len  gate length in 16th steps
     * @param  float  $vel  velocity, 0..1
     * @param  bool  $accent  marked by the arrangement, brightens the voice
     */
    public function __construct(
        public readonly array $notes,
        public readonly float $len,
        public readonly float $vel,
        public readonly bool $accent = false,
    ) {
        if ($notes === []) {
            throw new \InvalidArgumentException('a note event needs at least one pitch');
        }
    }

    public function first(int $fallback = 60): int
    {
        return $this->notes[0] ?? $fallback;
    }

    public function copy(): self
    {
        return new self($this->notes, $this->len, $this->vel, $this->accent);
    }

    public function jsonSerialize(): array
    {
        return [
            'notes' => $this->notes,
            'len' => $this->len,
            'vel' => $this->vel,
            'accent' => $this->accent,
        ];
    }
}