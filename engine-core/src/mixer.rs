//! Bus mixing: per-stem faders, ducking, delay send, and master processing.
//!
//! Each stem accumulates into its own stereo buffer so a cut or solo takes effect
//! instantly at the fader without touching the voices, and so send levels stay
//! independent of fader position.

use crate::dsp::{approach, soft_clip, Compressor, Delay, Limiter, Reverb, Smoothed, StereoBiquad};
use crate::track::{Stem, TrackKind};

/// Stereo accumulators for one stem.
#[derive(Clone, Copy, Default)]
pub struct Bus {
    pub left: f32,
    pub right: f32,
}

/// Mutable runtime state for one stem's channel strip.
pub struct Channel {
    pub bus: Bus,
    /// Fader target, 0..1, from the track's mix.
    pub vol: f32,
    /// Duck gain, multiplied by `vol` — this is the "pump".
    pub duck: f32,
    pub muted: bool,
    pub solo: bool,
    /// Echo send target, 0..1.
    pub send: f32,
    /// Post-fader metering level, smoothed for display.
    pub level: f32,
    /// The fader gain actually applied, gliding toward `vol` (or to zero when the stem
    /// is cut or another stem is soloed). Mute, solo and the fader used to switch the
    /// gain in one sample, which clicked on every toggle.
    pub gain_now: f32,
    /// The send actually applied, gliding toward `send` for the same reason.
    pub send_now: f32,
    /// Whether the bus was silent on the previous sample.
    was_silent: bool,
}

impl Default for Channel {
    fn default() -> Self {
        Self {
            bus: Bus::default(),
            vol: 0.8,
            duck: 1.0,
            muted: false,
            solo: false,
            send: 0.0,
            level: 0.0,
            gain_now: 0.0,
            send_now: 0.0,
            was_silent: true,
        }
    }
}

impl Channel {
    #[inline]
    pub fn audible(&self, any_solo: bool) -> bool {
        !self.muted && (!any_solo || self.solo)
    }

    #[inline]
    pub fn gain(&self, any_solo: bool) -> f32 {
        if self.audible(any_solo) {
            self.vol * self.duck
        } else {
            0.0
        }
    }

    /// Advance the fader and send glides one sample and return the gain to apply,
    /// including the duck. `coef` is the per-sample glide coefficient.
    ///
    /// The duck is deliberately not smoothed: it is the pump, a musical envelope with
    /// its own shape, not a control change.
    ///
    /// A gain change can only click if there is signal for it to step. While the
    /// stem's bus is silent, and on the first sample of sound after silence, the gain
    /// and send jump straight to their targets: a note that starts after a change
    /// starts at the new gain. So a stem cut before anything plays is cut from its very
    /// first sample, rather than letting the first hit through on the tail of a glide.
    #[inline]
    pub fn step_gain(&mut self, any_solo: bool, coef: f32) -> f32 {
        let target = if self.audible(any_solo) {
            self.vol
        } else {
            0.0
        };
        let silent = self.bus.left == 0.0 && self.bus.right == 0.0;
        let snap = silent || self.was_silent;
        self.was_silent = silent;
        if snap {
            self.gain_now = target;
            self.send_now = self.send;
        } else {
            if self.gain_now != target {
                self.gain_now = approach(self.gain_now, target, coef);
            }
            if self.send_now != self.send {
                self.send_now = approach(self.send_now, self.send, coef);
            }
        }
        self.gain_now * self.duck
    }

    /// Post-fader peak for metering, decayed between blocks so meters fall smoothly.
    #[inline]
    pub fn meter(&mut self) {
        let peak = self.bus.left.abs().max(self.bus.right.abs()).min(1.0);
        self.level = if peak > self.level {
            peak
        } else {
            self.level * 0.8
        };
    }

    #[inline]
    pub fn clear(&mut self) {
        self.bus.left = 0.0;
        self.bus.right = 0.0;
    }
}

/// Master chain, wired in the same order and with the same stages as the Web Audio
/// engine it replaces:
///
/// ```text
/// stems ─┬─────────────────────────────────────────────► hp 28 Hz
///        ├─ pre 380 Hz ─► room ─► wet 0.07 ─────────────┤
///        ├─ echo hp 240 Hz ─► throw ─► ping-pong ─► wet ┤
///        └─ per-stem sends ─────────────────► ping-pong ┘
///                                                       ▼
///              hp 28 Hz ─► compressor ─► saturator ─► dry ─► low ─► mid
///                    ─► high ─► tape sweep ─► recorder ─► master gain ─► limiter
/// ```
///
/// The order matters and was wrong here before. Saturation and compression have to
/// happen *before* the EQ: the compressor is what stops the kick and bass from stacking
/// into the clipper, and it can only do that on the summed signal. Running the EQ first
/// and saturating last meant the low end arrived at the clipper already summed, with
/// nothing holding it down — which is what made the bass sound thin and the whole mix
/// feel harsh.
pub struct Master {
    pub low: StereoBiquad,
    pub mid: StereoBiquad,
    pub high: StereoBiquad,
    pub sweep: StereoBiquad,
    pub delay: Delay,
    /// Output level, gliding.
    gain: Smoothed,
    /// Hardware-style balance, 0..1. At 0.5 (center) both channels pass at unity;
    /// turning left fades the right channel, turning right fades the left, and each
    /// end silences the opposite side. Not a pan: nothing is moved between channels.
    ///
    /// Mono is the width control's job (width 0 folds to mono), not this one's.
    /// `set_stereo_mode` still maps its three positions to 0, 0.5 and 1, which now
    /// mean hard left, center and hard right.
    balance: Smoothed,
    /// Stereo width: 0 mono, 1 as mixed, up to 1.5 wider, by scaling the side signal.
    width: Smoothed,
    pub scope: [u8; 256],
    sample_rate: f32,
    scope_t: f32,
    /// The tape filter's position, 0..1, stepped at control rate.
    sweep_open: Smoothed,
    /// The tape filter's resonance (Q) while it is closing, stepped at control rate.
    sweep_q: Smoothed,
    /// The isolators' gains in dB (low, mid, high), stepped at control rate.
    eq_db: [Smoothed; 3],
    /// Samples until the filter and EQ coefficients are next recomputed.
    control: u32,
    /// Echo time in beats. 0.75 (a dotted eighth) unless the UI picks another.
    delay_beats: f32,
    /// Whether the per-stem sends reach the echo. Off by choosing echo time 0; the
    /// echo throw is a separate feed and still works.
    sends_on: bool,
    /// Make-up trim on the output while Filter Hold is on ([`FILTER_HOLD_TRIM`]),
    /// gliding, so the held treatment is darker without being louder.
    filter_trim: Smoothed,
    /// Rumble filter on the sum, before the dynamics stage.
    hp: StereoBiquad,
    comp: Compressor,
    /// Pre-filter on the reverb send, so the room does not amplify infrasonic content.
    /// Stereo: a lone `Biquad` run left-then-right shares one delay line between the
    /// channels, which is the contamination `StereoBiquad` exists to prevent. This
    /// filter and `echo_hp` were the two that the original conversion missed.
    verb_pre: StereoBiquad,
    verb: Reverb,
    verb_wet: Smoothed,
    /// Highpass on the echo throw, keeping the delay out of the sub band. Stereo for
    /// the same reason as `verb_pre`.
    echo_hp: StereoBiquad,
    dry: Smoothed,
    wet: Smoothed,
    /// Extra send into the delay when the echo throw is engaged. Zero when off, so
    /// the per-stem sends pass straight through untouched.
    throw: Smoothed,
    echo_on: bool,
    /// The echo's feedback and return level as the user set them. The echo throw
    /// overrides both while it is held and puts these back when it lets go.
    echo_feedback: f32,
    echo_return: f32,
    /// Previous input to the saturator, for the 2x oversampled curve, one per
    /// channel. A single shared value (as this was) built the right channel's
    /// interpolated midpoint from the current *left* sample, leaking left into right.
    shaper_prev: [f32; 2],
    /// Per-stem sends accumulated for the current sample, drained by `process`.
    send_acc: f32,
    /// Output safety ceiling, the very last stage. The EQ, tape filter and master gain
    /// all sit after the compressor and can lift the sum past full scale.
    limiter: Limiter,
    /// The filter position and resonance as the setters and scenes wrote them: the
    /// base. Filter Hold overrides what the sweep glides to, never these.
    filter_base: f32,
    q_base: f32,
    filter_hold: bool,
    /// Gain on the echo and room returns from the engine's all-cut gate, 0..1, set
    /// every sample before [`Master::process`].
    returns_gate: f32,
    /// The solo flush: samples into it, or `None` when idle. See
    /// [`Master::flush_returns`].
    flush: Option<u32>,
    /// The flush's duck, hold and restore lengths, in samples.
    flush_duck: u32,
    flush_hold: u32,
}

