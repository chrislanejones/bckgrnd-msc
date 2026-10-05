<?php

declare(strict_types=1);

namespace App\Support\Music;

/**
 * Stretches a four-bar groove into the 16-bar song form the engine plays.
 *
 * Four sections of four bars each:
 *
 * | section | drums  | bass  | chords / lead / arp | pad |
 * |---------|--------|-------|---------------------|-----|
 * | Intro   | kick + hats, clap on the last bar only | bar 1 only | silent | full |
 * | Groove  | full   | full  | full                | full |
 * | Break   | a two-hit fill, everything else dropped | full, or kept for acid | full | full |
 * | Drop    | full, with the last kick of the bar reinforced | full | full | full |
 *
 * Hand percussion (on the hats stem) follows the same arc: the shaker slips in for
 * the intro's last two bars, rims and congas wait for the groove, the break keeps
 * the shaker and congas under its open hats, and the drop has everything.
 *
 * Doing this on the server keeps song form in one place: the same arrangement is
 * what the API serves, what a preset saves, and what the engine renders.
 */
final class Arranger
{
    public function __construct(private readonly Track $groove) {}

    public function build(): ArrangedTrack
    {
        $t = $this->groove;
        $isAcid = $t->kind === 'acid';
        $quiet = Phrase::silence();
        $empty = Phrase::emptyNotes();

        // --- Intro: the bare bones, then the groove.
        //
        // The chords, lead and arpeggio are withheld until bar 5, and bar 2 is kick and
        // hats alone. That sparseness is the point rather than an oversight: the app
        // asks you to un-mute stems and build the track yourself, and an intro that
        // arrives already full leaves you nothing to add. An earlier version filled
        // these bars in so that no bar was "too empty", and it made the tracks sound
        // worse — busier, with the melody crowded out. Do not "fix" this again.
        $intro = [
            'kick' => $t->kick,
            'clap' => Phrase::muteHits($t->clap, [3]),
            'hat' => $t->hat,
            'hatOpen' => $quiet,
            'bass' => Phrase::muteNotes($t->bass, [2, 3]),
            'stab' => $empty,
            'lead' => $empty,
            'pad' => Phrase::copyNotes($t->pad),
            'arp' => $empty,
        ];

        // --- Break: near-silence, saved by a two-hit kick fill.
        $breakKick = Phrase::silence();
        $breakKick[60] = 1.0;
        $breakKick[62] = 0.72;
        $breakKick[63] = 1.0;

        $break = [
            'kick' => $breakKick,
            'clap' => $quiet,
            'hat' => $t->hat,
            'hatOpen' => $t->hatOpen,
            // Acid keeps its bassline through the break, since the line *is* the
            // track; everything else drops the bass for two bars to open it up.
            'bass' => $isAcid ? Phrase::copyNotes($t->bass) : Phrase::muteNotes($t->bass, [3]),
            'stab' => Phrase::copyNotes($t->stab),
            'lead' => Phrase::copyNotes($t->lead),
            'pad' => Phrase::copyNotes($t->pad),
            'arp' => Phrase::copyNotes($t->arp),
        ];

        // --- Drop: the groove at full tilt, with a snare roll into the last bar.
        $dropKick = $t->kick;
        $dropKick[14] = max($dropKick[14] ?? 0.0, 0.7);

        $drop = [
            'kick' => $dropKick,
            'clap' => $t->clap,
            'hat' => $t->hat,
            'hatOpen' => $t->hatOpen,
            'bass' => Phrase::copyNotes($t->bass),
            'stab' => Phrase::copyNotes($t->stab),
            'lead' => Phrase::copyNotes($t->lead),
            'pad' => Phrase::copyNotes($t->pad),
            'arp' => Phrase::copyNotes($t->arp),
        ];

        // --- Groove: the base statement, every stem present.
        $groove = [
            'kick' => $t->kick,
            'clap' => $t->clap,
            'hat' => $t->hat,
            'hatOpen' => $t->hatOpen,
            'bass' => Phrase::copyNotes($t->bass),
            'stab' => Phrase::copyNotes($t->stab),
            'lead' => Phrase::copyNotes($t->lead),
            'pad' => Phrase::copyNotes($t->pad),
            'arp' => Phrase::copyNotes($t->arp),
        ];

        // --- Hand percussion: sparse in the intro, out of the way in the break.
        $perc = [];
        foreach ($t->perc as $instrument => $lane) {
            $inIntro = $instrument === 'shaker' ? Phrase::muteHits($lane, [2, 3]) : $quiet;
            $inBreak = $instrument === 'rim' ? $quiet : $lane;
            $joined = Phrase::join($inIntro, $lane, $inBreak, $lane);
            if (max($joined) > 0.0) {
                $perc[$instrument] = $joined;
            }
        }

        return new ArrangedTrack(
            id: $t->id,
            name: $t->name,
            detail: $t->detail,
            kind: $t->kind,
            bpm: $t->bpm,
            swing: $t->swing,
            mix: $t->mix,
            kick: Phrase::join($intro['kick'], $groove['kick'], $break['kick'], $drop['kick']),
            clap: Phrase::join($intro['clap'], $groove['clap'], $break['clap'], $drop['clap']),
            hat: Phrase::join($intro['hat'], $groove['hat'], $break['hat'], $drop['hat']),
            hatOpen: Phrase::join($intro['hatOpen'], $groove['hatOpen'], $break['hatOpen'], $drop['hatOpen']),
            bass: Phrase::join($intro['bass'], $groove['bass'], $break['bass'], $drop['bass']),
            stab: Phrase::join($intro['stab'], $groove['stab'], $break['stab'], $drop['stab']),
            lead: Phrase::join($intro['lead'], $groove['lead'], $break['lead'], $drop['lead']),
            pad: Phrase::join($intro['pad'], $groove['pad'], $break['pad'], $drop['pad']),
            arp: Phrase::join($intro['arp'], $groove['arp'], $break['arp'], $drop['arp']),
            section: $t->section,
            style: $t->style,
            perc: $perc,
        );
    }
}