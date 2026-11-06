/**
 * The stem machine, laid out as one instrument.
 *
 * A persistent transport across the top; the library on the left; the decks, pads
 * and stems in the middle; an inspector on the right; and a pattern drawer opened on
 * purpose from the bottom. On phones the same panels are shown one view at a time:
 * Perform, Mix and Edit. The rules behind the layout are in
 * docs/DESIGN_PHILOSOPHY.md.
 *
 * Every piece of state and every message to the engine lives in `useInstrument`; this
 * file only decides where things go. React holds no audio state and no musical clock.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInstrument } from './lib/instrument';
import { param } from './lib/contract';
import { STEM_ORDER, soundingMap, stemState, stemStateLabel } from './lib/stems';
import type { StemId, TrackSummary } from './lib/types';
import { InstrumentPanel, PerformancePad, Segmented, cx } from './ui/controls';
import { DeckWave } from './ui/Deck';
import { Inspector, type InspectorTab } from './ui/Inspector';
import { JogWheel } from './ui/JogWheel';
import { LibraryPanel } from './ui/Library';
import { PatternDrawer } from './ui/PatternDrawer';
import { MixerChannel } from './ui/MixerChannel';
import { SceneStrip } from './ui/SceneStrip';
import { CompareBar } from './ui/CompareBar';
import { SCENE_SLOTS } from './lib/contract';
import { TransportBar } from './ui/Transport';

type View = 'perform' | 'mix' | 'edit';

/** Below this the library is an overlay opened from the transport. */
const LIBRARY_DOCKED = '(min-width: 1180px)';
/** Below this the app shows one view at a time. */
const PHONE = '(max-width: 899.98px)';

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const on = () => setMatches(list.matches);
    on();
    list.addEventListener('change', on);
    return () => list.removeEventListener('change', on);
  }, [query]);
  return matches;
}

const LOOP_OPTIONS = (param('performance.loopBars').options ?? [])
  .filter((o) => o.value !== 0)
  .map((o) => ({ value: o.value, label: o.label, aria: `Loop ${o.label} bar${o.value === 1 ? '' : 's'}` }));

import { useProjects } from './lib/projects';
import { ProjectMenu } from './ui/ProjectMenu';
import { resolvedArrangement } from './lib/patterns';

