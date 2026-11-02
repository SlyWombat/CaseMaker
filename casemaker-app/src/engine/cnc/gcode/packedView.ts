/**
 * #899 — A READ-ONLY ARRAY VIEW OVER PACKED STORAGE.
 *
 * The simulation used to hold one JS object per G-code line (the parser's events, the timeline's
 * checkpoint moves), about 1.1 KB a line all told. The stores behind them now keep typed arrays,
 * and this view hands the old `T[]` interface back: an element is an ordinary object made on read,
 * so every consumer — the verifier, the restart planner, the sweeps, every spec — reads the list
 * exactly as it always has. Nothing writes through it.
 *
 * The target is a real (empty) array, so `Array.isArray` holds and every `Array.prototype` method
 * runs generically through `length` and the index reads. A packed store is found again from its
 * view with {@link packedSource}, which the hot paths use to read the arrays directly instead of
 * making an object per element.
 *
 * Elements are made on read, so two reads of one index are equal but not the same object. A small
 * cache keeps the last few reads, which is what a loop that reads `list[k].field` several times in
 * a row needs; the cached object must not be mutated (nothing does: the lists were never written
 * after they were built).
 */

const SOURCE = Symbol('cm.packedSource');

export interface PackedSource<T> {
  readonly length: number;
  at(i: number): T;
}

/** The packed store behind a {@link packedView}, or null for an ordinary array. */
export function packedSource<S>(list: readonly unknown[]): S | null {
  return ((list as unknown as Record<symbol, unknown>)[SOURCE] as S | undefined) ?? null;
}

function indexOf(key: string | symbol): number {
  if (typeof key !== 'string') return -1;
  const c = key.charCodeAt(0);
  if (c < 48 || c > 57) return -1;
  const i = Number(key);
  return Number.isInteger(i) && String(i) === key ? i : -1;
}

/** How many recent reads the view keeps. */
const CACHE = 4;

export function packedView<T>(source: PackedSource<T>): T[] {
  const keys: number[] = [];
  const vals: T[] = [];
  let next = 0;
  const read = (i: number): T | undefined => {
    if (i >= source.length) return undefined;
    for (let k = 0; k < keys.length; k++) if (keys[k] === i) return vals[k];
    const v = source.at(i);
    keys[next] = i;
    vals[next] = v;
    next = (next + 1) % CACHE;
    return v;
  };
  const iterate = function* (): IterableIterator<T> {
    const n = source.length;
    for (let i = 0; i < n; i++) yield source.at(i);
  };
  const readOnly = (): never => {
    throw new TypeError('a packed list is read-only');
  };
  return new Proxy([] as T[], {
    get(target, key, receiver) {
      if (key === 'length') return source.length;
      if (key === SOURCE) return source;
      if (key === Symbol.iterator) return iterate;
      const i = indexOf(key);
      if (i >= 0) return read(i);
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      const i = indexOf(key);
      if (i >= 0) return i < source.length;
      return key === SOURCE || Reflect.has(target, key);
    },
    ownKeys() {
      const out: (string | symbol)[] = [];
      for (let i = 0; i < source.length; i++) out.push(String(i));
      out.push('length');
      return out;
    },
    getOwnPropertyDescriptor(target, key) {
      if (key === 'length') return { value: source.length, writable: true, enumerable: false, configurable: false };
      const i = indexOf(key);
      if (i >= 0 && i < source.length) return { value: read(i), writable: false, enumerable: true, configurable: true };
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    set: readOnly,
    defineProperty: readOnly,
    deleteProperty: readOnly,
  });
}

/** Grow a typed array to at least `min` elements, keeping the first `n`. */
export function grown<A extends Float64Array | Int32Array | Uint32Array | Uint16Array | Uint8Array>(a: A, n: number, min: number): A {
  if (min <= a.length) return a;
  let cap = Math.max(16, a.length);
  while (cap < min) cap *= 2;
  const out = new (a.constructor as new (n: number) => A)(cap);
  out.set(a.subarray(0, n));
  return out;
}

/** The first `n` elements, in an array of exactly that length (drops the growth slack). */
export function trimmed<A extends Float64Array | Int32Array | Uint32Array | Uint16Array | Uint8Array>(a: A, n: number): A {
  return a.length === n ? a : (a.slice(0, n) as A);
}
