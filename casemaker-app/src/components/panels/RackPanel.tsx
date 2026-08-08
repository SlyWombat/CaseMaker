import { useProjectStore } from '@/store/projectStore';
import type { RackParams, RackAccessory, RackAccessoryType } from '@/types';
import { LabelledField } from '@/components/ui/LabelledField';
import {
  PRINTER_PRESETS,
  maxRackWidthForBed,
  maxRackDepthForBed,
  maxRackSlotsForBed,
} from '@/engine/compiler/rackFit';
import { computeRackDims, accessorySlots, SLOT_PITCH } from '@/engine/compiler/rack';
import { newId } from '@/utils/id';

/**
 * Rack archetype editor (see types/rack.ts). IMPORTANT: patchCase validates
 * with a TOP-LEVEL partial only, so every update sends the COMPLETE `rack`
 * object — never a nested fragment.
 */

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
    label: 'Wall — french cleat',
    hint: 'Separate 45° cleat strip screws to the wall; the rack hooks over it. Adds a bottom spacer strip. Removable without tools.',
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
          The hanger is cut INTO the side panels: a 45° hook at the top of each rear edge
          (visible in Exploded view). Screw the cleat strip to studs bevel-up, the flat
          spacer strip near the floor level, then lower the rack on from above — its hooks
          seat on the cleat and gravity pulls it against the wall.
        </p>
      )}

      <h3 className="panel-subhead">Accessories</h3>
      {(rack.accessories ?? []).map((acc, i) => {
        const n = accessorySlots(acc);
        return (
          <div
            key={acc.id}
            data-testid={`rack-accessory-${i}`}
            style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}
          >
            <select
              value={acc.type}
              aria-label={`Accessory ${i + 1} type`}
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
                style={{ width: 52 }}
                onChange={(e) => setAccessory(i, { ...acc, slots: Number(e.target.value) })}
              />
            )}
            {acc.type === 'shelf' && (
              <select
                value={String(acc.shelfDepth ?? 123)}
                aria-label={`Accessory ${i + 1} shelf depth`}
                onChange={(e) => setAccessory(i, { ...acc, shelfDepth: Number(e.target.value) })}
              >
                <option value="86">short (86 mm) — front screws only</option>
                <option value="123">long (123 mm) — anchors mid bar</option>
                <option value="160">extra deep (160 mm) — anchors mid bar</option>
              </select>
            )}
            <button
              type="button"
              aria-label={`Remove accessory ${i + 1}`}
              onClick={() => update({ accessories: (rack.accessories ?? []).filter((_, j) => j !== i) })}
            >
              ✕
            </button>
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
