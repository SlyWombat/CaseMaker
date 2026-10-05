// Render a `RunSheet` as Markdown — the file the operator takes to the bench (#248 item 1).
//
// A thin, pure renderer so the scripted path and (potentially) another exporter both print the
// SAME `buildRunSheet` structure the app's `RunSheetView` renders, instead of prose written by
// hand. It is here in `scripts/` beside its only consumer rather than in `src/`, because nothing
// in the app renders Markdown: the app has the React view, the bench has this.

import {
  runSheetDiagramSvg,
  type RunSheet,
  type RunSheetStep,
} from '../src/engine/cnc/engrave/runSheet';

function renderStep(step: RunSheetStep, i: number): string {
  let text = step.bold ? `**${step.text}**` : step.text;
  if (step.value !== undefined) text += ` — **${step.value}**`;
  if (step.record !== undefined) text += ` — \\_\\_\\_\\_\\_\\_\\_\\_  *(${step.record})*`;
  if (step.unverified !== undefined) text += `  ⚠ *Not yet confirmed on the machine (${step.unverified}).*`;
  return `${i + 1}. ${text}`;
}

/** The whole sheet as Markdown. `footerNote` is a provenance line appended at the foot, if given. */
export function renderRunSheetMarkdown(s: RunSheet, footerNote?: string): string {
  const out: string[] = [];
  out.push(`# Run sheet — ${s.header.jobName}`);
  out.push('');
  out.push(
    `Generated ${s.header.generatedOn} · file \`${s.header.fileName}\` · ` +
      `sha256 \`${s.header.fileHash}\` · estimated cutting time ${s.header.estimatedTime} ` +
      `(${s.header.estimatedTimeNote})`,
  );
  for (const section of s.sections) {
    out.push('');
    out.push(`## ${section.title}`);
    out.push('');
    out.push(section.steps.map(renderStep).join('\n'));
    if (section.id === 'origin') {
      out.push('');
      out.push(runSheetDiagramSvg(s.diagram));
    }
  }
  if (footerNote) {
    out.push('');
    out.push('---');
    out.push('');
    out.push(footerNote);
  }
  return out.join('\n') + '\n';
}
