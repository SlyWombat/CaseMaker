/**
 * The simulation session's phase, shared by the store, the run gate and the headless verify
 * pipeline. Lives in its own module (not `store/simStore.ts`) so the headless scripts' import graph
 * can name the type without reaching the browser-only sim store (#544, same class as #534).
 */
export type SimStatus = 'idle' | 'loading' | 'ready' | 'refused' | 'error';
