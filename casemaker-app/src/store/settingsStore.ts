import { create } from 'zustand';
import { todayISODate } from '@/engine/cnc/fixture';
import { parseMachineCalibration, type MachineCalibration } from '@/engine/cnc/calibration';
import { MARGIN_DEFAULTS, type MarginSettings } from '@/engine/cnc/engrave/depthBounds';
import type { Sacrificial, SacrificialSide, SacrificialUnder, ViseParams } from '@/types/engraveJob';

export type ExportLayoutMode = 'print-ready' | 'assembled';
export type ExportFormat = 'stl-binary' | 'stl-ascii' | '3mf';

/**
 * Saved fixture measurements (#203, #213, decision 28). A saved envelope is used until the
 * setup changes; `source` and `uncertainty` travel with it so a default is never mistaken for
 * a measurement. An absent `vise` means "use the shipped default"; an absent `sacrificial`
 * means "no sacrificial material".
 */
export interface FixturesSettings {
  vise?: ViseParams;
  sacrificial?: Sacrificial;
}

/**
 * One remembered tool pick (#316): a header signature — `headerSignature`'s own string — mapped to
 * the registry key the person chose for it. See `AppSettings.toolPicks`.
 */
export type ToolPicks = Record<string, string>;

/**
 * The app's own webview-local settings.
 *
 * `port` and `bindToAll` used to live here and never did anything (#372): the port the app binds is
 * read from `config.json` by `lib.rs`, so a value in this store was a control that looked like it
 * changed the app and could not — and after #312 that invited the user to answer a port-busy refusal
 * with it. The server settings now live where the app actually reads them, `config.rs`'s file,
 * reached through `platform/houseClient`'s two config calls, and nothing about the host process is
 * persisted in an origin-keyed store any more. What is left here is the user's preferences.
 */
export interface AppSettings {
  exportLayout: ExportLayoutMode;
  exportFormat: ExportFormat;
  fixtures: FixturesSettings;
  /**
   * The house's depth thresholds (#345): the two Z-error margins every job copies, and the four
   * numbers that SEED a new job's own `minFloor`/`edgeMargin`/`breakthrough`/`jawClearance`.
   *
   * A house default is not a recommendation (decision 28): `source` says whether this is the
   * shipped set or the user's own, and a job's own `margins` always wins over it.
   */
  margins: MarginSettings;
  /**
   * The cutter each header signature was settled on BY HAND, when a `.nc`'s TOOL record matched rows
   * in two tiers and neither was entitled to win (#316). Keyed by `headerSignature` — the file's own
   * identity in the match order — so the choice follows the PROGRAM and not the file name, and
   * remembered so the question is asked once per program rather than on every open.
   *
   * This is a convenience and not a fact about the house, which is why it lives here rather than in
   * the registry: it is persisted (a reload must not re-ask) but it never travels in
   * `casemaker-my-machine.json` (that file describes a MACHINE, and a pick names a cutter id).
   */
  toolPicks: ToolPicks;
  /**
   * The machine's own coordinate frame, read from it (#279). Decision 28's saved tier, for a
   * MACHINE rather than a fixture: absent means the shipped profile's vendor defaults are in
   * force, present means these numbers win. `MACHINES` is never mutated — the resolution happens
   * per call, in `resolveMachine`.
   */
  machineCalibration?: MachineCalibration;
}

const SETTINGS_KEY = 'casemaker.settings.v1';
const DEFAULT_EXPORT_LAYOUT: ExportLayoutMode = 'print-ready';
// Issue #75 — fresh users get a human-readable text STL out of the gate.
// Existing localStorage prefs override this default; they're respected
// in loadSettings() below.
const DEFAULT_EXPORT_FORMAT: ExportFormat = 'stl-ascii';

const DEFAULTS: AppSettings = {
  exportLayout: DEFAULT_EXPORT_LAYOUT,
  exportFormat: DEFAULT_EXPORT_FORMAT,
  fixtures: {},
  margins: { ...MARGIN_DEFAULTS },
  toolPicks: {},
};

const VALID_FORMATS: ReadonlySet<ExportFormat> = new Set(['stl-binary', 'stl-ascii', '3mf']);
const VALID_VISE_SOURCES: ReadonlySet<ViseParams['source']> = new Set(['default', 'saved', 'measured']);
const VALID_SAC_SOURCES: ReadonlySet<Sacrificial['source']> = new Set(['default', 'saved', 'measured']);

/**
 * The saved fixture slice, validated on load. A payload that does not describe a whole vise —
 * or a whole sacrificial setup — is dropped rather than half-honoured: a partial obstacle
 * envelope is more dangerous than none.
 */
