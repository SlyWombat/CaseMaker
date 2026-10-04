import { create } from 'zustand';
import { todayISODate } from '@/engine/cnc/fixture';
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

export interface AppSettings {
  port: number;
  bindToAll: boolean;
  exportLayout: ExportLayoutMode;
  exportFormat: ExportFormat;
  fixtures: FixturesSettings;
}

const SETTINGS_KEY = 'casemaker.settings.v1';
const DEFAULT_PORT = 8000;
const DEFAULT_EXPORT_LAYOUT: ExportLayoutMode = 'print-ready';
// Issue #75 — fresh users get a human-readable text STL out of the gate.
// Existing localStorage prefs override this default; they're respected
// in loadSettings() below.
const DEFAULT_EXPORT_FORMAT: ExportFormat = 'stl-ascii';

const DEFAULTS: AppSettings = {
  port: DEFAULT_PORT,
  bindToAll: false,
  exportLayout: DEFAULT_EXPORT_LAYOUT,
  exportFormat: DEFAULT_EXPORT_FORMAT,
  fixtures: {},
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

function loadSettings(): AppSettings {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return { ...DEFAULTS };
  }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      port: clampPort(parsed.port),
      bindToAll: Boolean(parsed.bindToAll),
      exportLayout:
        parsed.exportLayout === 'assembled' || parsed.exportLayout === 'print-ready'
          ? parsed.exportLayout
          : DEFAULT_EXPORT_LAYOUT,
      exportFormat:
        typeof parsed.exportFormat === 'string' && VALID_FORMATS.has(parsed.exportFormat as ExportFormat)
          ? (parsed.exportFormat as ExportFormat)
          : DEFAULT_EXPORT_FORMAT,
      fixtures: parseFixtures(parsed.fixtures),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function clampPort(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_PORT;
  const v = Math.floor(n);
  if (v < 1024 || v > 65535) return DEFAULT_PORT;
  return v;
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
  setPort: (port: number) => void;
  setBindToAll: (v: boolean) => void;
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
  resetSettings: () => void;
}

export const useSettingsStore = create<SettingsState>()((set, get) => {
  const initial = loadSettings();
  return {
    ...initial,
    setPort: (port) => {
      const clamped = clampPort(port);
      set({ port: clamped });
      persist({ ...get(), port: clamped });
    },
    setBindToAll: (bindToAll) => {
      set({ bindToAll });
      persist({ ...get(), bindToAll });
    },
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
    resetSettings: () => {
      const fresh = { ...DEFAULTS };
      set(fresh);
      persist(fresh);
    },
  };
});

export const SETTINGS_DEFAULTS = DEFAULTS;
export { clampPort };