/// The reverb's wet level, and the highpasses either side of the send.
pub const VERB_WET: f32 = 0.07;
/// The most room the mix control allows. Past this the room swamps the dry signal.
pub const VERB_WET_MAX: f32 = 0.5;
/// The echo's default feedback and return level (the values it always had).
pub const ECHO_FEEDBACK: f32 = 0.3;
pub const ECHO_RETURN: f32 = 0.24;
/// The highest feedback the user can set. The delay line itself caps at 0.95.
pub const ECHO_FEEDBACK_MAX: f32 = 0.9;
/// What the echo throw opens the feedback to, unless the user already set it higher.
const THROW_FEEDBACK: f32 = 0.78;
/// The tape filter's default resonance while closing, and its range.
pub const FILTER_Q: f32 = 0.85;
pub const FILTER_Q_MIN: f32 = 0.5;
pub const FILTER_Q_MAX: f32 = 6.0;
/// The Q the filter settles to when fully open, so an open filter is transparent at
/// any resonance setting.
const FILTER_OPEN_Q: f32 = 0.45;
/// The widest the stereo width goes.
pub const WIDTH_MAX: f32 = 1.5;
/// Filter Hold: the filter closes to this position (about 880 Hz on the 240 Hz to
/// 18 kHz sweep), or stays where the base has it if that is already darker.
pub const FILTER_HOLD_OPEN: f32 = 0.3;
/// Filter Hold: the resonance it holds at, or the base's if that is already higher.
pub const FILTER_HOLD_Q: f32 = 3.0;
/// Filter Hold: output trim while held, -1.5 dB. The resonant peak sits on the stab
/// and lead band, and without this a dense mix measured about 1 dB *louder* held
/// than open, which reads as a boost rather than the filter closing.
pub const FILTER_HOLD_TRIM: f32 = 0.84;
/// The solo flush: the returns duck over this, are held silent while the other stems'
/// faders finish gliding out (five time constants of the channel glide), have their
/// history cleared, and come back over the duck time again.
const FLUSH_DUCK_SECONDS: f32 = 0.016;
const FLUSH_HOLD_SECONDS: f32 = 0.048;
/// How often, in samples, the filter and EQ coefficients may be recomputed while they
/// move. Recomputing them every sample cost a `powf`, a `sin` and a `cos` per sample
/// for no audible gain; at this rate and these glide times each step is far below a
/// tenth of a dB.
const CONTROL_EVERY: u32 = 16;
/// Glide times, in seconds.
const GAIN_GLIDE: f32 = 0.015;
const BALANCE_GLIDE: f32 = 0.02;
const FILTER_GLIDE: f32 = 0.03;
const EQ_GLIDE: f32 = 0.02;
const VERB_PRE_HZ: f32 = 380.0;
const ECHO_HP_HZ: f32 = 240.0;
const RUMBLE_HP_HZ: f32 = 28.0;
/// The echo's default time: a dotted eighth.
pub const DELAY_BEATS_DEFAULT: f32 = 0.75;
/// Longest echo time, in seconds. A dotted quarter at the slowest tempo (70 bpm) is
/// 1.29 s; the line holds 1.5 s.
const DELAY_MAX_SECONDS: f32 = 1.45;
/// Equal-power makeup for the ping-pong returns, each repeat being on one side only.
const PING_PONG_GAIN: f32 = core::f32::consts::SQRT_2;
/// The output limiter: untouched below the knee, never past the ceiling.
const LIMIT_KNEE_DB: f32 = -3.0;
const LIMIT_CEILING_DB: f32 = -0.3;
const LIMIT_RELEASE: f32 = 0.08;

impl Master {
    pub fn new(sample_rate: f32) -> Self {
        let mut low = StereoBiquad::new();
        low.low_shelf(sample_rate, 180.0, 0.0);
        let mut mid = StereoBiquad::new();
        mid.peaking(sample_rate, 1000.0, 0.7, 0.0);
        let mut high = StereoBiquad::new();
        high.high_shelf(sample_rate, 3200.0, 0.0);
        let mut sweep = StereoBiquad::new();
        sweep.lowpass(sample_rate, 18_000.0, 0.45);
        let mut delay = Delay::new(sample_rate, 1.5);
        delay.set_feedback(ECHO_FEEDBACK);

        let mut hp = StereoBiquad::new();
        hp.highpass(sample_rate, RUMBLE_HP_HZ, 0.7);
        let mut verb_pre = StereoBiquad::new();
        verb_pre.highpass(sample_rate, VERB_PRE_HZ, 0.7);
        let mut echo_hp = StereoBiquad::new();
        echo_hp.highpass(sample_rate, ECHO_HP_HZ, 0.7);

        let control_rate = sample_rate / CONTROL_EVERY as f32;
        Self {
            low,
            mid,
            high,
            sweep,
            delay,
            gain: Smoothed::new(0.78, GAIN_GLIDE, sample_rate),
            balance: Smoothed::new(0.5, BALANCE_GLIDE, sample_rate),
            width: Smoothed::new(1.0, BALANCE_GLIDE, sample_rate),
            scope: [128; 256],
            sample_rate,
            scope_t: 0.0,
            sweep_open: Smoothed::new(1.0, FILTER_GLIDE, control_rate),
            sweep_q: Smoothed::new(FILTER_Q, FILTER_GLIDE, control_rate),
            eq_db: [Smoothed::new(0.0, EQ_GLIDE, control_rate); 3],
            control: 0,
            delay_beats: DELAY_BEATS_DEFAULT,
            sends_on: true,
            filter_trim: Smoothed::new(1.0, FILTER_GLIDE, sample_rate),
            hp,
            // The dynamics stage's settings are the load-bearing part of this chain, so
            // they are named once here rather than spread through the process method.
            comp: Compressor::new(sample_rate, -12.0, 8.0, 2.6, 0.008, 0.2),
            verb_pre,
            verb: Reverb::new(sample_rate),
            verb_wet: Smoothed::new(VERB_WET, GAIN_GLIDE, sample_rate),
            echo_hp,
            dry: Smoothed::new(1.0, GAIN_GLIDE, sample_rate),
            wet: Smoothed::new(ECHO_RETURN, GAIN_GLIDE, sample_rate),
            throw: Smoothed::new(0.0, GAIN_GLIDE, sample_rate),
            echo_on: false,
            echo_feedback: ECHO_FEEDBACK,
            echo_return: ECHO_RETURN,
            shaper_prev: [0.0; 2],
            send_acc: 0.0,
            limiter: Limiter::new(sample_rate, LIMIT_KNEE_DB, LIMIT_CEILING_DB, LIMIT_RELEASE),
            filter_base: 1.0,
            q_base: FILTER_Q,
            filter_hold: false,
            returns_gate: 1.0,
            flush: None,
            flush_duck: ((FLUSH_DUCK_SECONDS * sample_rate) as u32).max(1),
            flush_hold: ((FLUSH_HOLD_SECONDS * sample_rate) as u32).max(1),
        }
    }

    /// Clear the echo and room history: both lines, the room, and the filters that
    /// feed them. No glide; callers duck the returns first.
    fn clear_returns(&mut self) {
        self.delay.reset();
        self.verb.reset();
        self.verb_pre.reset();
        self.echo_hp.reset();
    }

    /// Duck the echo and room returns, clear their history, and bring them back:
    /// entering solo, so the soloed stem is not heard over another stem's tail.
    ///
    /// The returns fall to silence over 16 ms, stay there 48 ms while the other
    /// stems' faders finish gliding out (their sends are post-fader), are cleared,
    /// and return over 16 ms with nothing in them. Nothing jumps: the clear happens at
    /// zero gain. Called again mid-flush, it carries on from the gain it is at.
    pub fn flush_returns(&mut self) {
        let gain = self.flush_gain();
        self.flush = Some(((1.0 - gain) * self.flush_duck as f32) as u32);
    }

    /// The flush's gain on the returns now, 1 when idle.
    fn flush_gain(&self) -> f32 {
        let Some(t) = self.flush else { return 1.0 };
        let (duck, hold) = (self.flush_duck, self.flush_hold);
        if t < duck {
            1.0 - t as f32 / duck as f32
        } else if t < duck + hold {
            0.0
        } else {
            ((t - duck - hold) as f32 / duck as f32).min(1.0)
        }
    }

