/** The setups engine (#428 phase 1): plan, check, remount, re-register. Pure. */
export * from './types';
export * from './orient';
export * from './checks';
export * from './plan';
export * from './remount';
export * from './registration';
export * from './settings';
/** #471 — the job document's cuts as the planner's removals. */
export * from './fromJob';
/** #471 — the saved setups read against the document: staleness, invalidation, add-setup offer. */
export * from './authoring';
