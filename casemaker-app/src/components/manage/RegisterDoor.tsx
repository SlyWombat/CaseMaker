/**
 * The register frame (#311, tracking #212): the rail's other occupant, and the three doors onto
 * registering a physical cutter.
 *
 * THE STRIP IS THE FRAME, THE PANELS ARE #309's, and the frame outlived its own placeholder. #311
 * drew three named doors with a sentence each so the shape of the answer was legible before any of
 * it existed; #309 has now built the panels behind them, so this file is the strip, the heading and
 * the branch — nothing else, because anything else here would be a second place to look for a
 * decision the doors make themselves.
 */

import { useManageModeStore, type RegisterDoor as Door } from '@/store/manageModeStore';
import { CatalogueDoor } from './doors/CatalogueDoor';
import { ScanDoor } from './doors/ScanDoor';
import { TypeDoor } from './doors/TypeDoor';

const DOORS: ReadonlyArray<{ id: Door; label: string }> = [
  { id: 'scan', label: 'Scan' },
  { id: 'catalogue', label: 'Catalogue' },
  { id: 'type', label: 'Type' },
];

export function RegisterDoor() {
  const door = useManageModeStore((s) => s.door);
  const setDoor = useManageModeStore((s) => s.setDoor);
  const closeRegister = useManageModeStore((s) => s.closeRegister);

  return (
    <aside className="context-panel" data-testid="manage-register">
      <div className="panel-head">
        <h3>Register a cutter</h3>
        <button
          type="button"
          className="x"
          aria-label="Close"
          data-testid="manage-register-close"
          onClick={closeRegister}
        >
          ×
        </button>
      </div>

      <div className="door" role="tablist" aria-label="How to register" data-testid="manage-register-doors">
        {DOORS.map((d) => (
          <button
            key={d.id}
            type="button"
            role="tab"
            aria-selected={door === d.id}
            className={door === d.id ? 'on' : undefined}
            data-testid={`manage-door-${d.id}`}
            onClick={() => setDoor(d.id)}
          >
            {d.label}
          </button>
        ))}
      </div>

      {door === 'scan' && <ScanDoor />}
      {door === 'catalogue' && <CatalogueDoor />}
      {door === 'type' && <TypeDoor />}
    </aside>
  );
}
