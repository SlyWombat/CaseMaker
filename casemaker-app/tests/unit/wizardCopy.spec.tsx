// @vitest-environment jsdom
// #1109 — THE FOUR STEPS' COPY, BY RENDERING THEM. Three rules, each failing here so the next
// string added to a step cannot skip them:
//  (a) a `title` is never the only help: its words are on the screen too;
//  (b) every term in the checked-in `glossaryTerms.json` is rendered on a step (a dead glossary
//      entry fails — item 9 says a term on no step is deleted);
//  (c) the first step that shows a term shows its `Explain` line with it (the gloss is visible, not
//      a hover title, and the checked-in list is the test's source).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { HoldingStep } from '@/components/welcome/HoldingStep';
import { MachineStep } from '@/components/welcome/MachineStep';
import { OperationStep } from '@/components/welcome/OperationStep';
import { StartStockStep } from '@/components/welcome/StartStockStep';
import { GLOSSARY } from '@/components/welcome/glossary';
import type { WizardStepId } from '@/components/welcome/wizardSteps';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { defaultSetupAnswers } from '@/engine/cnc/engrave/setupFlow';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import type { MachineRecord, LocationView } from '@/platform/locationClient';
import type { EngraveJob } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as {
  id: string;
  name: string;
  createdAt: string;
  machines: MachineRecord[];
  accessories: unknown[];
};
/** The approved list — the glossary and this file must name the same terms, both ways. */
const TERMS = JSON.parse(readFileSync(join(HERE, 'glossaryTerms.json'), 'utf8')) as string[];

