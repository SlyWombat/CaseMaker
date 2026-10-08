import { useEffect } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { installCaseMakerTestApi } from '@/testing/windowApi';

export default function App() {
  useEffect(() => {
    installCaseMakerTestApi();
  }, []);
  // #306 — ask this page's own origin for the house's tool tiers, once: in the desktop app, and in
  // any browser that loaded this page from the service, that is how the user's own cutters reach the
  // pickers. Fire-and-forget by design: `refresh` never throws and never blocks, and the built-in
  // tier is what every picker runs on until (and if) an answer arrives.
  useEffect(() => {
    void useToolRegistryStore.getState().refresh();
  }, []);
  return <AppShell />;
}
