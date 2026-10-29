/**
 * #720 — the bytes of an imported goal/reference mesh live BESIDE the job, not inside it.
 *
 * The open job persists to localStorage, whose quota is ~5 MB. A real 3D model is often bigger
 * than that before base64 (a 12 MB 3MF becomes ~16 MB encoded), so a mesh cannot ride in the
 * persisted copy. It goes here instead: IndexedDB, keyed by the mesh's SHA-256 — its identity in
 * the document — the same way #680 keeps recent jobs' snapshot text out of localStorage.
 *
 * WHAT CARRIES WHAT. The persisted job keeps the hash, the size and the name; the open job in
 * memory keeps the bytes too, for the viewport, the CAM and the worker; the .cutjob FILE embeds
 * them, so a saved document is still self-contained and opens on another machine. On reload the
 * store asks this module for the hash and puts the bytes back; a miss is a sentence, not a
 * silent empty goal ("… is not here any more — Import it again").
 *
 * IndexedDB is not available in every context (jsdom, a build with it disabled): every call
 * rejects rather than throws synchronously, and the caller treats a rejection as a miss. Specs
 * replace the store with an in-memory map through {@link setMeshBlobIO}.
 */

const DB_NAME = 'casemaker-meshes';
const STORE = 'meshes';

export interface MeshBlobIO {
  put: (sha256: string, data: string) => Promise<void>;
  get: (sha256: string) => Promise<string | null>;
  /** #728 — every hash held; optional so a spec's double need not keep one. */
  keys?: () => Promise<string[]>;
  delete?: (sha256: string) => Promise<void>;
}

let io: MeshBlobIO | null = null;

/** Test seam: replace the blob store (the app never calls this). `null` restores IndexedDB. */
export function setMeshBlobIO(next: MeshBlobIO | null): void {
  io = next;
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this build'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('the mesh store could not be opened'));
  });
}

/** Store a mesh's base64 bytes under its hash; writing the same hash twice is harmless. */
export async function putMeshBlob(sha256: string, data: string): Promise<void> {
  touchMesh(sha256);
  if (io !== null) return io.put(sha256, data);
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(data, sha256);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('the mesh could not be stored'));
      tx.onabort = () => reject(tx.error ?? new Error('the mesh could not be stored'));
    });
  } finally {
    db.close();
  }
}

/** The base64 bytes stored under a hash, or null when this browser does not hold them. */
export async function getMeshBlob(sha256: string): Promise<string | null> {
  touchMesh(sha256);
  if (io !== null) return io.get(sha256);
  const db = await openDatabase();
  try {
    return await new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(sha256);
      request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null);
      request.onerror = () => reject(request.error ?? new Error('the mesh could not be read'));
    });
  } finally {
    db.close();
  }
}

/**
 * #728 — when each stored mesh was last written or read here, by hash, in localStorage (a few
 * dozen bytes a mesh). The sweep never deletes a mesh touched within {@link MESH_KEEP_MS}: another
 * tab can hold a job this tab cannot see (its bytes in memory, its hash about to be persisted
 * again), and a fresh write from it must not be swept under it.
 */
export const MESH_TOUCHED_KEY = 'casemaker.meshes.touched.v1';
/** A mesh no job refers to is kept this long after it was last touched: 30 days. */
export const MESH_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

function readTouched(): Record<string, number> | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(MESH_TOUCHED_KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, number>) : {};
  } catch {
    return null;
  }
}

function writeTouched(touched: Record<string, number>): void {
  try {
    localStorage.setItem(MESH_TOUCHED_KEY, JSON.stringify(touched));
  } catch {
    // A full or private store: the sweep then keeps what it cannot date.
  }
}

function touchMesh(sha256: string, now = Date.now()): void {
  const touched = readTouched();
  if (touched === null) return;
  touched[sha256] = now;
  writeTouched(touched);
}

/**
 * #728 — delete every stored mesh whose hash `keep` refuses and that has not been touched for
 * {@link MESH_KEEP_MS}; returns how many went. Nothing deleted a mesh before, so a browser kept
 * every model ever imported. The caller decides what is still referred to (the open job, the
 * recent jobs) — asked per key at delete time, so a mesh imported while the sweep was gathering
 * is not lost. A mesh with no touch on record (stored before this, or by a tab whose record was
 * lost) starts its clock now; without localStorage nothing can be dated and nothing goes; a store
 * that cannot list its keys sweeps nothing.
 */
export async function sweepMeshBlobs(keep: (sha256: string) => boolean, now = Date.now()): Promise<number> {
  const touched = readTouched();
  if (touched === null) return 0;
  const expired = (k: string): boolean => {
    const at = touched[k];
    if (typeof at !== 'number') {
      touched[k] = now;
      return false;
    }
    return now - at > MESH_KEEP_MS;
  };
  const sweepable = (k: string): boolean => !keep(k) && expired(k);
  const forget = (gone: readonly string[]): void => {
    // Re-read: another tab may have touched a mesh meanwhile; only the swept hashes leave.
    const latest = readTouched() ?? {};
    for (const [k, at] of Object.entries(touched)) if (latest[k] === undefined) latest[k] = at;
    for (const k of gone) delete latest[k];
    writeTouched(latest);
  };
  if (io !== null) {
    if (io.keys === undefined || io.delete === undefined) return 0;
    const gone = (await io.keys()).filter(sweepable);
    for (const k of gone) await io.delete(k);
    forget(gone);
    return gone.length;
  }
  const db = await openDatabase();
  try {
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const gone: string[] = [];
      const request = store.getAllKeys();
      request.onsuccess = () => {
        for (const key of request.result) {
          if (typeof key === 'string' && sweepable(key)) {
            store.delete(key);
            gone.push(key);
          }
        }
      };
      tx.oncomplete = () => {
        forget(gone);
        resolve(gone.length);
      };
      tx.onerror = () => reject(tx.error ?? new Error('the mesh store could not be swept'));
      tx.onabort = () => reject(tx.error ?? new Error('the mesh store could not be swept'));
    });
  } finally {
    db.close();
  }
}
