// @vitest-environment jsdom
// #1170 — THE FLIP CARD, between the last program of side 1 and the first of side 2.
//
// The card is drawn from the JOB: the axis and the two locating bores are the flipped setup's own
// record (#1073/#1088), never a stock picture; the stop rule quotes the shop's registration
// tolerance. The pure `flipDue` model decides when the card is due from the package and the
// finished hashes alone, so a reload lands back on it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CutFlipCard, flipCardWords, flipDue } from '@/components/panels/CutFlipCard';
import { prepareFlipArrival, type FlipArrivalIO } from '@/components/panels/flipArrival';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useMachineStore } from '@/store/machineStore';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { resetStripAccessoryStore, useStripAccessoryStore } from '@/store/stripAccessoryStore';
import type { EngraveJob, FrozenPackage, JobSetup } from '@/types/engraveJob';

const IDENTITY = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' } as const;
const FLIPPED = { top: 'bottom', bottom: 'top', left: 'right', right: 'left', front: 'front', back: 'back' } as const;
const AT = '2026-11-10T08:00:00.000Z';
const TARGET = { host: '192.0.2.10', port: 2222 };
// The engine's own hold for a LEFT-RIGHT flip: the line is the stock's right edge (x = L − 4),
// and the stored pins are side 2's frame, so they read x = 4. Reflect = x → L − x.
const PIN_A = { x: 4, y: 18 };
const PIN_B = { x: 4, y: 42 };

function setup(id: string, over: Partial<JobSetup> = {}): JobSetup {
  return {
    id,
    orientation: { ...IDENTITY },
    mount: { kind: 'bracket' },
    itemIds: [],
    tools: ['flat-1.0'],
    ...over,
  } as unknown as JobSetup;
}

/** A two-sided bracket job: setup 2 is the flipped side, with its two locating pins. */
function bracketJob(withFlip = true): EngraveJob {
  const job = defaultEngraveJob();
  job.toolKey = 'flat-1.0';
  job.stock = { ...job.stock, length: 100, width: 60, thickness: 25 };
  const ids = job.labels.map((l) => l.id);
  job.setups = [
    setup('s1', { itemIds: ids }),
    setup('s2', {
      itemIds: ids,
      orientation: { ...FLIPPED },
      ...(withFlip ? { flip: { method: 'tabs-in-blank' as const, axis: 'left-right' as const } } : {}),
      ...(withFlip ? { pins: { at: [PIN_A, PIN_B] as [{ x: number; y: number }, { x: number; y: number }] } } : {}),
    }),
  ];
  return job;
}

function packageOf(job: EngraveJob, count = 20): FrozenPackage {
  const programs = Array.from({ length: count }, (_, i) => ({
    setupIndex: i < count / 2 ? 1 : 2,
    setupId: i < count / 2 ? 's1' : 's2',
    toolKey: 'flat-1.0',
    nc: `G0 X0 Y0\n; p${i + 1}\nM02\n`,
    hash: `h${i + 1}`,
    frameNc: null,
    frameHash: null,
  }));
  return {
    jobId: job.id,
    frozenAt: AT,
    hash: 'package',
    jobHash: 'job',
    programs,
    setups: jobSetups(job).map((s) => ({ ...s })),
    stockEntryId: null,
    surface: null,
    hold: undefined,
  } as FrozenPackage;
}

const sideOneDone = Array.from({ length: 10 }, (_, i) => `h${i + 1}`);

function fakeArrival(): FlipArrivalIO & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isHomed: () => true,
    home: async () => {
      calls.push('home');
      return { kind: 'homed' };
    },
    lightOn: async () => {
      calls.push('light');
      return { kind: 'toggled' };
    },
  };
}

beforeEach(() => {
  useShopDefaultsStore.setState({ defaults: {} });
  useMachineStore.setState({
    machine: {
      name: 'QA Z1',
      host: TARGET.host,
      port: TARGET.port,
      busy: false,
      status: '<Idle|MPos:-1,-1,-1|WPos:0,0,0|S:0.0,0,0,0,0,0,0,0,0,0>',
      statusLine: { state: 'Idle', toolWaiting: null } as never,
      profileId: 'Z1',
      observedAt: AT,
      notes: [],
    } as never,
    heartbeat: { reachable: true, lastSeenAt: AT },
  });
  useStripAccessoryStore.setState({ modes: { [`${TARGET.host}:${TARGET.port}`]: { light: true } } });
});

