/**
 * #513 — A JOB BINDS TO THE BED PROFILE IT WAS SET UP ON.
 *
 * A bed profile is the machine's bed as it physically is (surface, placements, datums — #509's
 * design, `docs/design/bed-profiles.md`). A job does not copy those numbers; it records WHICH
 * profile — with its version — it was planned against, so a reloaded job can say exactly what it
 * was set up on, and a bed that has changed since is said out loud rather than silently re-planned
 * (`bed-changed`), with two presses: re-plan on the current bed, or switch the bed back.
 *
 * The version is the `at` of the profile's last history line (the design's bed-mounts Q12): every
 * write to a profile adds a line, and a profile edited without one is a bug the absent version
 * exposes (`profileVersion` falls back to `createdAt`, which the schema requires).
 *
 * THE FINDINGS, under the maintainer's rules:
 *  - `bed-changed` WARNS in Design (the design's §8: "error (run) / warning (design)"): the job was
 *    planned on a bed that is not there now, and both answers are presses beside the sentence. The
 *    ERROR is the Cut gate's (`preflightHub`'s policy row, fed by {@link bedChangedSentence}): no
 *    program is cut against a bed that moved, and the way out there is ‹ Design, where the two
 *    presses are. A warning here rather than an error is deliberate — generating the programs does
 *    not depend on the bed, so the operator may finish the design while the warning is up.
 *  - `mount-not-on-bed`, `stock-off-surface` and `surface-top-unmeasured` INFORM (warnings): each
 *    names what to do, and none refuses on a tolerance or on a size alone.
 *  - `fixture-overlap` is an ERROR: two fixtures on the same locating pins is a physical collision.
 *  - `bed-unmeasured` is deliberately NOT a per-job finding: every datum of a fresh bed is
 *    unmeasured, so a per-job "this bed is unmeasured" is a warning on every job until the bench
 *    measures it — noise by the maintainer's rule. It is stated once, on the bed and machine cards
 *    and on the Start line; a job's finding appears only where an unmeasured datum CHANGES the job
 *    (`surface-top-unmeasured`, when registration would need it).
 *
 * A job with NO `bed` (every document written before this slice) raises no `bed-changed`: it was
 * never bound to anything, and the mount checks below are the only facts it can be judged by. It
 * binds on its next Generate (`bindJob` is what the panel writes).
 */

import type { EngraveJob, JobBedBinding } from '@/types/engraveJob';
import type { BedProfile, MachineRecord } from '@/platform/locationClient';
// ONE OWNER for "the bed the machine has now": `machineChange.ts` has resolved it since #693 (the
// change-the-machine wizard reads what is on the pins off the same call), so this module uses that
// one rather than its own copy.
import { activeProfileOf, surfaceWords } from '@/platform/machineChange';
import { BED_DATUM_WORDS } from '@/platform/bedProfiles';
import type { Mount } from '@/engine/cnc/setups/types';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';

/** The profile's version: its last history line's time, else the day it was created. */
export function profileVersion(profile: Pick<BedProfile, 'createdAt' | 'history'>): string {
  const last = profile.history.at(-1);
  return last === undefined || last.at.trim() === '' ? profile.createdAt : last.at;
}

type Datum = NonNullable<BedProfile['datums']['surfaceTopZ']>;
const datumValue = (datum: Datum | null | undefined): number | null => datum?.value ?? null;

/** The job binding a profile makes, including the datum snapshot the job was planned against. */
export function bindJob(profile: BedProfile): JobBedBinding {
  return {
    profileId: profile.id,
    profileVersion: profileVersion(profile),
    datums: {
      surfaceTopZ: datumValue(profile.datums.surfaceTopZ),
      viseJawTopZ: datumValue(profile.datums.viseJawTopZ),
      bracketSeatZ: datumValue(profile.datums.bracketSeatZ),
      rotaryAxis: datumValue(profile.datums.rotaryAxis),
      // #1059 — degrees, not millimetres: a re-levelled square invalidates a bound job's A zero.
      rotaryFaceAngle: datumValue(profile.datums.rotaryFaceAngle),
    },
  };
}

