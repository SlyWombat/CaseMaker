/**
 * #743 P-1 — PCB, the material and its copper cap.
 *
 * Makera's catalogue lists a copper-clad `PCB` material and its rows for the engraving bits, but
 * this app had no material to ask for it, so those rows could never answer a job. This slice gives
 * the material its word, maps the vendor's name exactly, and writes a PCB blank's copper as the
 * stock's colour cap (design D2) — so the depth rules that already read a laminate answer "does the
 * isolation go through the copper?" without a PCB-only rule.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { materialOptionsFor } from '@/engine/cnc/engrave/setupFlow';
import {
  MATERIAL_LABELS,
  isCompositeMaterial,
  isConductiveMaterial,
  isMetalMaterial,
  isPlasticMaterial,
  isWoodMaterial,
} from '@/engine/cnc/materials';
import { feedsFor, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { PCB_COPPER_MM, stockFromMade } from '@/engine/cnc/stockStart';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill } from '@/engine/cnc/tool';

const CATALOGUE = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/unit/fixtures/pcb/catalogue-pcb.json'), 'utf8'),
) as { feeds: FeedCatalogueRow[] };

/** Makera's 0.1 mm × 60° engraving bit, by the id its PCB row names. */
const ENGRAVER = flatEndMill(0.1, {
  id: 'pcb-engrave-0-1-60',
  name: '0.1 mm 60° engraving bit',
  typeText: 'Engraving',
  shape: 'engraving',
  tipDiameter: 0.1,
  diameter: 3.175,
  halfAngle: 30,
  angle: 60,
});

describe('PCB, the material and its copper (#743 P-1)', () => {
  it('is offered on the Z1 with its own word, and is a composite, not a plastic', () => {
    const options = materialOptionsFor(Z1);
    expect(options.find((o) => o.value === 'pcb')?.label).toBe('PCB (copper-clad FR-4)');
    expect(MATERIAL_LABELS.pcb).toBe('PCB (copper-clad FR-4)');
    expect(isCompositeMaterial('pcb')).toBe(true);
    // None of the three poles: not a plastic (no antistatic switch), not a wood or a metal (so the
    // facing rule leaves it alone by its own default).
    expect(isPlasticMaterial('pcb')).toBe(false);
    expect(isWoodMaterial('pcb')).toBe(false);
    expect(isMetalMaterial('pcb')).toBe(false);
    // Its top face is copper, so the shelf's conductivity fact is true.
    expect(isConductiveMaterial('pcb')).toBe(true);
  });

  it("answers Makera's own PCB rows for the engraver: 12 000 / 500 / 200 / 0.1", () => {
    const feeds = feedsFor(CATALOGUE.feeds, 'pcb', ENGRAVER, Z1);
    expect(feeds.ok).toBe(true);
    if (!feeds.ok) return;
    expect(feeds.params.rpm).toBe(12_000);
    expect(feeds.params.feed).toBe(500);
    expect(feeds.params.plungeFeed).toBe(200);
    expect(feeds.params.stepDown).toBe(0.1);
    expect(feeds.catalogue?.cutterId).toBe('pcb-engrave-0-1-60');
  });

  it('refuses a PCB job with no catalogue, naming the material, rather than inventing numbers', () => {
    const feeds = feedsFor([], 'pcb', ENGRAVER, Z1);
    expect(feeds.ok).toBe(false);
    if (feeds.ok) return;
    expect(feeds.reason).toContain('PCB');
    expect(feeds.reason).toMatch(/catalogue/i);
  });

  it('writes a made PCB blank as a laminate whose cap is the copper', () => {
    const made = stockFromMade(
      { length: 60, width: 40, thickness: 1.6, form: 'plate', material: 'pcb', finish: 'finished' },
      Z1,
    );
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.choice.stock.colour).toEqual({ kind: 'laminate', capMm: PCB_COPPER_MM });
    expect(made.choice.colourSource).toBe('assumed');
    expect(made.choice.notes.join(' ')).toMatch(/copper/i);
    expect(made.choice.entry.conductive).toBe(true);
  });

  it('takes a stated copper thickness and says it was typed', () => {
    const made = stockFromMade(
      {
        length: 60,
        width: 40,
        thickness: 1.6,
        form: 'plate',
        material: 'pcb',
        finish: 'finished',
        copperMm: 0.07,
        copperSource: 'user',
      },
      Z1,
    );
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.choice.stock.colour).toEqual({ kind: 'laminate', capMm: 0.07 });
    expect(made.choice.colourSource).toBe('user');
    expect(made.choice.notes.join(' ')).toMatch(/as you stated it/);
  });

  it('keeps an ordinary plate free of a colour cap', () => {
    const made = stockFromMade(
      { length: 60, width: 40, thickness: 3, form: 'plate', material: 'pla', finish: 'printed' },
      Z1,
    );
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.choice.stock.colour).toBeUndefined();
    expect(made.choice.entry.conductive).toBe(false);
  });
});
