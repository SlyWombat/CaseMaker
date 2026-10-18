/**
 * A file as the receipt states it (#478): the path an operator can open, the bytes it holds, and the
 * SHA-256 of those bytes. Inputs and outputs are described the same way, so a receipt can be compared
 * against the disk it describes without any command reimplementing the hash.
 *
 * This is the one impure corner of the receipt work — `receipt.ts` itself never touches `node:fs`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { ReceiptFile } from '../../../src/platform/headless/receipt';

/** Read `path` and describe it for a receipt. Throws when the file cannot be read. */
export function fileReceipt(path: string): ReceiptFile {
  const bytes = readFileSync(path);
  return {
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}
