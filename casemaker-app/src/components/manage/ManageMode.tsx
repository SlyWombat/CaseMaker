/**
 * Manage mode (#311, tracking #212) — the house and the machines, with no project open.
 *
 * A THIRD MODE, NOT A SIDEBAR SECTION. Sections are per-project; this surface has to be reachable
 * when there is no project at all, which is exactly when someone is setting up cutters and checking
 * a machine. It takes the whole main area — the same way the welcome overlay does — and its rail is
 * its own, because the project rail's sections have nothing to say about a house.
 *
 * IT DOES NOT TOUCH THE PROJECT. Entering and leaving is a change of what is drawn, not of what is
 * open: `projectStore` and `welcomeMode` are left exactly as they were, so closing the mode puts the
 * user back on the viewport or the board picker they came from. Nothing here saves, and nothing here
 * asks.
 *
 * THE LAYOUT IS THREE COLUMNS AND EVERY SCOPE FILLS THE LAST TWO. The rail is this component's; each
 * scope renders its own main pane and its own right rail as siblings, so the Machines scope can
 * carry a different rail from the Tools scope without either knowing about the other.
 */

import { useManageModeStore } from '@/store/manageModeStore';
import { ManageRail } from './ManageRail';
import { MachinesScope } from './MachinesScope';
import { ToolsScope } from './ToolsScope';

export function ManageMode() {
  const scope = useManageModeStore((s) => s.scope);
  return (
    <div className="manage" data-testid="manage-mode" data-scope={scope}>
      <ManageRail />
      {scope === 'machines' ? <MachinesScope /> : <ToolsScope />}
    </div>
  );
}
