/**
 * The file bar's words, kept out of the component module: a component file that also exports a
 * plain function breaks Fast Refresh (react-refresh/only-export-components).
 */

/** The last-saved time as the mockup prints it (`saved 09:14`), or the unsaved line. */
export function savedTimeText(savedAt: number | null): string {
  if (savedAt === null) return 'Not saved yet';
  const d = new Date(savedAt);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `saved ${hh}:${mm}`;
}
