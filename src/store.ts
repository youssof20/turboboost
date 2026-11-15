// Everything persistent lives on the phone: localStorage for settings and profiles, IndexedDB for user samples.
// All access is wrapped so a blocked or empty store never breaks the app.

import { BASE_PROFILE, BUILTIN_PROFILES, validateProfile, type Profile } from './model/profiles.ts';
import type { Mode } from './audio/dsp.ts';

const P = 'tb.';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(P + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(P + key, JSON.stringify(value));
  } catch {
    /* private mode / quota: keep running without persistence */
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(P + key);
  } catch {
    /* ignore */
  }
}

export interface Settings {
  activeProfile: string;
  master: number;
  mode: Mode;
  headphone: boolean;
  /** true = hear it from inside the cabin, false = engine bay */
  cabin: boolean;
  dim: boolean;
  adapterId: string | null;
  adapterName: string | null;
  checked: boolean;
  latencyHint: 'interactive' | 'zero';
  /** adapter id -> profile id (a different car auto-selects its own profile) */
  adapterProfiles: Record<string, string>;
}

const DEFAULT_SETTINGS: Settings = {
  activeProfile: BASE_PROFILE.id,
  master: 0.6,
  mode: 'full',
  headphone: false,
  cabin: true,
  dim: false,
  adapterId: null,
  adapterName: null,
  checked: false,
  latencyHint: 'interactive',
  adapterProfiles: {},
};

export function loadSettings(): Settings {
  const s = { ...DEFAULT_SETTINGS, ...read<Partial<Settings>>('settings', {}) };
  if (!['mute', 'sport', 'full'].includes(s.mode)) s.mode = 'full';
  s.master = Math.min(1, Math.max(0, Number.isFinite(s.master) ? s.master : 0.6));
  return s;
}

export function saveSettings(s: Settings): void {
  write('settings', s);
}

// ---- profiles -------------------------------------------------------------------------------

export interface ProfileSet {
  profiles: Profile[];
  /** validation problems per profile id, shown to the user instead of crashing */
  errors: Record<string, string[]>;
}

export function loadProfiles(): ProfileSet {
  const errors: Record<string, string[]> = {};
  const profiles: Profile[] = [];
  for (const b of BUILTIN_PROFILES) {
    const saved = read<unknown>('profile.' + b.id, null);
    if (saved === null) {
      profiles.push(structuredClone(b));
      continue;
    }
    const r = validateProfile(saved, b);
    r.profile.id = b.id; // a builtin keeps its id
    if (r.errors.length) errors[b.id] = r.errors;
    profiles.push(r.profile);
  }
  for (const id of read<string[]>('customIds', [])) {
    const saved = read<unknown>('profile.' + id, null);
    if (saved === null) continue;
    const r = validateProfile(saved, BASE_PROFILE);
    r.profile.id = id;
    if (r.errors.length) errors[id] = r.errors;
    profiles.push(r.profile);
  }
  return { profiles, errors };
}

export function saveProfile(p: Profile): void {
  write('profile.' + p.id, p);
}

export function resetProfile(id: string): Profile | null {
  remove('profile.' + id);
  const b = BUILTIN_PROFILES.find((x) => x.id === id);
  return b ? structuredClone(b) : null;
}

export function isBuiltin(id: string): boolean {
  return BUILTIN_PROFILES.some((p) => p.id === id);
}

/** Import JSON text as a new custom profile. Returns the profile and any validation problems. */
export function importProfile(text: string): { profile: Profile; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { profile: structuredClone(BASE_PROFILE), errors: ['file is not valid JSON'] };
  }
  const r = validateProfile(raw, BASE_PROFILE);
  const ids = new Set([...BUILTIN_PROFILES.map((p) => p.id), ...read<string[]>('customIds', [])]);
  let id = r.profile.id && !ids.has(r.profile.id) ? r.profile.id : 'custom-' + Math.random().toString(36).slice(2, 7);
  if (ids.has(id)) id = 'custom-' + Math.random().toString(36).slice(2, 7);
  r.profile.id = id;
  write('customIds', [...read<string[]>('customIds', []), id]);
  saveProfile(r.profile);
  return r;
}

export function duplicateProfile(p: Profile): Profile {
  const copy = structuredClone(p);
  copy.id = 'custom-' + Math.random().toString(36).slice(2, 7);
  copy.name = p.name + ' copy';
  write('customIds', [...read<string[]>('customIds', []), copy.id]);
  saveProfile(copy);
  return copy;
}

export function deleteCustomProfile(id: string): void {
  if (isBuiltin(id)) return;
  write('customIds', read<string[]>('customIds', []).filter((x) => x !== id));
  remove('profile.' + id);
}

// ---- user samples (IndexedDB) ---------------------------------------------------------------

export interface UserSample {
  id?: number;
  kind: 'bov' | 'pop';
  name: string;
  data: ArrayBuffer;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no IndexedDB'));
    const req = indexedDB.open('turboboost', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('samples', { keyPath: 'id', autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listUserSamples(): Promise<UserSample[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const r = db.transaction('samples').objectStore('samples').getAll();
      r.onsuccess = () => resolve(r.result as UserSample[]);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return [];
  }
}

export async function addUserSample(s: UserSample): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('samples', 'readwrite');
      tx.objectStore('samples').add(s);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* persistence is best-effort */
  }
}

export async function clearUserSamples(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('samples', 'readwrite');
      tx.objectStore('samples').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}
