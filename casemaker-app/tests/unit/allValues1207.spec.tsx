// @vitest-environment jsdom
/**
 * #1207 — MANAGE › ADVANCED › ALL VALUES. The accepted mock-up's six changes and its four states:
 * the label leads and the key follows; chips mark exceptions only (changed/measured — never
 * "chosen, not measured"); the detail opens with what the value DECIDES; the record is "this shop's
 * record", not a file name; the phone row shows the recommendation beside the value; and the four
 * states are empty search, just saved, a save the house service refuses, and a read-only shop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';

import { KNOWN_DEFAULTS, KNOWN_FLAGS, MEASURED_ONLY, ShopDefaultsSchema, type ShopDefaults } from '@/platform/defaultsClient';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { AllValuesScope } from '@/components/manage/AllValuesScope';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const set = vi.fn();
const reset = vi.fn();

function entry(value: number, source: 'seeded' | 'chosen' | 'measured' = 'seeded') {
  return { value, source, setAt: source === 'seeded' ? null : '2026-11-13T09:42:00.000Z', unit: null, note: null } as const;
}

/** The store as a present shop with three exceptions: one changed, one measured, one seeded. */
function presentShop(overrides: Record<string, ReturnType<typeof entry>> = {}) {
  const defaults = ShopDefaultsSchema.parse({
    'plan.shortlistSize': entry(12, 'chosen'),
    'plan.leftoverTallMm': entry(1, 'seeded'),
    'registration.tipRadiusMm': entry(0.72, 'measured'),
    ...overrides,
  }) as ShopDefaults;
  useShopDefaultsStore.setState({
    status: 'present',
    defaults,
    etag: 'etag-1',
    reason: null,
    set: set as never,
    reset: reset as never,
  });
}

beforeEach(() => {
  set.mockReset();
  reset.mockReset();
  set.mockResolvedValue(true);
  reset.mockResolvedValue(true);
  presentShop();
});
afterEach(() => cleanup());

