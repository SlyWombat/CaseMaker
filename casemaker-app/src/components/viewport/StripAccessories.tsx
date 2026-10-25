/**
 * #648 — the accessory indicators: vacuum, antistatic, work light, at the far left of the strip.
 *
 * THE MAINTAINER'S PATTERN (design `docs/design/status-strip-dro.md` §6): an icon per accessory
 * (never a bare dot — colour alone fails colour-blind operators), filled when on, outlined when off,
 * dimmed when unknown, with a tooltip of name + state. A click opens a small popover that says what
 * the accessory is in one line and offers the toggle with the same guards the card switches have —
 * only on an explicit Idle machine with no job, an alarm refusing, one connection per press. What
 * the module answers is what the operator reads: a refusal's own sentence, and a failed socket
 * leaves the indicator UNKNOWN rather than claiming a mode.
 *
 * The vacuum text leaves the strip with this: the state dot and word remain the only text about the
 * machine's condition.
 */

import { useEffect, useRef, useState, type JSX } from 'react';
import { toggleVacuum, toggleAntistatic } from '@/platform/machineVacuum';
import { toggleLight } from '@/platform/machineLight';
import { useStripAccessoryStore, type AccessoryKind, type AccessoryMode } from '@/store/stripAccessoryStore';

export interface StripAccessoriesProps {
  target: string;
  host: string;
  port: number;
  /** The vacuum a released program recorded as last sent, when the store has nothing fresher. */
  vacuumFromRecord: AccessoryMode;
  /** The reason the machine cannot be switched now, or null when it can (Idle, no job). */
  disabledReason: string | null;
}

interface AccessorySpec {
  kind: AccessoryKind;
  name: string;
  meaning: string;
  icon: (on: boolean) => JSX.Element;
}

