// Stub: the original main.tsx was a JSON-envelope leak from Gemini Flash —
// the model returned what appears to be training-data content (an AWS
// cost calculator) instead of the Yotsuba main.tsx. Fascinating study
// finding: small models in unfamiliar domains can regress to training-set
// outputs even with explicit brief + design context.
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
