import { api } from '../api';

/**
 * "Connect OpenRouter": the one-press way to a hosted model.
 *
 * The page leaves for openrouter.ai, the learner signs in and approves, and
 * openrouter.ai sends the browser back to CALLBACK_PATH with a one-time code.
 * The server holds the PKCE verifier and does the exchange (server/routes/providers.js,
 * /api/ai/openrouter/*), so the key it gets is stored where every other key is
 * and never passes through this page.
 *
 * A path of its own rather than a query on the page that started it, because
 * App has to recognise the return before anything else renders — the welcome
 * screen and Settings both start it, and the learner must land back on the one
 * they left. Where that was is kept in sessionStorage, which survives the round
 * trip in the same tab and nothing else.
 */
export const OPENROUTER_CALLBACK_PATH = '/connect/openrouter';
const RETURN_KEY = 'terramentor-openrouter-return';

/** Leave for openrouter.ai. `returnTo` is the path to land on once the key is saved. */
export async function connectOpenRouter(returnTo: string): Promise<void> {
    const { url } = await api.startOpenRouterConnect(window.location.origin + OPENROUTER_CALLBACK_PATH);
    try { sessionStorage.setItem(RETURN_KEY, returnTo); } catch { /* lands on the home page instead */ }
    window.location.assign(url);
}

export function isOpenRouterReturn(): boolean {
    return window.location.pathname === OPENROUTER_CALLBACK_PATH;
}

/** Where to go after the return, read once. */
export function takeOpenRouterReturnPath(): string {
    let path = '/';
    try {
        path = sessionStorage.getItem(RETURN_KEY) || '/';
        sessionStorage.removeItem(RETURN_KEY);
    } catch { /* default */ }
    // Only ever a path on this origin — never a URL someone put in storage.
    return path.startsWith('/') && !path.startsWith('//') ? path : '/';
}
