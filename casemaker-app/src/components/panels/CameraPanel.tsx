/**
 * #530 — THE MACHINE'S CAMERA, as a pane over the app.
 *
 * The operator's question is "what is on the bed right now?" — from the Cut step, before the press,
 * and during a run from the strip's popover. This pane answers it with the machine's own ESP32
 * stream (`cameraStream.ts`), and it answers the second question a picture cannot: HOW OLD the
 * frame is. A stalled stream shows the last picture it had; the age beside it says so rather than
 * letting a frozen image pass for live.
 *
 * WHERE IT SITS. Mounted once by the shell and opened through `cameraPaneStore`, because the Cut
 * step and the status strip are in different trees. Escape and the Close button both close it.
 *
 * THE SOCKET IS THE PANE'S. It is opened while the pane is showing and not paused, and stopped on
 * pause, on close and on unmount: the ESP32 serves a client at a time and starves under load, so a
 * pane left open behind a closed window would be a client nobody is watching.
 *
 * SAVE. The pane is in a browser and the app has no handle on the run record's folder — the record
 * lives beside the `.nc`, which this page can read but not write — so a saved frame is a download,
 * named for the machine and the moment. That is the honest seam today; a desktop save dialog can
 * replace the click without changing anything above it.
 */

import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import {
  cameraStale,
  frameAgeWords,
  frameFileName,
  startCameraStream,
  type CameraState,
} from '@/platform/cameraStream';
import { useMachineCamera } from '@/hooks/useMachineCamera';
import { useCameraPaneStore } from '@/store/cameraPaneStore';
import { useMachineStore } from '@/store/machineStore';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: 0 };
const BUTTON: CSSProperties = { font: 'inherit', fontSize: 11, padding: '3px 10px' };
const STALE = '#f0d79b';

/** A frame kept for the picture AND for saving: the blob outlives the object URL that shows it. */
interface ShownFrame {
  blob: Blob;
  url: string;
  at: number;
}

/** How long a saved frame's temporary URL lives — long enough for the download to start. */
const SAVE_URL_MS = 1000;

function stateWords(state: CameraState, detail: string | null, paused: boolean): string {
  if (paused) return 'paused';
  switch (state) {
    case 'connecting':
      return 'connecting to the camera';
    case 'live':
      return 'live';
    case 'reconnecting':
      return detail === null ? 'reconnecting' : `reconnecting — ${detail}`;
    case 'stopped':
      return detail === null ? 'stopped' : `stopped — ${detail}`;
  }
}

export function CameraPanel(): JSX.Element | null {
  const open = useCameraPaneStore((s) => s.open);
  const close = useCameraPaneStore((s) => s.close);
  const machine = useMachineStore((s) => s.machine);
  const camera = useMachineCamera();
  const [paused, setPaused] = useState(false);
  const [frame, setFrame] = useState<ShownFrame | null>(null);
  // The pane opens onto a socket it is about to open: "connecting" is the honest first word.
  const [state, setState] = useState<CameraState>('connecting');
  const [detail, setDetail] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const shownUrl = useRef<string | null>(null);

  // A frame from the previous opening is still a fact about the bed, with an age; the first frame
  // after resume replaces it. Nothing here clears the picture on pause or on close.
  const cameraUrl = camera?.url ?? null;
  // …but a picture from ANOTHER machine is not this machine's bed, and the labels would say it was.
  // When the machine behind the pane changes, the frame goes with the URL that made it.
  useEffect(() => {
    setFrame(null);
    if (shownUrl.current !== null) {
      URL.revokeObjectURL(shownUrl.current);
      shownUrl.current = null;
    }
  }, [cameraUrl]);
  useEffect(() => {
    if (!open || paused || cameraUrl === null) return;
    const handle = startCameraStream({
      url: cameraUrl,
      onFrame: (f) => {
        const url = URL.createObjectURL(f.jpeg);
        const previous = shownUrl.current;
        shownUrl.current = url;
        setFrame({ blob: f.jpeg, url, at: f.at });
        setNow(f.at);
        if (previous !== null) URL.revokeObjectURL(previous);
      },
      onState: (s, why) => {
        setState(s);
        setDetail(why ?? null);
      },
    });
    return () => handle.stop();
  }, [open, paused, cameraUrl]);

  // The age is a reading, so it moves while the picture does not.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  // The object URL is the pane's own resource: release it when the pane goes away for good.
  useEffect(
    () => () => {
      if (shownUrl.current !== null) URL.revokeObjectURL(shownUrl.current);
      shownUrl.current = null;
    },
    [],
  );

  if (!open) return null;

  const lastFrameAt = frame?.at ?? null;
  const stale = !paused && cameraStale(lastFrameAt, now);
  const host = camera?.host ?? machine?.host ?? null;
  const header = machine?.name ?? 'Camera';

  function saveFrame(): void {
    if (frame === null || host === null) return;
    // A separate URL for the download: revoking this one leaves the live picture untouched.
    const url = URL.createObjectURL(frame.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = frameFileName(host, frame.at);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), SAVE_URL_MS);
  }

  return (
    <div
      data-testid="camera-panel"
      role="dialog"
      aria-label="Camera"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 44,
        width: 'min(520px, calc(100vw - 32px))',
        background: '#1b2027',
        border: '1px solid #2a2f36',
        borderRadius: 6,
        boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
        color: '#c8d3de',
        zIndex: 60,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid #2a2f36' }}>
        <span data-testid="camera-title" style={{ fontSize: 12, fontWeight: 600, color: '#e8eef4' }} title={camera?.source}>
          {header}
        </span>
        {host !== null && (
          <span style={{ fontSize: 11, color: '#8a97a5' }}>{host}</span>
        )}
        <span style={{ flex: '1 1 auto' }} />
        <button type="button" data-testid="camera-close" style={BUTTON} onClick={close}>
          Close
        </button>
      </div>
      {camera === null ? (
        <p data-testid="camera-empty" style={{ ...MUTED, padding: 12 }}>
          {machine === null ? 'No machine is connected.' : 'This machine has no camera.'}
        </p>
      ) : (
        <>
          <div style={{ padding: 8, background: '#0f1318', minHeight: 180, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {frame === null ? (
              <span data-testid="camera-frame-none" style={MUTED}>
                No picture yet.
              </span>
            ) : (
              <img
                data-testid="camera-frame"
                src={frame.url}
                alt="The machine's camera"
                style={{ width: '100%', height: 'auto', display: 'block' }}
              />
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', flexWrap: 'wrap' }}>
            <span data-testid="camera-frame-age" style={{ fontSize: 11, color: stale ? STALE : '#a8b4c0', fontVariantNumeric: 'tabular-nums' }}>
              {frameAgeWords(lastFrameAt, now)}
            </span>
            {stale && (
              <span data-testid="camera-frame-stale" style={{ fontSize: 11, color: STALE }}>
                The stream has stopped sending.
              </span>
            )}
            <span data-testid="camera-state" style={{ fontSize: 11, color: '#8a97a5' }}>
              {stateWords(state, detail, paused)}
            </span>
            <span style={{ flex: '1 1 auto' }} />
            <button
              type="button"
              data-testid="camera-pause"
              style={BUTTON}
              onClick={() => setPaused((p) => !p)}
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button
              type="button"
              data-testid="camera-save"
              style={BUTTON}
              disabled={frame === null}
              onClick={saveFrame}
            >
              Save frame
            </button>
          </div>
        </>
      )}
    </div>
  );
}