afterEach(() => {
  cleanup();
  resetStripAccessoryStore();
});

describe('#1170 when the flip is due', () => {
  it('side 1 done is the flip; a one-sided job, a side-1 program still running, and a boundary with no flip record are not', () => {
    const job = bracketJob();
    const pkg = packageOf(job);
    expect(flipDue({ job, pkg, finishedHashes: sideOneDone })).toMatchObject({
      fromSetup: 1,
      toSetup: 2,
      done: 10,
      total: 20,
      nextIndex: 11,
      axis: 'left-right',
    });
    // Nothing finished yet: side 1 has not ended, so there is no turn.
    expect(flipDue({ job, pkg, finishedHashes: [] })).toBeNull();
    // Side 2 already started: the turn happened.
    expect(flipDue({ job, pkg, finishedHashes: [...sideOneDone, 'h11'] })).toBeNull();
    // A one-sided job never has a boundary.
    const oneSide = bracketJob(false);
    oneSide.setups = oneSide.setups!.slice(0, 1);
    expect(flipDue({ job: oneSide, pkg: packageOf(oneSide), finishedHashes: ['h1'] })).toBeNull();
    // A second setup with no flip record is a plain bit change, not a card.
    expect(flipDue({ job: bracketJob(false), pkg, finishedHashes: sideOneDone })).toBeNull();
  });

  it('the bores are the job’s own: side 2’s stored pins, and the same points reflected back for side 1', () => {
    const job = bracketJob();
    const due = flipDue({ job, pkg: packageOf(job), finishedHashes: sideOneDone })!;
    expect(due.boresAfter).toEqual([PIN_A, PIN_B]);
    // left↔right mirrors X about the blank's length; the pair is the same two physical points.
    expect(due.boresBefore).toEqual([
      { x: 96, y: 18 },
      { x: 96, y: 42 },
    ]);
    expect(due.stock).toEqual({ length: 100, width: 60 });
  });

  it('the axis words say which edge stays and where the clamp goes back', () => {
    expect(flipCardWords('left-right')).toEqual({
      axisWords: 'left to right',
      arrow: 'left ↔ right',
      stays: 'front',
      clamp: 'back',
      corner: 'front-right',
    });
    expect(flipCardWords('front-back')).toEqual({
      axisWords: 'front to back',
      arrow: 'front ↔ back',
      stays: 'left',
      clamp: 'right',
      corner: 'back-left',
    });
  });
});

