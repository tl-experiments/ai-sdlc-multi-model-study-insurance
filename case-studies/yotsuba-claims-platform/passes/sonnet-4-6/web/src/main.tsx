import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

// Remove the pre-hydration shell once React takes over
const preloadShell = document.getElementById('__preload_shell');
if (preloadShell) {
  preloadShell.remove();
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error(
    '[Yotsuba Claims] Fatal: #root element not found in the DOM. ' +
    'Ensure index.html contains <div id="root">.',
  );
}

const root = ReactDOM.createRoot(rootElement);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);