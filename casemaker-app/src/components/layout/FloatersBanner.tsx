// Issue #83 — surface a warning when any node in the build has more than
// one disjoint solid component. A clean shell or lid has exactly 1; >1
// means something broke loose from its parent (a snap-fit lip not unioned
// with the wall, an orphaned cutout fragment, etc.) and will fall to the
// build plate as a loose part in the slicer.
//
// Warning only — never blocks export. Some users will know they have a
// floater (e.g. a custom cutout that creates an island) and want to clean
// it up in the slicer manually.

import { useJobStore } from '@/store/jobStore';

/** One decimal place for a mm or a mm³ in the banner. */
const n1 = (v: number): string => `${Math.round(v * 10) / 10}`;

export function FloatersBanner() {
  const nodes = useJobStore((s) => s.nodes);
  // Issue #850 — sealed cavities nobody asked for: information, not a warning.
  const voids = useJobStore((s) => s.sealedVoids);
  const offenders: { id: string; count: number }[] = [];
  for (const [id, node] of nodes.entries()) {
    const c = node.stats.componentCount;
    if (c !== undefined && c > 1) offenders.push({ id, count: c });
  }
  if (offenders.length === 0 && voids.length === 0) return null;
  const total = offenders.reduce((s, o) => s + o.count, 0);
  return (
    <div
      className="placement-banner placement-banner--warning"
      data-testid="floaters-banner"
      data-severity={offenders.length > 0 ? 'warning' : 'info'}
    >
      {offenders.length > 0 && (
        <>
          <div className="placement-banner__head">
            <span className="placement-banner__count">
              {total} loose part{total > 1 ? 's' : ''} detected
            </span>
          </div>
          <ul className="placement-banner__list">
            {offenders.map((o) => (
              <li key={o.id} data-severity="warning">
                <span className="placement-banner__sev">[loose]</span>{' '}
                <code>{o.id}</code> mesh has {o.count} disconnected pieces — the slicer
                will treat each as a separate part. Likely cause: a feature
                (snap-fit lip, custom cutout, ventilation slot) doesn't overlap
                its parent body. Export still works; clean up in your slicer if
                needed.
              </li>
            ))}
          </ul>
        </>
      )}
      {voids.length > 0 && (
        <ul className="placement-banner__list" data-testid="sealed-voids">
          {voids.map((v, i) => (
            <li key={`${v.node}-${i}`} data-severity="info" data-testid={`sealed-void-${i}`}>
              <span className="placement-banner__sev">[sealed]</span> a sealed{' '}
              {n1(v.volumeMm3)} mm³ cavity inside <code>{v.node}</code> at X {n1(v.centreMm[0])}, Y{' '}
              {n1(v.centreMm[1])}, Z {n1(v.centreMm[2])} — it prints as trapped air. Deliberate magnet
              pockets are expected and are not listed; this one is nobody's feature. Export still works.
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
