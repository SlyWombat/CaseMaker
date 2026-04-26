import { useEffect } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { installCaseMakerTestApi } from '@/testing/windowApi';

export default function App() {
  useEffect(() => {
    installCaseMakerTestApi();
  }, []);
  return <AppShell />;
}
