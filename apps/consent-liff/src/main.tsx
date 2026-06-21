import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { initLiff } from './lib/liff-client.js';
import './styles.css';

(async () => {
  try {
    await initLiff();
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } catch (err) {
    document.getElementById('root')!.innerHTML = `
      <div style="padding: 2rem; font-family: sans-serif; color: #b91c1c;">
        <h1 style="font-size: 1.25rem; margin-bottom: 1rem;">起動できませんでした</h1>
        <p>${err instanceof Error ? err.message : String(err)}</p>
      </div>
    `;
  }
})();
