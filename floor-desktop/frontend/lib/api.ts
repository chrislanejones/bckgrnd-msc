/**
 * The Laravel API, as the app uses it.
 *
 * Every request is same-origin and the app runs inside the NativePHP shell, so the
 * base URL is always the page's own origin — there is no configurable host to get
 * wrong between the dev server and a packaged build.
 */

import type {
  LibraryResponse,
  Preset,
  PresetDraft,
  StemId,
  TrackArrangement,
  TrackResponse,
} from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    // Laravel returns `{message, errors}`; surface the first field error if there
    // is one, since "validation failed" alone tells the user nothing actionable.
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as {
        message?: string;
        errors?: Record<string, string[]>;
      };
      const firstError = Object.values(body.errors ?? {}).flat()[0];
      detail = firstError ?? body.message ?? detail;
    } catch {
      // A non-JSON error body (a proxy page, say) leaves the status line.
    }
    throw new Error(detail);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * Deployment shape, decided at build time.
 *
 * The app ships two ways:
 *
 *  - **Desktop / self-hosted** (default): Laravel serves `/api/tracks`, computing the
 *    library and song form live so presets can be written to disk.
 *  - **Static** (`VITE_STATIC=1`, set by `pnpm run build:static`): the frontend sits on
 *    any CDN with no PHP in the request path and reads `public/library/*.json`,
 *    exported from the same PHP source at build time.
 *
 * Baking the choice into the bundle rather than probing for it matters: a runtime probe
 * would fire an `/api/tracks` request that 404s on every page load of a static
 * deployment. `withFallback` still falls back if the mode is somehow wrong, so a
 * mis-built bundle degrades to working rather than broken.
 */
const STATIC = import.meta.env.VITE_STATIC === '1';

export function usingStaticLibrary(): boolean {
  return STATIC;
}

/** Try the API unless this is a static build, then the exported JSON. */
async function withFallback<T>(
  apiPath: string,
  staticPath: string,
  parse: (raw: unknown) => T,
): Promise<T> {
  if (STATIC) {
    return parse(await request<unknown>(staticPath));
  }
  try {
    return await request<T>(apiPath);
  } catch (apiError) {
    try {
      return parse(await request<unknown>(staticPath));
    } catch {
      // Report the API failure: it is the more informative of the two, since a missing
      // static export is usually just a forgotten `pnpm run build:static`.
      throw apiError;
    }
  }
}

/** The library index: stem metadata and every track summary. */
export function fetchLibrary(): Promise<LibraryResponse> {
  return withFallback<LibraryResponse>(
    '/api/tracks',
    '/library/index.json',
    (raw) => raw as LibraryResponse,
  );
}

/** One arranged track, ready for the engine. */
export function fetchTrack(id: string): Promise<TrackResponse> {
  return withFallback<TrackResponse>(
    `/api/tracks/${id}`,
    `/library/${id}.json`,
    (raw) => raw as TrackResponse,
  );
}

export function listPresets(): Promise<{ presets: Preset[] }> {
  return request<{ presets: Preset[] }>('/api/presets');
}

export function savePreset(draft: PresetDraft): Promise<Preset> {
  return request<Preset>('/api/presets', {
    method: 'POST',
    body: JSON.stringify(draft),
  });
}

export function deletePreset(id: string): Promise<void> {
  return request<void>(`/api/presets/${id}`, { method: 'DELETE' });
}

/** Every stem cut at once, as a starting point for the fader readouts. */
export function emptyFlags(): Record<StemId, boolean> {
  return {
    kick: false,
    clap: false,
    hats: false,
    bass: false,
    stab: false,
    lead: false,
    pad: false,
    arp: false,
  };
}

/** Per-stem activity for one bar, derived from the arranged lanes. */
export function barActivity(track: TrackArrangement, stem: StemId, bar: number): boolean[] {
  const on = Array.from({ length: 16 }, () => false);
  const start = bar * 16;
  for (let i = 0; i < 16; i += 1) {
    const at = start + i;
    switch (stem) {
      case 'kick':
        on[i] = (track.kick[at] ?? 0) > 0;
        break;
      case 'clap':
        on[i] = (track.clap[at] ?? 0) > 0;
        break;
      case 'hats':
        on[i] = (track.hat[at] ?? 0) > 0 || (track.hatOpen[at] ?? 0) > 0;
        break;
      default:
        on[i] = track[stem][at] != null;
        break;
    }
  }
  return on;
}