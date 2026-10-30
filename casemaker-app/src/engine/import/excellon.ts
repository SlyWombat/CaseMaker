/**
 * Excellon drill file import (#743 P-3) — a board's holes as points in mm.
 *
 * The drill file is the second half of the Gerber set: `M48` header, `METRIC`/`INCH` (with `LZ`/
 * `TZ` zero suppression), `FMAT,2`, the tool table `TnnCddd`, and absolute drill coordinates in
 * the body. PTH and NPTH files are read the same way and their holes are merged by the caller —
 * the file itself rarely says which it is.
 *
 * Coordinates may be written with a decimal point (KiCad's own output: `X10.0Y10.0`) or as
 * fixed-point integers under a digit format (`METRIC,000.000`). A decimal-less coordinate with no
 * digit format is REFUSED rather than guessed: the same digits are 15.0000 mm under `TZ` and
 * 0.0015 mm under `LZ`, so a guess would be a hole in the wrong place.
 *
 * SLOTS ARE KEPT, NOT REFUSED (the maintainer's note, 2026-10-30). KiCad and EasyEDA write oval
 * connector holes as `G85` slots, and some fabs' files route with `M15`/`M16`; refusing the whole
 * file for one oval hole would lose the board. A slot is read as what it is — two endpoints and
 * the tool's width — and reported beside the round holes, so the caller can cut it or say it was
 * skipped. A routed polyline becomes one slot PER SEGMENT, which is what the machine would do.
 * Incremental coordinates (`G91`) are still refused: every file this app has met is absolute.
 */

export interface ExcellonHole {
  x: number;
  y: number;
  /** The tool's diameter, mm. */
  diameter: number;
  /** The tool number the file used, for grouping by size. */
  tool: number;
}

/** A milled oval: the two endpoints of the tool's centre path, and the tool's width. */
export interface ExcellonSlot {
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** The tool's diameter, mm — the slot's width. */
  width: number;
  tool: number;
}

export interface ExcellonReadOk {
  ok: true;
  holes: ExcellonHole[];
  slots: ExcellonSlot[];
  notes: string[];
  /** The file's own unit, for the import summary. */
  units: 'mm' | 'inch';
}

export type ExcellonRead = ExcellonReadOk | { ok: false; error: string };

class ExcellonRefusal extends Error {}

function refuse(line: number, what: string): never {
  throw new ExcellonRefusal(`line ${line}: ${what}`);
}

