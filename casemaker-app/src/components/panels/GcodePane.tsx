/**
 * The read-only G-code pane (#245, `/Makera-Parity.md` §14.2 A5). 11 of the 20 vendors in the
 * sample show the program text beside the simulation; we showed only `line N`, with no text.
 *
 * READ-ONLY BY CONSTRUCTION. The program is one `<pre>` of text: there is no field, no
 * `contenteditable`, and nothing here writes back. In-app G-code EDITING is on the refuse list
 * (§14.4 R8) — this is the half that pays without inviting a hand-edit of a verified file.
 *
 * The current line comes from the load's own `SimPath.line` through `lineAtStep` — the same
 * array the transport's `line N` readout already uses. Both are a binary search on a buffer
 * already in the main thread, so following playback costs no worker round trip and cannot lag
 * the scrubber. (`simStateAt` returns machine STATE; the source line never crosses the worker.)
 *
 * The scroll body is fixed-height with no wrapping, so the highlight band is placed by
 * `index * LINE_HEIGHT` — an O(1) update per step, however long the program.
 */

import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { splitLines } from '@/engine/cnc/gcode/lexer';
import { lineAtStep } from '@/engine/cnc/playbackClock';
import { useSimStore } from '@/store/simStore';

/** Fixed row height, px, so a highlight band is one multiplication away. */
const LINE_HEIGHT = 16;
/** The pane's own scroller height, px — a few thousand lines live here; the panel does not grow. */
const PANE_HEIGHT = 240;

const BODY: CSSProperties = {
  margin: 0,
  padding: '2px 6px',
  lineHeight: `${LINE_HEIGHT}px`,
  fontSize: 11,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  whiteSpace: 'pre',
  color: '#c8d3de',
};
const BAND_CURRENT: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  height: LINE_HEIGHT,
  background: 'rgba(77,142,255,.20)',
  borderTop: '1px solid rgba(77,142,255,.5)',
  borderBottom: '1px solid rgba(77,142,255,.5)',
  pointerEvents: 'none',
};
const BAND_JUMP: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  height: LINE_HEIGHT,
  background: 'rgba(224,192,122,.20)',
  borderTop: '1px solid rgba(224,192,122,.55)',
  borderBottom: '1px solid rgba(224,192,122,.55)',
  pointerEvents: 'none',
};

export interface GcodePaneProps {
  /** The program text exactly as opened. Never edited here. */
  text: string;
  /** The 1-based line a diagnostic asked to reveal, or null. */
  jumpLine?: number | null;
  /** Bumped on every jump request, so clicking the same diagnostic twice re-scrolls. */
  jumpSeq?: number;
}

export function GcodePane({ text, jumpLine = null, jumpSeq = 0 }: GcodePaneProps) {
  const path = useSimStore((s) => s.path);
  const step = useSimStore((s) => s.step);

  // Split with the parser's OWN rule (`splitLines`), so a line number means the same line here
  // and in every diagnostic. `\r\n`, `\n` and `\r` all count.
  const lines = useMemo(() => splitLines(text), [text]);
  const gutter = String(lines.length).length;
  const body = useMemo(
    () => lines.map((line, i) => `${String(i + 1).padStart(gutter, ' ')} | ${line}`).join('\n'),
    [lines, gutter],
  );

  const currentLine = path ? lineAtStep(path, step) : null;
  const indexIn = (line: number | null): number | null =>
    line !== null && line >= 1 && line <= lines.length ? line - 1 : null;
  const currentIndex = indexIn(currentLine);
  const jumpIndex = indexIn(jumpLine);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Follow playback: keep the current line inside the scroller, scrolling the least amount.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || currentIndex === null) return;
    const top = currentIndex * LINE_HEIGHT;
    const bottom = top + LINE_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [currentIndex]);

  // A diagnostic click reveals its line, centred, and brings the pane into view if the panel
  // had scrolled past it. `scrollIntoView` is absent under jsdom, hence the optional call.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || jumpIndex === null) return;
    el.scrollTop = Math.max(0, jumpIndex * LINE_HEIGHT - Math.floor(el.clientHeight / 2) + LINE_HEIGHT / 2);
    el.scrollIntoView?.({ block: 'nearest' });
  }, [jumpIndex, jumpSeq]);

  return (
    <div
      ref={scrollRef}
      data-testid="sim-gcode-pane"
      data-readonly="true"
      role="region"
      aria-label="G-code, read-only"
      style={{ position: 'relative', overflow: 'auto', height: PANE_HEIGHT, background: '#101418', border: '1px solid #2a2f36', borderRadius: 4 }}
    >
      <div style={{ position: 'relative', minHeight: lines.length * LINE_HEIGHT }}>
        {jumpIndex !== null && <div data-testid="sim-gcode-jump" data-line={jumpIndex + 1} style={{ ...BAND_JUMP, top: jumpIndex * LINE_HEIGHT }} />}
        {currentIndex !== null && (
          <div data-testid="sim-gcode-current" data-line={currentIndex + 1} style={{ ...BAND_CURRENT, top: currentIndex * LINE_HEIGHT }} />
        )}
        <pre data-testid="sim-gcode-text" style={BODY}>
          {body}
        </pre>
      </div>
    </div>
  );
}
