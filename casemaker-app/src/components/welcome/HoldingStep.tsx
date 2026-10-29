/**
 * #681/#684 — step 3 of the one cutting-job wizard: Holding.
 *
 * The step opens on WHAT IS ON THE MACHINE NOW (the location's active bed profile), then asks how
 * THIS stock sits in that mechanism. The options are computed from the stock's numbers by
 * `holdingMounts.ts`: a 3.81 mm plate stands 0.71 mm proud on the 3.1 mm ledge and that is the
 * default; a 2 mm sheet sits below the jaw tops, so a waste board under it is the default and the
 * ledge says why it is not; a block taller than the jaws is gripped as a block. The board under a
 * thin stock is the thinnest one that leaves it proud of the jaw tops, and a board that cannot is
 * still shown, saying how far the stock sits below. The stock's form word (plate/block/sheet)
 * decides nothing here (§3.3's note).
 *
 * THE PICTURE CARRIES THE ORIENTATION FACTS the panel used to print as prose (A10, B4): a top view
 * of the mechanism, a fixed jaw on the left, X between the jaws. The three landmark answers sit in
 * one fold, and only when the stock has a face worth telling apart. They are stated, not offered as
 * controls: this build's single setup is the identity mount, so a select that changed nothing would
 * be a dead control (the A10 rule). See the completion note on #684.
 *
 * THE ESCAPE IS THE REAL WIZARD (#693). An option the installed mechanism cannot give carries its
 * cost and `Change the machine…`, which opens `openMachineChange` over this wizard with the mount
 * that option needs and this job's name; the machine-change wizard is mounted once by AppShell and
 * its backdrop sits at the raised layer of the stacking scale (#348), so it is above this modal.
 * Its `onDone` re-reads the location, which redraws this step with the new bed.
 *
 * The step writes as the answers change (not at a Finish button that no longer exists), so an edit
 * from the panel's Hold `edit` is kept when the operator closes. The #231 proud-vs-thickness case
 * is still shown here, with the seated value that resolves it.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { rotaryStockFits } from '@/engine/cnc/setups/plan';
import { ROTARY_JAW_KEEP_OUT_MM, ROTARY_TAILSTOCK_BAND_MM, type RotaryMap } from '@/engine/cnc/rotary/wrap';
import {
  ROTARY_NECK_LENGTH_MM,
  ROTARY_NECK_MIN_LENGTH_MM,
  defaultRotaryNeck,
  neckEndLabel,
  neckJawClearanceSentence,
  rotaryNeckMinDiameterMm,
  rotaryNeckSpan,
} from '@/engine/cnc/rotary/neck';
import {
  defaultRotaryChuck,
  rodAxisOf,
  stepFindings,
  withVise,
  type SetupAnswers,
} from '@/engine/cnc/engrave/setupFlow';
import { dedupeFindings, validateJob, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { LEDGE_STEP, VISE_FLOOR_DEPTH } from '@/engine/cnc/fixture';
import { jobMachine } from '@/engine/cnc/calibration';
import { formLabel } from '@/engine/cnc/stockStart';
import {
  bracketSettings,
  anchorFrom,
  validateBracketMount,
  type BracketSettings,
  type ClampEdge,
  type ClampPlacement,
} from '@/engine/cnc/mounts/bracket';
import { TAPE_DEFAULTS } from '@/engine/cnc/engrave/jobSetup';
import { KNOWN_DEFAULTS, readDefault } from '@/platform/defaultsClient';
import { canDriveMachine } from '@/platform/capabilities';
import { bedUnderFacts, machineForJob } from '@/platform/bedProfiles';
import { surfaceWords, type MachineMountKind } from '@/platform/machineChange';
import type { BedProfile } from '@/platform/locationClient';
import { useLocationStore } from '@/store/locationStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { NARROW_QUERY } from './wizardLayout';
import { openMachineChange } from '@/components/machine-change';
import type { BracketHold, EngraveJob, JobStockForm, RotaryChuck, RotaryJawMode, RotaryNeck, TapeHold, ViseParams } from '@/types/engraveJob';
import {
  HOLDING_MOUNT_LABELS,
  HOLDING_MOUNT_WORDS,
  applyMount,
  applyRecommendedMount,
  armsAboveStock,
  bedAnchor,
  bedBracketHold,
  bedTapeHold,
  boardChoices,
  boardProvenance,
  clampLabelFor,
  clampPlacementAtPointer,
  clampRectFor,
  currentMount,
  defaultBedBoardMm,
  defaultBedMount,
  defaultBoardMm,
  fmt,
  isBedMount,
  jobHasThroughCut,
  machineNow,
  mechanismOf,
  mountOptions,
  seatedProud,
  centredStockRect,
  stockRectFor,
  tapeStripRects,
  tapeWhereAtPointer,
  tapeWhereWords,
  underFieldWords,
  underWords,
  type BedMount,
  type HoldingMount,
  type MountOption,
  type PictureRect,
} from './holdingMounts';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const FIELD_LABEL: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 12, margin: '2px 0' };
const SEVERITY_COLOR: Record<JobFinding['severity'], string> = { error: '#f0b4ad', warning: '#e0c07a', info: '#7fa6c9' };

/** One finding as the operator reads it: the sentence, never the code. */
function FindingRow({ finding, testid }: { finding: JobFinding; testid: string }): JSX.Element {
  return (
    <div data-testid={testid} style={{ fontSize: 12, lineHeight: 1.45, margin: '3px 0' }}>
      <span style={{ color: SEVERITY_COLOR[finding.severity] }}>● </span>
      {finding.message}
    </div>
  );
}

// ── The picture ────────────────────────────────────────────────────────────────────────────────

const SVG_TEXT = { fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 10, fill: '#d1d5db' } as const;
const SVG_MUTED = { ...SVG_TEXT, fill: '#9aa4b0' } as const;
const SVG_MONO = { fontFamily: 'IBM Plex Mono, monospace', fontSize: 11, fill: '#d1d5db' } as const;

/** #714 — the front view's numbers, from the job's own chuck and rod. */
export interface RotaryPicture {
  diameterMm: number;
  lengthMm: number;
  gripMm: number;
  stickoutMm: number;
  jawMode: RotaryJawMode;
  tailstock: boolean;
}

/** #715 — everything the bed pictures draw and the handles they move, from the job's own model. */
export interface BedPicture {
  surface: BedProfile['surface'] | null;
  tape: TapeHold | null;
  bracket: BracketHold | null;
  /** The board under the part, mm — the dashed slab under the stock. */
  boardMm: number | null;
  /** The bracket's and the clamps' sizes, from the shop's defaults. */
  clamps: BracketSettings;
  /** The clamp the caption names. */
  selectedClamp: number;
  /** Only a selected, enabled bed mount's handles move; a hovered preview is read-only. */
  interactive: boolean;
  onSelectClamp?: (index: number) => void;
  onMoveClamp?: (index: number, placement: ClampPlacement) => void;
  onRemoveClamp?: (index: number) => void;
  /** The tape's expected position, machine XY. */
  onMoveWhere?: (where: { x: number; y: number }) => void;
}

/**
 * #705 — the top view of the mount the step's radio is showing, and a side strip for the height
 * the top view cannot show. The mount decides the drawing (ledge / a waste board / gripped as a
 * block / taped to the bed / the bracket / the chuck), so the picture follows the selection; a
 * disabled option can still be previewed on hover or focus, labelled with what it needs.
 *
 * The stock's FORM decides its outline: a disc, and a rod standing on its end, are round seen
 * from above — the job plans them as the D × D square around them (#683) — so the picture must
 * not draw that square. Every rectangular form keeps the rectangle and its two numbers.
 *
 * #715 — the two bed mounts draw the bed from above as the design's stations 2–3 do: the surface
 * (the wasteboard with its scars, or the bare bed), the stock where it will go, the tape's strips
 * under it, the board under when one is chosen, and for the bracket its two arms, the origin at
 * its corner and each clamp AT ITS PLACE — a handle dragged along its free edge.
 */
