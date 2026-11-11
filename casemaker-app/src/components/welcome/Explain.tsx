/**
 * #1109 — ONE VISIBLE EXPLANATION. A glossary term renders its plain line under the control, not
 * in a hover title: the help is on the screen on touch and on keyboard focus alike. The rest of
 * the sentence may follow as children, after an em dash — the gloss and the sentence are two
 * statements, not one run-on.
 */
import type { JSX, ReactNode } from 'react';

import { GLOSSARY, type GlossaryTerm } from './glossary';

export function Explain({ term, children }: { term: GlossaryTerm; children?: ReactNode }): JSX.Element {
  return (
    <span data-testid={`explain-${term}`} style={{ display: 'block', fontSize: 10, color: '#9aa4b0', lineHeight: 1.35, marginTop: 2 }}>
      {GLOSSARY[term]}
      {children === undefined ? '' : <> — {children}</>}
    </span>
  );
}
