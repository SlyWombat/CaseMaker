import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/index.css';
import App from './App';
import { restoreWorkspaceSession, startWorkspaceSession } from './store/workspaceSession';
import { restoreOpenRun, startRunPersistence } from './store/runPersistence';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root element');
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// #1123 — after the first render call, like the #1124 check, so neither restore delays paint.
// Item 10 puts the open project, job and CNC half back (localStorage, synchronous); item 11
// restores the generated run once the house reads it is keyed against have settled, and the
// persistence subscription stores each settled run from then on.
restoreWorkspaceSession();
void restoreOpenRun();
startWorkspaceSession();
startRunPersistence();