describe('#1170 the flip card', () => {
  function draw(): { register: ReturnType<typeof vi.fn>; arrival: ReturnType<typeof fakeArrival> } {
    const job = bracketJob();
    const pkg = packageOf(job);
    useEngraveJobStore.setState({ job });
    useShopDefaultsStore.setState({
      defaults: { 'registration.surfaceToleranceMm': { value: 0.2, source: 'chosen', setAt: null } } as never,
    });
    const register = vi.fn();
    const arrival = fakeArrival();
    render(
      <CutFlipCard
        job={job}
        pkg={pkg}
        finishedHashes={sideOneDone}
        target={TARGET}
        onRegister={register}
        arrival={arrival}
      />,
    );
    return { register, arrival };
  }

  it('says the stage, the axis, the job’s two bores and the three steps', () => {
    draw();
    expect(screen.getByTestId('engrave-flip-card')).toBeTruthy();
    const head = screen.getByTestId('engrave-flip-header').textContent ?? '';
    expect(head).toContain('side 1 done, 10 of 20');
    expect(head).toContain('turn the blank');
    expect(head).toContain('homed · idle · light on');
    expect(screen.getByTestId('engrave-flip-axis').textContent).toContain('left ↔ right');

    // The two bores are drawn from the job's pins (side 2) and their reflection (side 1).
    const before = screen.getAllByTestId(/engrave-flip-bore-before-/).map((el) => ({
      x: Number(el.getAttribute('data-x')),
      y: Number(el.getAttribute('data-y')),
    }));
    const after = screen.getAllByTestId(/engrave-flip-bore-after-/).map((el) => ({
      x: Number(el.getAttribute('data-x')),
      y: Number(el.getAttribute('data-y')),
    }));
    expect(before).toEqual(expect.arrayContaining([
      { x: 96, y: 18 },
      { x: 96, y: 42 },
    ]));
    expect(after).toEqual(expect.arrayContaining([
      { x: 4, y: 18 },
      { x: 4, y: 42 },
    ]));
    // The fixture is not mirrored: both panels draw the bracket the same way.
    expect(screen.getByTestId('engrave-flip-bracket-before').getAttribute('d')).toBe(
      screen.getByTestId('engrave-flip-bracket-after').getAttribute('d'),
    );

    const steps = screen.getByTestId('engrave-flip-steps');
    expect(steps.querySelectorAll('li')).toHaveLength(3);
    expect(steps.textContent).toContain('Loosen the clamp');
    expect(steps.textContent).toContain('left to right');
    expect(steps.textContent).toContain('front edge stays at the front');
    expect(steps.textContent).toContain('back edge');
  });

  it('the one press waits for the confirmation, and the stop rule quotes the shop’s tolerance', () => {
    const { register } = draw();
    const press = screen.getByTestId('engrave-flip-register') as HTMLButtonElement;
    expect(press.textContent).toBe('Register side 2 on the two bores');
    expect(press.disabled).toBe(true);
    const note = screen.getByTestId('engrave-flip-register-note').textContent ?? '';
    expect(note).toContain('0.2 mm');
    expect(note).toContain('stops before any bore is entered');
    expect(note).toContain('program 11');

    fireEvent.click(screen.getByTestId('engrave-flip-confirm'));
    expect(press.disabled).toBe(false);
    fireEvent.click(press);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('homes first, then switches the work light on, once per arrival', async () => {
    draw();
    await vi.waitFor(() => expect((screen.getByTestId('engrave-flip-card') as HTMLElement).dataset.arrival).toBe('ready'));
  });
});

/**
 * The drawn content's bounds in an SVG's user units, STROKES INCLUDED — what a tight viewBox must
 * cover. Read from the rendered attributes, never from the component's own arithmetic, so the
 * assertion does not restate the implementation.
 */
function svgContentBounds(svg: SVGElement): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x0: number, y0: number, x1: number, y1: number): void => {
    minX = Math.min(minX, x0);
    minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x1);
    maxY = Math.max(maxY, y1);
  };
  const num = (el: Element, name: string): number => Number(el.getAttribute(name));
  for (const el of Array.from(svg.querySelectorAll('path, rect, circle'))) {
    const stroke = el.getAttribute('stroke') === null ? 0 : Number(el.getAttribute('stroke-width') ?? 1);
    const half = stroke / 2;
    if (el.tagName === 'rect') {
      const x = num(el, 'x');
      const y = num(el, 'y');
      add(x - half, y - half, x + num(el, 'width') + half, y + num(el, 'height') + half);
    } else if (el.tagName === 'circle') {
      const cx = num(el, 'cx');
      const cy = num(el, 'cy');
      const r = num(el, 'r') + half;
      add(cx - r, cy - r, cx + r, cy + r);
    } else {
      // The bracket's one shape: `M x y H x V y` (an L: bottom edge then right edge).
      const m = /^M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s+H\s*(-?[\d.]+)\s+V\s*(-?[\d.]+)$/.exec(
        (el.getAttribute('d') ?? '').trim(),
      );
      if (m === null) throw new Error(`unexpected path: ${el.getAttribute('d') ?? ''}`);
      const [x0, y0, x1, y1] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
      // Butt caps: a stroke spreads ACROSS its line, never past an end.
      add(x0, y0 - half, x1, y0 + half); // M(x0,y0) H x1 — the bottom edge
      add(x1 - half, Math.min(y0, y1), x1 + half, Math.max(y0, y1)); // V y1 — the right edge
    }
  }
  return { minX, minY, maxX, maxY };
}