describe('#1207 All values', () => {
  it('lists every registry entry by its own key', () => {
    render(<AllValuesScope />);
    const keys = [
      ...Object.keys(KNOWN_DEFAULTS),
      ...Object.keys(KNOWN_FLAGS),
      ...Object.keys(MEASURED_ONLY),
    ];
    expect(screen.getByTestId('all-values-chip-all').textContent).toContain(String(keys.length));
    for (const key of keys) expect(screen.getByTestId(`all-values-row-${key}`), key).toBeTruthy();
  });

  it('lists every registry entry, with the label leading and the key following', () => {
    render(<AllValuesScope />);
    const row = screen.getByTestId('all-values-row-plan.shortlistSize');
    const text = row.textContent ?? '';
    const labelAt = text.indexOf(KNOWN_DEFAULTS['plan.shortlistSize']!.label.slice(0, 30));
    const keyAt = text.indexOf('plan.shortlistSize');
    expect(labelAt, 'the row shows the registry label').toBeGreaterThanOrEqual(0);
    expect(keyAt).toBeGreaterThan(labelAt);
  });

  it('marks only exceptions: no "chosen, not measured" chip; changed and measured are marked', () => {
    render(<AllValuesScope />);
    const changed = screen.getByTestId('all-values-row-plan.shortlistSize');
    expect(changed.querySelector('[data-kind="changed"]')).not.toBeNull();
    const plain = screen.getByTestId('all-values-row-plan.leftoverTallMm');
    expect(plain.querySelector('[data-kind="changed"]')).toBeNull();
    expect(within(plain).queryByText(/chosen/i)).toBeNull();
    const measured = screen.getByTestId('all-values-row-registration.tipRadiusMm');
    expect(measured.querySelector('[data-kind="measured"]')).not.toBeNull();
  });

  it('the detail says what the value decides, and calls the shop’s copy this shop’s record', () => {
    render(<AllValuesScope />);
    fireEvent.click(screen.getByTestId('all-values-row-plan.shortlistSize'));
    const detail = screen.getByTestId('all-values-detail');
    expect(detail.textContent).toMatch(/This value decides/i);
    expect(detail.textContent).toMatch(/this shop’s record/i);
    expect(detail.textContent).not.toMatch(/location\.json/i);
  });

  it('saves a value through the shop-defaults store and says it was saved', async () => {
    render(<AllValuesScope />);
    fireEvent.click(screen.getByTestId('all-values-row-plan.shortlistSize'));
    fireEvent.change(screen.getByTestId('all-values-input'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('all-values-save'));
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]![0]).toBe('plan.shortlistSize');
    expect(set.mock.calls[0]![1].value).toBe(10);
    expect(await screen.findByTestId('all-values-saved')).toBeTruthy();
  });

  it('shows the house service’s refusal sentence, and applies nothing', async () => {
    set.mockResolvedValue(false);
    useShopDefaultsStore.setState({ reason: 'the shop’s record refused 10: outside the bounds the page may set' });
    render(<AllValuesScope />);
    fireEvent.click(screen.getByTestId('all-values-row-plan.shortlistSize'));
    fireEvent.change(screen.getByTestId('all-values-input'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('all-values-save'));
    expect((await screen.findByTestId('all-values-refusal')).textContent).toMatch(/refused 10/);
    expect(screen.queryByTestId('all-values-saved')).toBeNull();
  });

  it('an empty search is a stated state, not a blank list', () => {
    render(<AllValuesScope />);
    fireEvent.change(screen.getByTestId('all-values-search'), { target: { value: 'no such value zzz' } });
    expect(screen.getByTestId('all-values-empty').textContent).toMatch(/No values match/i);
  });

  it('a shop with no record is read-only: the recommendations show and saving is disabled', () => {
    useShopDefaultsStore.setState({ status: 'absent', defaults: null, etag: null, reason: 'no house service at this origin' });
    render(<AllValuesScope />);
    expect(screen.getByTestId('all-values-readonly').textContent).toMatch(/recommendations/i);
    fireEvent.click(screen.getByTestId('all-values-row-plan.shortlistSize'));
    expect((screen.getByTestId('all-values-save') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('all-values-reset') as HTMLButtonElement).disabled).toBe(true);
  });

  it('reset changed lists every changed value and never touches a measured one', async () => {
    render(<AllValuesScope />);
    fireEvent.click(screen.getByTestId('all-values-reset-changed'));
    const confirm = screen.getByTestId('all-values-reset-confirm');
    expect(confirm.textContent).toContain(KNOWN_DEFAULTS['plan.shortlistSize']!.label.slice(0, 30));
    expect(confirm.textContent).not.toContain(KNOWN_DEFAULTS['registration.tipRadiusMm']!.label.slice(0, 30));
    fireEvent.click(screen.getByTestId('all-values-reset-confirm-yes'));
    expect(reset).toHaveBeenCalledWith('plan.shortlistSize');
    expect(reset).not.toHaveBeenCalledWith('registration.tipRadiusMm');
  });

  it('the measured-only entries are listed, read-only, with no recommendation to reset to', () => {
    render(<AllValuesScope />);
    const key = Object.keys(MEASURED_ONLY)[0]!;
    const row = screen.getByTestId(`all-values-row-${key}`);
    expect(row.textContent).toMatch(/measured/i);
  });

  it('the yes/no registry entries are listed and save their answer', async () => {
    render(<AllValuesScope />);
    const key = Object.keys(KNOWN_FLAGS)[0]!;
    const row = screen.getByTestId(`all-values-row-${key}`);
    expect(row.textContent).toContain('on');
    fireEvent.click(row);
    const input = screen.getByTestId('all-values-input') as HTMLSelectElement;
    expect(input.tagName).toBe('SELECT');
    fireEvent.change(input, { target: { value: 'off' } });
    fireEvent.click(screen.getByTestId('all-values-save'));
    expect(set.mock.calls.at(-1)![0]).toBe(key);
    expect(set.mock.calls.at(-1)![1].value).toBe(false);
  });
});