/** One way the bed moved under a job, in words. */
export interface BedDifference {
  /** Which datum (or the profile itself). */
  what: 'profile' | 'version' | 'surfaceTopZ' | 'viseJawTopZ' | 'bracketSeatZ' | 'rotaryAxis' | 'rotaryFaceAngle';
  text: string;
}

const DATUM_WORD: Readonly<Record<'surfaceTopZ' | 'viseJawTopZ' | 'bracketSeatZ' | 'rotaryAxis' | 'rotaryFaceAngle', string>> = {
  surfaceTopZ: 'surface top',
  viseJawTopZ: 'jaw top',
  bracketSeatZ: 'bracket seat',
  rotaryAxis: 'rotary axis',
  // #1059 — the datum is in degrees; the sentence says so rather than "mm".
  rotaryFaceAngle: 'face angle',
};

const mm = (v: number): string => `${Number(v.toFixed(3))} mm`;
/** The face angle's own unit: degrees of A turn, never millimetres. */
const deg = (v: number): string => `${Number(v.toFixed(3))}°`;

/**
 * The differences between the bed a job was planned on and the bed the machine has now, in words.
 *
 * Same profile, new version: each datum the job's snapshot states is compared with the profile's
 * now — a moved number is named with both values, an unmeasured one says so. A DIFFERENT profile
 * is one difference (the profile), because two profiles' datums are not the same measurement.
 */
export function diffBed(
  jobBed: JobBedBinding,
  active: BedProfile,
  profiles?: readonly BedProfile[],
): BedDifference[] {
  if (active.id !== jobBed.profileId) {
    // The old profile's NAME when the machine still holds it; its id only when it is gone (an id is
    // the machine's way of naming a record, not a bed an operator can pick up).
    const was = profiles?.find((p) => p.id === jobBed.profileId)?.name;
    return [
      {
        what: 'profile',
        text: `the bed is now “${active.name}”, not the profile this job was set up on${was === undefined ? ` (“${jobBed.profileId}”)` : ` (“${was}”)`}`,
      },
    ];
  }
  const version = profileVersion(active);
  if (version === jobBed.profileVersion) return [];
  const out: BedDifference[] = [];
  const snapshot = jobBed.datums;
  if (snapshot !== undefined) {
    for (const key of ['surfaceTopZ', 'viseJawTopZ', 'bracketSeatZ', 'rotaryAxis', 'rotaryFaceAngle'] as const) {
      const before = snapshot[key];
      // A snapshot written before this datum existed says nothing about it — not "it moved".
      if (before === undefined) continue;
      const now = datumValue(active.datums[key]);
      if (before === now) continue;
      const unit = key === 'rotaryFaceAngle' ? deg : mm;
      if (before === null && now !== null) out.push({ what: key, text: `the ${DATUM_WORD[key]} is now measured at ${unit(now)}` });
      else if (before !== null && now === null) out.push({ what: key, text: `the ${DATUM_WORD[key]} (${unit(before)}) is unmeasured now` });
      else out.push({ what: key, text: `the ${DATUM_WORD[key]} moved from ${unit(before as number)} to ${unit(now as number)}` });
    }
  }
  if (out.length === 0) out.push({ what: 'version', text: 'the bed profile was edited since this job was set up' });
  return out;
}

/** What the surface is, in a sentence's words. */
function surfaceWord(profile: BedProfile): string {
  switch (profile.surface.kind) {
    case 'bare-bed':
      return 'bare bed';
    case 'wasteboard':
      return 'wasteboard';
    case 'fixture-plate':
      return 'fixture plate';
    case 'vacuum-bed':
      return 'vacuum bed';
  }
}

/**
 * WHY the job's bed is not the machine's bed, in the sentence both surfaces print — or null when
 * they agree (or the job names no bed, or the machine cannot be read).
 *
 * Design shows it as a warning with the two presses; the Cut gate shows the SAME words as its
 * error row, so the two surfaces cannot disagree about what moved. Each caller appends its own
 * way-out clause, because the presses are in the Design panel and Cut's way out is ‹ Design.
 */
