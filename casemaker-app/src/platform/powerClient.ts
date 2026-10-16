/**
 * An optional, controllable power switch on a machine record (#416, decision Q5). The service's half
 * is `src-tauri/src/power.rs`: it holds the token in the desktop's secure store and makes the
 * provider's calls; this side never sees a token after it is sent, only whether one is saved.
 *
 * NONE IS THE DEFAULT. A record with `power: null` has no switch, and nothing that reads one is ever
 * drawn. The GUARDS — never off while running, off only after Idle and a home — are in
 * `store/powerStore.ts`, because only the client can read the controller's status line.
 */

import { z } from 'zod';
import {
  houseRequest,
  type HouseFailure,
  type HouseReadFailure,
  type HouseRequestOptions,
  type HouseWrite,
} from './houseClient';

export const PowerSwitchSchema = z
  .object({
    provider: z.enum(['home-assistant']),
    baseUrl: z
      .string()
      .refine((v) => !v.startsWith('https://'), 'https:// is not supported yet — use the http:// address on the LAN')
      .refine((v) => /^http:\/\/(\[[^\]]+\]|[^/:?#@\s]+)(:\d{1,5})?\/?$/.test(v), 'is not an http://host[:port] address'),
    entityId: z.string().regex(/^switch\.[a-z0-9_]+$/, 'is not a switch entity — it looks like switch.makera_cnc'),
  })
  .strict();

export type PowerSwitch = z.infer<typeof PowerSwitchSchema>;

export const PlugStateSchema = z.union([
  z.object({ kind: z.literal('on') }),
  z.object({ kind: z.literal('off') }),
  z.object({ kind: z.literal('other'), detail: z.string() }),
]);
export type PlugState = z.infer<typeof PlugStateSchema>;

export const PowerStatusSchema = z.object({
  switch: PowerSwitchSchema.nullable(),
  hasToken: z.boolean(),
  state: PlugStateSchema.nullable(),
  problem: z.string().nullable(),
});
export type PowerStatus = z.infer<typeof PowerStatusSchema>;

export type PowerRead = { kind: 'ok'; status: PowerStatus } | HouseReadFailure | Extract<HouseFailure, { kind: 'refused' }>;

function parseStatus(text: string): PowerRead {
  try {
    const parsed = PowerStatusSchema.safeParse(JSON.parse(text));
    if (parsed.success) return { kind: 'ok', status: parsed.data };
  } catch {
    // fall through
  }
  return { kind: 'error', detail: "the power switch's answer does not match this build" };
}

const at = (id: string) => `/power/${encodeURIComponent(id)}`;

/** The switch, whether a token is saved, and the plug's state. */
export async function housePower(machineId: string, opts?: HouseRequestOptions): Promise<PowerRead> {
  const res = await houseRequest('GET', at(machineId), undefined, opts);
  return res.kind === 'ok' ? parseStatus(res.text) : res;
}

/** Set up or change the switch. GUARDED on the LOCATION's `ETag` (it is on the machine record). */
export async function houseSetPower(
  machineId: string,
  sw: PowerSwitch,
  locationEtag: string | null,
  opts?: HouseRequestOptions,
): Promise<HouseWrite> {
  const checked = PowerSwitchSchema.safeParse(sw);
  if (!checked.success) {
    return { kind: 'refused', status: 400, message: checked.error.issues[0]?.message ?? 'not a power switch' };
  }
  const res = await houseRequest('PUT', at(machineId), sw, { ...opts, ifMatch: locationEtag });
  return res.kind === 'ok' ? { kind: 'ok' } : res;
}

/** Remove the switch, and its token. Guarded as a set is. */
export async function houseRemovePower(
  machineId: string,
  locationEtag: string | null,
  opts?: HouseRequestOptions,
): Promise<HouseWrite> {
  const res = await houseRequest('DELETE', at(machineId), undefined, { ...opts, ifMatch: locationEtag });
  return res.kind === 'ok' ? { kind: 'ok' } : res;
}

/** Save the token in the desktop's secure store. Refused unless sent from the app's own computer. */
export async function houseSetPowerToken(
  machineId: string,
  token: string,
  opts?: HouseRequestOptions,
): Promise<HouseWrite> {
  const res = await houseRequest('PUT', `${at(machineId)}/token`, { token }, opts);
  return res.kind === 'ok' ? { kind: 'ok' } : res;
}

/** Switch the plug. The caller has already passed the guard in `powerStore.ts`. */
export async function houseSwitchPower(machineId: string, on: boolean, opts?: HouseRequestOptions): Promise<PowerRead> {
  const res = await houseRequest('POST', `${at(machineId)}/${on ? 'on' : 'off'}`, undefined, opts);
  return res.kind === 'ok' ? parseStatus(res.text) : res;
}