/** A fan: dust collection. */
const fanIcon = (on: boolean): JSX.Element => (
  <svg viewBox="0 0 16 16" width={13} height={13} aria-hidden="true" data-filled={on ? 'yes' : 'no'}>
    <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
    <path
      d="M8 5.6c-1.9-2.9-4.7-2.4-5.1-.9-.4 1.6 1.4 2.8 3.4 2.6M10.4 8c2.9-1.9 2.4-4.7.9-5.1-1.6-.4-2.8 1.4-2.6 3.4M5.6 8c-2.9 1.9-2.4 4.7-.9 5.1 1.6.4 2.8-1.4 2.6-3.4M8 10.4c1.9 2.9 4.7 2.4 5.1.9.4-1.6-1.4-2.8-3.4-2.6"
      fill={on ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={on ? 0.4 : 1}
      strokeLinejoin="round"
    />
  </svg>
);

/** A bolt: the static-removal device. */
const boltIcon = (on: boolean): JSX.Element => (
  <svg viewBox="0 0 16 16" width={13} height={13} aria-hidden="true" data-filled={on ? 'yes' : 'no'}>
    <path d="M9.2 1.5 3.8 9h3.1l-.6 5.5L12.2 7H9.1z" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={on ? 0.5 : 1.1} strokeLinejoin="round" />
  </svg>
);

/** A bulb: the work light. */
const bulbIcon = (on: boolean): JSX.Element => (
  <svg viewBox="0 0 16 16" width={13} height={13} aria-hidden="true" data-filled={on ? 'yes' : 'no'}>
    <path d="M8 1.8a4 4 0 0 1 2.5 7.1c-.5.4-.7.9-.7 1.4H6.2c0-.5-.2-1-.7-1.4A4 4 0 0 1 8 1.8Z" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={on ? 0.5 : 1.1} />
    <path d="M6.4 12.2h3.2M6.8 13.6h2.4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
  </svg>
);

const SPECS: AccessorySpec[] = [
  {
    kind: 'vacuum',
    name: 'Vacuum',
    meaning: 'Dust collection. M331 before a cut, M332 after; every program carries it.',
    icon: fanIcon,
  },
  {
    kind: 'antistatic',
    name: 'Antistatic',
    meaning: 'The static-removal device, for plastic work: M331.4 on, M332.4 off.',
    icon: boltIcon,
  },
  {
    kind: 'light',
    name: 'Work light',
    meaning: 'The machine’s own light: M821 on, M822 off.',
    icon: bulbIcon,
  },
];

/** Run the press for one accessory. Never throws: the modules answer in outcomes. */
async function press(kind: AccessoryKind, target: { host: string; port: number }, on: boolean) {
  if (kind === 'vacuum') return toggleVacuum(target, on);
  if (kind === 'antistatic') return toggleAntistatic(target, on);
  return toggleLight(target, on);
}

const NO_MODES: Partial<Record<AccessoryKind, AccessoryMode>> = {};

export function StripAccessories({ target, host, port, vacuumFromRecord, disabledReason }: StripAccessoriesProps): JSX.Element {
  // Select the STABLE map: a `?? {}` inside the selector returns a new object each render and sends
  // useSyncExternalStore into an infinite loop.
  const allModes = useStripAccessoryStore((s) => s.modes);
  const modes = allModes[target] ?? NO_MODES;
  const note = useStripAccessoryStore((s) => s.note);
  const [open, setOpen] = useState<AccessoryKind | null>(null);
  const [busy, setBusy] = useState<AccessoryKind | null>(null);
  const [notes, setNotes] = useState<Partial<Record<AccessoryKind, string>>>({});
  const root = useRef<HTMLDivElement | null>(null);

  // Escape and an outside click close the popover (the design's keyboard rule).
  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null);
    };
    const onDown = (e: MouseEvent): void => {
      if (root.current !== null && e.target instanceof Node && !root.current.contains(e.target)) setOpen(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const modeOf = (kind: AccessoryKind): AccessoryMode =>
    modes[kind] !== undefined ? modes[kind]! : kind === 'vacuum' ? vacuumFromRecord : null;

  async function toggle(kind: AccessoryKind, on: boolean): Promise<void> {
    if (busy !== null) return;
    setBusy(kind);
    try {
      const result = await press(kind, { host, port }, on);
      switch (result.kind) {
        case 'toggled':
          note(target, kind, result.on);
          setNotes((n) => ({ ...n, [kind]: `The controller answered — ${kind === 'light' ? 'the work light is' : `the ${kind === 'antistatic' ? 'antistatic device is' : 'vacuum is'}`} ${result.on ? 'on' : 'off'} now.` }));
          break;
        case 'busy':
        case 'refused':
          setNotes((n) => ({ ...n, [kind]: result.detail }));
          break;
        case 'timeout':
        case 'error':
        case 'unavailable':
          note(target, kind, null);
          setNotes((n) => ({ ...n, [kind]: result.detail }));
          break;
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div ref={root} data-testid="machine-status-accessories" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none', position: 'relative' }}>
      {SPECS.map((spec) => {
        const mode = modeOf(spec.kind);
        const word = mode === null ? 'unknown' : mode ? 'on' : 'off';
        const colour = mode === null ? '#5c6773' : mode ? '#e8eef4' : '#8a97a5';
        const isOpen = open === spec.kind;
        return (
          <div key={spec.kind} style={{ position: 'relative' }}>
            <button
              type="button"
              data-testid={`machine-status-accessory-${spec.kind}`}
              data-mode={word}
              aria-label={`${spec.name} ${word}`}
              aria-expanded={isOpen}
              title={`${spec.name} ${word}`}
              onClick={() => setOpen(isOpen ? null : spec.kind)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 20,
                height: 20,
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: colour,
                cursor: 'pointer',
                opacity: mode === null ? 0.55 : 1,
              }}
            >
              {spec.icon(mode === true)}
            </button>
            {isOpen && (
              <div
                data-testid={`machine-status-accessory-popover-${spec.kind}`}
                role="dialog"
                aria-label={spec.name}
                style={{
                  position: 'absolute',
                  left: 0,
                  bottom: '100%',
                  marginBottom: 6,
                  width: 250,
                  padding: 10,
                  background: '#1c2229',
                  border: '1px solid #2a2f36',
                  borderRadius: 6,
                  boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
                  zIndex: 40,
                  whiteSpace: 'normal',
                }}
              >
                <div style={{ fontWeight: 600, color: '#e8eef4', marginBottom: 2 }}>
                  {spec.name} — <span data-testid={`machine-status-accessory-state-${spec.kind}`}>{word}</span>
                </div>
                <p style={{ margin: '0 0 8px', color: '#a8b4c0', fontSize: 11, lineHeight: 1.4 }}>{spec.meaning}</p>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    data-testid={`machine-status-accessory-on-${spec.kind}`}
                    disabled={busy !== null || disabledReason !== null}
                    title={disabledReason ?? `Switch ${spec.name.toLowerCase()} on`}
                    onClick={() => void toggle(spec.kind, true)}
                    style={{ padding: '2px 10px' }}
                  >
                    On
                  </button>
                  <button
                    type="button"
                    data-testid={`machine-status-accessory-off-${spec.kind}`}
                    disabled={busy !== null || disabledReason !== null}
                    title={disabledReason ?? `Switch ${spec.name.toLowerCase()} off`}
                    onClick={() => void toggle(spec.kind, false)}
                    style={{ padding: '2px 10px' }}
                  >
                    Off
                  </button>
                </div>
                {disabledReason !== null && (
                  <p data-testid={`machine-status-accessory-disabled-${spec.kind}`} style={{ margin: '6px 0 0', color: '#e0c07a', fontSize: 11 }}>
                    {disabledReason}
                  </p>
                )}
                {notes[spec.kind] !== undefined && (
                  <p data-testid={`machine-status-accessory-note-${spec.kind}`} style={{ margin: '6px 0 0', color: '#a8b4c0', fontSize: 11 }}>
                    {notes[spec.kind]}
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
