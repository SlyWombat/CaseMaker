/**
 * The Scan door (#309, tracking #212): the box in the user's hand.
 *
 * THE FIELD IS THE FEATURE, AND IT TAKES A SCANNER. A barcode scanner is a keyboard that types a
 * code and presses Enter, so one focused `<input>` covers both a scan and a hunt-and-peck — no
 * library, no mode, no camera required. The camera below is an ADDITION (`BarcodeDetector`, where
 * the browser has it) and never the only way in, which is the constraint #309 states plainly.
 *
 * WHAT A CODE TURNS OUT TO NAME IS DRAWN, NOT HIDDEN. Three outcomes, and the panel never guesses
 * between them: a cutter the inventory already holds (the code names a POSSESSION, so the honest
 * answer is a count, not a second row), catalogue rows that fit the reading (the user picks the one
 * on the label), or nothing (an invitation to the other two doors). The reading itself is labelled
 * provisional, because it is (`registerCutter`, #208 A7).
 */

import { useEffect, useRef, useState } from 'react';
import { useHouseStore } from '@/store/houseStore';
import { useManageModeStore } from '@/store/manageModeStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { useToolRegistry } from '@/hooks/useToolRegistry';
import {
  itemFromEntry,
  quantityOrOne,
  quantityProblem,
  resolveCode,
  type ResolvedCode,
} from '@/engine/cnc/registerCutter';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { InventoryItem } from '@/platform/houseClient';
import { mm } from '../display';
import { InventoryFields } from './InventoryFields';
import { describeReading } from './reading';

/** `BarcodeDetector` is not in the DOM lib's typings, and not in every browser either. */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

function barcodeDetectorCtor(): BarcodeDetectorCtor | null {
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === 'function' ? ctor : null;
}

