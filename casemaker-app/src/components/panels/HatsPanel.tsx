import { useMemo, useState } from 'react';
import { useProjectStore } from '@/store/projectStore';
import { getBuiltinHat, hatsCompatibleWith } from '@/library/hats';
import { PortEditorRow } from './PortEditorRow';

export function HatsPanel() {
  const board = useProjectStore((s) => s.project.board);
  const hats = useProjectStore((s) => s.project.hats);
  const addHat = useProjectStore((s) => s.addHat);
  const removeHat = useProjectStore((s) => s.removeHat);
  const patchHat = useProjectStore((s) => s.patchHat);
  const setHatPortEnabled = useProjectStore((s) => s.setHatPortEnabled);
  const patchHatPort = useProjectStore((s) => s.patchHatPort);
  const resetHatPort = useProjectStore((s) => s.resetHatPortToDefault);

  const compatible = useMemo(
    () => hatsCompatibleWith(board.id, board.clonedFrom),
    [board.id, board.clonedFrom],
  );
  const [pickerValue, setPickerValue] = useState('');

  return (
    <div className="panel">
      <h3>HATs / shields</h3>
      <div className="settings-row" style={{ gridTemplateColumns: '1fr auto' }}>
        <label className="cell-label" style={{ flex: 1 }}>
          <span className="cell-label__axis">add HAT</span>
        <select
          value={pickerValue}
          onChange={(e) => setPickerValue(e.target.value)}
          data-testid="hat-picker"
          aria-label="Pick a HAT to add"
          title="Pick a HAT / shield to stack on this board. Only HATs compatible with the current board are listed."
        >
          <option value="">— select a HAT —</option>
          {compatible.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
        </label>
        <button
          onClick={() => {
            if (pickerValue) {
              addHat(pickerValue);
              setPickerValue('');
            }
          }}
          disabled={!pickerValue}
          data-testid="hat-add"
          title={pickerValue ? 'Add the picked HAT to the stack' : 'Pick a HAT first'}
        >
          + Add
        </button>
      </div>
      {compatible.length === 0 && (
        <p className="settings-hint">No HATs in the library are compatible with {board.name}.</p>
      )}
      {hats.length === 0 ? (
        <p className="settings-hint">No HATs stacked.</p>
      ) : (
        <ul className="port-list" style={{ marginTop: 8 }}>
          {[...hats]
            .sort((a, b) => a.stackIndex - b.stackIndex)
            .map((h, idx, arr) => {
              const profile = getBuiltinHat(h.hatId);
              const name = profile?.name ?? h.hatId;
              const positions = profile?.mountingPositions;
              const canMoveUp = idx > 0;
              const canMoveDown = idx < arr.length - 1;
              const swap = (otherIdx: number) => {
                const other = arr[otherIdx]!;
                const myStack = h.stackIndex;
                const otherStack = other.stackIndex;
                patchHat(h.id, { stackIndex: otherStack });
                patchHat(other.id, { stackIndex: myStack });
              };
              return (
                <li
                  key={h.id}
                  style={{
                    background: '#14181c',
                    borderRadius: 4,
                    padding: '6px 8px',
                    marginBottom: 4,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={{
                        background: '#2c343c',
                        borderRadius: 3,
                        padding: '1px 6px',
                        fontSize: 10,
                        color: '#8a94a4',
                      }}
                      title={`Stack index ${h.stackIndex}`}
                    >
                      #{h.stackIndex}
                    </span>
                    <input
                      type="checkbox"
                      checked={h.enabled}
                      onChange={(e) => patchHat(h.id, { enabled: e.target.checked })}
                      data-testid={`hat-enabled-${h.hatId}`}
                      aria-label={`HAT ${name} enabled`}
                      title={`Toggle the ${name} HAT on/off — disabled HATs are still in the stack but not rendered.`}
                    />
                    <span style={{ flex: 1, fontSize: 12 }}>{name}</span>
                    <button
                      onClick={() => canMoveUp && swap(idx - 1)}
                      disabled={!canMoveUp}
                      data-testid={`hat-up-${h.id}`}
                      title="Move up in stack"
                      style={{ fontSize: 11, padding: '2px 6px' }}
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => canMoveDown && swap(idx + 1)}
                      disabled={!canMoveDown}
                      data-testid={`hat-down-${h.id}`}
                      title="Move down in stack"
                      style={{ fontSize: 11, padding: '2px 6px' }}
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => removeHat(h.id)}
                      data-testid={`hat-remove-${h.id}`}
                      title="Remove HAT"
                      style={{ fontSize: 11, padding: '2px 6px' }}
                    >
                      ✕
                    </button>
                  </div>
                  {positions && positions.length > 1 && (
                    <div style={{ marginLeft: 18, marginTop: 4 }}>
                      <label style={{ fontSize: 11, color: '#8a94a4', display: 'flex', gap: 4, alignItems: 'center' }}>
                        Orientation:
                        <select
                          value={h.mountingPositionId ?? positions[0]!.id}
                          onChange={(e) => patchHat(h.id, { mountingPositionId: e.target.value })}
                          data-testid={`hat-orientation-${h.id}`}
                          style={{ fontSize: 11 }}
                          aria-label={`HAT ${name} orientation`}
                          title="Mounting orientation — which holes on this HAT align with which on the host board."
                        >
                          {positions.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                  {h.ports.length > 0 && (
                    <ul className="port-list" style={{ margin: '4px 0 0 18px' }}>
                      {h.ports.map((p) => (
                        <PortEditorRow
                          key={p.id}
                          port={p}
                          onSetEnabled={(v) => setHatPortEnabled(h.id, p.id, v)}
                          onPatch={(patch) => patchHatPort(h.id, p.id, patch)}
                          onReset={
                            p.sourceComponentId
                              ? () => resetHatPort(h.id, p.id)
                              : undefined
                          }
                          testIdPrefix={`hatport-${h.id}-${p.sourceComponentId ?? p.id}`}
                        />
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
        </ul>
      )}
    </div>
  );
}
