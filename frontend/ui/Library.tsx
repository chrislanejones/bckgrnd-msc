/**
 * The library panel: tracks by section and style, a favorites filter, and saved
 * projects.
 *
 * Favorites are a per-browser convenience, kept in localStorage and never part of a
 * project. Saved projects are listed here once saving exists; until then the panel
 * says plainly that changes last until a reload, rather than showing an empty list
 * that looks broken.
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { Star, X } from 'lucide-react';
import type { TrackSummary } from '../lib/types';
import { Segmented, cx } from './controls';

const FAVORITES_KEY = 'bckgrnd-msc:favorites';

function readFavorites(): Set<string> {
  try {
    const raw = window.localStorage.getItem(FAVORITES_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeFavorites(ids: Set<string>) {
  try {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify([...ids]));
  } catch {
    /* storage unavailable (private window, blocked): favorites last for this visit */
  }
}

type Filter = 'all' | 'favorites';

export const LibraryPanel = memo(function LibraryPanel({
  tracks,
  current,
  onPick,
  overlay,
  onClose,
}: {
  tracks: TrackSummary[];
  current: string;
  onPick: (track: TrackSummary) => void;
  /** Shown over the workspace (narrow screens) rather than beside it. */
  overlay: boolean;
  onClose: () => void;
}) {
  const [favorites, setFavorites] = useState<Set<string>>(readFavorites);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => writeFavorites(favorites), [favorites]);

  const toggleFavorite = (id: string) =>
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const shown = filter === 'favorites' ? tracks.filter((t) => favorites.has(t.id)) : tracks;

  /** Sections, in library order, each split into its styles. */
  const sections = useMemo(() => {
    const out: { name: string; styles: { name: string; items: TrackSummary[] }[] }[] = [];
    for (const t of shown) {
      let section = out[out.length - 1];
      if (!section || section.name !== t.section) {
        section = { name: t.section, styles: [] };
        out.push(section);
      }
      let style = section.styles[section.styles.length - 1];
      if (!style || style.name !== t.style) {
        style = { name: t.style, items: [] };
        section.styles.push(style);
      }
      style.items.push(t);
    }
    return out;
  }, [shown]);

  return (
    <div className="library">
      <div className="library-head">
        <h2 className="panel-title">Library</h2>
        {overlay ? (
          <button type="button" className="icon-button" aria-label="Close the library" onClick={onClose}>
            <X className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>

      <Segmented<Filter>
        label="Show"
        hideLabel
        value={filter}
        onPick={setFilter}
        options={[
          { value: 'all', label: 'All tracks' },
          { value: 'favorites', label: `Favorites${favorites.size ? ` · ${favorites.size}` : ''}` },
        ]}
      />

      {sections.length === 0 ? (
        <p className="empty-note">No favorites yet. Star a track to keep it here.</p>
      ) : null}

      {sections.map((section) => (
        <section key={section.name} className="lib-section" aria-label={section.name}>
          <h3 className="lib-section-title">
            <span>{section.name}</span>
          </h3>
          <div className="lib-section-body">
            {section.styles.map((style) => (
              <div key={style.name} className="lib-style">
                {style.name ? <p className="track-style">{style.name}</p> : null}
                <ul className="track-list">
                  {style.items.map((item) => (
                    <li key={item.id} className="track-row">
                      <button
                        type="button"
                        aria-pressed={item.id === current}
                        aria-label={`${item.name}, ${item.style ? `${item.style}, ` : ''}${item.bpm} bpm`}
                        className="track-badge tap"
                        onClick={() => onPick(item)}
                      >
                        <span className="truncate">{item.name}</span>
                        <span className="track-bpm">{item.bpm}</span>
                      </button>
                      <button
                        type="button"
                        className={cx('fav', favorites.has(item.id) && 'is-on')}
                        aria-pressed={favorites.has(item.id)}
                        aria-label={`Favorite ${item.name}`}
                        onClick={() => toggleFavorite(item.id)}
                      >
                        <Star className="size-3.5" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}

      <section className="lib-projects" aria-labelledby="lib-projects">
        <h3 id="lib-projects" className="control-label">
          Saved projects
        </h3>
        <p className="empty-note">
          Open Projects from the save status above to save, reopen or recover your work.
        </p>
      </section>
    </div>
  );
});