    /// Step the flush one sample and return its gain on the returns.
    #[inline]
    fn step_flush(&mut self) -> f32 {
        let Some(t) = self.flush else { return 1.0 };
        let g = self.flush_gain();
        if t == self.flush_duck + self.flush_hold {
            self.clear_returns();
        }
        self.flush = if t >= 2 * self.flush_duck + self.flush_hold {
            None
        } else {
            Some(t + 1)
        };
        g
    }

    /// The engine's all-cut gate on the returns, 0..1.
    #[inline]
    pub fn set_returns_gate(&mut self, gate: f32) {
        self.returns_gate = gate;
    }

    /// Hold the filter dark and resonant ([`FILTER_HOLD_OPEN`], [`FILTER_HOLD_Q`]) or
    /// let it back to the base. The sweep glides either way.
    pub fn set_filter_hold(&mut self, on: bool) {
        if self.filter_hold != on {
            self.filter_hold = on;
            self.retarget_filter();
        }
    }

    /// Point the sweep at the base, or at the hold's treatment of it. Out of line:
    /// every filter setter and scene commit calls it.
    #[inline(never)]
    fn retarget_filter(&mut self) {
        if self.filter_hold {
            self.sweep_open.set(self.filter_base.min(FILTER_HOLD_OPEN));
            self.sweep_q.set(self.q_base.max(FILTER_HOLD_Q));
            self.filter_trim.set(FILTER_HOLD_TRIM);
        } else {
            self.sweep_open.set(self.filter_base);
            self.sweep_q.set(self.q_base);
            self.filter_trim.set(1.0);
        }
    }

    /// The filter position as the setters left it, whatever a hold is doing.
    #[cfg(test)]
    pub fn filter_base(&self) -> f32 {
        self.filter_base
    }

    /// Where the sweep actually is now.
    #[cfg(test)]
    pub fn sweep_open_value(&self) -> f32 {
        self.sweep_open.value()
    }

    /// The resonance the sweep is heading for (held or base).
    #[cfg(test)]
    pub fn sweep_q_target(&self) -> f32 {
        self.sweep_q.target()
    }

    /// The feedback the echo line is heading for.
    #[cfg(test)]
    pub fn feedback_target(&self) -> f32 {
        self.delay.feedback_target()
    }

    pub fn reset(&mut self) {
        self.delay.reset();
        self.low.reset();
        self.mid.reset();
        self.high.reset();
        self.sweep.reset();
        self.hp.reset();
        self.verb_pre.reset();
        self.echo_hp.reset();
        self.verb.reset();
        self.comp.reset();
        self.shaper_prev = [0.0; 2];
        self.limiter.reset();
    }

    /// Accumulate a stem's send for this sample. The line itself is written exactly
    /// once per sample, in [`Master::process`].
    ///
    /// Accumulating rather than writing is load-bearing. [`Delay::write_input`]
    /// advances the write pointer, so calling it per send ran the line at the number
    /// of sends: six sending stems x two channels is twelve pointer advances per
    /// audio sample, which put the dotted-eighth echo at 20 ms instead of 357 ms and
    /// made the delay time change when the echo throw added a thirteenth write. It
    /// also stepped the time and feedback glides twelve times per sample. The echo
    /// was not an echo, it was a 20 ms metallic comb.
    ///
    /// Takes both channels so the two-call pattern that caused this cannot recur.
    /// The send is mono into the ping-pong's left line, so the pair is averaged,
    /// matching the echo throw's own `0.5 * (l + r)`.
    #[inline]
    pub fn feed_send(&mut self, left: f32, right: f32, amount: f32) {
        if amount > 0.0 && self.sends_on {
            self.send_acc += 0.5 * (left + right) * amount;
        }
    }

    pub fn echo_on(&self) -> bool {
        self.echo_on
    }

    /// Multiplier applied to a stem's delay send. The throw is not folded in here; it
    /// is a separate send off the sum.
    #[inline]
    pub fn send_gain(&self) -> f32 {
        1.0
    }

    /// The dry level the chain is heading for.
    pub fn mix_dry(&self) -> f32 {
        self.dry.target()
    }

    /// The echo return level the chain is heading for.
    pub fn mix_wet(&self) -> f32 {
        self.wet.target()
    }

    /// The filter position the sweep is heading for, 0..1.
    pub fn sweep_target(&self) -> f32 {
        self.sweep_open.target()
    }

    /// Whether the stems' echo sends feed the line (echo time is not "off").
    pub fn sends_enabled(&self) -> bool {
        self.sends_on
    }

    /// Convert a 0..1 filter position to a cutoff, exponentially from 240 Hz to
    /// 18 kHz so the useful range is spread evenly under the finger.
    pub fn filter_freq(open: f32) -> f32 {
        let a = open.clamp(0.0, 1.0);
        240.0 * (18_000.0_f32 / 240.0).powf(a)
    }

    /// The base filter position. Under a Filter Hold this is stored and the hold
    /// re-derived from it, so letting go lands here.
    pub fn set_filter(&mut self, open: f32) {
        if open.is_finite() {
            self.filter_base = open.clamp(0.0, 1.0);
            self.retarget_filter();
        }
    }

    /// The filter's resonance while it closes, as a Q from 0.5 to 6. Opening the
    /// filter all the way still fades it to a transparent 0.45, whatever this is.
    pub fn set_filter_q(&mut self, q: f32) {
        if q.is_finite() {
            self.q_base = q.clamp(FILTER_Q_MIN, FILTER_Q_MAX);
            self.retarget_filter();
        }
    }

    /// The Q the tape filter actually uses at `open` with resonance `q`.
    ///
    /// It used to switch from 0.85 to 0.45 the moment the filter passed 97% open,
    /// which put a step into the coefficients on every sweep through the top. It now
    /// blends across the last tenth of the travel instead.
    pub fn sweep_q_at(open: f32, q: f32) -> f32 {
        let t = ((open - 0.9) / 0.1).clamp(0.0, 1.0);
        let blend = t * t * (3.0 - 2.0 * t);
        q + (FILTER_OPEN_Q - q) * blend
    }

    pub fn set_eq(&mut self, low_db: f32, mid_db: f32, high_db: f32) {
        for (band, db) in self.eq_db.iter_mut().zip([low_db, mid_db, high_db]) {
            band.set(db);
        }
    }

    /// Step the filter and EQ glides and recompute whichever coefficients moved.
    /// Called every `CONTROL_EVERY` samples.
    fn control_tick(&mut self) {
        if !self.sweep_open.settled() || !self.sweep_q.settled() {
            let open = self.sweep_open.next();
            let q = self.sweep_q.next();
            self.sweep.lowpass(
                self.sample_rate,
                Self::filter_freq(open),
                Self::sweep_q_at(open, q),
            );
        }
        if !self.eq_db[0].settled() {
            let db = self.eq_db[0].next();
            self.low.low_shelf(self.sample_rate, 180.0, db);
        }
        if !self.eq_db[1].settled() {
            let db = self.eq_db[1].next();
            self.mid.peaking(self.sample_rate, 1000.0, 0.7, db);
        }
        if !self.eq_db[2].settled() {
            let db = self.eq_db[2].next();
            self.high.high_shelf(self.sample_rate, 3200.0, db);
        }
    }

    /// The echo's feedback, 0 to 0.9. The echo throw lifts it to 0.78 while held if
    /// this is lower, and puts it back after.
    pub fn set_echo_feedback(&mut self, amount: f32) {
        if !amount.is_finite() {
            return;
        }
        self.echo_feedback = amount.clamp(0.0, ECHO_FEEDBACK_MAX);
        self.delay.set_feedback(if self.echo_on {
            self.echo_feedback.max(THROW_FEEDBACK)
        } else {
            self.echo_feedback
        });
    }

    /// How loud the echo comes back, 0 to 1. The echo throw overrides it while held.
    pub fn set_echo_return(&mut self, amount: f32) {
        if !amount.is_finite() {
            return;
        }
        self.echo_return = amount.clamp(0.0, 1.0);
        if !self.echo_on {
            self.wet.set(self.echo_return);
        }
    }

    /// How much room is mixed in, 0 to 0.5. The default is 0.07.
    pub fn set_reverb_mix(&mut self, amount: f32) {
        if amount.is_finite() {
            self.verb_wet.set(amount.clamp(0.0, VERB_WET_MAX));
        }
    }

