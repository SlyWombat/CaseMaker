/**
 * Prefill a setup FORM from a `.nc` file's `;@MKR` header (`/Simulation.md` §6).
 *
 * It prefills a form and never the sweep. The header is UNTRUSTED (`gcode/mkrHeader.ts`,
 * `/Makera-Parity.md` §6.1): `ORIGIN`'s semantics — which stock axis `length` maps to, which
 * corner `topFrontLeft` is — rest on ONE square-stock sample. So:
 *
 *   - `STOCK` gives a cuboid only. `diameter=` is ignored for `id=cuboid` (the sample's
 *     `diameter=1` is a placeholder); any other `id` gets no geometry. A field that is
 *     non-finite or not positive is skipped with a warning, and a stock missing any of the
 *     three dimensions is not prefilled at all.
 *   - `ORIGIN`'s `type_name` picks a corner PRESET and nothing else. Its x/y/z only
 *     CROSS-CHECK that choice against the stock (|x| = length/2, |y| = width/2, z = height/2
 *     holds on the sample); when they disagree the corner is withheld and the semantics are
 *     said to be unverified.
 *
 * What cannot be prefilled, and why: `Setup` carries no "corner" — the work origin in
 * MACHINE coordinates is controller state the file cannot supply (`setup.ts` §1). So the
 * verified corner comes back as `workOrigin` for the form to turn into a placement; nothing
 * about it is put into `patch`.
 *
 * Pure: no I/O, never throws, never returns a patch field it was not sure of.
 */

import type { MkrHeader, MkrRecord } from './gcode/types';
import type { RegistrationSource, Setup } from './setup';

export interface HeaderDiagnostic {
  severity: 'warning' | 'info';
  code: string;
  message: string;
  /** 1-based line of the header record. */
  line: number;
}

/** The only corner preset with any evidence behind it: Makera's `topFrontLeft` on a square block. */
export type HeaderOriginCorner = 'top-front-left';

export interface SetupFromHeader {
  /** Only what the header supported; `part` is the one field today. */
  patch: Partial<Setup>;
  /** The verified corner preset, or null. A form hint, never a transform. */
  workOrigin: { corner: HeaderOriginCorner; source: RegistrationSource } | null;
  /** Always 'header': everything above was read from an untrusted file, not measured. */
  source: Extract<RegistrationSource, 'header'>;
  diagnostics: HeaderDiagnostic[];
}

/** Absolute tolerance, mm, for the ORIGIN cross-check: header numbers are decimal text. */
const CROSS_CHECK_MM = 1e-6;

type Dim = { ok: true; value: number } | { ok: false };

export function setupFromHeader(header: MkrHeader | null): SetupFromHeader {
  const out: SetupFromHeader = { patch: {}, workOrigin: null, source: 'header', diagnostics: [] };
  const warn = (rec: MkrRecord, code: string, message: string): void => {
    out.diagnostics.push({ severity: 'warning', code, message, line: rec.line });
  };
  if (!header) return out;

  const stocks = header.records.filter((r) => r.tag === 'STOCK');
  const origins = header.records.filter((r) => r.tag === 'ORIGIN');
  const stock = stocks[0];
  const origin = origins[0];
  if (stocks.length > 1) warn(stocks[1] as MkrRecord, 'stock-multiple', `${stocks.length} STOCK records; only the first is read`);
  if (origins.length > 1) warn(origins[1] as MkrRecord, 'origin-multiple', `${origins.length} ORIGIN records; only the first is read`);

  let dims: { length: number; width: number; height: number } | null = null;
  if (stock) {
    const id = stock.fields['id'] ?? '';
    if (id !== 'cuboid') {
      warn(stock, 'stock-shape-unsupported', `STOCK id="${id}" is not a cuboid: its geometry is not prefilled`);
    } else {
      const read = (key: string): Dim => {
        const raw = stock.fields[key];
        if (raw === undefined || raw.trim() === '') {
          warn(stock, 'stock-field-missing', `STOCK has no ${key}`);
          return { ok: false };
        }
        const n = Number(raw);
        if (!Number.isFinite(n) || !(n > 0)) {
          warn(stock, 'stock-field-invalid', `STOCK ${key}="${raw}" is not a finite positive number: skipped`);
          return { ok: false };
        }
        return { ok: true, value: n };
      };
      const l = read('length');
      const w = read('width');
      const h = read('height');
      if (l.ok && w.ok && h.ok) {
        dims = { length: l.value, width: w.value, height: h.value };
        out.patch.part = {
          kind: 'prism',
          outline: { kind: 'p-rect', size: [l.value, w.value] },
          thickness: h.value,
        };
        if (l.value !== w.value) {
          warn(stock, 'stock-axes-unverified', 'STOCK length and width differ, and which of them runs along X is unverified (the one sample is square): check the orientation');
        }
      } else {
        warn(stock, 'stock-incomplete', 'STOCK needs a valid length, width and height: stock not prefilled');
      }
    }
  }

  if (origin) {
    const type = origin.fields['type_name'] ?? '';
    if (type !== 'topFrontLeft') {
      warn(origin, 'origin-preset-unverified', `ORIGIN type_name="${type}" is not a corner preset with any evidence behind it: origin not prefilled`);
    } else if (!dims) {
      warn(origin, 'origin-unchecked', 'ORIGIN cannot be cross-checked without a valid cuboid STOCK: origin not prefilled');
    } else {
      const num = (k: string): number => {
        const raw = origin.fields[k];
        return raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
      };
      const x = num('x');
      const y = num('y');
      const z = num('z');
      const near = (a: number, b: number): boolean => Number.isFinite(a) && Math.abs(a - b) <= CROSS_CHECK_MM;
      if (near(Math.abs(x), dims.length / 2) && near(Math.abs(y), dims.width / 2) && near(z, dims.height / 2)) {
        out.workOrigin = { corner: 'top-front-left', source: 'header' };
      } else {
        warn(origin, 'origin-semantics-unverified', `ORIGIN x/y/z (${origin.fields['x']}, ${origin.fields['y']}, ${origin.fields['z']}) do not match |x| = length/2, |y| = width/2, z = height/2 for topFrontLeft on this stock: the ORIGIN semantics are unverified, origin not prefilled`);
      }
    }
  }
  return out;
}