function parseFixtures(raw: unknown): FixturesSettings {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: FixturesSettings = {};
  const vise = parseVise(r.vise);
  if (vise) out.vise = vise;
  const sacrificial = parseSacrificial(r.sacrificial);
  if (sacrificial) out.sacrificial = sacrificial;
  return out;
}

function parseVise(raw: unknown): ViseParams | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const source = o.source;
  if (typeof source !== 'string' || !VALID_VISE_SOURCES.has(source as ViseParams['source'])) {
    return undefined;
  }
  const nums = ['stockProud', 'fixedJawThickness', 'movingJawThickness', 'jawLength', 'jawStartY', 'uncertainty'] as const;
  for (const key of nums) {
    if (typeof o[key] !== 'number' || !Number.isFinite(o[key])) return undefined;
  }
  const measuredAt = o.measuredAt;
  if (measuredAt !== undefined && typeof measuredAt !== 'string') return undefined;
  return {
    stockProud: o.stockProud as number,
    fixedJawThickness: o.fixedJawThickness as number,
    movingJawThickness: o.movingJawThickness as number,
    jawLength: o.jawLength as number,
    jawStartY: o.jawStartY as number,
    source: source as ViseParams['source'],
    uncertainty: o.uncertainty as number,
    ...(measuredAt !== undefined ? { measuredAt } : {}),
  };
}

/** A finite number meeting the positivity rule, or undefined. */
function numOr(v: unknown, positive: boolean): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && (positive ? v > 0 : v >= 0) ? v : undefined;
}

/**
 * Validate one side strip (#213). `undefined` = the payload is not a strip (drop the whole
 * setup); `null` = a legal "no strip here".
 */
function parseSide(raw: unknown): SacrificialSide | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const thickness = numOr(o.thickness, true);
  if (thickness === undefined) return undefined;
  const height = o.height;
  if (height === 'flush') return { thickness, height };
  const h = numOr(height, true);
  return h === undefined ? undefined : { thickness, height: h };
}

/**
 * Validate a saved sacrificial setup (#213). Dropped whole when anything is off, matching the
 * vise rule: a partial obstacle model is more dangerous than none. An absent payload (the
 * common case) is "no sacrificial material", not an error.
 */
function parseSacrificial(raw: unknown): Sacrificial | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const source = o.source;
  if (typeof source !== 'string' || !VALID_SAC_SOURCES.has(source as Sacrificial['source'])) {
    return undefined;
  }

  let under: SacrificialUnder | null = null;
  if (o.under !== null && o.under !== undefined) {
    if (typeof o.under !== 'object') return undefined;
    const u = o.under as Record<string, unknown>;
    if (typeof u.overhang !== 'object' || u.overhang === null) return undefined;
    const ov = u.overhang as Record<string, unknown>;
    const thickness = numOr(u.thickness, true);
    const left = numOr(ov.left, false);
    const right = numOr(ov.right, false);
    const front = numOr(ov.front, false);
    const back = numOr(ov.back, false);
    const attach = u.attach;
    if (
      thickness === undefined ||
      left === undefined ||
      right === undefined ||
      front === undefined ||
      back === undefined ||
      (attach !== 'tape' && attach !== 'glue' && attach !== 'screws' && attach !== 'loose')
    ) {
      return undefined;
    }
    under = { thickness, overhang: { left, right, front, back }, attach };
  }

  if (typeof o.sides !== 'object' || o.sides === null) return undefined;
  const sr = o.sides as Record<string, unknown>;
  const sides: Sacrificial['sides'] = { left: null, right: null, front: null, back: null };
  for (const pos of ['left', 'right', 'front', 'back'] as const) {
    const side = parseSide(sr[pos]);
    if (side === undefined) return undefined;
    sides[pos] = side;
  }

  return { under, sides, source: source as Sacrificial['source'] };
}

/**
 * Validate a fixtures record for the "my machine" import (#247). Stricter than `parseFixtures`:
 * a section that is PRESENT but malformed refuses the WHOLE record with a reason, instead of
 * dropping just that section. Decision 28's whole-or-nothing rule, applied to a shared file —
 * a half-applied machine profile is worse than none. An absent section stays legal.
 */
export type FixturesParseResult =
  | { ok: true; fixtures: FixturesSettings }
  | { ok: false; reason: string };

