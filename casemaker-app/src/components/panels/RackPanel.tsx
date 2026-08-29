import type React from 'react';
import { useProjectStore } from '@/store/projectStore';
import type { RackParams, RackAccessory, RackAccessoryType } from '@/types';
import { LabelledField } from '@/components/ui/LabelledField';
import {
  PRINTER_PRESETS,
  maxRackWidthForBed,
  maxRackDepthForBed,
  maxRackSlotsForBed,
} from '@/engine/compiler/rackFit';
import {
  computeRackDims,
  rackFitsWhole,
  accessorySlots,
  accessorySpaces,
  floorRibsEnabled,
  SLOT_PITCH,
} from '@/engine/compiler/rack';
import { newId } from '@/utils/id';

/**
 * Rack archetype editor (see types/rack.ts). IMPORTANT: patchCase validates
 * with a TOP-LEVEL partial only, so every update sends the COMPLETE `rack`
 * object — never a nested fragment.
 */

/** Bordered card grouping one accessory/fan's controls with its remove
 *  button — so the ✕ visibly belongs to its row. */
const CARD_STYLE: React.CSSProperties = {
  border: '1px solid #2a2f36',
  borderRadius: 4,
  padding: 8,
  marginBottom: 6,
  background: '#161a20',
};
const REMOVE_STYLE: React.CSSProperties = {
  marginLeft: 'auto',
  flexShrink: 0,
  width: 26,
  height: 26,
  lineHeight: 1,
  borderRadius: 4,
};

const DEFAULT_RACK: RackParams = {
  enabled: true,
  width: 252,
  depth: 250,
  slots: 16,
  printer: { preset: 'prusa-xl', x: 360, y: 360, z: 360 },
  wallMount: 'none',
  accessories: [],
};

const ACCESSORY_LABELS: { value: RackAccessoryType; label: string; hint: string }[] = [
  { value: 'blank', label: 'Blank faceplate', hint: 'Solid N-slot plate for drilling or custom cutouts.' },
  { value: 'shelf', label: 'Vented shelf', hint: 'Open-front shelf; 86 mm short (pairs back-to-back) or 123 mm long (adds rear screws).' },
  { value: 'keystone', label: 'Keystone patch plate', hint: 'Standard keystone jacks (never scaled); count auto-fits the rack width at 30 mm pitch.' },
  { value: 'cable-tray', label: 'Cable tray', hint: 'Comb-finger tray for cable routing and tie-wraps; occupies 2 slots.' },
];

const WALL_MOUNT_OPTIONS: { value: NonNullable<RackParams['wallMount']>; label: string; hint: string }[] = [
  { value: 'none', label: 'Freestanding', hint: 'Sits on its stacking feet.' },
  {
    value: 'ears',
    label: 'Wall — screw ears',
    hint: 'Gusseted rear flanges on both side panels with countersunk screw holes. Screw into studs or rated anchors.',
  },
  {
    value: 'cleat',
    label: 'Wall — french cleat (15 mm standoff)',
    hint: 'Separate 45° cleat strip screws to the wall; the rack hooks over it. Strong, removable without tools — the strips hold the rack 15 mm off the wall.',
  },
  {
    value: 'keyhole',
    label: 'Wall — keyhole hangers (flush)',
    hint: 'Keyhole slots in the sides’ rear faces drop over pan-head screws in the wall. No extra printed parts; the back sits dead flat on the wall.',
  },
];

