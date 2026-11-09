import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/index.css';
import App from './App';
import { startRendererCheck } from './engine/cnc/rendererBits';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root element');
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// #1124 — after the first render, not before: the probe reserves the planner's ~704 MiB floor
// for a moment, and a 32-bit renderer must be told before Generate, not during the ball rank.
startRendererCheck();
