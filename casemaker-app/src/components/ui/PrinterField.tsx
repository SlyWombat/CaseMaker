import type { ReactElement } from 'react';
import { useProjectStore } from '@/store/projectStore';
import { LabelledField } from '@/components/ui/LabelledField';
import { PRINTER_PRESETS, resolvePrinter } from '@/engine/compiler/rackFit';
import type { PrinterVolume } from '@/types/printer';

/**
 * Issue #148 — the print bed, as one control.
 *
 * The bed belongs to the PROJECT now, not to the rack, so it has more than one
 * home: the rack panel (where it used to live) and the export modal (where the
 * parts that have to fit it are chosen). Two hand-kept copies of a preset table
 * and a custom-axis form is how the "Printer" dropdown and the parts it makes
 * possible drift apart, so both read and write through this component and the
 * store's one `setPrinter`.
 *
 * "Not set" is a real state: a project with no bed checks nothing and offers no
 * split, which is the honest answer for a project nobody has told the printer
 * about yet.
 */

/** What "custom" falls back to when there is no bed to modify. */
const CUSTOM_SEED: PrinterVolume = { x: 220, y: 220, z: 250 };

export interface PrinterFieldProps {
  /** Test-id prefix: the select becomes `${prefix}-preset`, the axes
   *  `${prefix}-x` / `-y` / `-z`. */
  testIdPrefix: string;
  hint?: string;
}

export function PrinterField({ testIdPrefix, hint }: PrinterFieldProps): ReactElement {
  const project = useProjectStore((s) => s.project);
  const setPrinter = useProjectStore((s) => s.setPrinter);
  const printer = resolvePrinter(project);
  // Three states, not two: no bed at all, a bed that came from a preset row,
  // and a bed with hand-typed numbers. A custom bed stores `preset: undefined`,
  // so falling back to 'none' here would snap the select back to "Not set" the
  // moment the user picked Custom… and hide the axis inputs they were about to
  // type into. A preset id that is no longer in the table reads as custom too,
  // so the select never shows a blank value.
  const presetId =
    printer === undefined
      ? 'none'
      : PRINTER_PRESETS.some((p) => p.id === printer.preset)
        ? printer.preset!
        : 'custom';

  const setPreset = (id: string): void => {
    if (id === 'none') {
      setPrinter(undefined);
      return;
    }
    if (id === 'custom') {
      setPrinter({ ...(printer ?? CUSTOM_SEED), preset: undefined });
      return;
    }
    const p = PRINTER_PRESETS.find((x) => x.id === id);
    if (p) setPrinter({ preset: p.id, x: p.x, y: p.y, z: p.z });
  };

  return (
    <>
      <LabelledField
        label="Printer"
        hint={
          hint ??
          'The project’s bed (#148) — saved with the project, so every archetype checks its parts against the same volume. Parts are checked flat AND diagonally.'
        }
      >
        <select
          value={presetId}
          data-testid={`${testIdPrefix}-preset`}
          onChange={(e) => setPreset(e.target.value)}
        >
          <option value="none">Not set</option>
          {PRINTER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
      </LabelledField>
      {presetId === 'custom' && printer && (
        <div style={{ display: 'flex', gap: 6 }}>
          {(['x', 'y', 'z'] as const).map((axis) => (
            <LabelledField key={axis} label={axis.toUpperCase()} unit="mm" inline>
              <input
                type="number"
                min={80}
                max={1000}
                value={printer[axis]}
                data-testid={`${testIdPrefix}-${axis}`}
                onChange={(e) => setPrinter({ ...printer, [axis]: Number(e.target.value) })}
              />
            </LabelledField>
          ))}
        </div>
      )}
    </>
  );
}