export function RackPanel() {
  const project = useProjectStore((s) => s.project);
  const patchCase = useProjectStore((s) => s.patchCase);
  const rack = project?.case.rack;

  if (!project) return null;

  if (!rack?.enabled) {
    return (
      <div className="panel-stack" data-testid="rack-panel-disabled">
        <p style={{ fontSize: 13, lineHeight: 1.5, color: '#9aa4b0' }}>
          Turn this project into a parametric 10&quot;-class mini rack: side panels, snap-in
          top/bottom plates, and any mix of faceplates, shelves, keystone plates, and cable
          trays on a universal 16.5&nbsp;mm screw pitch. Resizes to fit YOUR printer — screw
          holes and keystone jacks never scale. Replaces the normal case/lid pipeline while
          enabled.
        </p>
        <button
          type="button"
          data-testid="rack-enable"
          onClick={() => patchCase({ rack: { ...DEFAULT_RACK } })}
        >
          Enable mini-rack project
        </button>
      </div>
    );
  }

  const update = (partial: Partial<RackParams>): void => {
    patchCase({ rack: { ...rack, ...partial } });
  };
  const dims = computeRackDims(rack);
  const spaces = accessorySpaces(rack);
  const usedSlots = (rack.accessories ?? []).reduce((s, a) => s + accessorySlots(a), 0);
  const presetId = rack.printer?.preset ?? 'custom';

  // Slider ceilings from the printer's build volume. Never below the current
  // value so the handle doesn't jump when a smaller printer is picked — the
  // fit banner flags oversize instead.
  const printerMaxW = rack.printer
    ? Math.min(400, maxRackWidthForBed(rack.printer.x, rack.printer.y))
    : 400;
  const printerMaxD = rack.printer
    ? Math.min(400, maxRackDepthForBed(rack.width, rack.slots, rack.printer.x, rack.printer.y))
    : 400;
  const printerMaxS = rack.printer
    ? maxRackSlotsForBed(rack.depth, rack.printer.x, rack.printer.y)
    : 40;
  const sliderMaxW = Math.max(printerMaxW, Math.ceil(rack.width));
  const sliderMaxD = Math.max(printerMaxD, Math.ceil(rack.depth));
  const sliderMaxS = Math.min(40, Math.max(printerMaxS, rack.slots));
  // Height in mm ↔ slots: total = feet + slots·pitch + margins.
  const mmForSlots = (s: number): number => Math.round(5 + s * SLOT_PITCH + 11);
  const slotsForMm = (mm: number): number =>
    Math.min(40, Math.max(2, Math.round((mm - 16) / SLOT_PITCH)));

  const setPreset = (id: string): void => {
    if (id === 'custom') {
      update({ printer: { ...(rack.printer ?? { x: 220, y: 220, z: 250 }), preset: undefined } });
      return;
    }
    const p = PRINTER_PRESETS.find((x) => x.id === id);
    if (p) update({ printer: { preset: p.id, x: p.x, y: p.y, z: p.z } });
  };

  const setAccessory = (i: number, next: RackAccessory): void => {
    const list = [...(rack.accessories ?? [])];
    list[i] = next;
    update({ accessories: list });
  };

  return (
    <div className="panel-stack" data-testid="rack-panel">
      <LabelledField
        label="Width"
        unit="mm"
        hint={`Exterior width across the front — faceplates span it fully. Original: 252. Slider tops out at what the selected printer can fit (${printerMaxW} mm).`}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="range"
            min={120}
            max={sliderMaxW}
            step={1}
            value={rack.width}
            data-testid="rack-width-slider"
            aria-label="Width slider"
            style={{ flex: 1 }}
            onChange={(e) => update({ width: Number(e.target.value) })}
          />
          <input
            type="number"
            min={120}
            max={600}
            step={1}
            value={rack.width}
            data-testid="rack-width"
            style={{ width: 72 }}
            onChange={(e) => update({ width: Number(e.target.value) })}
          />
        </div>
      </LabelledField>
      <LabelledField
        label="Depth"
        unit="mm"
        hint={`Side panel front-to-back depth. Original: 250. Slider tops out at what the selected printer can fit at the current width and height (${printerMaxD} mm).`}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="range"
            min={80}
            max={sliderMaxD}
            step={1}
            value={rack.depth}
            data-testid="rack-depth-slider"
            aria-label="Depth slider"
            style={{ flex: 1 }}
            onChange={(e) => update({ depth: Number(e.target.value) })}
          />
          <input
            type="number"
            min={80}
            max={600}
            step={1}
            value={rack.depth}
            data-testid="rack-depth"
            style={{ width: 72 }}
            onChange={(e) => update({ depth: Number(e.target.value) })}
          />
        </div>
      </LabelledField>
      <LabelledField
        label="Height"
        unit="slots"
        hint={`Rack height in ${SLOT_PITCH} mm mounting slots — the fixed pitch every shelf/faceplate mounts on. Each slider step is one valid slot; it tops out at what the selected printer can fit (${printerMaxS} slots at the current depth). The mm box rounds to the nearest whole slot.`}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="range"
            min={2}
            max={sliderMaxS}
            step={1}
            value={rack.slots}
            data-testid="rack-slots-slider"
            aria-label="Height slider in slots"
            style={{ flex: 1 }}
            onChange={(e) => update({ slots: Number(e.target.value) })}
          />
          <input
            type="number"
            min={2}
            max={40}
            step={1}
            value={rack.slots}
            data-testid="rack-slots"
            style={{ width: 56 }}
            onChange={(e) => update({ slots: Number(e.target.value) })}
          />
          <input
            type="number"
            min={mmForSlots(2)}
            max={mmForSlots(40)}
            step={1}
            value={mmForSlots(rack.slots)}
            data-testid="rack-height-mm"
            aria-label="Height in millimetres (rounds to whole slots)"
            style={{ width: 72 }}
            onChange={(e) => update({ slots: slotsForMm(Number(e.target.value)) })}
          />
          <span style={{ fontSize: 11, color: '#9aa4b0' }}>mm</span>
        </div>
      </LabelledField>
      <p style={{ fontSize: 12, color: '#9aa4b0', margin: '2px 0 0' }}>
        Overall: {Math.round(dims.width)} × {Math.round(dims.depth)} × {Math.round(dims.totalH)} mm
        — {usedSlots}/{dims.slots} slots used
      </p>

      <h3 className="panel-subhead">Printer</h3>
      <LabelledField
        label="Printer"
        hint="Every part is checked against this build volume (flat or diagonal placement); blockers appear in the banner with achievable sizes."
      >
        <select value={presetId} data-testid="rack-printer-preset" onChange={(e) => setPreset(e.target.value)}>
          {PRINTER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
      </LabelledField>
      {presetId === 'custom' && rack.printer && (
        <div style={{ display: 'flex', gap: 6 }}>
          {(['x', 'y', 'z'] as const).map((axis) => (
            <LabelledField key={axis} label={axis.toUpperCase()} unit="mm" inline>
              <input
                type="number"
                min={80}
                max={1000}
                value={rack.printer![axis]}
                data-testid={`rack-printer-${axis}`}
                onChange={(e) =>
                  update({ printer: { ...rack.printer!, [axis]: Number(e.target.value) } })
                }
              />
            </LabelledField>
          ))}
        </div>
      )}

      {rackFitsWhole(rack) && (
        <label
          style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10, fontSize: 13 }}
        >
          <input
            type="checkbox"
            data-testid="rack-assembled-export"
            checked={rack.assembledExport === true}
            onChange={(e) => update({ assembledExport: e.target.checked })}
            style={{ marginTop: 3 }}
          />
          <span>
            Offer one-piece export
            <span style={{ display: 'block', color: '#9aa4b0', fontSize: 11, lineHeight: 1.45 }}>
              This printer can fit the whole rack, so it can be printed fused instead of bolted
              together — far stiffer, but a multi-day print with heavy internal support. Adds two
              entries to Export: the frame alone, and the frame with the shelves fused in. Off by
              default because building them costs a couple of seconds on every edit.
            </span>
          </span>
        </label>
      )}

      <h3 className="panel-subhead">Floor plate</h3>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
        <input
          type="checkbox"
          data-testid="rack-floor-ribs"
          checked={floorRibsEnabled(rack)}
          onChange={(e) => update({ floorRibs: e.target.checked })}
          style={{ marginTop: 3 }}
        />
        <span>
          Stiffening ribs under the floor
          <span style={{ display: 'block', color: '#9aa4b0', fontSize: 11, lineHeight: 1.45 }}>
            The floor plate is not supported by the ground — it sits 5 mm up, carried by its
            tabs. Ribs run into that gap and roughly halve the sag under heavy gear (a UPS
            on a {Math.round(dims.plateW)} mm span goes from ~
            {(((10 * 9.81 * dims.plateW ** 3) / (384 * 3500 * 1540)) * 5).toFixed(0)} mm to
            about half that at 10 kg). Adds ~64 g and makes the two plates different parts,
            since the top one is the bottom turned over. On automatically once the span
            passes 260 mm.
          </span>
        </span>
      </label>

      <h3 className="panel-subhead">Cable notches</h3>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
        <input
          type="checkbox"
          data-testid="rack-notches-enable"
          checked={rack.cableNotches != null}
          onChange={(e) =>
            update({
              cableNotches: e.target.checked
                ? { plate: 'bottom', count: 2, width: 40, depth: 30 }
                : undefined,
            })
          }
          style={{ marginTop: 3 }}
        />
        <span>
          Pass-throughs in the plate&apos;s rear edge
          <span style={{ display: 'block', color: '#9aa4b0', fontSize: 11, lineHeight: 1.45 }}>
            Openings at the BACK of the top and/or bottom plate for power and cabling. Note this
            makes the two plates different parts: the top plate is normally the bottom one turned
            over, and that flip would put a rear notch at the front.
          </span>
        </span>
      </label>
      {rack.cableNotches && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          <select
            data-testid="rack-notches-plate"
            aria-label="Notch plate"
            value={rack.cableNotches.plate}
            onChange={(e) =>
              update({
                cableNotches: { ...rack.cableNotches!, plate: e.target.value as 'top' | 'bottom' | 'both' },
              })
            }
          >
            <option value="bottom">bottom plate</option>
            <option value="top">top plate</option>
            <option value="both">both plates</option>
          </select>
          {([
            ['count', 'how many', 1, 12],
            ['width', 'width (mm)', 4, 120],
            ['depth', 'depth (mm)', 4, 120],
          ] as const).map(([key, label, lo, hi]) => (
            <label key={key} style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
              {label}
              <input
                type="number"
                min={lo}
                max={hi}
                data-testid={`rack-notches-${key}`}
                aria-label={`Notch ${key}`}
                value={rack.cableNotches![key]}
                onChange={(e) =>
                  update({
                    cableNotches: {
                      ...rack.cableNotches!,
                      [key]: Math.max(lo, Math.min(hi, Number(e.target.value) || lo)),
                    },
                  })
                }
                style={{ width: 62 }}
              />
            </label>
          ))}
        </div>
      )}

      <h3 className="panel-subhead">Mounting</h3>
      <LabelledField label="Mounting" hint="Freestanding, or wall-mounted via screw ears / french cleat. Wall modes solidify the sides' rear band for strength.">
        <select
          value={rack.wallMount ?? 'none'}
          data-testid="rack-wall-mount"
          onChange={(e) => update({ wallMount: e.target.value as RackParams['wallMount'] })}
        >
          {WALL_MOUNT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value} title={o.hint}>
              {o.label}
            </option>
          ))}
        </select>
      </LabelledField>
      {rack.wallMount === 'ears' && (
        <p style={{ fontSize: 12, color: '#d9c98a', margin: '2px 0 0' }} data-testid="rack-mount-guidance">
          Each side panel grows a gusseted rear flange. Drive the ear screws into studs or
          rated drywall anchors — a loaded rack can exceed 10&nbsp;kg. Print the sides
          inner-face-down so ears and gussets build up as solid walls.
        </p>
      )}
      {rack.wallMount === 'cleat' && (
        <p style={{ fontSize: 12, color: '#d9c98a', margin: '2px 0 0' }} data-testid="rack-mount-guidance">
          The hanger is cut INTO the side panels: the full-depth block at the top of each
          rear edge is the hook — it rests on the cleat&apos;s 45° bevel, and the rear band
          below it is relieved by the cleat&apos;s thickness. Screw the cleat strip to studs
          bevel-up, the flat spacer strip low, then lower the rack on from above. NOTE:
          the strips hold the rack 15&nbsp;mm off the wall by design — for a dead-flush
          back use keyhole hangers instead.
        </p>
      )}
      {rack.wallMount === 'keyhole' && (
        <p style={{ fontSize: 12, color: '#d9c98a', margin: '2px 0 0' }} data-testid="rack-mount-guidance">
          Four keyhole hangers (two per side) are cut into the rear faces. Drive #8 / 4 mm
          pan-head screws into studs or rated anchors, leaving ~4.5&nbsp;mm of the head
          proud, hang the rack over the heads and slide it down to lock. The back sits
          flush on the wall.
        </p>
      )}

      <h3 className="panel-subhead">Fans</h3>
      {(rack.fans ?? []).map((fan, i) => {
        const setFan = (next: typeof fan): void => {
          const list = [...(rack.fans ?? [])];
          list[i] = next;
          update({ fans: list });
        };
        return (
          <div key={fan.id} data-testid={`rack-fan-${i}`} style={CARD_STYLE}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select
                value={fan.side}
                aria-label={`Fan ${i + 1} side`}
                onChange={(e) => setFan({ ...fan, side: e.target.value as 'left' | 'right' })}
              >
                <option value="left">Left panel</option>
                <option value="right">Right panel</option>
              </select>
              <select
                value={String(fan.size)}
                aria-label={`Fan ${i + 1} size`}
                onChange={(e) => setFan({ ...fan, size: Number(e.target.value) as typeof fan.size })}
              >
                {[40, 60, 80, 92, 120].map((s) => (
                  <option key={s} value={s}>
                    {s} mm
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label={`Remove fan ${i + 1}`}
                title="Remove this fan"
                style={REMOVE_STYLE}
                onClick={() => update({ fans: (rack.fans ?? []).filter((_, j) => j !== i) })}
              >
                ✕
              </button>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 }}>
              <LabelledField label="From front" unit="mm" inline>
                <input
                  type="number"
                  min={30}
                  max={rack.depth - 30}
                  value={fan.y}
                  aria-label={`Fan ${i + 1} position from front`}
                  style={{ width: 60 }}
                  onChange={(e) => setFan({ ...fan, y: Number(e.target.value) })}
                />
              </LabelledField>
              <LabelledField label="Height" unit="mm" inline>
                <input
                  type="number"
                  min={30}
                  max={Math.round(dims.bodyH) - 30}
                  value={fan.z}
                  aria-label={`Fan ${i + 1} height`}
                  style={{ width: 60 }}
                  onChange={(e) => setFan({ ...fan, z: Number(e.target.value) })}
                />
              </LabelledField>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        data-testid="rack-add-fan"
        onClick={() =>
          update({
            fans: [
              ...(rack.fans ?? []),
              {
                id: newId(),
                side: 'left',
                size: 80,
                y: Math.round(rack.depth * 0.6),
                z: Math.round(dims.bodyH / 2),
              },
            ],
          })
        }
      >
        + Add side fan
      </button>
      {(rack.fans ?? []).length > 0 && (
        <p style={{ fontSize: 12, color: '#9aa4b0', margin: '2px 0 0' }}>
          Each fan sits on a solid strip in the side panel with the standard bolt
          pattern for its size — fans screw on from outside with their own
          self-tapping screws. The strip runs whichever way is shorter, across the
          depth or up the height, so a tall rack doesn&apos;t carry a full-height
          slab. Position is the fan&apos;s center: mm from the front, mm above the
          panel bottom.
        </p>
      )}

      <h3 className="panel-subhead">Accessories</h3>
      <p style={{ fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '0 0 8px' }}>
        Shelves and trays show the box that actually fits on them. Height is clear space
        above the deck up to the next shelf — or the top plate, when nothing is above.
        A faceplate above doesn&apos;t reduce it; it only closes the front. Width is
        between the end ribs, not the rack&apos;s outside width.
      </p>
      {(rack.accessories ?? []).map((acc, i) => {
        const n = accessorySlots(acc);
        // Issue #141 — slots are a mounting pitch, not usable space. Show what
        // will actually fit on this shelf.
        const space = spaces[i]?.usable ?? null;
        return (
          <div key={acc.id} data-testid={`rack-accessory-${i}`} style={CARD_STYLE}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select
                value={acc.type}
                aria-label={`Accessory ${i + 1} type`}
                style={{ flex: 1, minWidth: 0 }}
                onChange={(e) => setAccessory(i, { ...acc, type: e.target.value as RackAccessoryType })}
              >
                {ACCESSORY_LABELS.map((o) => (
                  <option key={o.value} value={o.value} title={o.hint}>
                    {o.label}
                  </option>
                ))}
              </select>
              {acc.type !== 'cable-tray' && (
                <input
                  type="number"
                  min={1}
                  max={12}
                  value={n}
                  aria-label={`Accessory ${i + 1} slots`}
                  title="Height in slots"
                  style={{ width: 44, flexShrink: 0 }}
                  onChange={(e) => setAccessory(i, { ...acc, slots: Number(e.target.value) })}
                />
              )}
              <button
                type="button"
                aria-label={`Remove accessory ${i + 1}`}
                title="Remove this accessory"
                style={REMOVE_STYLE}
                onClick={() => update({ accessories: (rack.accessories ?? []).filter((_, j) => j !== i) })}
              >
                ✕
              </button>
            </div>
            {space && (
              <div
                data-testid={`rack-accessory-space-${i}`}
                style={{ fontSize: 11, color: '#9aa4b0', marginTop: 6, lineHeight: 1.45 }}
              >
                Fits <strong style={{ color: '#c8d3de' }}>
                  {space.w.toFixed(0)} × {space.d.toFixed(0)} × {space.h.toFixed(0)} mm
                </strong>{' '}
                (W×D×H)
              </div>
            )}
            {acc.type === 'shelf' && (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                <select
                  value={String(acc.shelfDepth ?? 123)}
                  aria-label={`Accessory ${i + 1} shelf depth`}
                  onChange={(e) =>
                    setAccessory(i, {
                      ...acc,
                      shelfDepth: e.target.value === 'full' ? 'full' : Number(e.target.value),
                    })
                  }
                >
                  <option value="86">short (86 mm) — front screws only</option>
                  <option value="123">long (123 mm) — anchors mid bar</option>
                  <option value="160">extra deep (160 mm) — anchors mid bar</option>
                  <option value="full">
                    full depth ({Math.round(rack.depth - 12)} mm) — front, mid and rear screws
                  </option>
                </select>
                <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={acc.frontPlate ?? false}
                    aria-label={`Accessory ${i + 1} front plate`}
                    onChange={(e) => setAccessory(i, { ...acc, frontPlate: e.target.checked })}
                  />
                  Front plate
                </label>
                <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={acc.vented !== false}
                    aria-label={`Accessory ${i + 1} vented`}
                    onChange={(e) => setAccessory(i, { ...acc, vented: e.target.checked })}
                  />
                  Vented
                </label>
              </div>
            )}
          </div>
        );
      })}
      <button
        type="button"
        data-testid="rack-add-accessory"
        onClick={() =>
          update({
            accessories: [...(rack.accessories ?? []), { id: newId(), type: 'blank', slots: 2 }],
          })
        }
      >
        + Add accessory
      </button>

      <p style={{ fontSize: 12, color: '#9aa4b0' }}>
        Hardware: M5 cap screws (≈20–25 mm) through the side panels into each part&apos;s end
        ribs — one per slot per side. Attribution: remix of &quot;Mini Rack&quot; by Meuon
        (Printables 1307276, CC-BY 4.0).
      </p>
      <button
        type="button"
        data-testid="rack-disable"
        onClick={() => patchCase({ rack: { ...rack, enabled: false } })}
      >
        Disable rack (back to normal case)
      </button>
    </div>
  );
}
