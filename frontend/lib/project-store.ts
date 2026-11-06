import type { Snapshot } from './snapshot';

export type ProjectRecord = { current?: Snapshot; previous?: Snapshot; recovery?: Snapshot };
export interface ProjectStore {
  list(): Promise<ProjectRecord[]>;
  write(snapshot: Snapshot, expectedRevision: number): Promise<void>;
  recover(snapshot: Snapshot): Promise<void>;
  remove(id: string): Promise<void>;
}

/** One IndexedDB transaction commits the new revision and retains the old one.
 * CAS prevents another tab or a late asynchronous save overwriting newer work. */
export class BrowserProjectStore implements ProjectStore {
  private async db(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('bckgrnd-projects', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('projects');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('Close the other app tab to upgrade project storage.'));
    });
  }
  async list(): Promise<ProjectRecord[]> {
    const db = await this.db();
    try {
      return await new Promise((resolve, reject) => {
        const r = db.transaction('projects').objectStore('projects').getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    } finally { db.close(); }
  }
  private async update(id: string, fn: (record: ProjectRecord) => ProjectRecord | undefined): Promise<void> {
    const db = await this.db();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('projects', 'readwrite');
        const store = tx.objectStore('projects');
        const request = store.get(id);
        let failure: unknown;
        request.onsuccess = () => {
          try {
            const record = fn(request.result ?? {});
            if (record) store.put(record, id); else store.delete(id);
          } catch (e) { failure = e; tx.abort(); }
        };
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('Project write failed; the previous revision is intact.'));
      });
    } finally { db.close(); }
  }
  write(snapshot: Snapshot, expectedRevision: number): Promise<void> {
    const copy = structuredClone(snapshot);
    return this.update(copy.id, (record) => {
      if ((record.current?.revision ?? 0) !== expectedRevision) throw new Error('This project changed in another window. Save As to preserve both versions.');
      if (copy.revision < expectedRevision) throw new Error('Refusing an obsolete project revision.');
      return { previous: record.current ?? record.previous, current: copy,
        ...(record.recovery && record.recovery.revision > copy.revision ? { recovery: record.recovery } : {}) };
    });
  }
  recover(snapshot: Snapshot): Promise<void> {
    const copy = structuredClone(snapshot);
    return this.update(copy.id, (record) => {
      if ((record.current?.revision ?? 0) >= copy.revision || (record.recovery?.revision ?? 0) > copy.revision) return record;
      return { ...record, recovery: copy };
    });
  }
  remove(id: string): Promise<void> { return this.update(id, () => undefined); }
}