export function parseFixturesStrict(raw: unknown): FixturesParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'the fixtures record is not an object' };
  }
  const r = raw as Record<string, unknown>;
  const out: FixturesSettings = {};
  if (r.vise !== undefined && r.vise !== null) {
    const vise = parseVise(r.vise);
    if (!vise) return { ok: false, reason: 'the saved vise is incomplete or malformed' };
    out.vise = vise;
  }
  if (r.sacrificial !== undefined && r.sacrificial !== null) {
    const sacrificial = parseSacrificial(r.sacrificial);
    if (!sacrificial) return { ok: false, reason: 'the saved sacrificial setup is incomplete or malformed' };
    out.sacrificial = sacrificial;
  }
  return { ok: true, fixtures: out };
}

const VALID_MARGIN_SOURCES: ReadonlySet<MarginSettings['source']> = new Set(['default', 'user']);

/**
 * The house's depth thresholds (#345), validated on load. Whole-or-nothing, like the vise: a
 * partially-read margin set would apply the user's `boundaryMargin` with the shipped `minFloor`,
 * which is a threshold nobody chose. Absent — every install that predates this — is the shipped
 * set, so behaviour is exactly what it was.
 *
 * Exported for its spec: the fallback is the whole reason it exists, and nothing else in the app may
 * call it — the store reads it once, at load.
 */
export function parseMargins(raw: unknown): MarginSettings {
  if (typeof raw !== 'object' || raw === null) return { ...MARGIN_DEFAULTS };
  const o = raw as Record<string, unknown>;
  const source = o.source;
  if (typeof source !== 'string' || !VALID_MARGIN_SOURCES.has(source as MarginSettings['source'])) {
    return { ...MARGIN_DEFAULTS };
  }
  const keys = ['boundaryMargin', 'zTolerance', 'minFloor', 'edgeMargin', 'breakthrough'] as const;
  for (const key of keys) {
    if (typeof o[key] !== 'number' || !Number.isFinite(o[key]) || (o[key] as number) < 0) {
      return { ...MARGIN_DEFAULTS };
    }
  }
  // #362's jaw clearance, and the ONE place in here that reads a missing key as a version
  // difference rather than a fault. A record written before this field existed has five honest
  // thresholds in it and no `jawClearance`; failing the whole set closed over the key it could not
  // have carried would throw away the user's numbers to defend a default. So: absent → the shipped
  // default, which is the same 1 mm the check used before the setting existed; present and
  // malformed → the set is refused, the way every other key is.
  const rawClearance = o.jawClearance;
  if (
    rawClearance !== undefined &&
    (typeof rawClearance !== 'number' || !Number.isFinite(rawClearance) || rawClearance < 0)
  ) {
    return { ...MARGIN_DEFAULTS };
  }
  return {
    boundaryMargin: o.boundaryMargin as number,
    zTolerance: o.zTolerance as number,
    minFloor: o.minFloor as number,
    edgeMargin: o.edgeMargin as number,
    breakthrough: o.breakthrough as number,
    jawClearance: (rawClearance as number | undefined) ?? MARGIN_DEFAULTS.jawClearance,
    source: source as MarginSettings['source'],
  };
}

/**
 * Validate a margins record for the "my machine" import (#247). Stricter than `parseMargins`: a
 * section that is PRESENT but malformed refuses the whole record with a reason rather than quietly
 * falling back to the shipped numbers — a half-applied threshold set is worse than none.
 */
export function parseMarginsStrict(raw: unknown): { ok: true; margins: MarginSettings } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'the margins record is not an object' };
  }
  const o = raw as Record<string, unknown>;
  const source = o.source;
  if (typeof source !== 'string' || !VALID_MARGIN_SOURCES.has(source as MarginSettings['source'])) {
    return { ok: false, reason: 'the margins record does not say where its numbers came from' };
  }
  const keys = ['boundaryMargin', 'zTolerance', 'minFloor', 'edgeMargin', 'breakthrough'] as const;
  for (const key of keys) {
    if (typeof o[key] !== 'number' || !Number.isFinite(o[key]) || (o[key] as number) < 0) {
      return { ok: false, reason: `the margins record's ${key} is missing or not a number` };
    }
  }
  // #362's jaw clearance. An ABSENT key is the same version difference `parseMargins` reads it as —
  // a "my machine" file written before this field existed is not malformed, and refusing it would
  // lock a user out of importing their own machine over a default — so it takes the shipped value.
  // A key that IS there and is not a number is exactly what this path exists to refuse.
  const rawClearance = o.jawClearance;
  if (
    rawClearance !== undefined &&
    (typeof rawClearance !== 'number' || !Number.isFinite(rawClearance) || rawClearance < 0)
  ) {
    return { ok: false, reason: "the margins record's jawClearance is not a number" };
  }
  return {
    ok: true,
    margins: {
      boundaryMargin: o.boundaryMargin as number,
      zTolerance: o.zTolerance as number,
      minFloor: o.minFloor as number,
      edgeMargin: o.edgeMargin as number,
      breakthrough: o.breakthrough as number,
      jawClearance: (rawClearance as number | undefined) ?? MARGIN_DEFAULTS.jawClearance,
      source: source as MarginSettings['source'],
    },
  };
}