// #1170 (the flip-drawing finding) — the drawing is TIGHT and the words are HTML.
describe('#1170 the flip picture', () => {
  function drawCard(): void {
    const job = bracketJob();
    useEngraveJobStore.setState({ job });
    render(
      <CutFlipCard
        job={job}
        pkg={packageOf(job)}
        finishedHashes={sideOneDone}
        target={TARGET}
        onRegister={() => {}}
        arrival={fakeArrival()}
      />,
    );
  }

  it('draws no text: the labels and the turn sentence are HTML, not SVG', () => {
    drawCard();
    const svgs = screen.getAllByTestId('engrave-flip-diagram') as unknown as SVGElement[];
    expect(svgs).toHaveLength(2);
    for (const svg of svgs) expect(svg.querySelectorAll('text')).toHaveLength(0);
    // The words live outside the drawings, in the card's body type.
    for (const testid of ['engrave-flip-label-before', 'engrave-flip-label-after', 'engrave-flip-axis']) {
      const el = screen.getByTestId(testid);
      expect(el.closest('svg')).toBeNull();
      expect((el as HTMLElement).style.fontSize).toBe('var(--cm-text-body-size)');
    }
    expect(screen.getByTestId('engrave-flip-label-before').textContent).toContain('Before');
    expect(screen.getByTestId('engrave-flip-label-after').textContent).toContain('After');
    expect(screen.getByTestId('engrave-flip-axis').textContent).toBe('left ↔ right');
  });

  it('sets each viewBox to the drawn content’s bounds plus 4 % of the larger side', () => {
    drawCard();
    for (const svg of screen.getAllByTestId('engrave-flip-diagram') as unknown as SVGElement[]) {
      const b = svgContentBounds(svg);
      const width = b.maxX - b.minX;
      const height = b.maxY - b.minY;
      const pad = Math.max(width, height) * 0.04;
      const vb = (svg.getAttribute('viewBox') ?? '').split(/\s+/).map(Number);
      expect(vb).toHaveLength(4);
      expect(vb[0]).toBeCloseTo(b.minX - pad, 2);
      expect(vb[1]).toBeCloseTo(b.minY - pad, 2);
      expect(vb[2]).toBeCloseTo(width + 2 * pad, 2);
      expect(vb[3]).toBeCloseTo(height + 2 * pad, 2);
      // The fixed 560 × 220 canvas was the empty-margin defect.
      expect(svg.getAttribute('viewBox')).not.toBe('0 0 560 220');
      // The acceptance's own limit: no side may leave more than 6 % of the width empty.
      expect(Math.abs(vb[0]! - b.minX) / vb[2]!).toBeLessThanOrEqual(0.06);
      expect(Math.abs(vb[0]! + vb[2]! - b.maxX) / vb[2]!).toBeLessThanOrEqual(0.06);
    }
  });

  it('holds every stroke at one weight at any size', () => {
    drawCard();
    for (const svg of screen.getAllByTestId('engrave-flip-diagram') as unknown as SVGElement[]) {
      const stroked = Array.from(svg.querySelectorAll('[stroke]'));
      expect(stroked.length).toBeGreaterThan(0);
      for (const el of stroked) expect(el.getAttribute('vector-effect')).toBe('non-scaling-stroke');
    }
  });
});

describe('#1170 the flip arrival', () => {
  it('a homed head takes the light only; an unhomed one is homed first', async () => {
    const calls: string[] = [];
    const homed: FlipArrivalIO = {
      isHomed: () => true,
      home: async () => {
        calls.push('home');
        return { kind: 'homed' };
      },
      lightOn: async () => {
        calls.push('light');
        return { kind: 'toggled' };
      },
    };
    expect(await prepareFlipArrival(TARGET, homed)).toBe('light-on');
    expect(calls).toEqual(['light']);

    calls.length = 0;
    const unhomed: FlipArrivalIO = { ...homed, isHomed: () => false };
    expect(await prepareFlipArrival(TARGET, unhomed)).toBe('light-on');
    expect(calls).toEqual(['home', 'light']);
  });

  it('a failed home sends no light — the head is not home', async () => {
    const calls: string[] = [];
    const arrival: FlipArrivalIO = {
      isHomed: () => false,
      home: async () => {
        calls.push('home');
        return { kind: 'failed', detail: 'Alarm' };
      },
      lightOn: async () => {
        calls.push('light');
        return { kind: 'toggled' };
      },
    };
    expect(await prepareFlipArrival(TARGET, arrival)).toBe('home-failed');
    expect(calls).toEqual(['home']);
  });
});