export function HoldingPicture({
  mount = 'ledge',
  stock,
  form = null,
  proudMm = null,
  boardMm = null,
  note = null,
  bed = null,
  checks = [],
  rotary = null,
}: {
  mount?: HoldingMount;
  stock: { length: number; width: number; thickness: number };
  form?: JobStockForm | null;
  /** The option's own proud figure, mm; null when its sentence states none. */
  proudMm?: number | null;
  /** The board under the part, mm, when this mount is the waste board. */
  boardMm?: number | null;
  /** A disabled option's one line (why it cannot be chosen), shown beside the drawing. */
  note?: string | null;
  /** #715 — the bed's own model, for the two bed mounts. */
  bed?: BedPicture | null;
  /** #715 — the bed mount's own checks, under the picture. */
  checks?: readonly { severity: 'error' | 'warning' | 'info'; text: string }[];
  /** #714 — the chuck and the rod, for the front view. */
  rotary?: RotaryPicture | null;
}): JSX.Element {
  const mechanism = mechanismOf(mount);
  const round = form === 'disc' || form === 'rod';
  const dims = round ? `⌀ ${fmt(stock.length)}` : `${fmt(stock.length)} × ${fmt(stock.width)}`;
  const formWord = form === 'rod' ? 'rod' : form === 'disc' ? 'disc' : 'blank';
  const rim = round ? ', gripped on its rim' : '';
  const boardName = boardMm === null ? 'a waste board' : `a ${fmt(boardMm)} mm board`;
  const caption = ((): string => {
    switch (mount) {
      case 'ledge':
        return `Top view. The fixed jaw is on the left; the ${formWord} sits on the soft jaws’ ledge${rim}.`;
      case 'board':
        return `Top view. The fixed jaw is on the left; the ${formWord} sits on ${boardName} between the jaws${rim}.`;
      case 'block':
        return `Top view. The fixed jaw is on the left; the ${formWord} is gripped as a block, its sides free.`;
      case 'bed-tape':
        return `Top view. The ${formWord} is taped to the bed; the bed's front edge is nearest you.`;
      case 'bed-bracket':
        return `Top view. The ${formWord} sits in the bed's corner bracket, clamped.`;
      case 'rotary':
        return `Front view. The chuck is on the left; X runs along the ${formWord} from the jaws, and A turns it.`;
    }
  })();

  // #726 W18 — the blank is drawn to ITS OWN aspect. It used to be one fixed 136 × 46 rectangle
  // whatever the stock said, so the badge starter's 38.1 × 76.2 blank (the bench's quarter turn,
  // #383) drew LONG ALONG X — the opposite of its own numbers, and the same picture a typed
  // 76.2 × 38.1 blank gets. Now the longer side is the longer side: the jaws close on the blank's
  // X ends (a narrow blank moves them inward), and the dims run along the blank when it is too
  // narrow to hold them across.
  const drawn = ((): { w: number; h: number; x: number; y: number } => {
    const maxW = 136;
    const maxH = 88;
    const scale = Math.min(maxW / Math.max(stock.length, 0.001), maxH / Math.max(stock.width, 0.001));
    const w = Math.max(18, Math.min(maxW, stock.length * scale));
    const h = Math.max(14, Math.min(maxH, stock.width * scale));
    return { w, h, x: 120 - w / 2, y: 75 - h / 2 };
  })();
  const jawW = 34;
  const fixedJawX = Math.max(2, drawn.x - jawW);
  const movingJawX = Math.min(240 - 2 - jawW, drawn.x + drawn.w);
  const dimsAlongY = drawn.w < 70;
  const viseStock = round ? (
    <circle cx="120" cy="75" r="30" fill="#1e3a4a" stroke="#6aa6c9" strokeWidth="1.5" />
  ) : (
    <rect
      data-testid="engrave-setup-holding-picture-stock"
      x={drawn.x}
      y={drawn.y}
      width={drawn.w}
      height={drawn.h}
      fill="#1e3a4a"
      stroke="#6aa6c9"
      strokeWidth="1.5"
    />
  );

  // #715 — the two bed mounts draw their scene, and its handles, from the bed's own model.
  if (mechanism === 'bed') {
    const selected =
      bed !== null && mount === 'bed-bracket' && bed.bracket !== null
        ? bed.bracket.clamps[Math.min(bed.selectedClamp, bed.bracket.clamps.length - 1)] ?? null
        : null;
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        <BedTopView mount={mount as BedMount} stock={stock} form={form} bed={bed} />
        <p className="hint" style={{ margin: 0 }} data-testid="engrave-setup-holding-caption">
          {caption}
        </p>
        {selected !== null && bed !== null && (
          <p style={{ fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: 0 }} data-testid="engrave-setup-holding-clamp-label">
            Selected clamp: <b style={{ color: '#d1d5db' }}>{clampLabelFor(stock, selected, bed.clamps)}</b>. Drag it along the edge,
            {/* #725 P9 — the corner leads to the OTHER free edge: a clamp already on the right edge
                is not offered "onto the right edge". */}
            {' '}round the corner onto the {selected.edge === 'right' ? 'back' : 'right'} edge
            {bed.interactive && bed.bracket !== null && bed.bracket.clamps.length > 1 && (
              <>
                , or{' '}
                <button
                  type="button"
                  className="btn btn--sm"
                  data-testid="engrave-setup-clamp-remove"
                  onClick={() => bed.onRemoveClamp?.(bed.selectedClamp)}
                >
                  remove
                </button>
              </>
            )}
            .
          </p>
        )}
        {checks.length > 0 && (
          <div data-testid="engrave-setup-holding-checks" style={{ display: 'grid', gap: 2 }}>
            {checks.map((c, i) => (
              <p
                key={i}
                style={{
                  fontSize: 11,
                  lineHeight: 1.45,
                  margin: 0,
                  color: c.severity === 'error' ? '#f0b4ad' : c.severity === 'warning' ? '#e0c07a' : '#9aa4b0',
                }}
              >
                {c.text}
              </p>
            ))}
          </div>
        )}
        <HoldingSideView mount={mount} proudMm={proudMm} surface={bed?.surface ?? null} />
        {note !== null && (
          <p className="hint" style={{ margin: 0 }} data-testid="engrave-setup-holding-note">
            {note}
          </p>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <svg
        viewBox="0 0 240 150"
        style={{ width: '100%', maxWidth: '100%', display: 'block', border: '1px solid #2a2f36', background: '#10151b' }}
        role="img"
        aria-label={`Top view of the ${mechanism === 'rotary' ? 'rotary' : 'vise'}`}
        data-testid="engrave-setup-holding-picture"
        data-mechanism={mechanism}
        data-mount={mount}
        data-form={form ?? undefined}
      >
        <defs>
          <marker id="holding-x-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0 0 L6 3 L0 6 Z" fill="#d1d5db" />
          </marker>
        </defs>
        {mechanism === 'vise' ? (
          <>
            <rect x={fixedJawX} y="30" width={jawW} height="90" fill="#5b6672" />
            <rect x={movingJawX} y="30" width={jawW} height="90" fill="#39424c" stroke="#5b6672" />
            {mount === 'board' && (
              <rect
                data-testid="engrave-setup-holding-picture-board"
                x={drawn.x - 10}
                y={drawn.y - 10}
                width={drawn.w + 20}
                height={drawn.h + 20}
                fill="#3a3325"
                stroke="#7a6a45"
                strokeWidth="1"
              />
            )}
            {viseStock}
            <text
              x="120"
              y="79"
              textAnchor="middle"
              {...SVG_MONO}
              transform={dimsAlongY ? 'rotate(-90 120 79)' : undefined}
            >
              {dims}
            </text>
            <text x={fixedJawX + jawW / 2} y="22" textAnchor="middle" {...SVG_MUTED}>
              fixed jaw
            </text>
            <text x={movingJawX + jawW / 2} y="22" textAnchor="middle" {...SVG_MUTED}>
              moving jaw
            </text>
            <path d="M60 128 H180" stroke="#d1d5db" strokeWidth="1" markerEnd="url(#holding-x-arrow)" />
            <text x="120" y="142" textAnchor="middle" {...SVG_TEXT}>
              X runs between the jaws
            </text>
            <path d="M232 100 V60" stroke="#d1d5db" strokeWidth="1" />
            <text x="236" y="80" {...SVG_TEXT} transform="rotate(90 236 80)">
              Y
            </text>
          </>
        ) : (
          <RotaryFrontView
            rotary={
              rotary ?? {
                diameterMm: stock.width,
                lengthMm: stock.thickness,
                gripMm: 0,
                stickoutMm: stock.thickness,
                jawMode: 'standard',
                tailstock: true,
              }
            }
          />
        )}
      </svg>
      <p className="hint" style={{ margin: 0 }} data-testid="engrave-setup-holding-caption">
        {caption}
      </p>
      <HoldingSideView mount={mount} proudMm={proudMm} />
      {note !== null && (
        <p className="hint" style={{ margin: 0 }} data-testid="engrave-setup-holding-note">
          {note}
        </p>
      )}
    </div>
  );
}

// ── #714: the front view — looking along Y at the X–Z plane the cutter lives in ───────────────

/**
 * The rotary job's front view (design §3.4, station 3): the chuck on the left with its jaws and the
 * GRIP, the rod with its STICK-OUT, the tailstock on the right where it is in, X from the jaws and
 * the A arrow around the rod. The diameter is drawn to a readable height, not to scale — the
 * lengths along X are scaled together, so grip and stick-out compare honestly.
 */
function RotaryFrontView({ rotary }: { rotary: RotaryPicture }): JSX.Element {
  const length = Math.max(0.1, rotary.lengthMm);
  const scale = Math.min(1.5, 150 / length);
  const gripPx = Math.max(0, Math.min(rotary.gripMm, length)) * scale;
  const stickoutPx = Math.max(0, Math.min(rotary.stickoutMm, length)) * scale;
  const jawFace = 52;
  const rodStart = jawFace;
  const rodEnd = Math.min(228, rodStart + stickoutPx);
  const rodTop = 62;
  const rodBottom = 84;
  const tail = rotary.tailstock;
  return (
    <>
      {/* The chuck block and its two jaws; the grip sits inside them. */}
      <rect x="12" y="40" width="30" height="70" fill="#39424c" stroke="#5b6672" />
      <rect x={jawFace - 8} y={rodTop - 12} width="8" height="14" fill="#5b6672" />
      <rect x={jawFace - 8} y={rodBottom - 2} width="8" height="14" fill="#5b6672" />
      <text x="27" y="126" textAnchor="middle" {...SVG_MUTED}>
        chuck
      </text>
      {/* The rod, and the grip hidden in the jaws. */}
      <rect x={Math.max(20, rodStart - gripPx)} y={rodTop} width={rodEnd - Math.max(20, rodStart - gripPx)} height={rodBottom - rodTop} fill="#1e3a4a" stroke="#6aa6c9" strokeWidth="1.5" />
      <text x={(rodStart + rodEnd) / 2} y={(rodTop + rodBottom) / 2 + 4} textAnchor="middle" {...SVG_MONO}>
        rod ⌀{fmt(rotary.diameterMm)}
      </text>
      {/* The grip and the stick-out, under the rod. */}
      <path d={`M${rodStart - gripPx} 96 H${rodStart}`} stroke="#9aa4b0" strokeWidth="1" />
      <text x={rodStart - gripPx} y="108" {...SVG_MUTED}>
        grip {fmt(rotary.gripMm)} mm
      </text>
      <path d={`M${rodStart} 118 H${rodEnd}`} stroke="#d1d5db" strokeWidth="1" markerEnd="url(#holding-x-arrow)" />
      <text x={(rodStart + rodEnd) / 2} y="114" textAnchor="middle" {...SVG_TEXT}>
        stick-out {fmt(rotary.stickoutMm)} mm
      </text>
      {/* The tailstock, where it is in. */}
      {tail ? (
        <>
          <path d={`M${rodEnd + 12} ${rodTop} L${rodEnd} ${(rodTop + rodBottom) / 2} L${rodEnd + 12} ${rodBottom} Z`} fill="#39424c" stroke="#5b6672" />
          <text x={rodEnd + 4} y="126" {...SVG_MUTED}>
            tailstock
          </text>
        </>
      ) : null}
      {/* X from the jaws, and A around the rod. */}
      <path d={`M${rodStart} 138 H228`} stroke="#d1d5db" strokeWidth="1" markerEnd="url(#holding-x-arrow)" />
      <text x={rodStart} y="150" {...SVG_MUTED}>
        X 0 at the jaws
      </text>
      <path d={`M${(rodStart + rodEnd) / 2 - 14} ${rodTop - 8} a 14 8 0 1 0 28 0`} fill="none" stroke="#6aa6c9" strokeWidth="1" markerEnd="url(#holding-x-arrow)" />
      <text x={(rodStart + rodEnd) / 2} y="44" textAnchor="middle" {...SVG_TEXT}>
        A turns the rod about X
      </text>
    </>
  );
}

// ── The pictures' palette, shared by the mount picture and the orientation fold ───────────────

const VB = { w: 300, h: 230 } as const;
const STOCK_FILL = '#1e3a4a';
const STOCK_EDGE = '#6aa6c9';
const FIXTURE_FILL = '#39424c';
const FIXTURE_EDGE = '#5b6672';
const TAPE_FILL = '#d8c48a';
const BOARD_FILL = '#3a3325';
const BOARD_EDGE = '#7a6a45';
const SCAR_EDGE = '#44505c';
/** The one colour that is not the stock's or the fixture's: "this is the edge/face I mean". */
const LANDMARK_EDGE = '#e0c07a';

// ── #698: the orientation fold's three landmarks ──────────────────────────────────────────────

/** The three stated orientation facts a rectangular blank has in the vise (#698's decision). */
type OrientationLandmark = 'face-up' | 'fixed-jaw' | 'nearest';

/**
 * #698 — the orientation fold is the operator's bench instruction, so its pictures are drawn in
 * the SAME frame as the step's own top view: X left-right between the jaws, the FIXED JAW on the
 * LEFT, and the operator's front at the BOTTOM. The stock keeps its own aspect (the badge blank
 * is 38.1 mm across the jaws and 76.2 mm along them, #383), so the left edge is the long edge for
 * the blank this fold is usually about.
 *
 * The three facts are stated, not chosen: the job document has no orientation field (#698), so
 * there is no select here (A10, no dead controls). The pictures only show what the words say.
 */
function OrientationPicture({
  landmark,
  stock,
  faceWord,
}: {
  landmark: OrientationLandmark;
  stock: { length: number; width: number; thickness: number };
  faceWord: string;
}): JSX.Element {
  const view = { w: 120, h: 86 } as const;
  const svgStyle = {
    width: '100%',
    maxWidth: '100%',
    display: 'block',
    border: '1px solid #2a2f36',
    background: '#10151b',
  } as const;
  const caption =
    landmark === 'face-up'
      ? `Side view: the ${faceWord} is on top, where the cutter reaches it.`
      : landmark === 'fixed-jaw'
        ? 'Top view: the fixed jaw is on the left, and the stock’s left edge is flat against it.'
        : 'Top view: the fixed jaw is on the left; the stock’s front edge is at the bottom, nearest you.';

  if (landmark === 'face-up') {
    // A SIDE view: the printed/finished layer is the top of the stock, and the cutter is above it.
    return (
      <svg
        viewBox={`0 0 ${view.w} ${view.h}`}
        style={svgStyle}
        role="img"
        aria-label={caption}
        data-testid="engrave-setup-orientation-picture-face-up"
        data-landmark={landmark}
      >
        {/* The cutter, above the face the operator must turn up. */}
        <rect data-role="cutter" x="52" y="2" width="16" height="7" fill={FIXTURE_FILL} stroke={FIXTURE_EDGE} />
        <path d="M56 9 L60 18 L64 9 Z" fill={FIXTURE_FILL} stroke={FIXTURE_EDGE} />
        <text x="72" y="9" {...SVG_MUTED} fontSize={8.5}>
          cutter
        </text>
        {/* Up, from the face to the cutter. */}
        <path
          data-role="face-up-arrow"
          d="M60 42 V26 M55 31 L60 24 L65 31"
          fill="none"
          stroke="#d1d5db"
          strokeWidth={1.2}
        />
        <text x="67" y="40" {...SVG_MUTED} fontSize={8.5}>
          up
        </text>
        {/* The stock, its printed or finished layer on top. */}
        <rect
          data-role="stock-slab"
          x="10"
          y="46"
          width="100"
          height="22"
          fill={STOCK_FILL}
          stroke={STOCK_EDGE}
          strokeWidth={1.5}
        />
        <rect data-role="face-layer" x="10" y="46" width="100" height="6" fill={STOCK_EDGE} fillOpacity={0.45} />
        <text x="60" y="64" textAnchor="middle" {...SVG_TEXT} fontSize={9}>
          {faceWord}
        </text>
      </svg>
    );
  }

  // The two TOP views share one scene: the fixed jaw on the left, the stock in its own aspect,
  // the moving jaw on the right. The landmark's own edge is the one in LANDMARK_EDGE.
  const maxW = 44;
  const maxH = 48;
  const scale = Math.min(maxW / Math.max(stock.length, 0.001), maxH / Math.max(stock.width, 0.001));
  const w = Math.max(12, Math.min(maxW, stock.length * scale));
  const h = Math.max(12, Math.min(maxH, stock.width * scale));
  const start = (view.w - (16 + w + 16)) / 2;
  const y = 10 + (maxH - h) / 2;
  const stockX = start + 16;
  const movingX = stockX + w;
  const bottom = y + h;
  const jawLabel = { ...SVG_MUTED, fontSize: 8 } as const;
  const scene = (
    <>
      <rect data-role="fixed-jaw" x={start} y={y} width="16" height={h} fill={FIXTURE_EDGE} />
      <text x={start + 8} y="7" textAnchor="middle" {...jawLabel}>
        fixed jaw
      </text>
      <rect
        data-role="stock"
        x={stockX}
        y={y}
        width={w}
        height={h}
        fill={STOCK_FILL}
        stroke={STOCK_EDGE}
        strokeWidth={1.5}
      />
      <rect
        data-role="moving-jaw"
        x={movingX}
        y={y}
        width="16"
        height={h}
        fill={FIXTURE_FILL}
        stroke={FIXTURE_EDGE}
      />
      <text x={movingX + 8} y="7" textAnchor="middle" {...jawLabel}>
        moving
      </text>
    </>
  );

  if (landmark === 'fixed-jaw') {
    return (
      <svg
        viewBox={`0 0 ${view.w} ${view.h}`}
        style={svgStyle}
        role="img"
        aria-label={caption}
        data-testid="engrave-setup-orientation-picture-fixed-jaw"
        data-landmark={landmark}
      >
        {scene}
        {/* The stock's LEFT edge, pressed flat on the fixed jaw (the jaw itself does not move). */}
        <line
          data-role="left-edge"
          x1={stockX}
          y1={y}
          x2={stockX}
          y2={bottom}
          stroke={LANDMARK_EDGE}
          strokeWidth={3}
          strokeLinecap="round"
        />
        <text x={view.w / 2} y="76" textAnchor="middle" {...SVG_TEXT} fontSize={9}>
          left edge
        </text>
      </svg>
    );
  }

  // Nearest you: the front edge is the BOTTOM of the top view, and the operator stands below it.
  const centre = stockX + w / 2;
  return (
    <svg
      viewBox={`0 0 ${view.w} ${view.h}`}
      style={svgStyle}
      role="img"
      aria-label={caption}
      data-testid="engrave-setup-orientation-picture-nearest"
      data-landmark={landmark}
    >
      {scene}
      <line
        data-role="front-edge"
        x1={stockX}
        y1={bottom}
        x2={movingX}
        y2={bottom}
        stroke={LANDMARK_EDGE}
        strokeWidth={3}
        strokeLinecap="round"
      />
      <text x={centre} y={bottom - 5} textAnchor="middle" {...SVG_TEXT} fontSize={8}>
        front
      </text>
      {/* The operator, at the front of the machine — below the near edge, never to its left. */}
      <circle data-role="operator" cx={centre} cy="70" r="4" fill="#9aa4b0" />
      <path
        d={`M${centre - 8} 84 Q${centre} 74 ${centre + 8} 84`}
        fill="none"
        stroke="#9aa4b0"
        strokeWidth={1.2}
      />
      <text x={centre + 10} y="76" {...SVG_MUTED} fontSize={8}>
        nearest you
      </text>
    </svg>
  );
}

// ── #715: the bed from above, with its handles ─────────────────────────────────────────────────

/** The surface footprint the picture can place the stock on, when the record states one. */
function footprintOf(
  surface: BedProfile['surface'] | null,
): { length: number; width: number; frontLeft: [number, number] } | null {
  if (surface === null || surface.length === null || surface.width === null || surface.position === null) return null;
  return { length: surface.length, width: surface.width, frontLeft: surface.position.frontLeft };
}

/** Fit a surface of this size inside `frame`, its aspect kept and centred. */
function fitWithin(frame: PictureRect, size: { length: number; width: number }): PictureRect {
  const scale = Math.min(frame.w / Math.max(size.length, 1e-9), frame.h / Math.max(size.width, 1e-9));
  const w = size.length * scale;
  const h = size.width * scale;
  return { x: frame.x + (frame.w - w) / 2, y: frame.y + (frame.h - h) / 2, w, h };
}

/** `rect` grown by `pad` px on every side, never past `within`. */
function expandWithin(rect: PictureRect, within: PictureRect, pad: number): PictureRect {
  const x = Math.max(within.x, rect.x - pad);
  const y = Math.max(within.y, rect.y - pad);
  return {
    x,
    y,
    w: Math.min(within.x + within.w, rect.x + rect.w + pad) - x,
    h: Math.min(within.y + within.h, rect.y + rect.h + pad) - y,
  };
}

/** Keep the drag's pointer on this element, so its release is seen outside the picture too. */
function capturePointer(e: ReactPointerEvent<SVGElement>): void {
  (e.currentTarget as Element & { setPointerCapture?: (id: number) => void }).setPointerCapture?.(e.pointerId);
}

/** A pointer event in the picture's own units (the viewBox), from the element's client rect. */
function picturePoint(svg: SVGSVGElement, e: ReactPointerEvent): { px: number; py: number } {
  const r = svg.getBoundingClientRect();
  const sx = r.width === 0 ? 1 : VB.w / r.width;
  const sy = r.height === 0 ? 1 : VB.h / r.height;
  return { px: (e.clientX - r.left) * sx, py: (e.clientY - r.top) * sy };
}

/**
 * The bed seen from above: the surface (the wasteboard with its scars, or the bare bed), the stock
 * where it will go, the tape's strips dashed under it (taped) or the bracket's arms and each clamp
 * at its place (bracket). The handles are the model: dragging the stock writes its expected
 * position; dragging a clamp moves it along the free edge it is nearest, round the corner included.
 */
function BedTopView({
  mount,
  stock,
  form,
  bed,
}: {
  mount: BedMount;
  stock: { length: number; width: number; thickness: number };
  form: JobStockForm | null;
  bed: BedPicture | null;
}): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ kind: 'clamp'; index: number } | { kind: 'where' } | null>(null);
  const [liveClamp, setLiveClamp] = useState<ClampPlacement | null>(null);
  const [liveWhere, setLiveWhere] = useState<{ x: number; y: number } | null>(null);
  const interactive = bed?.interactive === true;
  const surface = bed?.surface ?? null;
  const footprint = footprintOf(surface);
  const tape = bed?.tape ?? null;
  const bracket = bed?.bracket ?? null;
  const settings = bed?.clamps ?? bracketSettings(null).settings;
  const boardMm = bed?.boardMm ?? null;
  const dims =
    form === 'disc' || form === 'rod' ? `⌀ ${fmt(stock.length)}` : `${fmt(stock.length)} × ${fmt(stock.width)}`;
  const formWord = form === 'rod' ? 'rod' : form === 'disc' ? 'disc' : 'blank';
  // #705 — a disc, and a rod on end, are round seen from above: the picture draws the circle.
  const round = form === 'disc' || form === 'rod';

  const end = (): void => {
    setDrag(null);
    setLiveClamp(null);
    setLiveWhere(null);
  };
  const move = (e: ReactPointerEvent): void => {
    if (drag === null || svgRef.current === null) return;
    const { px, py } = picturePoint(svgRef.current, e);
    if (drag.kind === 'clamp') setLiveClamp(clampPlacementAtPointer(stockRect, stock, px, py));
    else if (footprint !== null) setLiveWhere(tapeWhereAtPointer(surfaceRect, stock, footprint, px, py));
  };
  const release = (): void => {
    if (drag === null) {
      end();
      return;
    }
    if (drag.kind === 'clamp' && liveClamp !== null) bed?.onMoveClamp?.(drag.index, liveClamp);
    else if (drag.kind === 'where' && liveWhere !== null) bed?.onMoveWhere?.(liveWhere);
    end();
  };

  // The surface's rect: its stated footprint fitted into the frame, or the whole bed when the
  // record states no size (the bare bed has none).
  const frame: PictureRect =
    mount === 'bed-tape' ? { x: 18, y: 14, w: 264, h: 192 } : { x: 52, y: 26, w: 236, h: 168 };
  const surfaceRect: PictureRect = footprint === null ? frame : fitWithin(frame, footprint);
  const stockRect: PictureRect =
    mount === 'bed-tape'
      ? footprint === null
        ? centredStockRect(surfaceRect, stock, 0.55)
        : stockRectFor(surfaceRect, stock, footprint, liveWhere ?? tape?.where ?? null)
      : (() => {
          const scale = Math.min(
            Math.max(frame.w - 12, 1) / Math.max(stock.length, 1e-9),
            Math.max(frame.h - 12, 1) / Math.max(stock.width, 1e-9),
          );
          return { x: frame.x + 10, y: frame.y, w: stock.length * scale, h: stock.width * scale };
        })();

  const scars =
    mount === 'bed-tape' && footprint !== null && surface !== null
      ? surface.scars.map((s, i) => {
          const sx = surfaceRect.w / Math.max(footprint.length, 1e-9);
          const sy = surfaceRect.h / Math.max(footprint.width, 1e-9);
          return {
            key: i,
            x: surfaceRect.x + (s.x - footprint.frontLeft[0]) * sx,
            y: surfaceRect.y + surfaceRect.h - (s.y - footprint.frontLeft[1] + s.height) * sy,
            w: s.width * sx,
            h: s.height * sy,
          };
        })
      : [];

  const armPx = Math.max(6, settings.armWidth * (stockRect.w / Math.max(stock.length, 1e-9)));
  const clampRects =
    mount === 'bed-bracket' && bracket !== null
      ? bracket.clamps.map((p, i) => ({
          key: i,
          placement: drag?.kind === 'clamp' && drag.index === i && liveClamp !== null ? liveClamp : p,
          rect: clampRectFor(stockRect, stock, settings.clamp, drag?.kind === 'clamp' && drag.index === i && liveClamp !== null ? liveClamp : p),
        }))
      : [];

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VB.w} ${VB.h}`}
      style={{
        width: '100%',
        maxWidth: '100%',
        display: 'block',
        border: '1px solid #2a2f36',
        background: '#10151b',
        touchAction: 'none',
        cursor: drag === null ? 'default' : 'grabbing',
      }}
      role="img"
      aria-label={`Top view of the bed with the ${formWord}`}
      data-testid="engrave-setup-holding-picture"
      data-mechanism="bed"
      data-mount={mount}
      data-form={form ?? undefined}
      onPointerMove={move}
      onPointerUp={release}
      onPointerCancel={end}
    >
        <rect
          data-testid="engrave-setup-holding-picture-surface"
          data-surface={surface?.kind ?? 'bare-bed'}
          x={surfaceRect.x}
          y={surfaceRect.y}
          width={surfaceRect.w}
          height={surfaceRect.h}
          fill="#141a21"
          stroke={FIXTURE_EDGE}
        />
        <text x={surfaceRect.x + 6} y={surfaceRect.y + 12} {...SVG_MUTED}>
          {surface === null || surface.kind === 'bare-bed' ? 'bed' : surfaceWords(surface).replace(' under', '')}
        </text>
        {scars.map((s) => (
          <rect key={s.key} x={s.x} y={s.y} width={s.w} height={s.h} fill="none" stroke={SCAR_EDGE} strokeDasharray="2 2" />
        ))}
        {mount === 'bed-tape' ? (
          <>
            {boardMm !== null && footprint !== null && (
              <rect
                data-testid="engrave-setup-holding-picture-board"
                x={expandWithin(stockRect, surfaceRect, 4).x}
                y={expandWithin(stockRect, surfaceRect, 4).y}
                width={expandWithin(stockRect, surfaceRect, 4).w}
                height={expandWithin(stockRect, surfaceRect, 4).h}
                fill={BOARD_FILL}
                stroke={BOARD_EDGE}
              />
            )}
            {round ? (
              <ellipse
                cx={stockRect.x + stockRect.w / 2}
                cy={stockRect.y + stockRect.h / 2}
                rx={stockRect.w / 2}
                ry={stockRect.h / 2}
                fill={STOCK_FILL}
                stroke={STOCK_EDGE}
                strokeWidth={1.5}
                style={interactive && footprint !== null ? { cursor: 'grab' } : undefined}
                onPointerDown={(e) => {
                  if (!interactive || footprint === null) return;
                  e.preventDefault();
                  capturePointer(e);
                  setDrag({ kind: 'where' });
                }}
              />
            ) : (
              <rect
                x={stockRect.x}
                y={stockRect.y}
                width={stockRect.w}
                height={stockRect.h}
                fill={STOCK_FILL}
                stroke={STOCK_EDGE}
                strokeWidth={1.5}
                style={interactive && footprint !== null ? { cursor: 'grab' } : undefined}
                onPointerDown={(e) => {
                  if (!interactive || footprint === null) return;
                  e.preventDefault();
                  capturePointer(e);
                  setDrag({ kind: 'where' });
                }}
              />
            )}
            {tape !== null &&
              tapeStripRects(stockRect, stock, tape)
                .filter((r) => r.w > 0 && r.h > 0)
                .map((r, i) => (
                  <rect
                    key={i}
                    data-testid="engrave-setup-holding-picture-tape"
                    x={r.x}
                    y={r.y}
                    width={r.w}
                    height={r.h}
                    fill={TAPE_FILL}
                    opacity={0.55}
                    stroke={TAPE_FILL}
                    strokeDasharray="3 2"
                  />
                ))}
            <text x={stockRect.x + stockRect.w / 2} y={stockRect.y + stockRect.h / 2 + 4} textAnchor="middle" {...SVG_MONO}>
              {dims}
            </text>
            <path
              d={`M${stockRect.x} ${stockRect.y + stockRect.h + 16} H${stockRect.x + stockRect.w}`}
              stroke="#d1d5db"
              strokeDasharray="3 3"
            />
            <text x={stockRect.x + stockRect.w / 2} y={stockRect.y + stockRect.h + 28} textAnchor="middle" {...SVG_TEXT}>
              square to the front edge
            </text>
          </>
        ) : (
          <>
            {/* The bracket: its left and front arms outside the stock's front-left corner. */}
            <rect x={stockRect.x - armPx} y={stockRect.y} width={armPx} height={stockRect.h + armPx} fill={FIXTURE_FILL} stroke={FIXTURE_EDGE} />
            <rect x={stockRect.x - armPx} y={stockRect.y + stockRect.h} width={stockRect.w + armPx} height={armPx} fill={FIXTURE_FILL} stroke={FIXTURE_EDGE} />
            {boardMm !== null && (
              <rect
                data-testid="engrave-setup-holding-picture-board"
                x={stockRect.x - 3}
                y={stockRect.y - 3}
                width={stockRect.w + 6}
                height={stockRect.h + 6}
                fill={BOARD_FILL}
                stroke={BOARD_EDGE}
              />
            )}
            {round ? (
              <ellipse
                cx={stockRect.x + stockRect.w / 2}
                cy={stockRect.y + stockRect.h / 2}
                rx={stockRect.w / 2}
                ry={stockRect.h / 2}
                fill={STOCK_FILL}
                stroke={STOCK_EDGE}
                strokeWidth={1.5}
              />
            ) : (
              <rect
                x={stockRect.x}
                y={stockRect.y}
                width={stockRect.w}
                height={stockRect.h}
                fill={STOCK_FILL}
                stroke={STOCK_EDGE}
                strokeWidth={1.5}
              />
            )}
            <text x={stockRect.x - armPx / 2} y={stockRect.y + stockRect.h / 2} textAnchor="middle" transform={`rotate(-90 ${stockRect.x - armPx / 2} ${stockRect.y + stockRect.h / 2})`} {...SVG_MUTED}>
              left arm
            </text>
            <text x={stockRect.x + stockRect.w / 2 - armPx} y={stockRect.y + stockRect.h + armPx - 2} textAnchor="middle" {...SVG_MUTED}>
              front arm
            </text>
            <text x={stockRect.x + stockRect.w / 2} y={stockRect.y + stockRect.h / 2 + 4} textAnchor="middle" {...SVG_MONO}>
              {dims}
            </text>
            {clampRects.map((c) => (
              <rect
                key={c.key}
                data-testid="engrave-setup-holding-picture-clamp"
                data-edge={c.placement.edge}
                data-at={c.placement.at}
                x={c.rect.x}
                y={c.rect.y}
                width={c.rect.w}
                height={c.rect.h}
                fill={FIXTURE_FILL}
                stroke={bed?.selectedClamp === c.key ? '#6aa6c9' : FIXTURE_EDGE}
                strokeWidth={bed?.selectedClamp === c.key ? 2 : 1}
                style={interactive ? { cursor: 'grab' } : undefined}
                onPointerDown={(e) => {
                  if (!interactive) return;
                  e.preventDefault();
                  capturePointer(e);
                  bed?.onSelectClamp?.(c.key);
                  setDrag({ kind: 'clamp', index: c.key });
                }}
              />
            ))}
            <circle cx={stockRect.x} cy={stockRect.y + stockRect.h} r={4} fill="#f08a83" />
            <text x={stockRect.x + 8} y={stockRect.y + stockRect.h - 6} {...SVG_TEXT}>
              X 0 · Y 0 at the bracket’s corner
            </text>
            <text
              x={stockRect.x + stockRect.w + 14}
              y={stockRect.y + stockRect.h / 2}
              textAnchor="middle"
              transform={`rotate(90 ${stockRect.x + stockRect.w + 14} ${stockRect.y + stockRect.h / 2})`}
              {...SVG_MUTED}
            >
              right edge — free
            </text>
          </>
        )}
        <text x={VB.w - 12} y={VB.h - 8} textAnchor="end" {...SVG_TEXT}>
          front · you
        </text>
    </svg>
  );
}

/**
 * #705 — the height the top view cannot show, as a side strip. A SCHEMATIC: the jaw block and the
 * ledge/board/floor seat, the stock above it, and the proud figure the option's own sentence
 * states (or, for a block, how far its top stands above the vise floor). The bed mounts show the
 * bed and their fixing; the rotary its chuck.
 */
function HoldingSideView({
  mount,
  proudMm,
  surface = null,
}: {
  mount: HoldingMount;
  proudMm: number | null;
  /** #725 P8 — the surface under the stock, so the slab is labelled what it IS (the wasteboard). */
  surface?: BedProfile['surface'] | null;
}): JSX.Element {
  const mechanism = mechanismOf(mount);
  const proudWords =
    proudMm === null
      ? mount === 'bed-tape'
        ? 'Taped to the bed'
        : mount === 'bed-bracket'
          ? 'Corner bracket and clamps'
          : mount === 'rotary'
            ? 'In the chuck, along X'
            : null
      : mount === 'block'
        ? proudMm >= 0
          ? `sides free · ${fmt(proudMm)} mm above the vise floor`
          : `sides free · the top ${fmt(-proudMm)} mm below the jaw tops`
        : proudMm >= 0
          ? `${fmt(proudMm)} mm proud of the jaws`
          : `still ${fmt(-proudMm)} mm below the jaw tops`;
  return (
    <div style={{ display: 'grid', gap: 3 }}>
      <svg
        viewBox="0 0 240 70"
        style={{ width: '100%', maxWidth: '100%', display: 'block', border: '1px solid #2a2f36', background: '#10151b' }}
        role="img"
        aria-label="Side view: how the stock sits in the mount"
        data-testid="engrave-setup-holding-side"
        data-mount={mount}
      >
        {mechanism === 'vise' ? (
          <>
            {/* The jaw block; its top is the jaw top the proud figure is measured from. */}
            <rect x="36" y="26" width="168" height="30" fill="#39424c" stroke="#5b6672" />
            {mount === 'board' && (
              <rect
                data-testid="engrave-setup-holding-side-board"
                x="82"
                y="30"
                width="76"
                height="8"
                fill="#3a3325"
                stroke="#7a6a45"
              />
            )}
            <rect
              x="94"
              y={mount === 'block' ? 2 : 10}
              width="52"
              height={mount === 'block' ? 42 : 20}
              fill="#1e3a4a"
              stroke="#6aa6c9"
            />
            <path d="M212 26 V10" stroke="#d1d5db" strokeWidth="1" />
            <text x="120" y="66" textAnchor="middle" {...SVG_MUTED}>
              jaws
            </text>
          </>
        ) : mechanism === 'bed' ? (
          <>
            <rect x="24" y="48" width="192" height="10" fill="#141a21" stroke="#5b6672" />
            {mount === 'bed-tape' ? (
              <path d="M86 48 v-8 M154 48 v-8" stroke="#d8c48a" strokeWidth="5" />
            ) : (
              <>
                <path d="M24 40 h22 v8" fill="none" stroke="#5b6672" strokeWidth="4" />
                <rect x="60" y="36" width="16" height="8" fill="#5b6672" />
                <rect x="164" y="36" width="16" height="8" fill="#5b6672" />
              </>
            )}
            <rect x="86" y="20" width="68" height="28" fill="#1e3a4a" stroke="#6aa6c9" />
            <text x="120" y="66" textAnchor="middle" {...SVG_MUTED} data-testid="engrave-setup-holding-side-surface">
              {/* #725 P8 — the slab is what the record says is under the stock: "wasteboard",
                  never "bed" when a wasteboard is on it. */}
              {surface === null || surface.kind === 'bare-bed' ? 'bed' : surfaceWords(surface).replace(' under', '')}
            </text>
          </>
        ) : (
          <>
            <circle cx="44" cy="35" r="17" fill="#39424c" stroke="#5b6672" />
            <rect x="58" y="29" width="132" height="12" fill="#1e3a4a" stroke="#6aa6c9" />
            <text x="120" y="66" textAnchor="middle" {...SVG_MUTED}>
              chuck, along X
            </text>
          </>
        )}
      </svg>
      {proudWords !== null && (
        <p className="hint" style={{ margin: 0 }} data-testid="engrave-setup-holding-proud">
          {proudWords}
        </p>
      )}
    </div>
  );
}

// ── The step ───────────────────────────────────────────────────────────────────────────────────

export interface HoldingStepProps {
  job: EngraveJob;
  answers: SetupAnswers;
  /** Apply the answer immediately: there is no later Finish to collect it. */
  onAnswers: (answers: SetupAnswers) => void;
  /**
   * #240 — selecting the rotary chuck (or the vise again) is ONE store write, because the
   * workholding and the stock box change together: `rotary` null is the vise, and `next` carries
   * the answers' vise and sacrificial for that write.
   */
  onRotary: (rotary: RotaryChuck | null, next: SetupAnswers) => void;
  /**
   * #715 — selecting a bed mount (or the vise again) is ONE store write: the workholding and the
   * board under it are one fact. `hold` null is the vise, with `next`'s vise and sacrificial.
   */
  onBedHold: (hold: TapeHold | BracketHold | null, next: SetupAnswers) => void;
}

/** The answers with a board under the part, or none — the bed's own field, as the design writes it. */
function withBedSacrificial(a: SetupAnswers, mm: number | null): SetupAnswers {
  return {
    ...a,
    sacrificial: {
      ...a.sacrificial,
      under:
        mm === null
          ? null
          : { thickness: mm, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'tape' },
      source: 'saved',
    },
  };
}

export function HoldingStep({ job, answers, onAnswers, onRotary, onBedHold }: HoldingStepProps): JSX.Element {
  const location = useLocationStore((s) => s.location);
  // #730 — the JOB's machine (its `machineId` names a profile id), not the house's first: the
  // step's profile and its board sentence must judge the same bed Generate will. The change
  // wizard's own manage-side readers stay on the machine it is changing.
  const machine = machineForJob(location, job.machineId);
  const accessories = location?.accessories ?? [];
  const calibration = useSettingsStore((s) => s.machineCalibration);
  const shopDefaults = useShopDefaultsStore((s) => s.defaults);
  // #727 F9 — the tape's inset from every edge is the SHOP's (`tape.insetMm`), not a hard-coded 2:
  // a house that tapes differently says so once, and every new taped job starts from it. Declared
  // here, above the arrival effects that write a taped job.
  const tapeInsetMm = readDefault(shopDefaults ?? null, 'tape.insetMm').value;
  // #714 — the grip's default is the shop's own number (Makera publishes no jaw depth).
  const shopGrip = readDefault(shopDefaults ?? null, 'rotary.gripMm');
  // #726 W19 — a phone stacks the picture UNDER the options instead of beside them: at 390 px the
  // two-column grid left the options an 86 px column whose text ran under the picture, and the
  // caption printed on top of it. The same query the wizard shell reads for its own 16 px edge.
  const narrow = useMediaQuery(NARROW_QUERY);
  const now = useMemo(() => machineNow(machine), [machine]);
  const profile = now?.profile ?? null;
  const rotaryEnvelope = useMemo(() => jobMachine(job, calibration).rotary?.envelope, [job, calibration]);

  const boards = useMemo(() => boardChoices(now?.profile ?? null), [now]);
  const underMm = answers.sacrificial.under?.thickness ?? null;
  // The board the stock calls for: the thinnest house board that leaves it proud of the jaws, the
  // thickest when none does, the typed default when the house names none. The operator's own board
  // choice, once made, is the answers' and stands.
  const [boardMm, setBoardMm] = useState<number>(underMm ?? defaultBoardMm(answers.stock, boards));
  const boardIndex = boards.findIndex((b) => b.thickness === boardMm);
  const boardValue = boardIndex >= 0 ? `loc:${boardIndex}` : 'typed';

  // ── #715 — the bed's own model ────────────────────────────────────────────────────────────────
  const jobHold = job.workholding.kind === 'tape' || job.workholding.kind === 'bracket' ? job.workholding : null;
  /** The tape the step draws and writes: the job's own when it is taped, else the house roll's. */
  const tape = useMemo(
    () => bedTapeHold(profile, job.workholding.kind === 'tape' ? job.workholding.tape : null, tapeInsetMm),
    // #725 review — the shop defaults load ASYNC: without `tapeInsetMm` here the picture keeps the
    // 2 mm fallback until something else re-renders it.
    [profile, job.workholding, tapeInsetMm],
  );
  const bracketRead = useMemo(() => bracketSettings(shopDefaults ?? null), [shopDefaults]);
  /** The bracket the step draws and writes: the job's own when it is bracketed, else the default. */
  const bracketHold = useMemo(
    () =>
      bedBracketHold(
        answers.stock,
        shopDefaults ?? null,
        job.workholding.kind === 'bracket' ? job.workholding.bracket : null,
        bedAnchor(profile) ?? 1,
      ),
    [answers.stock, shopDefaults, job.workholding, profile],
  );
  const [selectedClamp, setSelectedClamp] = useState(0);
  const throughCut = jobHasThroughCut(job);
  const boardFieldShown = profile !== null && (profile.surface.kind === 'wasteboard' || throughCut);

  const options = useMemo(
    () =>
      mountOptions({
        machine,
        accessories,
        stock: answers.stock,
        boardMm,
        rotaryEnvelope,
        round: job.stockEntry?.form === 'rod' || job.stock.shape === 'cylinder',
        tape,
      }),
    [machine, accessories, answers.stock, boardMm, rotaryEnvelope, job, tape],
  );
  // #240/#715 — the mount the job is IN: the job's own workholding first (a rotary, or one of the
  // bed's two arms), the vise's seat and board otherwise.
  const current: HoldingMount =
    job.workholding.kind === 'tape'
      ? 'bed-tape'
      : job.workholding.kind === 'bracket'
        ? 'bed-bracket'
        : answers.workholding === 'rotary'
          ? 'rotary'
          : currentMount(answers);
  // #705 — the picture follows the radio: the operator's chosen mount, or the option under the
  // pointer/focus when it is a disabled one that needs a machine change (drawn with its cost line).
  const [previewMount, setPreviewMount] = useState<HoldingMount | null>(null);
  const drawnMount: HoldingMount = previewMount ?? current;
  const drawnOption = options.find((o) => o.mount === drawnMount) ?? null;
  const bedInteractive = drawnMount === current && isBedMount(current) && jobHold !== null;

  // The machine-only options have no way out when this build cannot drive a machine; a disabled
  // control with no escape is hidden (A10), not narrated. A writable mount the machine already
  // carries needs no escape and stays on offer.
  const shown = options.filter(
    (o) =>
      canDriveMachine ||
      mechanismOf(o.mount) === 'vise' ||
      (!o.disabled && now !== null && now.mount === mechanismOf(o.mount)),
  );
  // #715 — when the vise is not on the pins, its three seat choices are one line: none of them
  // can be used anyway, and the bed step's radio list is the two bed mounts' (mockup station 2).
  const rows =
    now !== null && now.mount !== 'vise'
      ? (() => {
          const vise = shown.find((o) => mechanismOf(o.mount) === 'vise');
          if (vise === undefined) return shown;
          return [
            { ...vise, label: 'In the vise, …', hint: null },
            ...shown.filter((o) => mechanismOf(o.mount) !== 'vise'),
          ];
        })()
      : shown;

  // First arrival at the step: the mount the stock calls for, unless someone has asserted a setup.
  // Deliberately once per mount of the step — a later answer is the operator's. A rotary job is
  // already asserted: the vise's seat and board say nothing about it (#240). With nothing on the
  // pins the BED's own effect below decides (#715).
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current) return;
    applied.current = true;
    if (job.workholding.kind !== 'vise') return;
    // With the bed or the rotary on the pins, their own effects decide (#715, #714).
    if (now !== null && now.mount !== 'vise') return;
    const next = applyRecommendedMount(answers, boardMm);
    if (next !== answers) onAnswers(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // #714 — with the module on the pins and a round rod that fits, the CHUCK is the default mount
  // (§3.4). Like the bed's default, it applies to an unasserted setup only, and once per bed
  // profile — an operator's own answer is never overwritten.
  //
  // #725 W10 — "unasserted" is `source: 'saved'` or a board of the operator's under the part. A
  // MEASURED vise is the machine's own calibration, not this job's answer: the wizard seeds it,
  // and it must not block the mount the machine actually carries (the same on the bed below).
  const rotaryArrived = useRef<string | null>(null);
  useEffect(() => {
    if (now === null || now.mount !== 'rotary') return;
    if (rotaryArrived.current === now.profile.id) return;
    rotaryArrived.current = now.profile.id;
    if (job.workholding.kind !== 'vise') return;
    if (answers.vise.source === 'saved' || answers.sacrificial.under !== null) return;
    const round = job.stockEntry?.form === 'rod' || job.stock.shape === 'cylinder';
    if (!round) return;
    const fits = rotaryStockFits(answers.stock, true, rotaryEnvelope ?? { diameter: 80, length: 150 });
    if (!fits) return;
    onRotary(defaultRotaryChuck(job, shopGrip.value), answers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, job.workholding.kind, job.stockEntry?.form, answers.stock]);

  // #715 — a job still in the vise takes the bed's default mount when nothing is on the pins
  // (§3.2): the profile's preferred mount for this stock among those the bed carries, else sheet
  // ≤ 3 mm on tape, plates and blocks in the bracket, else tape. It runs when the change wizard
  // presents a NEW bed profile inside this step (the profile id is the key), and only for a job
  // nobody has asserted: an operator's saved vise is not replaced by a machine change under it —
  // the bed options are there to be chosen. `wantedBed` remembers the bed row whose Change the
  // machine… opened the wizard, so asking for the bracket comes back with the bracket.
  const bedArrived = useRef<string | null>(null);
  // The bed row whose Change the machine… opened the wizard, and the profile it was opened on: the
  // request is honoured only when the wizard wrote a NEW profile (a close with nothing written
  // leaves the operator where they were).
  const wantedBed = useRef<{ mount: BedMount; fromProfile: string | null } | null>(null);
  useEffect(() => {
    if (now === null || now.mount !== 'bed') return;
    if (bedArrived.current === now.profile.id) return;
    bedArrived.current = now.profile.id;
    const wanted = wantedBed.current;
    wantedBed.current = null;
    if (wanted !== null) {
      if (wanted.fromProfile === now.profile.id) return;
      // The operator asked for this bed mount: their answer stands over any default.
      if (wanted.mount === 'bed-tape') onBedHold(bedTapeHold(profile, job.workholding.kind === 'tape' ? job.workholding.tape : null, tapeInsetMm), bedAnswers(answers));
      else
        onBedHold(
          bedBracketHold(
            answers.stock,
            shopDefaults ?? null,
            job.workholding.kind === 'bracket' ? job.workholding.bracket : null,
            bedAnchor(profile) ?? 1,
          ),
          bedAnswers(answers),
        );
      return;
    }
    if (job.workholding.kind !== 'vise') return;
    // #725 W10 — a MEASURED vise is the machine's calibration, not an assertion of this job's
    // mount: with nothing on the pins the vise cannot hold the job at all, so only the operator's
    // own saved setup stands over the bed's default.
    if (answers.vise.source === 'saved') return;
    const mount = defaultBedMount(profile, answers.stock, job.stockEntry?.form ?? null);
    if (mount === 'bed-tape') onBedHold(bedTapeHold(profile, null, tapeInsetMm), answers);
    else onBedHold(bedBracketHold(answers.stock, shopDefaults ?? null, null, bedAnchor(profile) ?? 1), answers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, job.workholding.kind, answers.stock, answers.vise.source, profile]);

  // #715 — on the bare bed a through cut needs a board under it, and the field's default is the
  // thinnest house board thick enough (§3.5). Once offered, the operator's "none" stands.
  const boardDefaulted = useRef(false);
  const bareBedNeedsBoard =
    jobHold !== null &&
    throughCut &&
    profile !== null &&
    profile.surface.kind !== 'wasteboard' &&
    answers.sacrificial.under === null;
  useEffect(() => {
    if (!bareBedNeedsBoard || boardDefaulted.current) return;
    boardDefaulted.current = true;
    const mm = defaultBedBoardMm(profile, job.breakthrough + 1);
    if (mm !== null) onAnswers(withBedSacrificial(answers, mm));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bareBedNeedsBoard]);

  /** The answers with the board a through cut needs on this surface, when one is chosen for it. */
  function bedAnswers(a: SetupAnswers): SetupAnswers {
    if (profile === null || profile.surface.kind === 'wasteboard') return a;
    if (!throughCut || a.sacrificial.under !== null) return a;
    const mm = defaultBedBoardMm(profile, job.breakthrough + 1);
    return mm === null ? a : withBedSacrificial(a, mm);
  }

  function choose(mount: HoldingMount, mm: number = boardMm): void {
    // #240 — the chuck holds a rod; the vise answers describe the vise. Either switch is the one
    // store write that also turns the stock box to the frame the mount holds it in. #714 — a rod
    // joining the chuck starts on the shop's grip and Makera's jaw rule for its diameter.
    if (mount === 'rotary') {
      const chuck =
        job.workholding.kind === 'rotary-chuck'
          ? job.workholding.rotary
          : defaultRotaryChuck(job, shopGrip.value);
      onRotary(chuck, answers);
      return;
    }
    // #715 — the two bed mounts are the job's own writes, with the board under them.
    if (mount === 'bed-tape') {
      onBedHold(bedTapeHold(profile, job.workholding.kind === 'tape' ? job.workholding.tape : null, tapeInsetMm), bedAnswers(answers));
      return;
    }
    if (mount === 'bed-bracket') {
      onBedHold(
        bedBracketHold(
          answers.stock,
          shopDefaults ?? null,
          job.workholding.kind === 'bracket' ? job.workholding.bracket : null,
          bedAnchor(profile) ?? 1,
        ),
        bedAnswers(answers),
      );
      return;
    }
    const next = applyMount(answers, mount, mm);
    if (job.workholding.kind === 'rotary-chuck') onRotary(null, next);
    // #715 — taking the bed job back to the vise is the bed write with `null`.
    else if (jobHold !== null) onBedHold(null, next);
    else onAnswers(next);
  }

  /** Write the job's tape (a moved position, a changed board) through the bed's own action. */
  function writeTape(next: TapeHold): void {
    onBedHold({ ...next, source: 'saved' }, answers);
  }

  /** Write the job's bracket (a dragged clamp, one added or removed) through the bed's own action. */
  function writeBracket(next: BracketHold): void {
    onBedHold({ ...next, source: 'saved' }, answers);
  }

  function moveClamp(index: number, placement: ClampPlacement): void {
    const clamps = bracketHold.clamps.map((c, i) => (i === index ? placement : c));
    writeBracket({ ...bracketHold, clamps });
  }

  function addClamp(): void {
    if (bracketHold.clamps.length >= 4) return;
    // "+ clamp adds one on the longer free edge" (§3.6), at its middle.
    const edge: ClampEdge = answers.stock.length >= answers.stock.width ? 'back' : 'right';
    const len = edge === 'back' ? answers.stock.length : answers.stock.width;
    const clamps = [...bracketHold.clamps, { edge, at: Math.round(len / 2 * 1000) / 1000 }];
    setSelectedClamp(clamps.length - 1);
    writeBracket({ ...bracketHold, clamps });
  }

  function removeClamp(index: number): void {
    if (bracketHold.clamps.length <= 1) return;
    const clamps = bracketHold.clamps.filter((_, i) => i !== index);
    setSelectedClamp(Math.max(0, Math.min(index, clamps.length - 1)));
    writeBracket({ ...bracketHold, clamps });
  }

  function changeMachine(
    target: MachineMountKind | null,
    holding: string,
    wanted: BedMount | null = null,
    fitBracket = false,
  ): void {
    // Asking for a bed mount opens the wizard from that row; the step comes back with it selected.
    if (wanted !== null) wantedBed.current = { mount: wanted, fromProfile: profile?.id ?? null };
    openMachineChange({
      ...(target === null ? {} : { target }),
      ...(fitBracket ? { fitBracket: true } : {}),
      forJob: { name: job.name, holding },
      onDone: () => void useLocationStore.getState().refresh(),
    });
  }

  // The visible checks: the mount's sacrificial ones plus the blank's, minus the provenance note
  // that now lives in the Technical fold (B12/A10).
  const findings = useMemo(
    () =>
      dedupeFindings([
        ...stepFindings('holding', job, answers),
        ...stepFindings('blank', job, answers),
      ]),
    [job, answers],
  );
  const defaultFinding = findings.find((f) => f.code === 'vise-default') ?? null;
  const visibleFindings = findings.filter((f) => f.code !== 'vise-default');

  // The #231 fix, seated on the mount the answers are actually in: the board under the part is
  // part of the height (a 12 mm board is not ignored just because the seat is the ledge). A job in
  // the chuck has no vise seat to fix (#240), and neither has a bed job (#715) — its answers carry
  // the neutral shipped vise, which is not the fixture under it.
  const fix: ViseParams | null =
    job.workholding.kind !== 'vise' || answers.vise.stockProud < answers.stock.thickness
      ? null
      : {
          ...answers.vise,
          stockProud: seatedProud(answers),
          source: 'saved',
        };
  const seatPhrase = answers.vise.seat === 'floor' ? 'on the vise body' : 'on the jaws’ ledge';

  const form = job.stockEntry?.form;
  const heading = `How is the ${form === undefined ? 'blank' : formLabel(form).toLowerCase()} held?`;

  const finish = job.stockEntry?.finish;
  const hasFace = (finish !== undefined && finish !== 'unknown') || job.stock.colour !== undefined;
  // #698 — the fold's three stated landmarks, in the operator's own words. The face is named only
  // when the job says which face is special; a plain blank still gets the landmark, not a colour.
  const faceWord =
    finish === 'printed' || job.stock.colour?.kind === 'printed'
      ? 'printed face'
      : finish === 'finished' || job.stock.colour?.kind === 'laminate'
        ? 'finished face'
        : 'face you want cut';
  const orientationCards = [
    {
      key: 'face-up',
      label: 'Face up',
      caption: `The ${faceWord} is up, where the cutter can reach it.`,
    },
    {
      key: 'fixed-jaw',
      label: 'Against the fixed jaw',
      caption: 'The left edge is flat against the fixed jaw — the jaw that does not move.',
    },
    {
      key: 'nearest',
      label: 'Nearest you',
      caption: 'The front edge is closest to you, at the bottom of the top view.',
    },
  ] as const;

  // #705 — WHAT THE PICTURE DRAWS: the mount on show (the radio, or a hovered/focused option), the
  // option's own proud figure and board, and — for a disabled option — the line naming what it
  // needs, so an unavailable mount can be looked at without pretending it can be chosen.
  const drawnProud =
    drawnMount === 'ledge' || drawnMount === 'board' || drawnMount === 'block'
      ? seatedProud(answers, drawnMount)
      : null;
  const drawnBoard =
    drawnMount === 'board'
      ? answers.sacrificial.under?.thickness ?? boardMm
      : isBedMount(drawnMount)
        ? answers.sacrificial.under?.thickness ?? null
        : null;
  const drawnNote = drawnOption?.disabled === true ? drawnOption.reason : null;

  // #715 — the bed's picture data: one model for the drawing and its handles. Only the job's OWN
  // bed mount's handles move; a hovered preview is read-only.
  const bedPicture: BedPicture = {
    surface: profile?.surface ?? null,
    tape,
    bracket: bracketHold,
    boardMm: answers.sacrificial.under?.thickness ?? null,
    clamps: bracketRead.settings,
    selectedClamp,
    interactive: bedInteractive,
    onSelectClamp: setSelectedClamp,
    onMoveClamp: moveClamp,
    onMoveWhere: (where) => {
      if (job.workholding.kind === 'tape') writeTape({ ...job.workholding.tape, where });
    },
    onRemoveClamp: removeClamp,
  };
  // The bracket's own checks, under the picture (§3.6): a clamp hanging past its edge, two clamps
  // on top of each other, a stock longer than the arm. The sizes' provenance is Technical's.
  const bedChecks =
    drawnMount === 'bed-bracket'
      ? validateBracketMount(
          { x: answers.stock.length, y: answers.stock.width, z: answers.stock.thickness },
          bracketHold.clamps,
          bracketRead,
        ).filter((c) => c.code !== 'mount-unmeasured')
      : [];
  // #712's board-size refusal, at the field that causes it (§3.5): the house board must cover the
  // stock, and the sentence names the board's own size.
  const boardTooSmall = useMemo(() => {
    if (jobHold === null || profile === null) return null;
    const bed = bedUnderFacts(machine, shopDefaults ?? null, job.breakthrough + 1, {
      length: job.stock.length,
      width: job.stock.width,
    });
    if (bed === null) return null;
    return validateJob(job, null, { bed }).find((f) => f.code === 'board-too-small') ?? null;
  }, [job, machine, shopDefaults, jobHold, profile]);

  // #715 — the Technical fold's provenance, each fact in its own place.
  const holdRatio = readDefault(shopDefaults ?? null, 'tape.holdRatio');
  const tapeProvenance = profile?.consumables?.tape?.provenance ?? TAPE_DEFAULTS.provenance;
  const surfaceTop = profile?.datums.surfaceTopZ ?? null;
  const surfaceTopWords =
    surfaceTop === null
      ? 'not measured — the first touch in Cut measures it'
      : `${fmt(surfaceTop.value)} mm, measured ${surfaceTop.measuredAt}`;
  const anchor = bedAnchor(profile) ?? 1;
  const anchorRead = machine === null ? null : anchorFrom(calibration, machine.id, anchor);
  const bedBoardValue =
    answers.sacrificial.under === null
      ? 'none'
      : boards.findIndex((b) => b.thickness === answers.sacrificial.under?.thickness) >= 0
        ? `loc:${boards.findIndex((b) => b.thickness === answers.sacrificial.under?.thickness)}`
        : 'typed';

  /** The fields the selected bed option shows, indented under its radio (§3.4, §3.6). */
  function bedFields(mount: BedMount): JSX.Element {
    const boardRow = boardFieldShown && (
      <FieldRow label="Board under">
        <BedBoardSelect
          value={bedBoardValue}
          boards={boards}
          mm={answers.sacrificial.under?.thickness ?? defaultBedBoardMm(profile, job.breakthrough + 1) ?? 2}
          onSelect={(value) => {
            if (value === 'none') {
              onAnswers(withBedSacrificial(answers, null));
              return;
            }
            if (value === 'typed') {
              onAnswers(withBedSacrificial(answers, defaultBedBoardMm(profile, job.breakthrough + 1) ?? 2));
              return;
            }
            const board = boards[Number(value.slice('loc:'.length))];
            if (board !== undefined) onAnswers(withBedSacrificial(answers, board.thickness));
          }}
          onMm={(mm) => {
            if (Number.isFinite(mm) && mm > 0) onAnswers(withBedSacrificial(answers, mm));
          }}
        />
        {profile !== null && profile.surface.kind !== 'wasteboard' && (
          <>
            {throughCut && (
              <span className="hint" style={{ flexBasis: '100%' }}>
                the through cut goes into the board, not the bed
              </span>
            )}
            <span className="hint" style={{ flexBasis: '100%' }}>
              tape the board to the bed, then the plate to the board
            </span>
          </>
        )}
      </FieldRow>
    );

    if (mount === 'bed-tape') {
      return (
        <div data-testid="engrave-setup-bed-fields-bed-tape" style={BED_FIELDS}>
          <FieldRow label="Under it">{underFieldWords(profile) ?? 'the bed'}</FieldRow>
          {boardRow}
          <FieldRow label="Where">
            <span data-testid="engrave-setup-tape-where">{tapeWhereWords(tape)}</span>
            {footprintOf(profile?.surface ?? null) !== null && (
              <span className="hint">(drag on the picture)</span>
            )}
          </FieldRow>
          <FieldRow label="Square to">the front edge of the bed</FieldRow>
          {boardTooSmall !== null && (
            <p style={BED_ERROR} data-testid="engrave-setup-board-too-small">
              {boardTooSmall.message}
            </p>
          )}
          <details data-testid="engrave-setup-bed-technical">
            <summary style={{ fontSize: 12, cursor: 'pointer' }}>Technical</summary>
            <div style={{ marginTop: 4 }}>
              <p style={MUTED}>
                Tape: {fmt(tape.width)} mm wide, {fmt(tape.thickness)} mm thick — {tapeProvenance}
              </p>
              <p style={MUTED}>
                The hold rule: taped area ≥ {fmt(holdRatio.value)} × (cutter ⌀ × step-down) —{' '}
                {KNOWN_DEFAULTS['tape.holdRatio']!.label}
              </p>
              <p style={MUTED}>
                Under it: {underWords(profile) ?? 'the bed'} — the surface’s top is {surfaceTopWords}
              </p>
            </div>
          </details>
        </div>
      );
    }

    const count = bracketHold.clamps.length;
    const arms = armsAboveStock(answers.stock, answers.sacrificial.under?.thickness ?? 0, bracketRead.settings);
    return (
      <div data-testid="engrave-setup-bed-fields-bed-bracket" style={BED_FIELDS}>
        <FieldRow label="Bracket">thin, at anchor {bracketHold.anchor}</FieldRow>
        <FieldRow label="Clamps">
          <span data-testid="engrave-setup-clamp-count">
            {count} top clamp{count === 1 ? '' : 's'} · {fmt(bracketRead.settings.clamp.height)} mm tall
          </span>
          <span className="hint" style={{ flexBasis: '100%' }}>
            drag a clamp along the back or right edge
            {count < 4 && (
              <>
                {' · '}
                <button type="button" className="btn btn--sm" data-testid="engrave-setup-clamp-add" onClick={addClamp}>
                  + clamp
                </button>
              </>
            )}
          </span>
        </FieldRow>
        {boardRow}
        {arms > 0 && (
          <p className="hint" style={{ margin: 0 }} data-testid="engrave-setup-arms-above">
            the arms stand {fmt(arms)} mm above the plate
          </p>
        )}
        {boardTooSmall !== null && (
          <p style={BED_ERROR} data-testid="engrave-setup-board-too-small">
            {boardTooSmall.message}
          </p>
        )}
        <details data-testid="engrave-setup-bed-technical">
          <summary style={{ fontSize: 12, cursor: 'pointer' }}>Technical</summary>
          <div style={{ marginTop: 4 }}>
            <p style={MUTED}>
              The bracket’s and the clamps’ sizes: {fmt(bracketRead.settings.armLengthX)} mm arms ·{' '}
              {fmt(bracketRead.settings.armWidth)} mm wide · {fmt(bracketRead.settings.height)} mm tall · clamps{' '}
              {fmt(bracketRead.settings.clamp.length)} × {fmt(bracketRead.settings.clamp.width)} mm, reaching{' '}
              {fmt(bracketRead.settings.clamp.reach)} mm onto the plate —{' '}
              {bracketRead.unmeasured.length === 0 ? 'measured' : 'defaults, not measured'}
            </p>
            <p style={MUTED} data-testid="engrave-setup-bracket-anchor">
              anchor {anchor}: {anchorRead === null ? 'Makera’s own' : anchorRead.ok ? anchorRead.anchor.from : anchorRead.reason}
            </p>
          </div>
        </details>
      </div>
    );
  }

  /** #714 — the chuck's four answers, indented under its radio (design §3.4, station 3). */
  function rotaryFields(): JSX.Element {
    const chuck =
      job.workholding.kind === 'rotary-chuck' ? job.workholding.rotary : defaultRotaryChuck(job, shopGrip.value);
    const rod = rodAxisOf(job.stock);
    const grip = round3(Math.max(0, rod.length - chuck.stickout));
    const write = (patch: Partial<RotaryChuck>): void => onRotary({ ...chuck, ...patch }, answers);
    // #737 — the neck's placement and its safe minimum are the ENGINE's (`rotary/neck.ts`), read
    // here off the chuck on screen so the sentence quotes the span the findings and the CAM will
    // use — including while the rotary option is merely previewed and the job is still a vise.
    const neck = chuck.neck;
    const neckMap: RotaryMap = {
      radius: rod.diameter / 2,
      circumference: Math.PI * rod.diameter,
      stickout: chuck.stickout,
      grip,
      length: rod.length,
      tailstock: chuck.tailstock,
    };
    const neckSpan = neck === undefined ? null : rotaryNeckSpan(neckMap, neck);
    const neckMin = neckSpan === null ? null : rotaryNeckMinDiameterMm(job.stock.material, neckSpan.effectiveMm);
    // The default the toggle will write for THIS rod: the ⌀7 mm figure is capped to keep it inside
    // a slim rod, and the note quotes what the operator will actually get.
    const neckDefault = defaultRotaryNeck(rod.diameter);
    const axisDatum = profile?.datums.rotaryAxis ?? null;
    return (
      <div data-testid="engrave-setup-rotary-fields" style={BED_FIELDS}>
        <FieldRow label="Jaws">
          <select
            className="fld"
            aria-label="Jaws"
            data-testid="engrave-setup-rotary-jaws"
            value={chuck.jawMode}
            onChange={(e) => write({ jawMode: e.target.value as RotaryJawMode })}
          >
            <option value="standard">standard</option>
            <option value="reverse-inner">reverse, inner teeth</option>
            <option value="reverse-outer">reverse, outer teeth</option>
          </select>
          <span className="hint" style={{ flexBasis: '100%' }} data-testid="engrave-setup-rotary-rule">
            Makera’s rule for ⌀{fmt(rod.diameter)}: standard under ⌀20, reverse inner 20–35, reverse outer over 35
          </span>
        </FieldRow>
        <FieldRow label="Grip">
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input
              type="number"
              className="fld"
              aria-label="Grip in the jaws"
              data-testid="engrave-setup-rotary-grip"
              min="0"
              max={fmt(rod.length)}
              step="1"
              value={grip}
              style={{ width: 64 }}
              onChange={(e) => {
                const g = Number(e.target.value);
                if (!Number.isFinite(g) || g < 0) return;
                const clamped = Math.min(g, Math.max(0, rod.length - 0.1));
                write({ stickout: round3(Math.max(0.1, rod.length - clamped)) });
              }}
            />{' '}
            mm in the jaws
          </label>
          <span data-testid="engrave-setup-rotary-stickout">Stick-out {fmt(chuck.stickout)} mm</span>
        </FieldRow>
        <FieldRow label="Tailstock">
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              aria-label="Tailstock in"
              data-testid="engrave-setup-rotary-tailstock"
              checked={chuck.tailstock}
              onChange={(e) => write({ tailstock: e.target.checked })}
            />
            {chuck.tailstock ? 'in — drill a centre hole in the free end first' : 'out — the free end is unsupported'}
          </label>
        </FieldRow>
        <FieldRow label="Neck for parting">
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              aria-label="Neck for parting"
              data-testid="engrave-setup-rotary-neck"
              checked={neck !== undefined}
              onChange={(e) => {
                if (e.target.checked) {
                  write({ neck: defaultRotaryNeck(rod.diameter) });
                } else {
                  // Absent is OFF (the document rule): the key goes, rather than a false flag a
                  // later reader would have to know to ignore.
                  const cleared = { ...chuck };
                  delete cleared.neck;
                  onRotary(cleared, answers);
                }
              }}
            />
            {neck === undefined ? 'off — the part is not cut down for sawing' : 'on — leave the part on a neck and saw it off'}
          </label>
        </FieldRow>
        {neck !== undefined && (
          <FieldRow label="Neck size">
            <select
              className="fld"
              aria-label="Neck side"
              data-testid="engrave-setup-rotary-neck-end"
              value={neck.end}
              onChange={(e) => write({ neck: { ...neck, end: e.target.value as RotaryNeck['end'] } })}
            >
              <option value="tailstock">tailstock side</option>
              <option value="chuck">chuck side</option>
            </select>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              ⌀
              <input
                type="number"
                className="fld"
                aria-label="Neck diameter"
                data-testid="engrave-setup-rotary-neck-diameter"
                min="0.1"
                step="0.1"
                value={neck.diameter}
                style={{ width: 64 }}
                onChange={(e) => {
                  const d = Number(e.target.value);
                  if (!Number.isFinite(d) || d <= 0) return;
                  write({ neck: { ...neck, diameter: d } });
                }}
              />
              mm
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <input
                type="number"
                className="fld"
                aria-label="Neck length"
                data-testid="engrave-setup-rotary-neck-length"
                min="0.1"
                step="0.1"
                value={neck.length}
                style={{ width: 64 }}
                onChange={(e) => {
                  const l = Number(e.target.value);
                  if (!Number.isFinite(l) || l <= 0) return;
                  write({ neck: { ...neck, length: l } });
                }}
              />
              mm long
            </label>
            <span className="hint" style={{ flexBasis: '100%' }} data-testid="engrave-setup-rotary-neck-note">
              {neckSpan === null || neckMin === null
                ? 'The neck needs a length and a diameter above 0 mm.'
                : `The program’s last operation cuts it down to ⌀${fmt(neck.diameter)} mm all the way round with the ` +
                  `part’s own cutter, and you saw ${neck.end === 'chuck' ? 'the part' : 'the scrap end'} off at ` +
                  `X ${fmt(neckSpan.sawAtMm)} mm — the neck runs ` +
                  `X ${fmt(neckSpan.fromMm)}–${fmt(neckSpan.toMm)} mm on the ${neckEndLabel(neck.end)}. ` +
                  (neck.end === 'chuck'
                    ? 'The stock goes into the jaws at the chuck side, so the saw frees the whole part. '
                    : 'The stock goes into the jaws at the chuck side, so a neck here frees only the scrap ' +
                      'stub: the part stays joined to the stock in the chuck and is not parted off. ') +
                  `Case Maker starts the neck at ⌀${fmt(neckDefault.diameter)} mm and ${ROTARY_NECK_LENGTH_MM} mm long ` +
                  `(a saw needs at least ${ROTARY_NECK_MIN_LENGTH_MM} mm): those are labelled defaults, not ` +
                  `measurements. ` +
                  `The check treats ${neck.end === 'chuck' ? 'the whole part beyond the neck' : 'the scrap stub beyond the neck'} ` +
                  `as carried: it runs ${fmt(neckSpan.carriedMm)} mm from the neck’s root at X ${fmt(neckSpan.fromMm)} mm ` +
                  `to the free end; ` +
                  (neckMap.tailstock
                    ? `the neck and the tailstock centre hold its ends, so the bending is shared and the check ` +
                      `counts half its length (${fmt(neckSpan.effectiveMm)} mm). `
                    : `nothing holds its far end, so it hangs free and the check counts the whole length ` +
                      `(${fmt(neckSpan.effectiveMm)} mm). `) +
                  `The safe minimum is ⌀${Number(neckMin.diameterMm.toFixed(2))} mm — Case Maker’s defaults ` +
                  `(${neckMin.loadN} N sideways at its free end, ${neckMin.stressMpa} MPa allowable bending ` +
                  `stress), not measurements: the neck is cut last, with the part still held, so this is a ` +
                  'rough check and the minimum is a guess until it is checked on the machine.' +
                  (neck.diameter < neckMin.diameterMm
                    ? ` This ⌀${fmt(neck.diameter)} mm neck is below that minimum — make it thicker, shorten ` +
                      'the part, or choose a stronger stock.'
                    : '') +
                  ` ${neckJawClearanceSentence(neck.end)}`}
            </span>
          </FieldRow>
        )}
        <details data-testid="engrave-setup-rotary-technical">
          <summary style={{ fontSize: 12, cursor: 'pointer' }}>Technical</summary>
          <div style={{ marginTop: 4 }}>
            <p style={MUTED}>
              Envelope: ⌀{fmt(rotaryEnvelope?.diameter ?? 80)} × {fmt(rotaryEnvelope?.length ?? 150)} mm — Makera’s figure
            </p>
            <p style={MUTED}>Jaws: Makera’s rule by diameter (the decompiled Studio), not measured on this chuck</p>
            <p style={MUTED} data-testid="engrave-setup-rotary-grip-source">
              Grip: {fmt(shopGrip.value)} mm —{' '}
              {shopGrip.source === 'measured'
                ? 'measured on this machine'
                : shopGrip.source === 'chosen'
                  ? 'the shop’s setting'
                  : 'the shop’s seeded default, not measured'}
              ; the stick-out is the rod less it
            </p>
            <p style={MUTED}>Tailstock: in — Makera’s shipped value (Studio’s rotary relief)</p>
            <p style={MUTED}>
              Keep-out: {fmt(ROTARY_JAW_KEEP_OUT_MM)} mm from the jaws, a {fmt(ROTARY_TAILSTOCK_BAND_MM)} mm
              tailstock band — Case Maker’s defaults until measured
            </p>
            <p style={MUTED} data-testid="engrave-setup-rotary-axis-datum">
              Axis datum:{' '}
              {axisDatum === null ? 'shipped value — not measured on this machine' : `measured ${axisDatum.measuredAt}`}
            </p>
          </div>
        </details>
      </div>
    );
  }

  // #714 — the front view's numbers, from the chuck the job holds (or the one it would get).
  const rotaryChuck =
    job.workholding.kind === 'rotary-chuck' ? job.workholding.rotary : defaultRotaryChuck(job, shopGrip.value);
  const rotaryRod = rodAxisOf(job.stock);
  const rotaryPicture: RotaryPicture = {
    diameterMm: rotaryRod.diameter,
    lengthMm: rotaryRod.length,
    gripMm: round3(Math.max(0, rotaryRod.length - rotaryChuck.stickout)),
    stickoutMm: rotaryChuck.stickout,
    jawMode: rotaryChuck.jawMode,
    tailstock: rotaryChuck.tailstock,
  };

  return (
    <div data-testid="engrave-setup-step-holding" style={{ marginTop: 8 }}>
      {/* ── What is on the machine now ─────────────────────────────────────────────────────── */}
      <div
        data-testid="engrave-setup-machine-now"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexWrap: 'wrap',
          border: '1px solid #2a2f36',
          background: '#10151b',
          borderRadius: 4,
          padding: '6px 8px',
          fontSize: 12,
          marginBottom: 10,
        }}
      >
        <span style={MUTED}>On the machine now</span>
        {now === null ? (
          <span data-testid="engrave-setup-machine-none">Not read from a machine record.</span>
        ) : (
          <>
            <b>{now.parts[0]}</b>
            {now.parts.length > 1 && <span>· {now.parts.slice(1).join(' · ')}</span>}
          </>
        )}
        {canDriveMachine && now !== null && (
          <button
            type="button"
            className="btn btn--sm"
            style={{ marginLeft: 'auto' }}
            data-testid="engrave-setup-change-machine"
            onClick={() => changeMachine(null, HOLDING_MOUNT_WORDS[current])}
          >
            Change the machine…
          </button>
        )}
      </div>

      <div
        data-testid="engrave-setup-holding-columns"
        style={{
          display: 'grid',
          gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) minmax(190px, 230px)',
          gap: narrow ? 12 : 16,
          alignItems: 'start',
        }}
      >
        <div style={{ display: 'grid', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 500 }} data-testid="engrave-setup-holding-heading">
            {heading}
          </span>

          <div data-testid="engrave-setup-holding-vise" style={{ display: 'grid', gap: 7 }}>
            {rows.map((option) => (
              <MountRow
                key={option.mount}
                option={option}
                checked={!option.disabled && current === option.mount}
                onChoose={() => choose(option.mount)}
                onPreview={setPreviewMount}
                onMachineChange={() => {
                  if (option.escape !== null) {
                    changeMachine(
                      option.escape,
                      option.holdingWords,
                      isBedMount(option.mount) ? option.mount : null,
                      option.escapeFitBracket === true,
                    );
                  }
                }}
                boardControl={
                  option.mount === 'board' && !option.disabled ? (
                    <BoardSelect
                      value={boardValue}
                      boards={boards}
                      mm={boardMm}
                      onSelect={(value) => {
                        if (value === 'typed') {
                          choose('board', boardMm);
                          return;
                        }
                        const board = boards[Number(value.slice('loc:'.length))];
                        if (board === undefined) return;
                        setBoardMm(board.thickness);
                        choose('board', board.thickness);
                      }}
                      onMm={(value) => {
                        if (!Number.isFinite(value) || value <= 0) return;
                        setBoardMm(value);
                        choose('board', value);
                      }}
                    />
                  ) : null
                }
                details={
                  isBedMount(option.mount) && !option.disabled
                    ? bedFields(option.mount)
                    : option.mount === 'rotary' && !option.disabled
                      ? rotaryFields()
                      : null
                }
              />
            ))}
          </div>

          {hasFace && (
            <details data-testid="engrave-setup-orientation">
              <summary style={{ fontSize: 12, cursor: 'pointer' }}>
                {current === 'rotary' ? 'Which end is in the jaws' : 'Which way round'}
              </summary>
              {current === 'rotary' ? (
                // #714 — a round rod has no face or edge to square; the only landmark is its ends,
                // and either end will do unless they differ (design §3.4).
                <ul style={{ ...MUTED, margin: '4px 0 0 18px', padding: 0 }}>
                  <li>Either end — unless the ends differ: a printed rod's layers, a tube's chamfer.</li>
                </ul>
              ) : (
                // #698 — three pictures, not three bullets: the operator is told what to LOOK AT at
                // the vise. Each is drawn in the step's own top-view frame (fixed jaw LEFT, the
                // operator's front BOTTOM), so the words and the picture name the same side.
                <div
                  data-testid="engrave-setup-orientation-pictures"
                  style={{ display: 'grid', gap: 10, marginTop: 8 }}
                >
                  {orientationCards.map((card) => (
                    <figure
                      key={card.key}
                      data-testid={`engrave-setup-orientation-${card.key}`}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '104px minmax(0, 1fr)',
                        gap: 10,
                        alignItems: 'center',
                        margin: 0,
                      }}
                    >
                      <OrientationPicture landmark={card.key} stock={answers.stock} faceWord={faceWord} />
                      <figcaption style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                        <b
                          data-testid={`engrave-setup-orientation-label-${card.key}`}
                          style={{ fontSize: 12, color: '#d1d5db' }}
                        >
                          {card.label}
                        </b>
                        <span
                          data-testid={`engrave-setup-orientation-caption-${card.key}`}
                          style={{ ...MUTED, margin: 0 }}
                        >
                          {card.caption}
                        </span>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              )}
            </details>
          )}

          {/* #715 — a bed job's provenance lives in its own option's Technical fold. */}
          {jobHold === null && (
          <details data-testid="engrave-setup-holding-technical">
            <summary style={{ fontSize: 12, cursor: 'pointer' }}>Technical</summary>
            <div style={{ marginTop: 4 }}>
              {defaultFinding !== null && (
                <FindingRow finding={defaultFinding} testid="engrave-setup-step-finding-vise-default" />
              )}
              {answers.workholding === 'vise' && (
                <p style={MUTED} data-testid="engrave-setup-holding-jaws">
                  Jaws: {fmt(answers.vise.fixedJawThickness)} mm fixed ·{' '}
                  {fmt(answers.vise.movingJawThickness)} mm moving · {fmt(answers.vise.jawLength)} mm long ·{' '}
                  ledge {fmt(LEDGE_STEP)} mm · vise body {fmt(VISE_FLOOR_DEPTH)} mm
                </p>
              )}
              {answers.sacrificial.under !== null && (
                <p style={MUTED} data-testid="engrave-setup-holding-board">
                  Board {fmt(answers.sacrificial.under.thickness)} mm (
                  {boardProvenance(answers.sacrificial.under.thickness, boards)}), taped down
                </p>
              )}
              {Object.values(answers.sacrificial.sides).some((s) => s !== null) && (
                <p style={MUTED} data-testid="engrave-setup-holding-strips">
                  Strips beside the part
                </p>
              )}
            </div>
          </details>
          )}
        </div>

        {/* #725 B6 — the picture column is OUT of the grid's sizing. The preview follows the
            hovered option, and its height varies by mount; in the flow that changed the wizard's
            height, so a centred modal re-centred and the row under the pointer moved out from
            under it — a hover/reflow loop that made the row's button unclickable. The slot takes
            the options column's height (the row's `stretch`) and scrolls its own picture if one is
            taller, so nothing outside it ever moves. */}
        <div
          data-testid="engrave-setup-holding-picture-slot"
          style={{
            position: 'relative',
            alignSelf: 'stretch',
            // #726 W19 — a stacked slot has no options column to take its height from, and the
            // picture inside is absolutely placed: without a height of its own the row would
            // collapse to nothing. 260 px shows the top view and its caption whole.
            minHeight: narrow ? 260 : 0,
          }}
        >
          <div style={{ position: 'absolute', inset: 0, overflowY: 'auto' }}>
            <HoldingPicture
              mount={drawnMount}
              stock={answers.stock}
              form={form ?? null}
              proudMm={drawnProud}
              boardMm={drawnBoard}
              note={drawnNote}
              bed={isBedMount(drawnMount) ? bedPicture : null}
              checks={bedChecks}
              rotary={drawnMount === 'rotary' ? rotaryPicture : null}
            />
          </div>
        </div>
      </div>

      {fix !== null && (
        <div
          data-testid="engrave-setup-fix-slot"
          style={{ border: '1px solid #7a5a28', background: '#241d12', borderRadius: 4, padding: 6, marginTop: 8 }}
        >
          <p style={{ ...MUTED, color: '#e0c07a', margin: 0 }}>
            The vise holds the stock {fmt(answers.vise.stockProud)} mm proud, taller than this{' '}
            {fmt(answers.stock.thickness)} mm blank. Seated {seatPhrase} it stands{' '}
            {fmt(fix.stockProud)} mm proud.
          </p>
          <button
            type="button"
            data-testid="engrave-setup-fix-proud"
            onClick={() => onAnswers(withVise(answers, { stockProud: fix.stockProud, source: fix.source }))}
          >
            Set stock proud to {fmt(fix.stockProud)} mm
          </button>
        </div>
      )}

      {visibleFindings.length > 0 && (
        <div data-testid="engrave-setup-findings" style={{ marginTop: 6 }}>
          {visibleFindings.map((f, i) => (
            <FindingRow key={`${f.code}-${i}`} finding={f} testid={`engrave-setup-step-finding-${f.code}`} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── One mount row ──────────────────────────────────────────────────────────────────────────────

function MountRow({
  option,
  checked,
  onChoose,
  onPreview,
  onMachineChange,
  boardControl,
  details = null,
}: {
  option: MountOption;
  checked: boolean;
  onChoose: () => void;
  /** #705 — the picture follows the option under the pointer or focus, disabled ones included. */
  onPreview: (mount: HoldingMount | null) => void;
  onMachineChange: () => void;
  boardControl: JSX.Element | null;
  /** #715 — the selected bed option's own fields, indented under its radio. */
  details?: JSX.Element | null;
}): JSX.Element {
  const hint =
    option.disabled && option.reason !== null
      ? option.reason
      : option.hint !== null
        ? option.hint
        : null;
  return (
    <div
      data-testid={`engrave-setup-mount-row-${option.mount}`}
      data-disabled={option.disabled}
      onMouseEnter={() => onPreview(option.mount)}
      onMouseLeave={() => onPreview(null)}
      onFocus={() => onPreview(option.mount)}
      onBlur={() => onPreview(null)}
    >
      <label style={{ ...FIELD_LABEL, opacity: option.disabled ? 0.65 : 1 }}>
        <input
          type="radio"
          name="start-wizard-holding-mount"
          checked={checked}
          disabled={option.disabled}
          onChange={onChoose}
          data-testid={`engrave-setup-mount-${option.mount}`}
        />
        <span>
          <b style={{ fontWeight: checked ? 600 : 400 }}>{option.label}</b>
          {hint !== null && (
            <>
              <br />
              <span style={{ ...MUTED, margin: 0 }}>{hint}</span>
            </>
          )}
        </span>
      </label>
      {option.disabled && option.escape !== null && canDriveMachine && (
        <button
          type="button"
          className="btn btn--sm"
          style={{ marginLeft: 22, marginTop: 2 }}
          data-testid={`engrave-setup-change-${option.mount}`}
          onClick={onMachineChange}
        >
          Change the machine…
        </button>
      )}
      {option.mount === 'board' && boardControl !== null && (
        <div style={{ marginLeft: 22, marginTop: 2 }}>{boardControl}</div>
      )}
      {checked && details !== null && <div style={{ marginLeft: 22, marginTop: 4 }}>{details}</div>}
    </div>
  );
}

// ── #715: the bed's field rows and its board select ───────────────────────────────────────────

const BED_FIELDS: CSSProperties = { display: 'grid', gap: 4, margin: '2px 0 4px' };
const BED_ERROR: CSSProperties = { fontSize: 12, lineHeight: 1.45, margin: '2px 0', color: '#f0b4ad' };

/** One labelled row of the bed option's fields, the mockup's "Under it | wasteboard". */
function FieldRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '96px minmax(0, 1fr)',
        gap: 6,
        alignItems: 'baseline',
        fontSize: 12,
      }}
    >
      <span style={{ ...MUTED, margin: 0 }}>{label}</span>
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', minWidth: 0 }}>{children}</span>
    </div>
  );
}

/** The bed's board under: none, a house board, or a typed thickness (§3.5). */
function BedBoardSelect({
  value,
  boards,
  mm,
  onSelect,
  onMm,
}: {
  value: string;
  boards: readonly { thickness: number; material: string; count: number }[];
  mm: number;
  onSelect: (value: string) => void;
  onMm: (value: number) => void;
}): JSX.Element {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <select
        className="fld"
        aria-label="Board under the part"
        data-testid="engrave-setup-bed-board"
        value={value}
        onChange={(e) => onSelect(e.target.value)}
      >
        <option value="none">none</option>
        {boards.map((board, i) => (
          <option key={`${board.material}-${board.thickness}-${i}`} value={`loc:${i}`}>
            {fmt(board.thickness)} mm {board.material}
          </option>
        ))}
        <option value="typed">Other thickness…</option>
      </select>
      {value === 'typed' && (
        <label style={{ ...FIELD_LABEL, margin: 0 }}>
          <input
            type="number"
            className="fld"
            aria-label="Board thickness"
            data-testid="engrave-setup-bed-board-thickness"
            min="0.1"
            step="0.1"
            value={mm}
            style={{ width: 64 }}
            onChange={(e) => onMm(Number(e.target.value))}
          />{' '}
          mm
        </label>
      )}
    </span>
  );
}

// ── The board under the part: the step's ONE sacrificial select ─────────────────────────────────

function BoardSelect({
  value,
  boards,
  mm,
  onSelect,
  onMm,
}: {
  value: string;
  boards: readonly { thickness: number; material: string; count: number }[];
  mm: number;
  onSelect: (value: string) => void;
  onMm: (value: number) => void;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <select
        className="fld"
        aria-label="Board under the part"
        data-testid="engrave-setup-sacrificial"
        value={value}
        onChange={(e) => onSelect(e.target.value)}
      >
        {boards.map((board, i) => (
          <option key={`${board.material}-${board.thickness}-${i}`} value={`loc:${i}`}>
            {fmt(board.thickness)} mm {board.material}
          </option>
        ))}
        <option value="typed">Other thickness…</option>
      </select>
      {value === 'typed' && (
        <label style={{ ...FIELD_LABEL, margin: 0 }}>
          <input
            type="number"
            className="fld"
            aria-label="Board thickness"
            data-testid="engrave-setup-board-thickness"
            min="0.1"
            step="0.1"
            value={mm}
            style={{ width: 64 }}
            onChange={(e) => onMm(Number(e.target.value))}
          />{' '}
          mm
        </label>
      )}
    </div>
  );
}

/** The label words, exported for the step's tests and the panel's future Hold line. */
export { HOLDING_MOUNT_LABELS, HOLDING_MOUNT_WORDS };
export type { HoldingMount };
