/**
 * #527 §6 — the machine layer's ONE body, drawn by both scenes that can show the machine: the
 * simulation (`SimMeshes`) and the engrave preview (Cut mode). The caller decides the position
 * (`toolPlacement`) and what is fitted (`fittedTool` / the probe flag); this component only builds
 * the group, disposes it when it is replaced, and places its TIP at `at`.
 *
 * Both bodies are built in the same frame (`toolHeadGroup` / `probeHeadGroup`): the contact point at
 * the origin, the body rising along +Z. So the caller hands in the tip — the live `WPos`, the
 * scrub step — and nothing here re-derives one.
 */

import { useEffect, useMemo, type JSX } from 'react';
import type { HolderProfile } from '@/engine/cnc/machine';
import type { Tool } from '@/engine/cnc/tool';
import { disposeToolHeadGroup, probeHeadGroup, toolHeadGroup } from './simGeometry';

export interface LiveToolHeadProps {
  /** The tool tip in the scene's work frame, or null when there is no honest position to draw at. */
  at: [number, number, number] | null;
  /** The fitted cutter, when the probe is not the instrument. */
  tool: Tool | null;
  /** The wired probe's tip diameter while a registration owns the machine; null draws the cutter. */
  probeTipDiameterMm: number | null;
  /** The measured collet nut from the machine profile, or null — the generic stub stands in. */
  holder: HolderProfile | null;
  /** The three object's name, for a scene probe; defaults to `machine-tool`. */
  name?: string;
}

export function LiveToolHead({
  at,
  tool,
  probeTipDiameterMm,
  holder,
  name = 'machine-tool',
}: LiveToolHeadProps): JSX.Element | null {
  const group = useMemo(
    () =>
      probeTipDiameterMm !== null
        ? probeHeadGroup(probeTipDiameterMm, { holder })
        : toolHeadGroup(tool, { holder }),
    [probeTipDiameterMm, tool, holder],
  );
  useEffect(() => () => disposeToolHeadGroup(group), [group]);
  if (at === null || group === null) return null;
  return <primitive object={group} position={at} name={name} />;
}