export function bedChangedSentence(job: EngraveJob, machine: MachineRecord | null): string | null {
  const bound = job.bed;
  if (bound === undefined || machine === null) return null;
  const active = activeProfileOf(machine);
  if (active === null) {
    const was = machine.bedProfiles?.find((p) => p.id === bound.profileId)?.name ?? bound.profileId;
    return `This job was set up on the bed “${was}”, and the machine has no active bed profile now.`;
  }
  const differences = diffBed(bound, active, machine.bedProfiles);
  if (differences.length === 0) return null;
  // The old profile's name, when the machine still holds it, so both sides read as beds.
  const was = machine.bedProfiles?.find((p) => p.id === bound.profileId)?.name ?? bound.profileId;
  return `This job was set up on the bed “${was}”, and the bed has changed since: ${differences.map((d) => d.text).join('; ')}.`;
}

/** True when the profile carries no measured datum at all — a shipped default, nothing read yet. */
export function bedNeverMeasured(profile: Pick<BedProfile, 'datums'>): boolean {
  return Object.values(profile.datums).every((d) => d == null);
}

/** An axis-aligned rectangle in MACHINE XY, mm — the frame scars and the surface's position use. */
export interface MachineRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const rectsOverlap = (a: MachineRect, b: MachineRect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * The stock's footprint in MACHINE XY for a TAPED job, or null when the surface cannot place it:
 * the job's tape hold states its front-left corner (`where`), or null for the middle of the
 * surface — both in machine XY, like the surface's own position. A bare bed has no size, so it
 * cannot place anything; neither can a surface without a position or size.
 */
export function tapeFootprint(
  profile: BedProfile,
  tape: { where: { x: number; y: number } | null },
  stock: { length: number; width: number },
): MachineRect | null {
  const surface = profile.surface;
  const at = surface.position;
  if (surface.length === null || surface.width === null || at === null) return null;
  if (tape.where !== null) return { x: tape.where.x, y: tape.where.y, width: stock.length, height: stock.width };
  return {
    x: at.frontLeft[0] + (surface.length - stock.length) / 2,
    y: at.frontLeft[1] + (surface.width - stock.width) / 2,
    width: stock.length,
    height: stock.width,
  };
}

/** The surface's scars the footprint sits over (#417's check, re-homed onto the bed profile). */
export function scarsUnder(profile: BedProfile, footprint: MachineRect): BedProfile['surface']['scars'] {
  return profile.surface.scars.filter((scar) => rectsOverlap(footprint, scar));
}

/**
 * How far — and on which sides — the footprint leaves the surface, mm per side (0 when inside).
 * The words are the sentence's: "past the right edge by 12 mm".
 */
export function overhangOf(
  profile: BedProfile,
  footprint: MachineRect,
): { left: number; right: number; front: number; back: number } | null {
  const surface = profile.surface;
  const at = surface.position;
  if (surface.length === null || surface.width === null || at === null) return null;
  return {
    left: Math.max(0, at.frontLeft[0] - footprint.x),
    right: Math.max(0, footprint.x + footprint.width - (at.frontLeft[0] + surface.length)),
    front: Math.max(0, at.frontLeft[1] - footprint.y),
    back: Math.max(0, footprint.y + footprint.height - (at.frontLeft[1] + surface.width)),
  };
}

/**
 * The run sheet's Bed line (#513, design §6): "Vise on the pins; jaw top −56.650 mm measured
 * 2026-10-17; surface not measured".
 *
 * `mount` is the job's own (`jobMount`), so the datum printed is the one THIS job's registration
 * reads — a vise job names the jaw top, a bracket job the bracket seat (or the surface top it falls
 * back to), and every job names the surface top under it, because a through cut is judged by it.
 * A measured datum carries its reading AND the day it was taken: the sheet is read at the machine
 * days later, and a number without its date is a claim about the wrong morning.
 */
export function bedLine(profile: BedProfile, mount: Mount | null): string {
  const pins = profile.placements.find((p) => p.where.kind === 'pins');
  const anchor = profile.placements.find((p) => p.where.kind === 'anchor');
  const mounted =
    pins !== undefined
      ? pins.where.pins === 'rotary'
        ? 'Rotary on the pins'
        : 'Vise on the pins'
      : anchor !== undefined
        ? `L-bracket at anchor ${anchor.where.anchor ?? 1}`
        : surfaceWords(profile.surface);
  const part = (key: 'surfaceTopZ' | 'viseJawTopZ' | 'bracketSeatZ' | 'rotaryAxis'): string => {
    const datum = profile.datums[key];
    return datum == null
      ? `${BED_DATUM_WORDS[key]} not measured`
      : `${BED_DATUM_WORDS[key]} ${Number(datum.value.toFixed(3))} mm measured ${datum.measuredAt.slice(0, 10)}`;
  };
  const parts = [mounted];
  if (mount === 'vise') {
    parts.push(part('viseJawTopZ'));
    parts.push(part('surfaceTopZ'));
  } else if (mount === 'bracket') {
    // The bracket's seat is the profile's bracket datum when it has one, else the surface top —
    // `bracketSeatDatumFor`'s precedence (#509), so the sheet prints the number the plan will read.
    if (profile.datums.bracketSeatZ != null || profile.datums.surfaceTopZ == null) {
      parts.push(part('bracketSeatZ'));
      parts.push(part('surfaceTopZ'));
    } else {
      parts.push(part('surfaceTopZ'));
    }
  } else {
    parts.push(part('surfaceTopZ'));
  }
  return parts.join('; ');
}

/**
 * Whether the job cuts through the blank anywhere — the `through` flag any item carries, or a
 * depth that reaches the blank's thickness. The same reading `floorOf` makes in `jobSetup`, kept
 * local because this module only needs the yes/no.
 */
function jobCutsThrough(job: EngraveJob): boolean {
  const t = job.stock.thickness;
  const lists: readonly (readonly unknown[])[] = [
    job.labels,
    job.shapes,
    job.cutouts ?? [],
    job.chamfers ?? [],
    job.combined ?? [],
    job.traces ?? [],
    job.vectors ?? [],
    job.keepOuts ?? [],
    job.drills ?? [],
    job.threads ?? [],
    job.primitives ?? [],
  ];
  return lists.some((list) =>
    list.some((item) => {
      if (typeof item !== 'object' || item === null) return false;
      const it = item as { through?: unknown; depth?: unknown };
      if (it.through === true) return true;
      return typeof it.depth === 'number' && it.depth >= t - 1e-9;
    }),
  );
}

export interface BedFindingArgs {
  job: EngraveJob;
  /** The location's machine record for the job's machine, or null when it cannot be read. */
  machine: MachineRecord | null;
  /** `jobMount(job, ...)`, passed in so this module does not re-derive the mount. */
  mount: Mount;
}

/** The bed's findings for a job, per the rules at the top of this file. */
export function bedFindings({ job, machine, mount }: BedFindingArgs): JobFinding[] {
  if (machine === null) return [];
  const active = activeProfileOf(machine);
  const out: JobFinding[] = [];

  // 1 — BED-CHANGED (design: warning; the Cut gate makes it the error).
  const changed = bedChangedSentence(job, machine);
  if (changed !== null) {
    out.push({
      severity: 'warning',
      code: 'bed-changed',
      message: `${changed} Re-plan on the current bed, or switch the bed back.`,
    });
  }

  if (active === null) return out; // the rest are statements about a bed that exists

  // 2 — FIXTURE-OVERLAP: two fixtures on the same locating pins. The schema refuses this at save;
  // a document that reached here anyway is a physical collision, and the run must not proceed.
  const pinUsers = active.placements.filter((p) => p.where.kind === 'pins').map((p) => p.where.pins);
  if (pinUsers.length > 1 && new Set(pinUsers).size > 1) {
    out.push({
      severity: 'error',
      code: 'fixture-overlap',
      message:
        `The bed “${active.name}” places two fixtures on the same locating pins — the vise and the 4th-axis module share them, ` +
        `and only one can be on the bed at a time. Change the bed (Machines → I changed the bed) so it names the one that is fitted.`,
    });
  }

  // 3 — MOUNT-NOT-ON-BED: the job's mount names a fixture the active bed does not have. INFORMS:
  // the fix is named, and the geometry is not in question (a warning, not a refusal).
  if (mount === 'vise' && !active.placements.some((p) => p.where.kind === 'pins' && p.where.pins === 'vise')) {
    out.push({
      severity: 'warning',
      code: 'mount-not-on-bed',
      message:
        `This job holds the stock in the vise, and the bed “${active.name}” has no vise on it. ` +
        `Switch the bed profile to the one with the vise, or change the bed (Machines → I changed the bed).`,
    });
  } else if (mount === 'bracket' && !active.placements.some((p) => p.where.kind === 'anchor')) {
    out.push({
      severity: 'warning',
      code: 'mount-not-on-bed',
      message:
        `This job holds the stock in the bracket, and the bed “${active.name}” has no bracket on it. ` +
        `Switch the bed profile to the one with the bracket, or change the bed (Machines → I changed the bed).`,
    });
  }

  // 4 — STOCK-OFF-SURFACE / CUT-LEAVES-BOARD: a bed-held job whose stock leaves the surface under
  // it. A TAPED job states where the stock goes in machine XY (`tape.where`, or the middle), so its
  // overhang is EXACT; the bracket's position is the bracket's, and the honest check is the size.
  // INFORMS — and when the job cuts THROUGH, the same geometry is the hazard worth naming: the cut
  // breaks through past the board's edge and into the bed, so that sentence replaces this one.
  const bedHeld = mount === 'tape' || mount === 'bracket';
  const surface = active.surface;
  if (bedHeld && surface.length !== null && surface.width !== null) {
    const { length, width } = job.stock;
    const footprint =
      mount === 'tape' && job.workholding.kind === 'tape' ? tapeFootprint(active, job.workholding.tape, job.stock) : null;
    const overhang = footprint === null ? null : overhangOf(active, footprint);
    const sides = overhang === null ? [] : (['left', 'right', 'front', 'back'] as const).filter((side) => overhang[side] > 1e-9);
    const off = sides.length > 0 || length > surface.length + 1e-9 || width > surface.width + 1e-9;
    if (off) {
      const where =
        sides.length > 0 && footprint !== null
          ? `The blank sits ${sides.map((side) => `${mm(overhang![side])} past the ${side} edge`).join(' and ')} of the ${surfaceWord(active)}`
          : `The stock is ${mm(length)} × ${mm(width)} and the ${surfaceWord(active)} under it is ${mm(surface.length)} × ${mm(surface.width)}`;
      const fix = 'Move the blank in (drag it in the Holding step), trim it, or use a larger board.';
      out.push(
        jobCutsThrough(job)
          ? {
              severity: 'warning',
              code: 'cut-leaves-board',
              message: `${where}, and this job cuts through: a through cut near that edge breaks through past the board and into the bed. ${fix}`,
            }
          : {
              severity: 'warning',
              code: 'stock-off-surface',
              message: `${where}: the part of it beyond the edge is held by nothing and sits on whatever is below. ${fix}`,
            },
      );
    }
  }

  // 5 — SURFACE-TOP-UNMEASURED: the mount's registration reads the surface (tape), or the surface
  // as the bracket seat's fallback, and neither datum exists. Named where it changes THIS job; the
  // bed's own unmeasured state is stated once, on the machine and bed cards.
  if (bedHeld) {
    const surfaceTop = datumValue(active.datums.surfaceTopZ);
    const seat = datumValue(active.datums.bracketSeatZ);
    const needed = mount === 'bracket' ? surfaceTop === null && seat === null : surfaceTop === null;
    if (needed) {
      out.push({
        severity: 'warning',
        code: 'surface-top-unmeasured',
        message:
          mount === 'bracket'
            ? `The bed “${active.name}” has neither a surface top nor a bracket seat measured, so registration on this bed refuses until one is (Machines → Measure…).`
            : `The bed's surface top has not been measured, so registration on this bed refuses until it is (Machines → Measure…).`,
      });
    }
  }

  return out;
}
