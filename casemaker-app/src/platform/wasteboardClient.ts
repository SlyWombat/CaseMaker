/**
 * Writing a machine's wasteboard record (#417): `PUT /api/v1/wasteboard/:id`, the record or `null`
 * to clear it, guarded on the LOCATION's `ETag` (it is a field of the machine record). Checked here
 * against the same schema the read uses before it is sent.
 */

import { WasteboardSchema, type Wasteboard } from '@/engine/cnc/wasteboard';
import { houseRequest, type HouseRequestOptions, type HouseWrite } from './houseClient';

export async function houseSetWasteboard(
  machineId: string,
  board: Wasteboard | null,
  locationEtag: string | null,
  opts?: HouseRequestOptions,
): Promise<HouseWrite> {
  if (board !== null) {
    const checked = WasteboardSchema.safeParse(board);
    if (!checked.success) {
      return { kind: 'refused', status: 400, message: checked.error.issues[0]?.message ?? 'not a wasteboard' };
    }
  }
  const res = await houseRequest('PUT', `/wasteboard/${encodeURIComponent(machineId)}`, board, {
    ...opts,
    ifMatch: locationEtag,
  });
  return res.kind === 'ok' ? { kind: 'ok' } : res;
}