export function App() {
  const inst = useInstrument();
  const projects = useProjects(inst);
  const { library, track, vols, error } = inst;

  const libraryDocked = useMedia(LIBRARY_DOCKED);
  const phone = useMedia(PHONE);
  const [view, setView] = useState<View>('perform');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selected, setSelected] = useState<StemId>('kick');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('master');

  const songStep = inst.songStep;
  const bar = inst.bar;

  const soundingTrack = useMemo(() => track ? resolvedArrangement(track, inst.patterns.audible) : null, [track, inst.patterns.audible]);
  const sounding = useMemo(() => (soundingTrack ? soundingMap(soundingTrack) : null), [soundingTrack]);
  const soloedBy = STEM_ORDER.filter((id) => inst.solo[id]);
  const stateOf = (id: StemId) =>
    stemState(id, {
      muted: inst.muted,
      solo: inst.solo,
      playing: inst.playing,
      soundsThisBar: Boolean(sounding?.[bar]?.[id]),
    });

  /** Which stems are silent because of the user, for the live waveform. */
  const silenced = useMemo(() => {
    const anySolo = STEM_ORDER.some((id) => inst.solo[id]);
    return Object.fromEntries(
      STEM_ORDER.map((id) => [id, Boolean(inst.muted[id]) || (anySolo && !inst.solo[id])]),
    ) as Record<StemId, boolean>;
  }, [inst.muted, inst.solo]);

  const closeLibrary = useCallback(() => setLibraryOpen(false), []);
  const { selectTrack } = inst;
  const pickTrack = useCallback(
    (t: TrackSummary) => {
      selectTrack(t);
      if (!libraryDocked) setLibraryOpen(false);
    },
    [selectTrack, libraryDocked],
  );

  const selectStem = useCallback((id: StemId) => {
    setSelected(id);
    setInspectorTab('stem');
  }, []);

  function openPattern(id?: StemId) {
    if (id) setSelected(id);
    if (phone) setView('edit');
    else setDrawerOpen(true);
  }

  function changeView(next: View) {
    setView(next);
    // Edit is about one stem, so it opens on that stem; Mix opens on the master.
    if (next === 'edit') setInspectorTab('stem');
    if (next === 'mix') setInspectorTab('master');
  }

  // Space plays, 1–8 cut a stem, Shift+1–4 launch a scene, Escape closes whatever was
  // opened on purpose.
  // Ignored while a text field or a slider has focus, so their own keys still work.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (drawerOpen) {
          setDrawerOpen(false);
          return;
        }
        if (libraryOpen) {
          setLibraryOpen(false);
          document.querySelector<HTMLElement>('[aria-controls="library"]')?.focus();
        }
        return;
      }
      const focus = event.target as HTMLElement | null;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !focus?.closest('[data-editor]') && !/^(INPUT|TEXTAREA)$/.test(focus?.tagName ?? '')) {
        if (event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? inst.patterns.redo() : inst.patterns.undo(); return; }
        if (event.key.toLowerCase() === 's') { event.preventDefault(); void projects.save(event.shiftKey); return; }
      }
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      // Inside the pattern editor the digits are not stem cuts (they would cut a stem
      // while typing a value or nudging a note), and Space on a step is the step's.
      const inEditor = Boolean(target?.closest('[data-editor]'));
      if (event.code === 'Space') {
        // Space is play/stop wherever focus is, as it always has been, so clicking a
        // Cut badge and then pressing Space doesn't cut it again. The controls that use
        // Space themselves (the jog wheel's backspin, the hold-to-bend pads) opt out.
        if (target?.closest('[data-own-space]')) return;
        event.preventDefault();
        void inst.togglePlay();
        return;
      }
      // Shift+1–4 launch a scene. Checked by physical key, because Shift+1 types "!".
      const digit = /^Digit([1-4])$/.exec(event.code);
      if (event.shiftKey && digit) {
        const slot = SCENE_SLOTS[Number(digit[1]) - 1];
        if (slot) inst.launchScene(slot);
        return;
      }
      if (event.shiftKey || inEditor) return;
      const n = Number(event.key);
      if (n >= 1 && n <= 8) {
        const id = STEM_ORDER[n - 1];
        if (id) inst.toggleMute(id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // The overlay library closes itself when the screen gets wide enough to dock it.
  useEffect(() => {
    if (libraryDocked) setLibraryOpen(false);
  }, [libraryDocked]);

  if (error && (!library || !track || !vols)) {
    return (
      <main className="grid min-h-dvh place-items-center bg-bg p-6 text-fg">
        <div className="max-w-md text-center" role="alert">
          <h1 className="font-display text-2xl font-extrabold">bckgrnd-msc could not start</h1>
          <p className="mt-2 text-sm text-muted">{error}</p>
          <p className="mt-4 text-xs text-muted">
            The audio engine is a WebAssembly module; if this is a packaged build, check
            that <code>public/wasm</code> and <code>public/build</code> were copied in.
          </p>
        </div>
      </main>
    );
  }

  if (!library || !track || !vols) {
    return (
      <main className="grid min-h-dvh place-items-center bg-bg text-fg">
        <p className="text-sm text-muted" role="status">
          Loading the library…
        </p>
      </main>
    );
  }

  const deckStatus = (side: 'a' | 'b') =>
    inst.liveDeck === side ? (inst.playing ? 'Live' : 'Cue') : 'Idle';
  const metaFor = (id: StemId) => library.stems.find((s) => s.id === id);

  return (
    <div
      className="app"
      data-view={view}
      data-playing={inst.playing ? 'yes' : 'no'}
      data-library={libraryDocked ? 'docked' : libraryOpen ? 'open' : 'closed'}
    >
      {error && <div className="audio-error" role="alert"><span>{error}</span><button onClick={() => void inst.togglePlay()}>Resume Audio</button></div>}
      <TransportBar
        track={track}
        playing={inst.playing}
        bar={bar}
        bpm={inst.bpm}
        edited={inst.edited}
        projects={<ProjectMenu projects={projects} />}
        mixing={inst.mixing}
        liveDeck={inst.liveDeck}
        onTogglePlay={() => void inst.togglePlay()}
        libraryToggle={
          libraryDocked
            ? undefined
            : {
                open: libraryOpen,
                onToggle: () => setLibraryOpen((o) => !o),
              }
        }
      />

      <div className="workspace">
        {!libraryDocked && libraryOpen ? (
          <button
            type="button"
            className="scrim"
            aria-label="Close the library"
            tabIndex={-1}
            onClick={() => setLibraryOpen(false)}
          />
        ) : null}
        <aside
          id="library"
          className="library-panel"
          aria-label="Library"
        >
          <LibraryPanel
            tracks={inst.tracks}
            current={track.id}
            overlay={!libraryDocked}
            onClose={closeLibrary}
            onPick={pickTrack}
          />
        </aside>

        <main className="perform-area" aria-label="Performance">
          <InstrumentPanel title="Decks" views={['perform']} hideTitle>
            <div className="decks">
              {(['a', 'b'] as const).map((side) => (
                <DeckWave
                  key={side}
                  side={side}
                  track={inst.liveDeck === side ? soundingTrack : inst.cued}
                  step={inst.liveDeck === side ? songStep : -1}
                  status={deckStatus(side)}
                  silenced={inst.liveDeck === side ? silenced : undefined}
                  bpm={inst.bpm}
                  mixing={inst.mixing !== null}
                />
              ))}
            </div>
          </InstrumentPanel>

          <InstrumentPanel
            title="Stems"
            views={['perform', 'mix']}
            className="stems-panel"
          >
            <div className="stems-toolbar" title="Sound selection applies immediately; scenes use the timing selector.">
              <Segmented
                label="Stem selection · applies immediately"
                hideLabel
                value={inst.mask}
                onPick={(m) => m !== 'custom' && inst.applyMask(m)}
                options={[
                  { value: 'full', label: 'All sounds' },
                  { value: 'nomusic', label: 'Drums only' },
                  { value: 'nodrums', label: 'Music only' },
                ]}
              />
              <button
                type="button"
                className="text-button"
                aria-expanded={drawerOpen}
                aria-controls="pattern-drawer"
                onClick={() => (drawerOpen ? setDrawerOpen(false) : openPattern())}
              >
                {drawerOpen ? 'Close patterns' : 'Edit patterns'}
              </button>
            </div>
            <dl className="stems-guide" id="stems-guide">
              <div><dt>Level</dt><dd>Volume</dd></div>
              <div><dt>Solo</dt><dd>Hear alone</dd></div>
              <div><dt>Cut</dt><dd>Mute</dd></div>
            </dl>
            <div className="stems mixer-bank" role="group" aria-label="Mixer" aria-describedby="stems-guide">
              {library.stems.map((meta, index) => {
                const state = stateOf(meta.id);
                return (
                  <MixerChannel
                    key={meta.id}
                    meta={meta}
                    index={index}
                    state={state}
                    stateLabel={stemStateLabel(state, soloedBy)}
                    volume={vols[meta.id]}
                    home={track.mix[meta.id]}
                    muted={inst.muted[meta.id]}
                    soloed={inst.solo[meta.id]}
                    selected={selected === meta.id && inspectorTab === 'stem'}
                    onVolume={inst.setStemVolume}
                    onCut={inst.toggleMute}
                    onSolo={inst.toggleSolo}
                    onSelect={selectStem}
                  />
                );
              })}
            </div>
            <div className="stems-footer">
              <p>Select a name for details. <span className="stems-shortcuts">Keys <kbd>1–8</kbd> toggle sounds.</span></p>
            </div>
          </InstrumentPanel>

          {inst.scenes ? (
            <InstrumentPanel title="Scenes & comparison" views={['perform', 'mix']} className="scenes-panel">
              <SceneStrip
                scenes={inst.scenes.slots}
                track={track}
                active={inst.activeScene}
                modified={inst.sceneModified}
                request={inst.sceneRequest}
                timing={inst.sceneTiming}
                unavailable={inst.mixing ? 'Available after mix' : inst.sceneRestoring ? 'Restoring previous mix' : null}
                status={inst.sceneStatus}
                onTiming={inst.setSceneTiming}
                onLaunch={inst.launchScene}
                onCancel={inst.cancelScene}
                onCapture={inst.captureSceneSlot}
                onRename={inst.renameSceneSlot}
                onDuplicate={inst.duplicateSceneSlot}
                onReset={inst.resetSceneSlot}
                {...(inst.hasFill
                  ? {
                      fill: inst.fill.status,
                      fillBar: inst.fill.bar,
                      fillName: inst.fillName,
                      fillUnavailable: inst.mixing ? 'Available after mix' : !inst.playing ? 'Press play first: a fill needs playback' : null,
                      onFill: inst.toggleFill,
                    }
                  : {})}
              >
                <CompareBar
                  compare={inst.compare}
                  modified={inst.compareModified}
                  request={inst.sceneRequest}
                  disabled={inst.mixing ? 'Available after mix' : inst.sceneRestoring ? 'Restoring previous mix' : null}
                  onCapture={inst.captureCompare}
                  onListen={inst.listenCompare}
                  onUpdate={inst.updateCompare}
                  onKeep={inst.keepCompare}
                  onExit={inst.exitCompare}
                />
              </SceneStrip>
            </InstrumentPanel>
          ) : null}

          <InstrumentPanel title="Deck" views={['perform']} className="deck-panel">
            <div className="deck-row">
              <JogWheel spinning={inst.playing} />
              <div className="deck-pads">
                <PerformancePad label="Cue" ariaLabel="Cue to the start" onPress={inst.cue} />
                <PerformancePad label="Brake" ariaLabel="Vinyl brake" onPress={inst.brake} />
                <PerformancePad
                  label="Echo"
                  hint="hold"
                  ariaLabel="Echo throw, while held"
                  latched={inst.echo}
                  onHoldStart={() => inst.holdEffect('echo')}
                  onHoldEnd={() => inst.releaseEffect('echo')}
                />
                <PerformancePad
                  label="Filter"
                  hint="hold"
                  ariaLabel="Filter hold, while held"
                  latched={inst.filterHeld}
                  onHoldStart={() => inst.holdEffect('filter')}
                  onHoldEnd={() => inst.releaseEffect('filter')}
                />
                <PerformancePad
                  label="Bend +"
                  hint="hold"
                  ariaLabel="Nudge tempo up"
                  onHoldStart={() => inst.nudge(1)}
                  onHoldEnd={() => inst.nudge(0)}
                />
                <PerformancePad
                  label="Bend −"
                  hint="hold"
                  ariaLabel="Nudge tempo down"
                  onHoldStart={() => inst.nudge(-1)}
                  onHoldEnd={() => inst.nudge(0)}
                />
                <PerformancePad label="Backspin" ariaLabel="Backspin the platter" onPress={inst.backspin} />
              </div>
            </div>
            {/* Three different exits, kept apart: Cancel scene (in the scene strip)
                restores the previous mix, Release FX lets go of held effects, Panic
                stops everything and clears the tails. */}
            <div className="deck-safety">
              <button
                type="button"
                className="text-button"
                disabled={!inst.echo && !inst.filterHeld}
                onClick={inst.releaseAllEffects}
              >
                Release FX
              </button>
              <button type="button" className="panic-button" onClick={inst.panic}>
                Panic
              </button>
            </div>
            <Segmented<number>
              label={inst.loopBars ? `Loop · ${inst.loopBars} bar${inst.loopBars === 1 ? '' : 's'}` : 'Loop · off'}
              value={inst.loopBars}
              onPick={inst.pickLoop}
              options={LOOP_OPTIONS}
            />
          </InstrumentPanel>

          <InstrumentPanel title="Mix to the next track" views={['perform']} className="next-panel">
            <div className="next-row">
              <label className="next-select">
                <span className="control-label">Next</span>
                <select
                  className="next-song"
                  aria-label="Next song"
                  value={inst.nextId}
                  disabled={Boolean(inst.mixing)}
                  onChange={(event) => inst.setNextId(event.target.value)}
                >
                  {inst.tracks
                    .filter((item) => item.id !== track.id)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {item.bpm} bpm
                      </option>
                    ))}
                </select>
              </label>
              <button
                type="button"
                aria-pressed={Boolean(inst.mixing)}
                className="mix-action tap"
                onClick={inst.autoMix}
              >
                <span className="block">{inst.mixing ? 'Mixing' : 'Auto mix'}</span>
                <span className="mix-action-note">{inst.mixing ?? 'track'}</span>
              </button>
              {(
                [
                  ['swap', 'Continuous mix', 'stem swap'],
                  ['plain', 'Continuous mix', 'song after song'],
                ] as const
              ).map(([mode, label, note]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={inst.continuous === mode}
                  className="mix-action tap"
                  // Picking one turns the other off; pressing the lit one stops.
                  onClick={() => inst.setContinuous((now) => (now === mode ? 'off' : mode))}
                >
                  <span className="block">{label}</span>
                  <span className="mix-action-note">{note}</span>
                </button>
              ))}
            </div>
          </InstrumentPanel>

        </main>

        <aside className="inspector panel" aria-label="Inspector" data-views="mix edit">
          <Inspector
            tab={inspectorTab}
            onTab={setInspectorTab}
            stem={selected}
            stemMeta={metaFor(selected)}
            stemState={stateOf(selected)}
            stemStateLabel={stemStateLabel(stateOf(selected), soloedBy)}
            inst={inst}
            onShowPattern={() => openPattern(selected)}
          />
        </aside>
      </div>

      <PatternDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        inst={inst}
        stem={selected}
        onStem={setSelected}
        phone={phone}
      />

      {phone ? (
        <nav className="view-tabs" aria-label="Views">
          {(
            [
              ['perform', 'Perform'],
              ['mix', 'Mix'],
              ['edit', 'Edit'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={cx('view-tab tap')}
              aria-pressed={view === id}
              onClick={() => changeView(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