    /// The room's decay time in seconds, 0.2 to 2.5. The default is 0.32.
    pub fn set_reverb_decay(&mut self, seconds: f32) {
        self.verb.set_rt60(seconds);
    }

    /// Stereo width: 0 mono, 1 as mixed, 1.5 wider.
    pub fn set_width(&mut self, width: f32) {
        if width.is_finite() {
            self.width.set(width.clamp(0.0, WIDTH_MAX));
        }
    }

    /// Output balance: 0 hard left (right channel silent), 0.5 center (both at
    /// unity), 1 hard right (left channel silent).
    pub fn set_balance(&mut self, balance: f32) {
        if balance.is_finite() {
            self.balance.set(balance.clamp(0.0, 1.0));
        }
    }

    /// Beat-synced delay, `delay_beats` long (a dotted eighth by default).
    pub fn set_delay_time(&mut self, bpm: f32, rate: f32) {
        let beat = 60.0 / (bpm * rate.max(0.2));
        self.delay
            .set_time((beat * self.delay_beats).clamp(0.05, DELAY_MAX_SECONDS));
    }

    /// Choose the echo time in beats (0.25 a sixteenth, 1 a quarter, ...), clamped to
    /// 1/8 to 2 beats, and retime the line for the current tempo. The line glides to
    /// the new time, so a change mid-echo slides rather than clicks.
    ///
    /// Zero or less turns the stem sends off: nothing new enters the line, and what is
    /// already in it rings out on its own feedback rather than being cut. The time is
    /// left where it was, so the echo throw still repeats at the last chosen value.
    pub fn set_delay_beats(&mut self, beats: f32, bpm: f32, rate: f32) {
        if beats.is_finite() && beats <= 0.0 {
            self.sends_on = false;
            return;
        }
        self.sends_on = true;
        self.delay_beats = if beats.is_finite() {
            beats.clamp(0.125, 2.0)
        } else {
            DELAY_BEATS_DEFAULT
        };
        self.set_delay_time(bpm, rate);
    }

    /// The echo throw: the summed bus, high-passed, fed into the delay line, plus a
    /// wet/dry swap and longer feedback so repeats sustain.
    ///
    /// The direct sound never routes through the delay — the line is fed by the
    /// per-stem sends plus this throw — so the echo is purely additive and the dry
    /// signal keeps its own level. Turning it on pulls the mix wetter and opens the
    /// feedback up.
    pub fn set_echo(&mut self, on: bool) {
        self.echo_on = on;
        if on {
            self.throw.set(0.9);
            self.dry.set(0.55);
            self.wet.set(0.95);
            self.delay
                .set_feedback(self.echo_feedback.max(THROW_FEEDBACK));
        } else {
            self.throw.set(0.0);
            self.dry.set(1.0);
            self.wet.set(self.echo_return);
            self.delay.set_feedback(self.echo_feedback);
        }
    }

    /// The glue saturator, run at twice the sample rate.
    ///
    /// `tanh` is a memoryless nonlinearity, so at 1x every harmonic it generates above
    /// Nyquist folds straight back into the audible band as aliasing — audible as grit
    /// on the bass and hats right where the signal is hottest. Interpolating up one
    /// octave, saturating both interpolated points and averaging them back down puts an
    /// anti-image filter in front of the fold, which is what the Web Audio waveshaper's
    /// `oversample = "2x"` does.
    ///
    /// `ch` is 0 for left and 1 for right: the interpolation reads the previous sample
    /// of the *same* channel.
    #[inline]
    fn saturate(&mut self, ch: usize, x: f32) -> f32 {
        const AMOUNT: f32 = 1.35;
        let prev = &mut self.shaper_prev[ch & 1];
        let up = 0.5 * (x + *prev);
        *prev = x;
        0.5 * (soft_clip(up, AMOUNT) + soft_clip(x, AMOUNT))
    }

    /// Render one stereo sample through the master chain. `left`/`right` are the
    /// summed stem buses. Per-stem sends must already have been pushed via
    /// [`Master::feed_send`] for this sample; the wet taps are read once here.
    pub fn process(&mut self, left: f32, right: f32) -> (f32, f32) {
        // The filter and EQ glide at control rate; see `control_tick`.
        if self.control == 0 {
            self.control_tick();
            self.control = CONTROL_EVERY;
        }
        self.control -= 1;

        // --- The delay line: exactly one write per sample, carrying the per-stem
        // sends accumulated for this sample plus the echo throw off the summed bus.
        // Read the tap before writing, so the line delays rather than feeding this
        // sample straight back out.
        //
        // Stereo ping-pong: each repeat lands on one side only, so the returns are
        // lifted by sqrt(2) to keep the echo's power where the mono return had it
        // (the mono line put every repeat on both sides at full level).
        let (wet_l, wet_r) = self.delay.tap_stereo();
        let (wet_l, wet_r) = (wet_l * PING_PONG_GAIN, wet_r * PING_PONG_GAIN);
        let throw_gain = self.throw.next();
        let throw = if throw_gain > 0.0 {
            let (t_l, t_r) = self.echo_hp.process(left, right);
            0.5 * (t_l + t_r) * throw_gain
        } else {
            0.0
        };
        self.delay.write_input(self.send_acc + throw);
        self.send_acc = 0.0;

        // --- Reverb send, tapped off the summed buses before any master processing.
        let (send_l, send_r) = self.verb_pre.process(left, right);
        let (verb_l, verb_r) = self.verb.process(send_l, send_r);

        // --- Rumble filter, taking the sum and every wet return together. The returns
        // carry the solo flush and the all-cut gate on top of their own levels.
        let returns = self.step_flush() * self.returns_gate;
        let verb_wet = self.verb_wet.next() * returns;
        let wet = self.wet.next() * returns;
        let (mut l, mut r) = self.hp.process(
            left + verb_l * verb_wet + wet_l * wet,
            right + verb_r * verb_wet + wet_r * wet,
        );

        // --- Dynamics, then the saturator, then the dry trim. Both sit *before* the EQ
        // so the low end is controlled on the summed signal rather than after it has
        // already been shaped.
        // Stereo-linked: one detector step per sample, one gain for both sides.
        (l, r) = self.comp.process_stereo(l, r);
        let dry = self.dry.next();
        l *= dry;
        r *= dry;

        l = self.saturate(0, l);
        r = self.saturate(1, r);

        // --- EQ and the tape filter, after the glue.
        (l, r) = self.low.process(l, r);
        (l, r) = self.mid.process(l, r);
        (l, r) = self.high.process(l, r);
        (l, r) = self.sweep.process(l, r);

        let gain = self.gain.next();
        l *= gain;
        r *= gain;

        // Width, by scaling the side signal: 0 folds to mono, 1 leaves the mix alone.
        let width = self.width.next();
        if width != 1.0 {
            let mid = 0.5 * (l + r);
            let side = 0.5 * (l - r) * width;
            l = mid + side;
            r = mid - side;
        }

        // Balance, the way a hardware console does it: center is unity on both
        // channels, turning left fades the right channel, turning right fades the
        // left, and each end silences the opposite side. Linear amplitude.
        let b = self.balance.next();
        let gain_l = (2.0 * (1.0 - b)).min(1.0);
        let gain_r = (2.0 * b).min(1.0);
        let mut out_l = l * gain_l;
        let mut out_r = r * gain_r;
        let trim = self.filter_trim.next();
        out_l *= trim;
        out_r *= trim;

        // --- The safety ceiling, last of all, so nothing upstream can clip the output.
        (out_l, out_r) = self.limiter.process(out_l, out_r);

        self.scope_t += 1.0;
        if self.scope_t >= self.sample_rate / 60.0 {
            self.scope_t = 0.0;
            self.push_scope((out_l + out_r) * 0.5);
        }

        (out_l, out_r)
    }

    /// Advance the oscilloscope trace one pixel per frame at a fixed 60 Hz.
    fn push_scope(&mut self, sample: f32) {
        let v = (sample.clamp(-1.0, 1.0) * 127.0 + 128.0) as u8;
        self.scope.rotate_right(1);
        self.scope[0] = v;
    }

    pub fn set_master(&mut self, gain: f32) {
        if gain.is_finite() {
            self.gain.set(gain.clamp(0.0, 1.0));
        }
    }
}

/// Per-stem duck automation driven by the kick.
pub struct Ducker {
    /// Gain the ducked stems fall to at the moment of the hit.
    floor: f32,
    /// Recovery length in beats, from the track flavour. Kept so the recovery time
    /// can be *recomputed* at each tempo rather than derived from its own last value.
    beats: f32,
    /// Seconds for the stems to recover back to unity.
    recovery: f32,
    stems: Vec<usize>,
    /// Phase through the duck, 0 at the hit and 1 when fully recovered.
    phase: f32,
    active: bool,
}