export function ScanDoor() {
  const items = useToolRegistryStore((s) => s.items);
  const health = useToolRegistryStore((s) => s.health);
  const entries = useToolRegistry();
  const registerItem = useHouseStore((s) => s.registerItem);
  const updateItem = useHouseStore((s) => s.updateItem);
  const busy = useHouseStore((s) => s.busy);
  const setDoor = useManageModeStore((s) => s.setDoor);

  const [code, setCode] = useState('');
  const [symbology, setSymbology] = useState('text');
  const [resolved, setResolved] = useState<ResolvedCode | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [notes, setNotes] = useState('');
  const [camera, setCamera] = useState<'off' | 'on' | 'denied'>('off');

  const fieldRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Focused on mount: a scanner types wherever the caret is, and a door that opens with the caret
  // nowhere means the first scan goes into the void.
  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  /** Everything the three outcomes share: read what was handed over, and close the camera. */
  function handleCode(value: string, from: string) {
    setCode(value);
    setSymbology(from);
    setPicked(null);
    setResolved(resolveCode(value, items, entries));
  }

  function releaseCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCamera('off');
  }

  async function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamera('denied');
      return;
    }
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      setCamera('on');
    } catch {
      setCamera('denied');
    }
  }

  // The decode loop, alive only while the camera is: `handleCode` closes it the moment a code
  // decodes, so a label held in frame is read once rather than once per frame.
  useEffect(() => {
    if (camera !== 'on') return;
    const video = videoRef.current;
    const stream = streamRef.current;
    const Ctor = barcodeDetectorCtor();
    if (!video || !stream || !Ctor) return;
    video.srcObject = stream;
    void video.play().catch(() => {});
    const detector = new Ctor({ formats: ['qr_code'] });
    const timer = window.setInterval(() => {
      void detector
        .detect(video)
        .then((found) => {
          const first = found.find((f) => f.rawValue.trim().length > 0);
          if (first) {
            releaseCamera();
            handleCode(first.rawValue, 'qr');
          }
        })
        .catch(() => {});
    }, 300);
    return () => window.clearInterval(timer);
    // `handleCode` reads the store's current lists through the closure of THIS render; a code read
    // 300 ms later resolving against a list from the render that opened the camera is a stale
    // question, so the effect deliberately re-arms when either list changes (they are `readonly`s
    // from Zustand and the registry, so identity changes only when the contents do).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, items, entries]);

  // Leaving the door must not leave the lamp on.
  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  const pickedEntry = picked ? (entries.find((e) => e.key === picked) ?? null) : null;
  // The count comes from the LIVE list, never from the copy `resolveCode` returned: a write re-reads
  // the inventory, and a sentence about how many the user has that does not move when the count does
  // is a panel lying about the drawer. (This is the bug the browser QA caught — the sentence stayed
  // at "2 on record" after the third box was recorded.)
  const owned = resolved?.kind === 'owned' ? (items.find((i) => i.id === resolved.item.id) ?? resolved.item) : null;
  const qtyProblem = quantityProblem(quantity);
  const disabled = busy !== null;

  function registerPicked(entry: ToolLibraryEntry) {
    void registerItem(
      itemFromEntry(entry, {
        quantity: quantityOrOne(quantity),
        code: code.trim().length > 0 ? { symbology, value: code.trim() } : null,
        notes,
        now: new Date().toISOString(),
        health,
      }),
    );
  }

  return (
    <>
      <label className="lf">
        <span>
          the code on the box <em>scanner or keyboard</em>
        </span>
        <input
          ref={fieldRef}
          className="fld fld--text mono"
          type="text"
          value={code}
          placeholder="C1-BIT-…"
          data-testid="manage-scan-code"
          disabled={disabled}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleCode(code, symbology);
            }
          }}
        />
      </label>

      {barcodeDetectorCtor() !== null && (
        <div className="btn-row">
          <button
            type="button"
            className="btn btn--sm"
            data-testid="manage-scan-camera"
            disabled={disabled}
            onClick={() => (camera === 'off' ? void openCamera() : releaseCamera())}
          >
            {camera === 'off' ? 'Use the camera' : 'Stop the camera'}
          </button>
        </div>
      )}
      {camera === 'on' && (
        <video
          ref={videoRef}
          className="scan-video"
          data-testid="manage-scan-video"
          muted
          playsInline
        />
      )}
      {camera === 'denied' && (
        <p className="hint">The camera is not available here — type the code instead.</p>
      )}

      {owned && <OwnedResult item={owned} onAgain={updateItem} busy={disabled} />}

      {resolved?.kind === 'candidates' && (
        <>
          <p className="hint" data-testid="manage-scan-reading">
            Read as a Makera box code: <b>{describeReading(resolved.prefill)}</b>. The match is drawn
            rather than hidden — <b>
              {resolved.rows.length} row{resolved.rows.length === 1 ? '' : 's'} fit
            </b>{' '}
            — pick the one on the label.
          </p>
          <div className="panel-subhead">Match</div>
          <div className="card">
            {resolved.rows.map((row) => (
              <label className="cand--radio" key={row.key}>
                <input
                  type="radio"
                  name="manage-scan-candidate"
                  checked={picked === row.key}
                  data-testid={`manage-scan-candidate-${row.key}`}
                  disabled={disabled}
                  onChange={() => setPicked(row.key)}
                />
                <span>{row.tool.name}</span>
                <small>
                  flute {mm(row.tool.fluteLength)} · shoulder {mm(row.tool.shoulderLength)}
                </small>
              </label>
            ))}
          </div>
          <InventoryFields
            prefix="manage-scan"
            quantity={quantity}
            notes={notes}
            onQuantity={setQuantity}
            onNotes={setNotes}
            disabled={disabled}
          />
          <div className="btn-row">
            <button
              type="button"
              className="btn btn--primary"
              data-testid="manage-scan-register"
              disabled={pickedEntry === null || qtyProblem !== null || disabled}
              title={qtyProblem ?? 'Register this cutter'}
              onClick={() => pickedEntry && registerPicked(pickedEntry)}
            >
              Add to inventory
            </button>
            <span className="hint" style={{ margin: 0 }}>
              creates an <b>owned</b> row; the definition stays Makera’s
            </span>
          </div>
        </>
      )}

      {resolved?.kind === 'unknown' && (
        <>
          <p className="hint" data-testid="manage-scan-unknown">
            {resolved.prefill
              ? `Read as a Makera box code: ${describeReading(resolved.prefill)} — but no catalogue row fits it.`
              : 'That is not a code this app can read.'}
          </p>
          <p className="hint">
            Not on the list?{' '}
            <button type="button" className="linkish" data-testid="manage-scan-to-catalogue" onClick={() => setDoor('catalogue')}>
              Search the catalogue
            </button>{' '}
            or{' '}
            <button type="button" className="linkish" data-testid="manage-scan-to-type" onClick={() => setDoor('type')}>
              type it
            </button>
            .
          </p>
        </>
      )}
    </>
  );
}

/**
 * The code is on a cutter the inventory already holds. A scan is the user standing at the bench
 * with the box, so "you have one of these" is the answer — and another press is a second copy,
 * which is why it is a button the user presses rather than an increment applied on sight.
 */
function OwnedResult({
  item,
  onAgain,
  busy,
}: {
  item: InventoryItem;
  onAgain: (item: InventoryItem) => Promise<boolean>;
  busy: boolean;
}) {
  return (
    <>
      <div className="panel-subhead">Match</div>
      <p className="hint" data-testid="manage-scan-owned">
        This code is on a cutter you already have — <b>{item.tool.name}</b>,{' '}
        {item.quantity} on record. Recording another box like it adds one.
      </p>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn--primary"
          data-testid="manage-scan-plus-one"
          disabled={busy}
          onClick={() => void onAgain({ ...item, quantity: item.quantity + 1 })}
        >
          Add one more
        </button>
      </div>
    </>
  );
}
