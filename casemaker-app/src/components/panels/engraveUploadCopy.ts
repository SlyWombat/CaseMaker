import type { MachineUploadResult } from '@/platform/machineUpload';

/**
 * The sentence for one result. It is the part worth testing: the panel's honesty about what
 * happened is copy, and copy that drifts from the outcome is how a refusal starts reading as a
 * success. It lives here, not in the component's file, because fast refresh needs that file to
 * export only a component.
 */
export function describeUpload(result: MachineUploadResult, label: string): string {
  switch (result.kind) {
    case 'uploaded': {
      // #562 — a compressed upload is a different FILE on the card (`<name>.bin`), so the sentence
      // names it; a fallback is why the plain one went after all.
      const as = result.compressed === true ? ` compressed as ${result.filename}.bin` : '';
      const base = result.alreadyPresent
        ? `${label} already had ${result.filename}${as} — the same bytes, so no data was sent.`
        : `${label} received ${result.filename}${as} — ${result.bytes} bytes in ${result.packets} packets.`;
      return result.fallback === undefined ? base : `${base} (${result.fallback})`;
    }
    case 'refused':
      return `${label} declined ${result.filename}: ${result.detail}`;
    case 'busy':
      return `${label} is busy: ${result.detail}. Wait for it to finish, then press Upload again.`;
    case 'timeout':
      return `The transfer of ${result.filename} timed out: ${result.detail}`;
    case 'error':
      return `${result.filename} was not uploaded — ${result.detail}.`;
    case 'unavailable':
      return `This build cannot reach a machine: ${result.reason}`;
  }
}