/** The three shapes `headerSignature` can return, in its own order (`key=` › `id=` › `shape=`). */
const SIGNATURE_PREFIXES = ['key=', 'id=', 'shape='] as const;

/**
 * The remembered tool picks (#316), validated per ENTRY rather than whole-or-nothing.
 *
 * The difference is deliberate, and it is the one place this file's usual rule does not apply.
 * Whole-or-nothing guards a record where a half-applied value is DANGEROUS — an obstacle envelope,
 * a threshold set — and a pick is not one: the read side applies a remembered key only after
 * showing it is still among the rows that actually match that signature, so a bad entry can only
 * ever be a pick that does not come back. Refusing the whole map over one junk entry would throw
 * away every other pick the user had made to defend a convenience.
 *
 * A signature must carry one of the three prefixes `headerSignature` writes. That is not
 * decoration: it is what stops a hand-edited or foreign payload from landing a key like
 * `__proto__` in here, since the alternative to an allow-list would be writing a candidate object
 * key straight into a plain object.
 */
export function parseToolPicks(raw: unknown): ToolPicks {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: ToolPicks = {};
  for (const [signature, key] of Object.entries(raw as Record<string, unknown>)) {
    const prefix = SIGNATURE_PREFIXES.find((p) => signature.startsWith(p));
    if (prefix === undefined || signature.length === prefix.length) continue;
    if (typeof key !== 'string' || key.length === 0) continue;
    out[signature] = key;
  }
  return out;
}

function loadSettings(): AppSettings {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return { ...DEFAULTS, margins: { ...MARGIN_DEFAULTS } };
  }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS, margins: { ...MARGIN_DEFAULTS } };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    // A record written before #372 still carries `port` and `bindToAll`; they are simply not read,
    // which is the whole of that change from this side — `config.json` has been the only thing the
    // app binds from all along.
    return {
      exportLayout:
        parsed.exportLayout === 'assembled' || parsed.exportLayout === 'print-ready'
          ? parsed.exportLayout
          : DEFAULT_EXPORT_LAYOUT,
      exportFormat:
        typeof parsed.exportFormat === 'string' && VALID_FORMATS.has(parsed.exportFormat as ExportFormat)
          ? (parsed.exportFormat as ExportFormat)
          : DEFAULT_EXPORT_FORMAT,
      fixtures: parseFixtures(parsed.fixtures),
      margins: parseMargins(parsed.margins),
      toolPicks: parseToolPicks(parsed.toolPicks),
      ...pickCalibration(parsed.machineCalibration),
    };
  } catch {
    return { ...DEFAULTS, margins: { ...MARGIN_DEFAULTS } };
  }
}

/**
 * The saved machine calibration, or nothing (#279). A malformed record is DROPPED rather than
 * half-honoured — the same whole-or-nothing rule `parseVise` follows, and for a sharper reason:
 * a frame with one vendor value left in it would be a machine of its own, and every position
 * derived from it would be quietly wrong. Dropping it falls back to the shipped profile, which
 * is what ran before any of this existed, and `machineCalibrationNotice` then says so out loud.
 */
function pickCalibration(raw: unknown): { machineCalibration?: MachineCalibration } {
  if (raw === undefined || raw === null) return {};
  const parsed = parseMachineCalibration(raw);
  return parsed.ok ? { machineCalibration: parsed.calibration } : {};
}

function persist(s: AppSettings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // ignore quota errors
  }
}

