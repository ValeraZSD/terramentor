import type { AIStatus } from '../../types';

/** The welcome screen's three ways to a model (ConnectModel.tsx). */
export type Way = 'openrouter' | 'key' | 'local';

export const isOpenRouter = (url: string | undefined) => /(^|\/\/|\.)openrouter\.ai(?=[:/]|$)/i.test(String(url || ''));
export const isLoopback = (url: string | undefined) => {
    try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(String(url)).hostname); } catch { return false; }
};

/** Which card a library already configured belongs under. A fresh library is
 *  Ollama with no model, which is not a choice anyone made — so it is offered
 *  the recommended card rather than the one its defaults happen to name. */
export function wayOf(s: AIStatus | null): Way {
    if (!s) return 'openrouter';
    if (s.provider === 'ollama') return s.model ? 'local' : 'openrouter';
    if (isOpenRouter(s.baseUrl)) return 'openrouter';
    return isLoopback(s.baseUrl) ? 'local' : 'key';
}

/** A model the app can use right now, through the way that is on screen.
 *  OpenRouter has its own card, so the "another hosted provider" card does
 *  not count an OpenRouter library as its own: a learner who opens it there
 *  wants a different provider and needs the fields. */
export function isReady(s: AIStatus | null, way: Way): boolean {
    if (!s || !s.enabled || !s.available) return false;
    if (way === 'local') return s.provider === 'ollama' || isLoopback(s.baseUrl);
    if (s.provider !== 'openai' || !s.hasApiKey) return false;
    return way === 'openrouter' ? isOpenRouter(s.baseUrl) : !isLoopback(s.baseUrl) && !isOpenRouter(s.baseUrl);
}

const sameAddress = (a: string | undefined, b: string | undefined) =>
    String(a ?? '').trim().replace(/\/+$/, '').toLowerCase() === String(b ?? '').trim().replace(/\/+$/, '').toLowerCase();

/** Whether the key the library holds belongs to the address typed in the
 *  card: the hint "a key is already saved for this address" is only true then. */
export function keySavedFor(s: AIStatus | null, typedUrl: string): boolean {
    return !!s && s.provider === 'openai' && !!s.hasApiKey && !!typedUrl.trim() && sameAddress(s.baseUrl, typedUrl);
}
