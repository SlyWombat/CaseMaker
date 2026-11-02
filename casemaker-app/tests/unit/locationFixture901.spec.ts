/**
 * #901 — THE SHARED LOCATION FIXTURE CARRIES EVERY KNOWN DEFAULT.
 *
 * `tests/unit/fixtures/location-doc.json` is the shared location document: the Rust house's
 * round-trip test imports and exports it, and many e2e routes and bench jobs serve it as the
 * bench location. The Rust import back-fills missing seeds (`add_missing_seeds`), so a default
 * added to the seed table but not to this fixture makes the export differ from the fixture and
 * turns the RUST suite red — a suite no gate here runs (that is exactly how #846's three
 * `rough3d.*` seeds sat unnoticed for a day).
 *
 * This check moves the failure into the gate we do run: a new default fails here until the
 * fixture carries it too.
 */
import { describe, expect, it } from 'vitest';

import { KNOWN_DEFAULTS } from '@/platform/defaultsClient';
import fixture from './fixtures/location-doc.json';

describe('#901 the shared location fixture is complete', () => {
  it('holds every default the shop knows', () => {
    const defaults = (fixture as { defaults: Record<string, unknown> }).defaults;
    const missing = Object.keys(KNOWN_DEFAULTS).filter((key) => !(key in defaults));
    expect(
      missing,
      'add these to tests/unit/fixtures/location-doc.json (the Rust round-trip and the bench location read it)',
    ).toEqual([]);
  });

  it('every entry states where its number came from', () => {
    // The fixture is a DOCUMENT, not a list: each default carries its source, and a seeded one
    // carries the unit the service validates it against. A hand-added entry with no source would
    // pass the key check above and still be wrong as a document.
    const defaults = (fixture as { defaults: Record<string, { source?: string; unit?: string | null }> }).defaults;
    for (const [key, value] of Object.entries(defaults)) {
      expect(value.source, `${key} has no source`).toMatch(/^(seeded|chosen|measured|default)$/);
      if (value.source === 'seeded') expect(value.unit, `${key} is seeded with no unit`).toBeDefined();
    }
  });
});
