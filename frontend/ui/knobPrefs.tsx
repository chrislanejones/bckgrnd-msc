/**
 * How knobs follow a drag: up and down (the default), or round the dial.
 *
 * A per-viewer preference, kept in localStorage and never part of a project.
 */

import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

export type KnobDrag = 'vertical' | 'circular';

const KEY = 'bckgrnd-msc:knob-drag';

function read(): KnobDrag {
  try {
    return window.localStorage.getItem(KEY) === 'circular' ? 'circular' : 'vertical';
  } catch {
    return 'vertical';
  }
}

const Context = createContext<{ mode: KnobDrag; setMode: (mode: KnobDrag) => void }>({
  mode: 'vertical',
  setMode: () => {},
});

export function KnobPrefsProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<KnobDrag>(read);
  useEffect(() => {
    try {
      window.localStorage.setItem(KEY, mode);
    } catch {
      /* storage unavailable: the choice lasts for this visit */
    }
  }, [mode]);
  return <Context.Provider value={{ mode, setMode }}>{children}</Context.Provider>;
}

export function useKnobDrag(): KnobDrag {
  return useContext(Context).mode;
}

export function useKnobDragSetting() {
  return useContext(Context);
}
