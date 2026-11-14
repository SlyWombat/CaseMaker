// #1273 — THE ONE WAY A TEST CHOOSES A MOUNT FOR THE OPERATOR WHEN NOTHING IS RECORDED.
//
// With no machine recorded the Holding step asks "What will hold this on the machine?" and selects
// nothing; Create waits. A test that needs a job anyway chooses a seat as the operator's own
// assumption — and this helper refuses to do it silently: it requires the ask to be on the page, the
// seat to be one the ask allows, and Create to be waiting before the pick; after it, the step must
// say the hold is the operator's assumption. A walk that finds a preselected seat (a machine
// recorded, or a regression that brings the silent default back) fails here, naming the cause.
import { fireEvent, screen } from '@testing-library/react';
import { expect } from 'vitest';

export type AssumedSeat = 'ledge' | 'board' | 'block';

export function pickAssumedMount(seat: AssumedSeat): void {
  expect(screen.queryByTestId('engrave-setup-holding-ask'), 'the Holding step must be asking (nothing recorded)').not.toBeNull();
  const radio = screen.getByTestId(`engrave-setup-mount-${seat}`) as HTMLInputElement;
  expect(radio.disabled, `the ${seat} seat is not one the ask allows for this blank`).toBe(false);
  expect(radio.checked, 'nothing may be selected before the operator chooses').toBe(false);
  expect((screen.getByTestId('engrave-setup-next') as HTMLButtonElement).disabled, 'Create waits for the choice').toBe(true);
  fireEvent.click(radio);
  expect(screen.queryByTestId('engrave-setup-holding-assumed'), 'the choice is carried as the operator’s assumption').not.toBeNull();
}