export function readExcellon(text: string): ExcellonRead {
  try {
    return parse(text);
  } catch (e) {
    if (e instanceof ExcellonRefusal) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

interface DigitFormat {
  decimals: number;
}

function parse(text: string): ExcellonRead {
  const lines = text.split(/\r\n|\r|\n/);
  const notes: string[] = [];
  let units: 'mm' | 'inch' | null = null;
  let digits: DigitFormat | null = null;
  const tools = new Map<number, number>();
  let tool: number | null = null;
  let x: number | null = null;
  let y: number | null = null;
  let sawHeader = false;
  let inHeader = false;
  const holes: ExcellonHole[] = [];
  const slots: ExcellonSlot[] = [];
  /** Inside an `M15`…`M16` routed slot, the point the tool went down at and where it is now. */
  let routing: { tool: number; lastX: number; lastY: number } | null = null;

  const scale = (): number => (units === 'inch' ? 25.4 : 1);

  const coordinate = (raw: string, line: number): number => {
    if (raw.includes('.')) {
      const v = Number(raw);
      if (!Number.isFinite(v)) refuse(line, `“${raw}” is not a coordinate`);
      return v * scale();
    }
    if (digits === null) {
      refuse(line, `the coordinate “${raw}” has no decimal point and the file states no digit format (for example METRIC,000.000)`);
    }
    const v = Number(raw);
    if (!Number.isFinite(v)) refuse(line, `“${raw}” is not a coordinate`);
    return (v / 10 ** digits.decimals) * scale();
  };

  lines: for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = (lines[i] as string).trim();
    if (line === '') continue;
    if (line.startsWith(';')) continue; // a comment
    // A line may carry several space-separated tokens (each is complete on its own).
    for (const token of line.split(/\s+/)) {
      if (token === '') continue;
      if (token === 'M48') {
        sawHeader = true;
        inHeader = true;
        continue;
      }
      if (token === '%' || token === 'M95') {
        inHeader = false;
        continue;
      }
      if (inHeader) {
        const head = /^(METRIC|INCH)(?:,([A-Z]*))?(?:,(\d+)\.(\d+))?$/.exec(token);
        if (head !== null) {
          units = head[1] === 'INCH' ? 'inch' : 'mm';
          if (head[3] !== undefined && head[4] !== undefined) {
            // The format is written as literal zeros (`000.000`): the COUNT of digits each way.
            digits = { decimals: head[4].length };
            notes.push(`coordinates without a decimal point are read on the file's ${head[3]}.${head[4]} digit format.`);
          }
          continue;
        }
        if (/^FMAT,\d+$/.test(token)) continue;
        if (/^T\d+C[\d.]+$/.test(token)) {
          const m = /^T(\d+)C([\d.]+)$/.exec(token) as RegExpExecArray;
          const dia = Number(m[2]);
          if (!(dia > 0)) refuse(lineNo, `tool T${m[1]} states a diameter of ${m[2]}, which is not a size`);
          tools.set(Number(m[1]), dia * scale());
          continue;
        }
        if (/^T\d+$/.test(token)) {
          // A bare tool selection in the header is legal; it selects the tool for the body.
          tool = Number(token.slice(1));
          continue;
        }
        if (token.startsWith('DETECT') || token.startsWith('ATC') || token === 'VER' || token.startsWith('FILE_FORMAT')) continue;
        if (/^(METRIC|INCH),/.test(token)) {
          // e.g. "METRIC,TZ,LZ" variants this reader does not need beyond the unit.
          units = token.startsWith('INCH') ? 'inch' : 'mm';
          continue;
        }
        refuse(lineNo, `the drill file's header command “${token}” is not one this import reads`);
      }

      if (/^T\d+$/.test(token)) {
        tool = Number(token.slice(1));
        if (!tools.has(tool)) refuse(lineNo, `tool T${tool} is selected before the header defines it`);
        continue;
      }
      if (/^M0?[02]$/.test(token) || token === 'M30') break lines;
      if (token === 'G90') continue;
      if (token === 'G05' || token === 'G81') continue;
      if (token === 'G91') refuse(lineNo, 'the file uses incremental coordinates (G91), which this import does not read');
      if (token === 'M15') {
        if (tool === null) refuse(lineNo, 'a slot is routed before any tool is selected');
        if (x === null || y === null) refuse(lineNo, 'a routed slot starts before any point is stated');
        routing = { tool, lastX: x, lastY: y };
        continue;
      }
      if (token === 'M16') {
        routing = null;
        continue;
      }
      // A G85 slot: `X…Y…G85X…Y…` — the first pair is where the tool is, the second where the
      // slot ends; the tool's diameter is its width.
      if (token.includes('G85')) {
        if (tool === null) refuse(lineNo, 'a slot is milled before any tool is selected');
        const [start, end] = token.split('G85');
        const readPair = (part: string | undefined, line: number): { x: number; y: number } => {
          let px = x;
          let py = y;
          for (const m of (part ?? '').matchAll(/([XY])([-+]?[\d.]+)/g)) {
            const v = coordinate(m[2] as string, line);
            if (m[1] === 'X') px = v;
            else py = v;
          }
          if (px === null || py === null) refuse(line, 'a G85 slot has a missing coordinate');
          return { x: px, y: py };
        };
        const a = readPair(start, lineNo);
        const b = readPair(end, lineNo);
        x = a.x;
        y = a.y;
        const width = tools.get(tool);
        if (width === undefined) refuse(lineNo, `tool T${tool} has no diameter`);
        if (a.x !== b.x || a.y !== b.y) slots.push({ from: a, to: b, width, tool });
        x = b.x;
        y = b.y;
        continue;
      }
      if (token.startsWith('R')) refuse(lineNo, 'the file uses a repeat (R), which this import does not read');
      // A drill hit: X and Y (either may be omitted, keeping the last one).
      if (/^[XY]/.test(token)) {
        if (!sawHeader) refuse(lineNo, 'the file has no M48 header, so its unit and tools cannot be read');
        if (tool === null) refuse(lineNo, 'a hole is drilled before any tool is selected');
        let rest = token;
        while (rest.length > 0) {
          const m = /^([XY])([-+]?[\d.]+)/.exec(rest);
          if (m === null) refuse(lineNo, `the coordinate “${rest}” is not one this import reads`);
          if (m[1] === 'X') x = coordinate(m[2] as string, lineNo);
          else y = coordinate(m[2] as string, lineNo);
          rest = rest.slice(m[0].length);
        }
        if (x === null || y === null) refuse(lineNo, 'a hole has only one coordinate; the first drill needs both');
        const diameter = tools.get(tool);
        if (diameter === undefined) refuse(lineNo, `tool T${tool} has no diameter`);
        if (routing !== null) {
          // A moved point while the tool is DOWN is a routed slot segment, not another hole.
          if (routing.lastX !== x || routing.lastY !== y) {
            slots.push({ from: { x: routing.lastX, y: routing.lastY }, to: { x, y }, width: diameter, tool: routing.tool });
          }
          routing.lastX = x;
          routing.lastY = y;
        } else {
          holes.push({ x, y, diameter, tool });
        }
        continue;
      }
      refuse(lineNo, `“${token}” is not a command this import reads`);
    }
  }

  if (!sawHeader) return { ok: false, error: 'the file has no M48 header, so its unit and tools cannot be read' };
  if (units === null) return { ok: false, error: 'the file states no unit (METRIC or INCH), so its sizes cannot be read' };
  if (tools.size === 0) return { ok: false, error: 'the file defines no tools, so no hole has a size' };
  if (holes.length === 0 && slots.length === 0) return { ok: false, error: 'the file drills no holes' };
  if (slots.length > 0) {
    const widths = [...new Set(slots.map((slot) => `${slot.width} mm`))].join(', ');
    notes.push(
      `${slots.length} slot${slots.length === 1 ? '' : 's'} read at ${widths} wide: kept apart from the round holes, so a cutter that cannot mill them does not hide the rest of the file.`,
    );
  }
  return { ok: true, holes, slots, notes, units };
}
