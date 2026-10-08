import { useEffect, useState } from 'react';
import { useProjectStore } from '@/store/projectStore';
import { useViewportStore, type SidebarSectionId } from '@/store/viewportStore';
import { derivedKind, type Archetype } from '@/engine/compiler/archetype';

/** Phone breakpoint, matching the welcome screen's ≤640px block. Below it the
 *  left rail is an off-canvas drawer instead of a fixed 320px column, which
 *  otherwise leaves the 3D viewport a ~70px sliver (issue #134). */
const COMPACT_MAX_W = 640;

const SECTIONS: { id: SidebarSectionId; label: string; icon: string; hint: string }[] = [
  { id: 'board',    label: 'Board',           icon: '🟦', hint: 'Host PCB profile, mounting holes, components' },
  { id: 'case',     label: 'Case parameters', icon: '📦', hint: 'Walls, lid, joint, seal, latches, hinge, rugged exterior' },
  { id: 'rack',     label: 'Mini rack',       icon: '🗄️', hint: 'Parametric 10"-class network rack — resize to your printer, shelves, keystone plates, wall mount' },
  { id: 'insert',   label: 'Tool insert',     icon: '🧰', hint: 'Parametric tool-insert holder — a plate of round and hex pockets sized to your own sockets, bits, wrenches and drivers' },
  { id: 'toolbox',  label: 'Toolbox',         icon: '🧱', hint: 'Stacking toolbox modules — bins and lids that register on each other with no connector, with a drop-in floor grid' },
  { id: 'ports',    label: 'Port cutouts',    icon: '🔌', hint: 'USB, HDMI, audio, custom port openings' },
  { id: 'hats',     label: 'HATs',            icon: '🎩', hint: 'HAT placements stacked above the host board' },
  { id: 'features', label: 'Features',        icon: '⚙️',  hint: 'Snap catches, mounting features, fans, antennas, displays, text labels' },
  { id: 'assets',   label: 'External assets', icon: '📎', hint: 'STL imports, custom cutouts' },
  // #282 — the board-less part archetypes' editor. Sits before Export so it leads the rail of a
  // badge or blank project (the two archetypes that list it), and is deliberately NOT in a shell's
  // rail: for a shell there is no `case.badge`/`case.blank` to edit, and the way to get one is the
  // welcome wizard, not a section.
  { id: 'part',     label: 'Part',            icon: '🧩', hint: 'The part itself — a name badge’s outline, colour split and magnet, or a bare blank’s size, thickness and corner radius' },
  { id: 'export',   label: 'Export',          icon: '⬇️',  hint: 'Per-part Save + Save All' },
];

// #196 / #205 — the CNC panels. Behind the compile-time flag, the same gate as the stores and
// workers they drive, so the electricrv.ca bundle carries no CNC UI. The engrave editor sits
// above Simulate .nc (the issue's order).
if (__FEATURE_SIM__) {
  SECTIONS.push(
    {
      id: 'cnc-engrave',
      label: 'Engrave text',
      icon: '🪵',
      hint: 'Carve text into a blank held in the vise, each label at its own depth',
    },
    {
      id: 'cnc-sim',
      label: 'Simulate .nc',
      icon: '🧪',
      hint: 'Open a G-code file and watch it cut, before the machine does',
    },
  );
}

/** Sections that make sense for a rack project — everything else (boards,
 *  ports, HATs, board-case features) assumes a PCB in a shell. Rack fans
 *  live inside the rack panel itself. Both `cnc-` panels are included: a
 *  `.nc` file and a block of stock held in the vise have nothing to do with
 *  the open project. */
const RACK_SECTION_IDS: SidebarSectionId[] = ['rack', 'export', 'cnc-sim', 'cnc-engrave'];

/** Same idea for the name-badge archetype (issue #167): no board, no shell,
 *  no ports — but unlike a rack the badge IS the thing the engrave editor
 *  drives, so that panel stays and the rack's own section does not. Since
 *  #282 the Part section leads it: the badge's own outline, colour split and
 *  magnet were write-once before that. */
const BADGE_SECTION_IDS: SidebarSectionId[] = ['part', 'export', 'cnc-sim', 'cnc-engrave'];

/** Same idea for the tool-insert archetype (issue #158): a plate of pockets
 *  has no board, no ports and no shell features, but it is a plain printed
 *  part so it keeps the Export section. */
const INSERT_SECTION_IDS: SidebarSectionId[] = ['insert', 'export', 'cnc-sim', 'cnc-engrave'];

/** Same idea for the bare-blank archetype (issue #280): the project IS the
 *  blank, so there is no board, no shell and no ports — but it is the thing the
 *  engrave editor drives, which is the whole point of the archetype. Identical
 *  rail to the badge today; kept as its own constant so each archetype's rule
 *  is named where it lives and the two can diverge without one edit silently
 *  changing the other's rail. The Part section (#282) is where the plate's own
 *  size, thickness and corner radius live — the last of which no other route
 *  could reach. */
const BLANK_SECTION_IDS: SidebarSectionId[] = ['part', 'export', 'cnc-sim', 'cnc-engrave'];

/** Same idea for the stacking-toolbox archetype (issue #155): a bin and a lid
 *  have no board, no ports and no shell features, but they are printed parts
 *  and the toolbox's own parameters are the thing worth editing — so the
 *  toolbox section leads the rail, as the rack's does for a rack. */
