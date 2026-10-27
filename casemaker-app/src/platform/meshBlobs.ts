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