export interface SettingsState extends AppSettings {
  setExportLayout: (mode: ExportLayoutMode) => void;
  setExportFormat: (fmt: ExportFormat) => void;
  /** Save a vise measurement ("Save as my vise", #205), persisted with the rest of settings. */
  setVise: (vise: ViseParams) => void;
  /** Forget the saved vise and fall back to the shipped default. */
  clearVise: () => void;
  /** Save a sacrificial setup ("Save as my setup", #213), persisted with the rest of settings. */
  setSacrificial: (sacrificial: Sacrificial) => void;
  /** Forget the saved sacrificial setup; a new job then starts with none. */
  clearSacrificial: () => void;
  /**
   * Save the house's depth thresholds (#345). The caller has already built the record; this
   * persists it verbatim, `source` and all, so the app can still tell a threshold the user chose
   * from the shipped set.
   */
  setMargins: (margins: MarginSettings) => void;
  /** Put the shipped thresholds back. */
  clearMargins: () => void;
  /**
   * Remember which cutter a header signature was settled on (#316) — written when the person picks
   * between two rows that both matched, so the same program does not ask again. Persisted: a reload
   * is not an answer, and re-asking after one would be the prompt the decision exists to avoid.
   */
  setToolPick: (signature: string, key: string) => void;
  /**
   * Replace the whole saved-fixture slice in one step (#247) — what a validated "my machine"
   * import does. The caller has already validated the record; this persists it verbatim.
   */
  replaceFixtures: (fixtures: FixturesSettings) => void;
  /** Save the machine's own coordinate frame, read from it (#279). Persisted with the rest. */
  setMachineCalibration: (calibration: MachineCalibration) => void;
  /** Forget it and go back to the profile's vendor defaults. */
  clearMachineCalibration: () => void;
  resetSettings: () => void;
}

export const useSettingsStore = create<SettingsState>()((set, get) => {
  const initial = loadSettings();
  return {
    ...initial,
    setExportLayout: (mode) => {
      set({ exportLayout: mode });
      persist({ ...get(), exportLayout: mode });
    },
    setExportFormat: (fmt) => {
      set({ exportFormat: fmt });
      persist({ ...get(), exportFormat: fmt });
    },
    // "Save as my vise" (#203): a non-default value records the day it was saved, unless the
    // caller already stamped one. A persisted `default` is not a measurement and carries no date.
    setVise: (vise) => {
      const stamped: ViseParams =
        vise.source !== 'default' && !vise.measuredAt
          ? { ...vise, measuredAt: todayISODate() }
          : vise;
      const fixtures = { ...get().fixtures, vise: stamped };
      set({ fixtures });
      persist({ ...get(), fixtures });
    },
    clearVise: () => {
      const fixtures = { ...get().fixtures };
      delete fixtures.vise;
      set({ fixtures });
      persist({ ...get(), fixtures });
    },
    // "Save as my setup" (#213): remembered verbatim, provenance and all, so a saved setup
    // still says whether it was measured or only asserted.
    setSacrificial: (sacrificial) => {
      const fixtures = { ...get().fixtures, sacrificial };
      set({ fixtures });
      persist({ ...get(), fixtures });
    },
    clearSacrificial: () => {
      const fixtures = { ...get().fixtures };
      delete fixtures.sacrificial;
      set({ fixtures });
      persist({ ...get(), fixtures });
    },
    replaceFixtures: (fixtures) => {
      set({ fixtures });
      persist({ ...get(), fixtures });
    },
    // The house thresholds (#345) are remembered verbatim, `source` and all: a set the user chose
    // has to keep saying so, or the app would seed new jobs from a number nobody picked.
    setMargins: (margins) => {
      set({ margins });
      persist({ ...get(), margins });
    },
    clearMargins: () => {
      const margins = { ...MARGIN_DEFAULTS };
      set({ margins });
      persist({ ...get(), margins });
    },
    // The remembered pick (#316). Written through from the sim setup when the person chooses, and
    // read back there: this store owns the map, and knows nothing about which keys still exist —
    // that check belongs to the reader, which is the only place the fresh candidate list is in hand.
    setToolPick: (signature, key) => {
      const toolPicks = { ...get().toolPicks, [signature]: key };
      set({ toolPicks });
      persist({ ...get(), toolPicks });
    },
    // Saved verbatim, provenance and all (#279): the record has to keep saying WHICH machine and
    // WHEN, or a year-old read becomes an assertion about a machine that has since been trammed.
    setMachineCalibration: (machineCalibration) => {
      set({ machineCalibration });
      persist({ ...get(), machineCalibration });
    },
    clearMachineCalibration: () => {
      const next = { ...get() };
      delete next.machineCalibration;
      set({ machineCalibration: undefined });
      persist(next);
    },
    resetSettings: () => {
      // `margins` is cloned, not shared: `DEFAULTS` is module state, and a reset that handed out
      // the same object the next edit would then mutate is how a "reset" stops resetting.
      const fresh = { ...DEFAULTS, margins: { ...MARGIN_DEFAULTS } };
      // Zustand's `set` MERGES, so a key `DEFAULTS` does not carry would survive a reset. The
      // machine's saved frame (#279) is one: it has to go back to "nothing read" like every other
      // setting, or "reset" would leave a calibration in force that nothing on screen claims.
      set({ ...fresh, machineCalibration: undefined });
      persist(fresh);
    },
  };
});

export const SETTINGS_DEFAULTS = DEFAULTS;
