import type { ExportLayoutMode } from '@/engine/exportLayout';
import { fitRelief, type FitVariant } from '@/types/snap';
import {
  printMetaForId,
  type ProjectPart,
} from '@/engine/exporters/parts';

/**
 * Issue #154 — the print-notes sidecar text.
 *
 * A plain-text companion dropped beside a multi-part export so the print
 * guidance stops living in docs and constants. It names, for each part being
 * exported: how it sits on the bed, whether it is flipped in THIS layout, how
 * much support it needs and why, and the wall/infill suggestion where the part
 * is structural.
 *
 * `layoutMode` is REQUIRED, and it is not a detail. In `print-ready` layout the
 * exporter flips the parts that need it, so the file really does "already come
 * this way up". In `assembled` layout it skips the flip entirely
 * (`meshNodesForExport`, exportTrigger) — so for a flipped part the notes must
 * say the opposite: turn it over yourself. A function that hard-codes the
 * print-ready sentence is wrong half the time.
 *
 * Takes the parts actually being exported (after any filtering), not the whole
 * plan: Save All excludes the fused assembled racks, and the notes must match
 * the files, not the plan.
 */
export function printNotesText(
  parts: readonly ProjectPart[],
  layoutMode: ExportLayoutMode,
  fit: FitVariant | null = null,
): string {
  const lines: string[] = [];
  lines.push('CaseMaker — print notes');
  lines.push('='.repeat(40));
  lines.push('');
  lines.push(
    layoutMode === 'print-ready'
      ? 'Layout: PRINT-READY. Parts are laid flat and flipped where they need it, so each STL drops straight onto the bed as exported.'
      : 'Layout: ASSEMBLED. The print-ready flip is NOT applied — parts export in their assembly orientation. Turn over any part marked FLIP below.',
  );
  lines.push('');
  // Issue #153 — a relieved fit is a property of the file's geometry (the
  // mating cut is bigger than as-designed), and it is the one thing in these
  // notes that is a CHOICE rather than a fact about the part. The name says
  // which grade; this says what that means, because the slicer shows the name
  // and not this file. Omitted entirely for the default, so a project that
  // never chose a fit gets the notes it always got.
  if (fit) {
    lines.push(
      `Snap fit:    ${fit} — the mating cut is relieved by ${fitRelief(fit)} mm. Print this grade and a tighter one, then keep whichever seats.`,
    );
    lines.push('');
  }
  lines.push(
    'The STL geometry is authoritative; these notes only say how to place and slice it.',
  );
  lines.push('');

  if (parts.length === 0) {
    lines.push('(no parts listed)');
    return lines.join('\n');
  }

  for (const part of parts) {
    const meta = printMetaForId(part.id);
    lines.push(`--- ${part.displayName} (${part.id}) ---`);
    lines.push(`Material:    ${part.material === 'flex' ? 'flex (TPU 95A)' : 'rigid'}`);
    if (meta.flipForPrint) {
      lines.push(
        layoutMode === 'print-ready'
          ? `Orientation: ${meta.hint} FLIP FOR PRINT — the exported file is already turned over: ${meta.exportedFlipNote ?? 'drop it straight in.'}`
          : `Orientation: ${meta.hint} FLIP FOR PRINT — this file is NOT flipped (assembled layout): turn it over in the slicer.`,
      );
    } else {
      lines.push(`Orientation: ${meta.hint}`);
    }
    if (meta.supports === 'none') {
      lines.push('Supports:    none');
    } else {
      lines.push(
        `Supports:    ${meta.supports}${meta.supportWhy ? ` — ${meta.supportWhy}` : ''}`,
      );
    }
    if (meta.walls !== undefined || meta.infill !== undefined) {
      const walls = meta.walls !== undefined ? `${meta.walls} walls` : '—';
      const infill = meta.infill !== undefined ? `${meta.infill}% infill` : '—';
      lines.push(
        `Walls/infill: ${walls}, ${infill} (structural starting point, not a measured value)`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
