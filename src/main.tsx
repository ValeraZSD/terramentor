import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { registerSW } from './sw-register';
import { i18nReady } from './i18n';

// The interface language is applied BEFORE the first render: the cached choice
// is read synchronously, but a non-English locale is a chunk that has to
// arrive, and mounting first would paint English and then swap every label.
void i18nReady.then(() => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
        <React.StrictMode>
            <BrowserRouter>
                <App />
            </BrowserRouter>
        </React.StrictMode>
    );
});

// Register the service worker (prod standalone build only) so the app is
// installable as a standalone PWA and picks up new builds via an in-app "Update
// available" prompt. In dev it unregisters instead — HMR handles live updates,
// and a lingering SW only serves stale assets. See `sw-register.ts`.
registerSW();
