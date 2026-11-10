/**
 * #1128 follow-up review — REVEAL THE CLEARANCE STATEMENT; NEVER TICK IT.
 *
 * The clearance tick is the operator's own statement that they checked the vise and the tool's
 * reach themselves. A one-click "acknowledge" in the findings list would let them tick it without
 * reading it, so the Do row's clearance action only takes them TO the statement: step 1 opens, the
 * statement scrolls into view, and its checkbox takes focus. The tick is theirs.
 */

/**
 * Open the step, scroll the statement into view and focus its checkbox. Best-effort by design —
 * a surface without the statement (a spec, a run with no program yet) is a no-op, never a throw.
 */
export function revealClearanceStatement(doc: Document = document): void {
  const step = doc.querySelector<HTMLDetailsElement>('[data-testid="engrave-cut-step-1"]');
  if (step !== null) step.open = true;
  const box = doc.querySelector<HTMLElement>('[data-testid="engrave-cut-ack"]');
  box?.scrollIntoView?.({ block: 'center' });
  doc.querySelector<HTMLInputElement>('[data-testid="engrave-ack"]')?.focus();
}
