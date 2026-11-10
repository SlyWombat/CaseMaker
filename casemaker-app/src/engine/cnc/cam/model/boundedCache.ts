/**
 * #1147 — A FIFO-BOUNDED MEMO, for values whose KEY IS THE DATA (a plan's IRs).
 *
 * `planModelCam` stamps a goal-grid field per unique chain-step IR (5.51 MiB each on the tray's
 * goal) and folds those fields for the picker, the rank's measurement, the rest's region and the
 * plan outcome. A plain WeakMap kept every field for the plan's life (≈1.6 GiB on set B's top);
 * caching nothing re-stamped shared IRs on every fold (1202 s of chain against 834). This keeps
 * reuse and puts a hard ceiling on retention: at most `capacity` entries, the oldest evicted
 * first. An evicted field is simply re-stamped the next time it is asked for — correctness never
 * depends on a hit, only speed does.
 *
 * Insertion order is the eviction order (FIFO, not LRU): a hit does not refresh an entry. That is
 * deliberate — the access pattern is a per-candidate sweep, and a FIFO's behaviour is the one a
 * reader can predict from the trace without an LRU's recency bookkeeping.
 */
export class BoundedCache<K extends object, V> {
  private readonly map = new Map<K, V>();
  private readonly order: K[] = [];
  private readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`BoundedCache capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    if (!this.map.has(key)) this.order.push(key);
    this.map.set(key, value);
    while (this.order.length > this.capacity) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  /** Entries currently held — never more than `capacity`. */
  get size(): number {
    return this.map.size;
  }

  /** The ceiling this cache was built with. */
  get limit(): number {
    return this.capacity;
  }
}
