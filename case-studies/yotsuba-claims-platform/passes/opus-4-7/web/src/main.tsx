/**
 * Entry point for the Yotsuba Adjuster Workbench SPA.
 *
 * STUB FIX: Original Opus main.tsx double-wrapped <App /> in BrowserRouter +
 * AuthProvider, which App.tsx already does internally. Two nested
 * BrowserRouters → white screen. Track A authoring bug — documented as a
 * study finding; Track B refinement loop would catch this on first integration
 * test. This thin entry just mounts App.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Yotsuba Workbench: missing #root element');

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
