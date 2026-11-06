import type { ProjectRecord, ProjectStore } from './project-store';
import type { Snapshot } from './snapshot';

export const isDesktop = () => !!document.querySelector('meta[name="bckgrnd-native-token"]');
export async function nativeAction<T = { cancelled?: boolean; path?: string; document?: unknown }>(action: string, body: unknown = {}): Promise<T> {
  const token = document.querySelector<HTMLMetaElement>('meta[name="bckgrnd-native-token"]')?.content;
  if (!token) throw new Error('Native file actions are available in the installed desktop app.');
  const binary = body instanceof ArrayBuffer;
  const response = await fetch(`/api/native/projects/${action}`, { method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': binary ? 'application/octet-stream' : 'application/json', 'X-Bckgrnd-Token': token },
    body: binary ? body : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? `Native action failed (${response.status}).`);
  return result as T;
}
export class NativeProjectStore implements ProjectStore {
  list() { return nativeAction<ProjectRecord[]>('list'); }
  async write(snapshot: Snapshot, expectedRevision: number) { await nativeAction('write', { snapshot, expectedRevision }); }
  async recover(snapshot: Snapshot) { await nativeAction('recover', { snapshot }); }
  async remove(id: string) { await nativeAction('remove', { id }); }
}
declare global {
  interface Window {
    BckgrndDesktop?: { onClose(fn: () => void): () => void; confirmClose(): void; onMenu(fn: (action: string) => void): () => void };
  }
}