const caps = vi.hoisted(() => ({ drive: true }));
vi.mock('@/platform/capabilities', async (orig) => {
  const real = await orig<typeof import('@/platform/capabilities')>();
  return {
    ...real,
    get canReachMachine() {
      return caps.drive;
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * HOW EACH TERM IS WRITTEN WHERE A STEP SHOWS IT. The glossary ids are kebab; the screens say
 * "jaw ledge", "reverse, inner teeth", "Anchor 1". One row per approved term, so a renamed control
 * fails (c) rather than silently losing its gloss.
 */
const SURFACE: Record<string, RegExp> = {
  'v-carve': /v[-\s]?carve/i,
  'variable-depth': /variable[-\s]depth/i,
  inlay: /\binlay\b/i,
  prism: /\bprism\b/i,
  flute: /\bflute\b/i,
  texture: /\btexture\b/i,
  // "Studio's rotary relief" (the rotary provenance note on Holding) is Makera's own feature name,
  // not the 3D operation the glossary's line explains — only the operation's word counts here.
  relief: /(?<!rotary )\brelief\b/i,
  gerber: /gerber/i,
  boss: /\bboss\b/i,
  'simulate-only': /simulate only/i,
  proud: /\bproud\b/i,
  'jaw-ledge': /jaw ledge/i,
  'stick-out': /stick[-\s]?out/i,
  'neck-for-parting': /neck for parting/i,
  'self-centring-scroll': /self-centring/i,
  'anchor-1': /\banchor 1\b/i,
  'reverse-teeth': /reverse,\s*(inner|outer)\s+teeth/i,
  broadcasts: /broadcast/i,
};

const ROTARY = {
  id: 'fx-rotary-1',
  kind: 'rotary-module',
  product: 'makera-4th-axis',
  variant: null,
  constants: {},
  unit: {},
  provenance: {},
  whereabouts: { kind: 'machine', machineId: 'makera-z1-1a2b3c', since: '2026-10-27T09:00:00.000Z' },
  history: [],
};

function seedLocation(machines: MachineRecord[] = DOC.machines, accessories: unknown[] = DOC.accessories): void {
  const location = {
    kind: 'casemaker-location',
    schemaVersion: 1,
    id: DOC.id,
    name: DOC.name,
    createdAt: DOC.createdAt,
    machines,
    accessories,
  } as unknown as LocationView;
  act(() => {
    useLocationStore.setState({ status: 'present', location, etag: '"e1"', reason: null });
  });
}

/** The fixture with the 4th axis on its pins and a bare bed (the #714 test's own setup). */
function rotaryMachine(): MachineRecord {
  const machine = JSON.parse(JSON.stringify(DOC.machines[0])) as MachineRecord;
  const profile = machine.bedProfiles![0]!;
  profile.placements = [
    {
      id: 'pl-rotary',
      fixture: 'fx-rotary-1',
      where: { kind: 'pins', pins: 'rotary', anchor: null },
      count: null,
      seed: null,
      frame: null,
      provenance: {},
    },
  ] as never;
  profile.surface = {
    kind: 'bare-bed',
    material: null,
    length: null,
    width: null,
    thickness: null,
    position: null,
    provenance: {},
    scars: [],
    lastResurfacedAt: null,
  } as never;
  profile.consumables = null;
  return machine;
}

/** The fixture with NOTHING on the pins: the bed options are real choices, the bracket is absent. */
function bareBedMachine(): MachineRecord {
  const machine = JSON.parse(JSON.stringify(DOC.machines[0])) as MachineRecord;
  const profile = machine.bedProfiles![0]!;
  profile.placements = profile.placements.filter((pl) => pl.where.kind !== 'pins');
  profile.consumables = null;
  return machine;
}

/** A ⌀20 × 85 mm rod in the chuck, the rotary step's own job. */
function dowelJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { length: 100, width: 20, thickness: 20, material: 'pla', shape: 'cylinder', diameter: 20 },
    workholding: {
      kind: 'rotary-chuck',
      rotary: { jawDiameter: null, stickout: 85, gripDiameter: null, jawMode: 'reverse-inner', tailstock: true, source: 'test' },
    },
    labels: [],
    shapes: [],
  } as EngraveJob;
}

type View = ReturnType<typeof render>;

const RENDERS: readonly { step: WizardStepId; name: string; view: () => View }[] = [
  {
    step: 'machine',
    name: 'a machine found at its recorded address',
    view: () =>
      render(
        <MachineStep
          machines={DOC.machines}
          busy={false}
          outcome="found"
          route="recorded"
          machine={{
            name: 'Makera Z1',
            host: '192.168.10.43',
            port: 2222,
            busy: false,
            ip: '192.168.10.43',
            mac: null,
            profileId: 'Z1',
            observedAt: '2026-11-11T09:00:00.000Z',
            notes: [],
            status: '<Idle|MPos:-1.000,-1.000,-1.000|F:0,0,100|S:0,0,100|T:0>',
          }}
          reason={null}
          onCheck={() => undefined}
          selectedMachineId={DOC.machines[0]!.id}
        />,
      ),
  },
  {
    step: 'operation',
    name: 'the flat question, on its cards',
    view: () => render(<OperationStep job={defaultEngraveJob()} hasOperations={false} onChoiceChange={() => undefined} />),
  },
  {
    step: 'operation',
    name: 'the sixteen engine chips under Something else…',
    view: () => {
      const view = render(<OperationStep job={defaultEngraveJob()} hasOperations={false} onChoiceChange={() => undefined} />);
      fireEvent.click(screen.getByTestId('start-wizard-preset-something-else'));
      return view;
    },
  },
  {
    step: 'operation',
    name: 'a rod in the chuck (the rotary picker)',
    view: () => render(<OperationStep job={dowelJob()} hasOperations={false} onChoiceChange={() => undefined} />),
  },
  {
    step: 'stock',
    name: 'a new blank',
    view: () => {
      seedLocation();
      return render(<StartStockStep onChange={() => undefined} />);
    },
  },
  {
    step: 'holding',
    name: 'a plate in the vise',
    view: () => {
      seedLocation();
      const job = defaultEngraveJob();
      return render(
        <HoldingStep
          job={job}
          answers={defaultSetupAnswers(job)}
          onAnswers={() => undefined}
          onRotary={() => undefined}
          onBedHold={() => undefined}
          onHold={() => undefined}
          onMoveItemsToTop={() => undefined}
        />,
      );
    },
  },
  {
    step: 'holding',
    name: 'a rod in the rotary chuck',
    view: () => {
      seedLocation([rotaryMachine()], [...DOC.accessories, ROTARY]);
      const job = dowelJob();
      return render(
        <HoldingStep
          job={job}
          answers={defaultSetupAnswers(job)}
          onAnswers={() => undefined}
          onRotary={() => undefined}
          onBedHold={() => undefined}
          onHold={() => undefined}
          onMoveItemsToTop={() => undefined}
        />,
      );
    },
  },
  {
    step: 'holding',
    name: 'nothing on the pins, without the bracket',
    view: () => {
      seedLocation([bareBedMachine()]);
      const job = defaultEngraveJob();
      return render(
        <HoldingStep
          job={job}
          answers={defaultSetupAnswers(job)}
          onAnswers={() => undefined}
          onRotary={() => undefined}
          onBedHold={() => undefined}
          onHold={() => undefined}
          onMoveItemsToTop={() => undefined}
        />,
      );
    },
  },
];

/** The first render per step that shows a term owns its Explain; later steps are not re-checked. */
/**
 * The visible words with a space at every element boundary: `textContent` glues a chip's label to
 * its help line ("InlayA pocket…"), which hides the word boundary a term matcher needs.
 */
function readableText(root: HTMLElement): string {
  const out: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) out.push(node.textContent ?? '');
    else for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(root);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

const seen = new Map<string, Set<string>>();
const shown = new Set<string>();

afterEach(() => cleanup());

describe('#1109 the four steps’ copy', () => {
  it('the glossary and the checked-in list name the same terms', () => {
    expect(Object.keys(GLOSSARY).sort()).toEqual([...TERMS].sort());
    for (const term of TERMS) expect(SURFACE[term], term).toBeDefined();
  });

  for (const entry of RENDERS) {
    it(`${entry.step}: ${entry.name} — help is visible, and every term is explained where it first shows`, () => {
      cleanup();
      resetLocationStore();
      const { container } = entry.view();
      const text = readableText(container);
      const seenThisStep = seen.get(entry.step) ?? new Set<string>();

      // (a) every `title` also reads on the screen (never the only help).
      for (const el of Array.from(container.querySelectorAll('[title]'))) {
        const title = el.getAttribute('title')!;
        expect(text, `<${el.tagName.toLowerCase()}> title="${title}" has no visible twin`).toContain(title);
      }

      // (c) the first render of the step that shows a term has its Explain line.
      for (const term of TERMS) {
        const explains = container.querySelectorAll(`[data-testid="explain-${term}"]`);
        const saysWord = SURFACE[term]!.test(text);
        // (b)'s "rendered" is either the word or its gloss line: a term whose point is explained
        // before the operator reads the trade word (self-centring scroll, on a round rod) is used.
        if (saysWord || explains.length > 0) shown.add(term);
        if (!saysWord || seenThisStep.has(term)) continue;
        expect(explains.length, `${entry.step} shows “${term}” first here — no Explain line`).toBeGreaterThan(0);
        seenThisStep.add(term);
      }
      seen.set(entry.step, seenThisStep);
    });
  }

  it('(b) every approved term is rendered on at least one step', () => {
    const missing = TERMS.filter((term) => !shown.has(term));
    expect(missing, 'terms in glossaryTerms.json that no step renders (delete them, item 9)').toEqual([]);
  });

  it('the boss is the raised post or stud, not a pocket island', () => {
    expect(GLOSSARY.boss).toContain('raised post or stud');
    expect(GLOSSARY.boss).not.toContain('island');
  });
});
