import { useState } from 'react';
import { triggerExport } from '@/engine/exportTrigger';

export function ExportPanel() {
  const [busy, setBusy] = useState(false);
  const onClick = (format: 'stl' | '3mf') => async () => {
    setBusy(true);
    try {
      await triggerExport(format);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel">
      <h3>Export</h3>
      <button onClick={onClick('stl')} disabled={busy} data-testid="export-stl">
        Download STL
      </button>
      <button
        onClick={onClick('3mf')}
        disabled={busy}
        data-testid="export-3mf"
        style={{ marginLeft: 8 }}
      >
        Download 3MF
      </button>
    </div>
  );
}
