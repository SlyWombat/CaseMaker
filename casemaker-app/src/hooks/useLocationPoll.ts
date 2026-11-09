/**
 * #1123-12 — THE LOCATION IS NOT READ ONCE.
 *
 * At the 2026-11-09 bench the house's machine record gained the bracket out of band (another
 * window, the machine wizard's workaround through the house API). Cut kept the stale "nothing on
 * the pins" because `startLocationSync` reconciles at connect and after this window's own writes —
 * nothing re-read a record changed by somebody else. Reloading to clear it then cost a 12-minute
 * run (#1123 item 11).
 *
 * So a surface that judges the machine keeps it in step WHILE IT IS ON SCREEN: one re-read on
 * {@link LOCATION_POLL_MS} while the tab is visible, one when the tab becomes visible again, and
 * one when the change-the-machine wizard closes. The store's `poll()` is the read that is safe to
 * repeat: it takes a new record (a real change changes the etag the persisted-run signature is
 * keyed on — #1123 item 11, case-maker-46), keeps the same object when the validator has not moved,
 * and on a dropped request keeps the last good record rather than blanking the machine for a blip.
 *
 * A build with no house service (the hosted web site) answered `absent` at connect and is not
 * polled: there is nothing there that can start answering, and a poll would be one request per
 * interval from every visitor.
 */

import { useEffect } from 'react';
import { useLocationStore } from '@/store/locationStore';
import { useMachineChangeStore } from '@/store/machineChangeStore';

/** How often a visible surface re-reads the location, ms. */
export const LOCATION_POLL_MS = 10_000;

export function useLocationPoll(): void {
  useEffect(() => {
    let inFlight = false;
    let again = false;
    const read = (): void => {
      // A hidden tab is not on screen: the visibility listener reads once when it comes back.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const store = useLocationStore.getState();
      if (store.status === 'absent') return;
      if (inFlight) {
        // One read at a time; a request made while a read is out (the wizard closing mid-poll)
        // runs once that read lands, so the newest record wins and no answer is reordered.
        again = true;
        return;
      }
      inFlight = true;
      void store.poll().finally(() => {
        inFlight = false;
        if (again) {
          again = false;
          read();
        }
      });
    };
    const timer = setInterval(read, LOCATION_POLL_MS);
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') read();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // The operator comes back from a machine change: whatever was written while the wizard was up
    // (here, another window, the API) is read before the step's judgement is shown again.
    const offWizard = useMachineChangeStore.subscribe((s, prev) => {
      if (prev.open && !s.open) read();
    });
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      offWizard();
    };
  }, []);
}