impl Ducker {
    /// Recovery time at a tempo. Matches the reference's
    /// `min(0.48, (60 / bpm) * beats)` — the cap is the reference's, and it binds
    /// below about 73 bpm for `deep`.
    fn recovery_for(beats: f32, bpm: f32, sample_rate: f32) -> f32 {
        let back = ((60.0 / bpm.max(40.0)) * beats).min(0.48);
        back.max(1.0 / sample_rate.max(1.0))
    }

    pub fn new(kind: TrackKind, bpm: f32, sample_rate: f32) -> Self {
        let (floor, beats) = Stem::duck_shape(kind);
        Self {
            floor,
            beats,
            recovery: Self::recovery_for(beats, bpm, sample_rate),
            stems: Stem::ducks_under(kind).iter().map(|s| s.index()).collect(),
            phase: 1.0,
            active: false,
        }
    }

    /// Trigger a duck at the current tempo.
    ///
    /// Recomputed from `beats`, not from the previous `recovery`. Multiplying the
    /// stored value by `60 / bpm` again on every hit (as this did) decays it
    /// geometrically: at 126 bpm the house pump went 0.262 s, 0.125, 0.059, ... and
    /// was under a millisecond — inaudible — eight kicks in. The duck still reached
    /// its floor, so no level test caught it; the four-on-the-floor breathing just
    /// vanished a bar into every track.
    pub fn trigger(&mut self, bpm: f32, sample_rate: f32) {
        self.recovery = Self::recovery_for(self.beats, bpm, sample_rate);
        self.phase = 0.0;
        self.active = true;
    }

    /// How many samples a full recovery takes at this tempo, for the engine to
    /// schedule against.
    pub fn recovery_samples(&self, sample_rate: f32) -> u32 {
        (self.recovery * sample_rate).ceil() as u32
    }