const TOOLBOX_SECTION_IDS: SidebarSectionId[] = ['toolbox', 'export', 'cnc-sim', 'cnc-engrave'];

/** A shell project offers every section EXCEPT `part` (#282): its two archetypes are the board-less
 *  ones, and a shell has neither `case.badge` nor `case.blank` to edit. Built from `SECTIONS`
 *  rather than written out, so a section added to the rail is a shell section by default and the
 *  archetype-only ones have to say so. */
const SHELL_SECTION_IDS: SidebarSectionId[] = SECTIONS.map((s) => s.id).filter(
  (id) => id !== 'part',
);

/** The section ids the current archetype offers. */
function sectionIdsFor(archetype: Archetype): SidebarSectionId[] {
  if (archetype === 'rack') return RACK_SECTION_IDS;
  if (archetype === 'badge') return BADGE_SECTION_IDS;
  if (archetype === 'insert') return INSERT_SECTION_IDS;
  if (archetype === 'blank') return BLANK_SECTION_IDS;
  if (archetype === 'toolbox') return TOOLBOX_SECTION_IDS;
  return SHELL_SECTION_IDS;
}

/** Where the rail lands when the open section no longer applies to the
 *  archetype: the archetype's own editor when it has one, else Export. */
function homeSectionFor(archetype: Archetype): SidebarSectionId {
  if (archetype === 'rack') return 'rack';
  if (archetype === 'toolbox') return 'toolbox';
  // #282 — a badge or a blank now has its own editor, one step in from Export (which is where the
  // rail used to land, because there was nowhere else to go).
  if (archetype === 'badge' || archetype === 'blank') return 'part';
  return 'export';
}

export function Sidebar() {
  const welcomeMode = useProjectStore((s) => s.welcomeMode);
  const archetype = useProjectStore((s) => derivedKind(s.project));
  const activeSection = useViewportStore((s) => s.activeSidebarSection);
  const setSection = useViewportStore((s) => s.setActiveSidebarSection);
  // Phone-width drawer (issue #134). Mirrors ContextPanel's compact pattern:
  // the rail leaves the grid, a fixed handle toggles it, and a section tap
  // hands off to the right-rail drawer (which auto-opens on the same change).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isCompact, setIsCompact] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= COMPACT_MAX_W : false,
  );

  useEffect(() => {
    function onResize() {
      setIsCompact(window.innerWidth <= COMPACT_MAX_W);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const allowedIds = sectionIdsFor(archetype);

  // A stale active section (e.g. HATs was open when the rack got enabled)
  // would leave the right rail showing an inapplicable panel.
  useEffect(() => {
    if (activeSection && !allowedIds.includes(activeSection)) {
      setSection(homeSectionFor(archetype));
    }
  }, [allowedIds, archetype, activeSection, setSection]);
  if (welcomeMode) {
    return <aside className="sidebar" />;
  }
  // `allowedIds` is the archetype's list, and it decides the ORDER too — `SECTIONS` is the one
  // canonical order (a shell's), and each archetype's list is a subset written in rail order.
  const sections = SECTIONS.filter((s) => allowedIds.includes(s.id));
  // Sidebar is now an INDEX of sections. Clicking a section opens its
  // editor in the right rail (ContextPanel). Mutually exclusive with
  // viewport geometry selection — clicking either switches the right
  // rail to host that thing.
  const onSelect = (id: SidebarSectionId, isActive: boolean) => {
    setSection(isActive ? null : id);
    // On a phone, get out of the way: the section editor is a full-height
    // drawer on the other edge, so leaving the rail up would bury the scene.
    if (isCompact) setDrawerOpen(false);
  };
  const className = [
    'sidebar',
    isCompact ? 'sidebar--drawer' : '',
    isCompact ? (drawerOpen ? 'sidebar--open' : 'sidebar--closed') : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <>
      {isCompact && (
        <button
          type="button"
          className="sidebar__handle"
          onClick={() => setDrawerOpen((v) => !v)}
          aria-label={drawerOpen ? 'Close sections' : 'Open sections'}
          aria-expanded={drawerOpen}
          title={drawerOpen ? 'Close sections (◂)' : 'Open sections (☰)'}
          data-testid="sidebar-handle"
        >
          {drawerOpen ? '◂' : '☰'}
        </button>
      )}
      <aside className={className} data-testid="sidebar" aria-label="Sections" style={{ padding: 8 }}>
        {sections.map((s) => {
          const isActive = activeSection === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s.id, isActive)}
              data-testid={`sidebar-button-${s.id}`}
              aria-pressed={isActive}
              title={s.hint}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '10px 12px',
                marginBottom: 4,
                background: isActive ? '#243042' : '#1a1f25',
                border: `1px solid ${isActive ? '#3a5a7a' : '#2a2f36'}`,
                borderRadius: 4,
                color: isActive ? '#cfe' : '#d1d5db',
                fontSize: 13,
                fontWeight: isActive ? 600 : 500,
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <span aria-hidden style={{ fontSize: 16 }}>{s.icon}</span>
              <span>{s.label}</span>
            </button>
          );
        })}
      </aside>
    </>
  );
}
