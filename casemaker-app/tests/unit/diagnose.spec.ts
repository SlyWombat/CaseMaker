// #826 — the `diagnose` line, read into the facts the status monitor shows. Pure: the bench trace
// line from docs/bench/traces/2026-10-30-probe-survey.log, and the field order the firmware's own
// `Endstops.cpp` writes (the sixth E slot is the two cover switches ANDed, not Z max).

import { describe, expect, it } from 'vitest';
import { readDiagnoseLine } from '@/platform/desktop/protocol';

const BENCH =
  '{S:0,10000,0,0,20,22|L:0,0|V:1,26|F:0,0|G:1,0,0,0,0|T:0|C:1|E:0,0,0,0,0,1,1,0|P:0,0|I:0|RSSI:-40}';

describe('#826 readDiagnoseLine', () => {
  it('reads the bench line: probe open, cover closed, no limit held, e-stop released, Wi-Fi −40 dBm', () => {
    expect(readDiagnoseLine(BENCH)).toEqual({
      coverClosed: true,
      endstops: { xMin: false, xMax: false, yMin: false, yMax: false, zMin: false },
      probe: false,
      calibrate: false,
      // C slot 0 is the wireless probe charger's output (#884); the bench line carries `C:1`.
      probeChargerOn: true,
      estop: false,
      rssi: -40,
    });
  });

  it('a pressed stylus reads the probe input and leaves the calibrate input alone', () => {
    const reading = readDiagnoseLine(BENCH.replace('|P:0,0|', '|P:1,0|'));
    expect(reading.probe).toBe(true);
    expect(reading.calibrate).toBe(false);
  });

  it('the sixth E value is the cover (both switches ANDed), not Z max', () => {
    expect(readDiagnoseLine(BENCH.replace('|E:0,0,0,0,0,1,', '|E:0,0,0,0,0,0,')).coverClosed).toBe(false);
    // The A/B values after the six are the rotary home pin and the motor alarm; they are not
    // endstops and do not move any axis slot.
    expect(readDiagnoseLine(BENCH).endstops.zMin).toBe(false);
  });

  it('a held limit is named by its slot', () => {
    const reading = readDiagnoseLine(BENCH.replace('|E:0,0,0,0,0,', '|E:1,0,0,1,0,'));
    expect(reading.endstops).toMatchObject({ xMin: true, yMax: true, xMax: false, yMin: false });
  });

  it('an e-stop reads pressed; a missing field is null, never 0', () => {
    expect(readDiagnoseLine(BENCH.replace('|I:0|', '|I:1|')).estop).toBe(true);
    const bare = readDiagnoseLine('{S:0|E:0,0,0}');
    expect(bare.coverClosed).toBeNull();
    expect(bare.endstops.zMin).toBeNull();
    expect(bare.probe).toBeNull();
    expect(bare.calibrate).toBeNull();
    expect(bare.estop).toBeNull();
    expect(bare.rssi).toBeNull();
  });

  it('a firmware that does not emit RSSI has no Wi-Fi reading', () => {
    expect(readDiagnoseLine(BENCH.replace('|RSSI:-40', '')).rssi).toBeNull();
  });
});