    /// Advance one sample and write the current duck gain into the affected channels.
    ///
    /// The drop is instantaneous and the return to unity is linear across `recovery`,
    /// matching the reference's `setValueAtTime(floor, t)` followed by
    /// `linearRampToValueAtTime(1, t + back)`. An earlier version glided *into* the
    /// floor over the first 15% of the recovery, which at 126 bpm is a 39 ms fade
    /// where the kick wants a step, and squeezed the ramp back into the other 85%.
    pub fn apply(&mut self, channels: &mut [Channel; 8], sample_rate: f32) {
        for &i in &self.stems {
            if let Some(c) = channels.get_mut(i) {
                c.duck = 1.0;
            }
        }
        if !self.active {
            return;
        }
        self.phase += 1.0 / (self.recovery * sample_rate).max(1.0);
        if self.phase >= 1.0 {
            self.phase = 1.0;
            self.active = false;
        }
        let g = self.floor + (1.0 - self.floor) * self.phase;
        for &i in &self.stems {
            if let Some(c) = channels.get_mut(i) {
                c.duck = g;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole master chain left in silence after an echo throw must go back to
    /// emitting exact zeros, with no subnormal residue anywhere it recirculates. This is
    /// the Stop / every-stem-cut case: the chain keeps running on silence, and before
    /// `dsp::flush` its reverb, delay and filter states sat in the subnormal range
    /// indefinitely, costing 10-20x the normal render time.
    #[test]
    fn the_master_falls_to_exact_silence_after_an_echo_tail() {
        let mut m = Master::new(48_000.0);
        m.set_eq(3.0, -2.0, 2.0);
        m.set_filter(0.4);
        m.set_echo(true);
        for _ in 0..96_000 {
            let x = crate::dsp::noise() * 0.5;
            m.feed_send(x, x, 0.3);
            m.process(x, -x);
        }
        m.set_echo(false);
        let mut last = (1.0, 1.0);
        for _ in 0..(30 * 48_000) {
            last = m.process(0.0, 0.0);
        }
        assert_eq!(last, (0.0, 0.0), "the master never fell to exact silence");
        assert!(
            m.delay.is_silent(),
            "the echo lines kept a residue after 30 s of silence"
        );
    }
    /// The echo has to arrive where the tempo says it does.
    ///
    /// This is measured through the real call pattern — several stems feeding sends
    /// before each `process` — because that pattern is what broke. A test that calls
    /// `Delay::process` once per sample cannot see it: the fault was one pointer
    /// advance per *send*, so the error scaled with how many stems were sending.
    #[test]
    fn the_echo_lands_on_the_dotted_eighth_whatever_is_sending() {
        let sr = 48_000.0;
        let bpm = 126.0;
        // A dotted eighth at 126 bpm: (60 / 126) * 0.75.
        let expected = (60.0 / bpm) * 0.75;

        for sending_stems in [1usize, 6] {
            let mut m = Master::new(sr);
            m.set_delay_time(bpm, 1.0);
            // Let the time glide settle off its 0.25 s default before measuring.
            for _ in 0..(sr as usize) {
                m.process(0.0, 0.0);
            }

            // A short burst through the sends, then silence, watching for the repeat.
            let mut onset = None;
            for i in 0..(sr as usize) {
                let drive = if i < (sr * 0.01) as usize { 0.6 } else { 0.0 };
                for _ in 0..sending_stems {
                    m.feed_send(drive, drive, 0.3);
                }
                m.process(0.0, 0.0);
                if onset.is_none() && i > (sr * 0.02) as usize && m.delay.tap().abs() > 0.02 {
                    onset = Some(i as f32 / sr);
                }
            }

            let onset = onset.expect("the delay never returned anything");
            assert!(
                (onset - expected).abs() < 0.02,
                "{sending_stems} sending stem(s): echo arrived at {onset:.4} s, \
                 expected {expected:.4} s"
            );
        }
    }

    /// Every echo time the UI offers lands on its own division of the beat.
    #[test]
    fn each_echo_time_lands_on_its_division() {
        let sr = 48_000.0;
        let bpm = 120.0;
        for beats in [0.25f32, 1.0 / 3.0, 0.5, 0.75, 1.0, 1.5] {
            let expected = (60.0 / bpm) * beats;
            let mut m = Master::new(sr);
            m.set_delay_beats(beats, bpm, 1.0);
            // Let the time glide settle before measuring.
            for _ in 0..(sr as usize * 2) {
                m.process(0.0, 0.0);
            }
            let mut onset = None;
            for i in 0..(sr as usize * 2) {
                let drive = if i < (sr * 0.01) as usize { 0.6 } else { 0.0 };
                m.feed_send(drive, drive, 0.3);
                m.process(0.0, 0.0);
                if onset.is_none() && i > (sr * 0.02) as usize && m.delay.tap().abs() > 0.02 {
                    onset = Some(i as f32 / sr);
                }
            }
            let onset = onset.expect("the delay never returned anything");
            assert!(
                (onset - expected).abs() < 0.02,
                "{beats} beats: echo at {onset:.4} s, expected {expected:.4} s"
            );
        }
    }

    #[test]
    fn echo_time_zero_turns_the_sends_off_and_lets_the_tail_ring() {
        let sr = 48_000.0;
        let mut m = Master::new(sr);
        m.set_delay_beats(0.5, 120.0, 1.0);
        for _ in 0..(sr as usize) {
            m.process(0.0, 0.0);
        }
        // A burst in, then off: the repeat already in the line still arrives.
        for i in 0..(sr * 0.01) as usize {
            m.feed_send(0.6, 0.6, 0.3);
            m.process(0.0, 0.0);
            let _ = i;
        }
        m.set_delay_beats(0.0, 120.0, 1.0);
        let mut tail = 0.0f32;
        for _ in 0..(sr as usize) {
            m.process(0.0, 0.0);
            tail = tail.max(m.delay.tap().abs());
        }
        assert!(tail > 0.02, "switching off cut the echo already sounding");

        // Once it has rung out, sends no longer reach the line at all.
        for _ in 0..(sr as usize * 6) {
            m.process(0.0, 0.0);
        }
        let mut leak = 0.0f32;
        for _ in 0..(sr as usize) {
            m.feed_send(0.6, 0.6, 0.3);
            m.process(0.0, 0.0);
            leak = leak.max(m.delay.tap().abs());
        }
        assert!(
            leak < 1e-4,
            "sends still feed the echo when it is off: {leak}"
        );

        // And any time turns it back on.
        m.set_delay_beats(0.25, 120.0, 1.0);
        let mut back = 0.0f32;
        for _ in 0..(sr as usize) {
            m.feed_send(0.6, 0.6, 0.3);
            m.process(0.0, 0.0);
            back = back.max(m.delay.tap().abs());
        }
        assert!(back > 0.02, "the echo did not come back on");
    }

    #[test]
    fn echo_times_out_of_range_are_clamped_and_finite() {
        let mut m = Master::new(48_000.0);
        for beats in [f32::NAN, f32::INFINITY, -1.0, 0.0, 50.0] {
            m.set_delay_beats(beats, 70.0, 1.0);
            for _ in 0..4_800 {
                m.feed_send(0.3, 0.3, 0.3);
                let (l, r) = m.process(0.1, 0.1);
                assert!(l.is_finite() && r.is_finite(), "{beats}: non-finite output");
            }
        }
    }

    /// The echo is a ping-pong: the first repeat on the left, the second on the right,
    /// and so on, each at the dotted eighth after the last.
    #[test]
    fn successive_repeats_alternate_sides() {
        let sr = 48_000.0;
        let bpm = 126.0;
        let step = (60.0 / bpm) * 0.75;
        let mut m = Master::new(sr);
        m.set_delay_time(bpm, 1.0);
        m.set_echo(true);
        for _ in 0..(sr as usize) {
            m.process(0.0, 0.0);
        }
        // A short burst into the sends only, so nothing but the echo reaches the output.
        let total = (sr * step * 4.6) as usize;
        let mut out = Vec::with_capacity(total);
        for i in 0..total {
            let drive = if i < (sr * 0.01) as usize { 0.6 } else { 0.0 };
            m.feed_send(drive, drive, 0.3);
            out.push(m.process(0.0, 0.0));
        }
        for k in 1..=4usize {
            let at = (k as f32 * step * sr) as usize;
            let (mut el, mut er) = (0.0f32, 0.0f32);
            for (l, r) in &out[at.saturating_sub(480)..(at + 1440).min(total)] {
                el += l * l;
                er += r * r;
            }
            assert!(el + er > 1e-6, "repeat {k} is missing");
            if k % 2 == 1 {
                assert!(
                    el > er * 20.0,
                    "repeat {k} should be on the left: L {el} R {er}"
                );
            } else {
                assert!(
                    er > el * 20.0,
                    "repeat {k} should be on the right: L {el} R {er}"
                );
            }
        }
    }

    /// Engaging the echo must not move the delay time.
    #[test]
    fn the_echo_throw_does_not_retune_the_delay() {
        let sr = 48_000.0;
        let onset = |echo: bool| -> f32 {
            let mut m = Master::new(sr);
            m.set_delay_time(126.0, 1.0);
            m.set_echo(echo);
            for _ in 0..(sr as usize) {
                m.process(0.0, 0.0);
            }
            for i in 0..(sr as usize) {
                let drive = if i < (sr * 0.01) as usize { 0.6 } else { 0.0 };
                m.feed_send(drive, drive, 0.3);
                m.process(drive, drive);
                if i > (sr * 0.02) as usize && m.delay.tap().abs() > 0.02 {
                    return i as f32 / sr;
                }
            }
            f32::NAN
        };
        let (off, on) = (onset(false), onset(true));
        assert!(
            (off - on).abs() < 0.02,
            "echo moved the delay time: {off:.4} s off vs {on:.4} s on"
        );
    }

    /// The pump has to still be there after a few bars.
    ///
    /// `trigger` used to fold `60 / bpm` into the previous recovery value, so the
    /// duck shortened geometrically and the breathing was gone within two bars while
    /// still passing any test that only asked whether the gain reached its floor.
    #[test]
    fn the_duck_recovery_does_not_shrink_across_hits() {
        let sr = 48_000.0;
        let bpm = 126.0;
        let mut d = Ducker::new(TrackKind::House, bpm, sr);
        let mut chans: [Channel; 8] = std::array::from_fn(|_| Channel::default());

        let mut lengths = Vec::new();
        for _ in 0..16 {
            d.trigger(bpm, sr);
            // Count the samples until the duck has recovered to unity.
            let mut n = 0usize;
            loop {
                d.apply(&mut chans, sr);
                n += 1;
                if !d.active || n > (sr as usize) {
                    break;
                }
            }
            lengths.push(n as f32 / sr);
        }

        let first = lengths[0];
        let expected = ((60.0 / bpm) * 0.55f32).min(0.48);
        assert!(
            (first - expected).abs() < 0.005,
            "first duck was {first:.4} s, expected {expected:.4} s"
        );
        for (i, l) in lengths.iter().enumerate() {
            assert!(
                (l - first).abs() < 0.005,
                "duck {i} lasted {l:.4} s against the first at {first:.4} s: {lengths:?}"
            );
        }
    }

    #[test]
    fn solo_isolates_the_soloed_stems() {
        let mut chans: [Channel; 8] = std::array::from_fn(|_| Channel::default());
        chans[0].solo = true;
        let any_solo = true;
        assert!(chans[0].gain(any_solo) > 0.0);
        for c in chans.iter().skip(1) {
            assert_eq!(c.gain(any_solo), 0.0);
        }
    }

    #[test]
    fn mute_zeroes_gain_even_when_soloed() {
        let c = Channel {
            muted: true,
            solo: true,
            ..Channel::default()
        };
        assert_eq!(c.gain(true), 0.0);
    }

    #[test]
    fn filter_position_is_exponential_and_clamped() {
        assert!((Master::filter_freq(0.0) - 240.0).abs() < 1.0);
        assert!(Master::filter_freq(1.0) > 17_000.0);
        assert_eq!(Master::filter_freq(2.0), Master::filter_freq(1.0));
        assert_eq!(Master::filter_freq(-1.0), Master::filter_freq(0.0));
    }

    #[test]
    fn echo_engages_and_disengages_the_send() {
        let sr = 48_000.0;
        let mut m = Master::new(sr);
        assert!(!m.echo_on());
        // A stem's own send is never scaled by the throw: the throw is a separate
        // input to the line, taken off the summed bus rather than off each stem.
        assert_eq!(m.send_gain(), 1.0, "stems send at unity regardless of echo");
        m.set_echo(true);
        assert!(m.echo_on());
        assert_eq!(m.send_gain(), 1.0, "echo does not rescale the stem sends");
        assert!(m.mix_wet() > m.mix_dry(), "echo pulls the mix wetter");
        m.set_echo(false);
        assert!(!m.echo_on());
        assert_eq!(m.send_gain(), 1.0);
        assert_eq!(m.mix_dry(), 1.0, "dry signal untouched with echo off");
    }

    #[test]
    fn the_room_still_rings_after_the_input_stops() {
        // The chain ends in a 0.32 s room. Tapping a short burst and then feeding
        // silence must produce a decaying tail, not a hard cut — this is the send
        // that makes the mix sound like a recording rather than a sum of oscillators.
        let sr = 48_000.0;
        let mut m = Master::new(sr);
        let hit = (sr * 0.05) as usize / 128;
        for i in 0..hit {
            let t = i as f32 * 128.0 / sr;
            m.process(0.5 * (t * 220.0 * std::f32::consts::TAU).sin(), 0.0);
        }

        let mut peaks = Vec::new();
        for _ in 0..12 {
            let (l, _) = m.process(0.0, 0.0);
            peaks.push(l.abs());
        }
        assert!(
            peaks[0] > 1e-4,
            "the room should still be sounding after the input stops: {peaks:?}"
        );
        assert!(peaks[11] < peaks[0], "the tail should decay: {peaks:?}");
    }

    #[test]
    fn echo_lengthens_the_delay_tail() {
        // Measured on the delay line itself rather than on the master output. The echo
        // configuration deliberately pulls the dry signal down to 0.55, so any
        // end-to-end comparison is dominated by that duck rather than by the repeats,
        // and the room on the master bus decays over a comparable time again. The line
        // is the thing the echo actually changes.
        let sr = 48_000.0;
        let tail = |echo: bool| -> f32 {
            let mut m = Master::new(sr);
            m.set_delay_time(150.0, 1.0);
            m.set_echo(echo);
            // Let the throw's gains glide in before anything is sent.
            for _ in 0..(sr as usize) / 10 {
                m.process(0.0, 0.0);
            }
            // A short tone burst, then silence. A tone rather than a constant: the
            // throw is high-passed at 240 Hz, so a constant only ever sent its onset.
            for i in 0..(sr as usize) / 8 {
                let v = 0.5 * (i as f32 / sr * 300.0 * core::f32::consts::TAU).sin();
                let (l, r) = m.process(v, 0.0);
                let _ = l + r;
            }
            let mut energy = 0.0;
            for _ in 0..(sr as usize) * 2 {
                let (l, _) = m.process(0.0, 0.0);
                let tap = m.delay.tap();
                energy += tap * tap + l * l * 0.01;
            }
            energy
        };

        let off = tail(false);
        let on = tail(true);
        assert!(off > 0.0, "the dry delay send should still ring a little");
        assert!(
            on > off * 5.0,
            "echo should sustain the line: off {off:.5} on {on:.5}"
        );
    }

    #[test]
    fn the_compressor_holds_the_sum_down() {
        // A loud, continuous low tone is the case the dynamics stage exists for. With
        // no compressor the sum reaches the clipper and the saturator distorts it; the
        // compressor's job is to pull it back first. Threshold is -12 dB at 2.6:1, so a
        // 0.8 tone should come out meaningfully lower than the same chain would pass
        // it uncompressed.
        //
        // The bound is relative to that uncompressed level rather than an absolute
        // number. It used to be `< 0.45`, which was calibrated on a detector whose
        // one-pole weights were swapped: it followed the waveform sample by sample and
        // squashed each peak like a waveshaper. With real 8 ms / 200 ms ballistics the
        // detector sits a little under the sine's crest, so the reduction is a few dB
        // rather than six, and it is gain riding rather than distortion.
        let sr = 48_000.0;
        let mut m = Master::new(sr);
        let uncompressed = m.gain.value() * soft_clip(0.8, 1.35);
        let mut peak = 0.0f32;
        for i in 0..(sr as usize) {
            let t = i as f32 / sr;
            let (l, _) = m.process(0.8 * (t * 220.0 * std::f32::consts::TAU).sin(), 0.0);
            if i > 4800 {
                // Past the 8 ms attack, so the measurement is of steady state.
                peak = peak.max(l.abs());
            }
        }
        // At least 2.5 dB of reduction, and no more than about 9 dB.
        assert!(
            peak < uncompressed * 0.75,
            "the sum is not being held down: {uncompressed:.3} uncompressed, {peak:.3} out"
        );
        assert!(
            peak > uncompressed * 0.35,
            "the compressor is over-reducing: {uncompressed:.3} uncompressed, {peak:.3} out"
        );
    }

    /// A hard-panned source has to stay on its own side through the whole chain.
    ///
    /// The saturator's 2x interpolation used one `shaper_prev` for both channels, so
    /// the right channel's midpoint was built from the current left sample and a
    /// hard-left source leaked audibly into the right.
    #[test]
    fn a_hard_left_source_stays_off_the_right_channel() {
        let sr = 48_000.0;
        let mut m = Master::new(sr);
        let mut left_peak = 0.0f32;
        let mut right_peak = 0.0f32;
        for i in 0..(sr as usize) {
            let t = i as f32 / sr;
            let (l, r) = m.process(0.7 * (t * 110.0 * std::f32::consts::TAU).sin(), 0.0);
            left_peak = left_peak.max(l.abs());
            right_peak = right_peak.max(r.abs());
        }
        assert!(
            left_peak > 0.1,
            "the left side should carry the tone: {left_peak}"
        );
        assert!(
            right_peak < 1e-6,
            "left leaked into the right channel at {right_peak}"
        );
    }

    /// The master's compressor has to release over the time it was configured with.
    ///
    /// Two faults hid this. The detector's one-pole had its weights swapped, so the
    /// envelope followed the signal sample by sample with no release at all; and the
    /// master ran one mono compressor left-then-right, stepping it twice per sample.
    /// After a drop the detector must close 63% of the gap in one release time
    /// constant, 0.2 s, not instantly and not in 0.1 s.
    #[test]
    fn the_compressor_releases_over_its_configured_time() {
        let sr = 48_000.0;
        let release = 0.2;
        let mut c = Compressor::new(sr, -12.0, 8.0, 2.6, 0.008, release);
        // Settle on a loud level, on the left only: the link has to see it anyway.
        for _ in 0..(sr as usize) {
            c.process_stereo(0.5, 0.0);
        }
        let loud = c.envelope_db();
        let quiet_db = 20.0 * 0.05f32.log10();
        let target = quiet_db + (loud - quiet_db) * (-1.0f32).exp();
        let mut crossed = None;
        for i in 0..(sr as usize) {
            c.process_stereo(0.0, 0.05);
            if crossed.is_none() && c.envelope_db() <= target {
                crossed = Some(i as f32 / sr);
            }
        }
        let t = crossed.expect("the detector never released");
        assert!(
            (t - release).abs() < release * 0.05,
            "released in {t:.4} s, configured {release} s"
        );
    }

    /// Linked: both channels take the same gain, whichever side is loud.
    #[test]
    fn the_compressor_applies_one_gain_to_both_channels() {
        let mut c = Compressor::new(48_000.0, -12.0, 8.0, 2.6, 0.008, 0.2);
        let mut last = (0.0, 0.0);
        for _ in 0..4_800 {
            last = c.process_stereo(0.9, 0.1);
        }
        let (gl, gr) = (last.0 / 0.9, last.1 / 0.1);
        assert!(gl < 0.8, "a 0.9 peak should be reduced, gain {gl}");
        assert!((gl - gr).abs() < 1e-6, "gains differ: {gl} vs {gr}");
    }

    /// Normal levels leave the limiter idle: unity gain the whole way through.
    #[test]
    fn the_limiter_is_idle_at_normal_levels() {
        let sr = 48_000.0;
        let mut m = Master::new(sr);
        for i in 0..(sr as usize) {
            let t = i as f32 / sr;
            let v = 0.25 * (t * 220.0 * std::f32::consts::TAU).sin();
            m.process(v, v);
            assert_eq!(m.limiter.gain(), 1.0, "limiter engaged at sample {i}");
        }
    }

    /// Mean |L| and |R| over a second of the same 220 Hz tone on both inputs, after a
    /// quarter second for the balance glide to arrive. A sine, not a constant: the
    /// chain opens with a 28 Hz highpass, which removes a steady level.
    fn balanced_levels(balance: Option<f32>) -> (f32, f32) {
        let sr = 48_000.0;
        let mut m = Master::new(sr);
        if let Some(b) = balance {
            m.set_balance(b);
        }
        let tone = |i: usize| 0.25 * (i as f32 / sr * 220.0 * std::f32::consts::TAU).sin();
        let warm = sr as usize / 4;
        for i in 0..warm {
            m.process(tone(i), tone(i));
        }
        let n = sr as usize;
        let (mut sl, mut sr_sum) = (0.0f32, 0.0f32);
        for i in warm..warm + n {
            let (l, r) = m.process(tone(i), tone(i));
            sl += l.abs();
            sr_sum += r.abs();
        }
        (sl / n as f32, sr_sum / n as f32)
    }

    /// Center is the untouched mix, sample for sample.
    #[test]
    fn balance_center_is_unity() {
        let sr = 48_000.0;
        let mut plain = Master::new(sr);
        let mut centered = Master::new(sr);
        centered.set_balance(0.5);
        for i in 0..(sr as usize) {
            let t = i as f32 / sr;
            let l = 0.3 * (t * 220.0 * std::f32::consts::TAU).sin();
            let r = 0.2 * (t * 330.0 * std::f32::consts::TAU).sin();
            assert_eq!(
                plain.process(l, r),
                centered.process(l, r),
                "center changed sample {i}"
            );
        }
    }

    /// The ends silence the opposite channel and leave the near one at full level.
    #[test]
    fn balance_ends_silence_the_opposite_side() {
        let (cl, cr) = balanced_levels(None);
        assert!(cl > 0.05 && cr > 0.05, "center too quiet: {cl} {cr}");

        let (l, r) = balanced_levels(Some(0.0));
        assert!(r < 1e-4, "hard left should silence the right, got {r}");
        assert!((l - cl).abs() < 1e-4, "left not at full level: {l} vs {cl}");

        let (l, r) = balanced_levels(Some(1.0));
        assert!(l < 1e-4, "hard right should silence the left, got {l}");
        assert!(
            (r - cr).abs() < 1e-4,
            "right not at full level: {r} vs {cr}"
        );
    }

    /// A quarter of the way from hard left, the right channel is at half (-6 dB).
    #[test]
    fn balance_quarter_halves_the_right() {
        let (l, r) = balanced_levels(Some(0.25));
        let ratio = r / l;
        assert!(
            (ratio - 0.5).abs() < 0.01,
            "right/left at 0.25 is {ratio}, want 0.5"
        );
    }

    #[test]
    fn scope_tracks_the_signal() {
        let sr = 48_000.0;
        let mut m = Master::new(sr);
        // A sine, not a constant: the chain opens with a 28 Hz highpass, which removes
        // a DC level almost entirely, so a steady input would correctly draw a flat
        // centre line.
        // The trace advances one pixel per frame at 60 Hz, so run long enough for
        // the whole 256-pixel window to be written before inspecting it.
        for i in 0..(sr as usize * 5) {
            let t = i as f32 / sr;
            let v = 0.8 * (t * 440.0 * std::f32::consts::TAU).sin();
            m.process(v, v);
        }
        // The trace samples one point per frame at 60 Hz, so it aliases any musical
        // pitch — a 440 Hz tone read at 60 Hz lands wherever the fold puts it. What the
        // trace has to do is move off the centre line when there is signal and come
        // back to it when there is not, which is what this checks.
        let off_centre = m.scope.iter().filter(|b| **b != 128).count();
        assert!(
            off_centre > m.scope.len() / 2,
            "trace did not follow the signal: only {off_centre} of {} pixels moved",
            m.scope.len()
        );

        // Silence should settle back to the centre line.
        m.reset();
        for _ in 0..(sr as usize * 5) {
            m.process(0.0, 0.0);
        }
        let off_centre = m.scope.iter().filter(|b| **b != 128).count();
        assert!(off_centre < m.scope.len() / 4, "trace should recentre");
    }

    // --- The controls exposed on Night 2: each one changes the sound it says. ---

    /// A tone at `freq`, `amp` peak, sample `i`.
    fn tone(i: usize, sr: f32, freq: f32, amp: f32) -> f32 {
        amp * (i as f32 / sr * freq * core::f32::consts::TAU).sin()
    }

    /// Run `m` for `n` samples of silence and return the energy of the output.
    fn tail_energy(m: &mut Master, n: usize) -> f32 {
        let mut e = 0.0;
        for _ in 0..n {
            let (l, r) = m.process(0.0, 0.0);
            e += l * l + r * r;
        }
        e
    }

    #[test]
    fn filter_resonance_lifts_the_cutoff() {
        // A lowpass biquad's gain at its own cutoff is its Q, so a tone sat on the
        // cutoff should come out louder with the resonance up.
        let sr = 48_000.0;
        let open = 0.45;
        let freq = Master::filter_freq(open);
        let peak_at = |q: f32| {
            let mut m = Master::new(sr);
            m.set_filter(open);
            m.set_filter_q(q);
            let mut peak = 0.0f32;
            for i in 0..(sr as usize) {
                let (l, _) = m.process(tone(i, sr, freq, 0.05), tone(i, sr, freq, 0.05));
                if i > sr as usize / 2 {
                    peak = peak.max(l.abs());
                }
            }
            peak
        };
        let flat = peak_at(FILTER_Q);
        let resonant = peak_at(FILTER_Q_MAX);
        assert!(
            resonant > flat * 3.0,
            "resonance should lift the cutoff: {flat:.4} -> {resonant:.4}"
        );
    }

    #[test]
    fn the_filter_q_blends_rather_than_jumps_at_the_top() {
        // Walking the position across the old 0.97 switch point in fine steps, the Q
        // must never move by more than a small amount between neighbours.
        let mut last = Master::sweep_q_at(0.85, FILTER_Q);
        let mut worst = 0.0f32;
        for i in 0..=1500 {
            let open = 0.85 + 0.15 * i as f32 / 1500.0;
            let q = Master::sweep_q_at(open, FILTER_Q);
            worst = worst.max((q - last).abs());
            last = q;
        }
        assert!(worst < 0.002, "Q stepped by {worst}");
        assert!(
            (Master::sweep_q_at(1.0, FILTER_Q_MAX) - 0.45).abs() < 1e-6,
            "fully open is transparent"
        );
        assert!(
            (Master::sweep_q_at(0.5, 2.0) - 2.0).abs() < 1e-6,
            "closed uses the set resonance"
        );
    }

    #[test]
    fn echo_feedback_lengthens_the_repeats_and_the_throw_gives_it_back() {
        let sr = 48_000.0;
        let line_tail = |fb: f32, throw: bool| {
            let mut m = Master::new(sr);
            m.set_delay_time(120.0, 1.0);
            m.set_echo_feedback(fb);
            if throw {
                m.set_echo(true);
                m.set_echo(false);
            }
            for _ in 0..(sr as usize) / 10 {
                m.process(0.0, 0.0);
            }
            for i in 0..(sr as usize) / 20 {
                let v = tone(i, sr, 400.0, 0.4);
                m.feed_send(v, v, 1.0);
                m.process(0.0, 0.0);
            }
            // The late tail only, from one second on: the first repeats are the same
            // at any feedback, and it is how long they keep going that feedback sets.
            let mut energy = 0.0;
            for i in 0..(sr as usize) * 3 {
                m.process(0.0, 0.0);
                if i >= sr as usize {
                    let tap = m.delay.tap();
                    energy += tap * tap;
                }
            }
            energy
        };
        let short = line_tail(0.1, false);
        let long = line_tail(0.85, false);
        assert!(
            long > short * 4.0,
            "more feedback should ring longer: {short:.4} vs {long:.4}"
        );
        let after_throw = line_tail(0.1, true);
        assert!(
            (after_throw - short).abs() < short * 0.2,
            "letting go of the throw restores the user's feedback: {short:.4} vs {after_throw:.4}"
        );
    }

    #[test]
    fn echo_return_at_zero_silences_the_repeats() {
        let sr = 48_000.0;
        let tail = |ret: f32| {
            let mut m = Master::new(sr);
            m.set_delay_time(120.0, 1.0);
            m.set_reverb_mix(0.0);
            m.set_echo_return(ret);
            for _ in 0..(sr as usize) / 10 {
                m.process(0.0, 0.0);
            }
            for i in 0..(sr as usize) / 20 {
                let v = tone(i, sr, 400.0, 0.4);
                m.feed_send(v, v, 1.0);
                m.process(v, v);
            }
            // Skip the dry burst's own last milliseconds through the chain.
            tail_energy(&mut m, sr as usize / 20);
            tail_energy(&mut m, sr as usize)
        };
        let default = tail(ECHO_RETURN);
        let none = tail(0.0);
        assert!(
            default > 1e-3,
            "the default echo should be heard, {default}"
        );
        assert!(
            none < default * 0.01,
            "return 0 should silence it: {none} vs {default}"
        );
    }

    #[test]
    fn room_decay_and_mix_change_the_room() {
        let sr = 48_000.0;
        // A burst into the room alone (no echo send), then what is left 0.3 s later.
        let tail = |mix: f32, decay: f32| {
            let mut m = Master::new(sr);
            m.set_echo_return(0.0);
            m.set_reverb_mix(mix);
            m.set_reverb_decay(decay);
            for _ in 0..(sr as usize) / 10 {
                m.process(0.0, 0.0);
            }
            for i in 0..(sr as usize) / 20 {
                let v = tone(i, sr, 700.0, 0.4);
                m.process(v, v);
            }
            tail_energy(&mut m, (sr * 0.3) as usize);
            tail_energy(&mut m, sr as usize)
        };
        let short = tail(VERB_WET, crate::dsp::ROOM_RT60);
        let long = tail(VERB_WET, 2.5);
        let dry = tail(0.0, 2.5);
        assert!(
            long > short * 50.0,
            "a longer decay should ring on: {short:.2e} vs {long:.2e}"
        );
        assert!(
            dry < long * 1e-3,
            "no room should leave no tail: {dry:.2e} vs {long:.2e}"
        );
    }

    #[test]
    fn width_folds_to_mono_and_widens() {
        let sr = 48_000.0;
        let spread = |width: f32| {
            let mut m = Master::new(sr);
            m.set_width(width);
            let mut total = 0.0f32;
            for i in 0..(sr as usize) {
                let (l, r) = m.process(tone(i, sr, 300.0, 0.2), tone(i, sr, 300.0, 0.05));
                if i > sr as usize / 4 {
                    total += (l - r).abs();
                }
            }
            total
        };
        let mono = spread(0.0);
        let normal = spread(1.0);
        let wide = spread(WIDTH_MAX);
        assert!(mono < normal * 1e-4, "width 0 is mono: {mono} vs {normal}");
        assert!(
            wide > normal * 1.3,
            "width 1.5 is wider: {wide} vs {normal}"
        );
    }
}
