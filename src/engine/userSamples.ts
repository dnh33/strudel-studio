// User sample library, stored in IndexedDB so imported audio files survive reloads.

export interface UserSample {
  name: string; // sound name used in code, e.g. "my_vox"
  files: { fileName: string; type: string; data: ArrayBuffer }[];
  addedAt: number;
}

const DB = 'strudel-studio';
const STORE = 'samples';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'name' });
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const urlCache = new Map<string, string[]>();

export function sampleUrls(s: UserSample): string[] {
  const key = s.name + ':' + s.addedAt;
  let urls = urlCache.get(key);
  if (!urls) {
    urls = s.files.map((f) => URL.createObjectURL(new Blob([f.data], { type: f.type || 'audio/wav' })));
    urlCache.set(key, urls);
  }
  return urls;
}

export async function loadUserSamples(register: (name: string, urls: string[]) => void): Promise<UserSample[]> {
  const all = (await tx<UserSample[]>(STORE, 'readonly', (s) => s.getAll() as IDBRequest<UserSample[]>)) ?? [];
  for (const s of all) register(s.name, sampleUrls(s));
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

export function sanitizeSampleName(n: string) {
  return (
    n
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^(\d)/, 'u$1') || 'sample'
  );
}

export async function saveUserSample(s: UserSample) {
  await tx(STORE, 'readwrite', (st) => st.put(s));
}

export async function deleteUserSample(name: string) {
  await tx(STORE, 'readwrite', (st) => st.delete(name));
}

// ---- local project library (browser storage) ----
export interface StoredProject {
  id: string;
  name: string;
  updatedAt: number;
  json: string;
}
export async function listStoredProjects(): Promise<StoredProject[]> {
  const all = (await tx<StoredProject[]>('projects', 'readonly', (s) => s.getAll() as IDBRequest<StoredProject[]>)) ?? [];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function putStoredProject(p: StoredProject) {
  await tx('projects', 'readwrite', (s) => s.put(p));
}
export async function deleteStoredProject(id: string) {
  await tx('projects', 'readwrite', (s) => s.delete(id));
}
