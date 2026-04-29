import { useState } from 'react';
import { triggerExport, type ExportFormat } from '@/engine/exportTrigger';
import { DonateButton } from '@/components/layout/DonateButton';

const FORMATS: { value: ExportFormat; label: string; testId: string }[] = [
  { value: 'stl-binary', label: 'STL (binary)', testId: 'export-stl' },
  { value: 'stl-ascii', label: 'STL (ASCII)', testId: 'export-stl-ascii' },
  { value: '3mf', label: '3MF', testId: 'export-3mf' },
];

export function ExportPanel() {
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState(false);
  const onClick = (format: ExportFormat) => async () => {
    setBusy(true);
    try {
      await triggerExport(format);
      setExported(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel">
      <h3>Export</h3>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {FORMATS.map((f) => (
          <button
            key={f.value}
            onClick={onClick(f.value)}
            disabled={busy}
            data-testid={f.testId}
          >
            {f.label}
          </button>
        ))}
      </div>
      {exported && <DonateButton variant="export" />}
    </div>
  );
}
