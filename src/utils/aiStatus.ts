import type { AIStatus } from '../types';
import i18n from '../i18n';

// Copy in a utility module cannot use the hook, so it reads `i18n.t` at call
// time — every caller is inside a render or an effect, which runs again on a
// language change, so the words follow the language the same as JSX does.
const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts);

// Friendly label for where the model runs, derived from the AI status. Ollama is
// named directly; OpenAI-compatible backends (llama-swap, LM Studio, OpenRouter…)
// are recognised by their base URL host, falling back to the bare hostname.
export function providerLabel(status: AIStatus): string {
    if (status.provider === 'ollama') return 'Ollama';
    try {
        const host = new URL(status.baseUrl).hostname;
        if (host.includes('openrouter')) return 'OpenRouter';
        if (host.includes('openai.com')) return 'OpenAI';
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return t('Local');
        return host;
    } catch {
        return t('OpenAI-compatible');
    }
}

// True when the AI is actually usable — the single, canonical check every
// component shares, so "available" means the same thing everywhere.
export function isAIUsable(status: AIStatus | null): boolean {
    return !!status && status.enabled && status.available;
}

/**
 * Four states, four colours — the vocabulary of the status dot next to a model
 * name. Deliberately distinguishes "off" from "broken": a grey dot because the
 * learner turned AI off is not a problem to investigate, a red one is.
 */
export type AIHealth = 'online' | 'offline' | 'warning' | 'error' | 'unknown';

export interface AIHealthInfo {
    level: AIHealth;
    /** One or two words, for a dot's accessible name. */
    label: string;
    /** Full sentence for the tooltip. */
    detail: string;
}

/** The dot's colour classes, keyed by level. Grey off, orange warn, red error. */
export const AI_HEALTH_DOT: Record<AIHealth, string> = {
    online: 'bg-emerald-500',
    offline: 'bg-slate-400 dark:bg-slate-500',
    warning: 'bg-amber-500',
    error: 'bg-red-500',
    unknown: 'bg-slate-300 dark:bg-slate-600',
};

/** Classify an AI status into the dot's state. Shares `describeAIUnavailable`'s rules. */
export function aiHealth(status: AIStatus | null): AIHealthInfo {
    if (!status) {
        return { level: 'unknown', label: t('Unknown'), detail: t('Could not reach the app server to check AI status.') };
    }
    if (!status.enabled) {
        return { level: 'offline', label: t('Off'), detail: t('AI features are turned off in Settings → AI & Models.') };
    }
    if (!status.model) {
        return { level: 'warning', label: t('No model'), detail: t('No model is selected. Choose one in Settings → AI & Models.') };
    }
    if (!status.available) {
        return {
            level: 'error',
            label: t('Unreachable'),
            detail: status.error || t('Can’t reach {{provider}} — the model server may not be running.', { provider: providerLabel(status) }),
        };
    }
    return { level: 'online', label: t('Online'), detail: t('{{provider}} · {{model}} is responding.', { provider: providerLabel(status), model: status.model }) };
}

export interface AIUnavailableInfo {
    /** Short headline for the amber notice. */
    headline: string;
    /** One-line explanation, provider-aware. Prefers the server's own error text. */
    detail: string;
    /** Optional numbered setup steps (Ollama gets these; API providers don't). */
    steps: string[];
}

// The single source of truth for *why* the AI is unavailable and what to tell the
// user. Provider-aware: it never mentions Ollama when an OpenAI-compatible endpoint
// is selected, and it distinguishes "disabled" / "no model" / "can't connect".
// The server already returns a provider-correct `error` string (checkOllamaHealth),
// so we surface that verbatim when present rather than reinventing the copy.
export function describeAIUnavailable(status: AIStatus | null): AIUnavailableInfo {
    if (!status) {
        return {
            headline: t('AI status unavailable'),
            detail: t('Could not reach the app server to check AI status.'),
            steps: [],
        };
    }
    if (!status.enabled) {
        return {
            headline: t('AI features are turned off'),
            detail: t('Enable them in Settings → AI & Models.'),
            steps: [],
        };
    }
    if (!status.model) {
        return {
            headline: t('No model selected'),
            detail: t('Choose a model in Settings → AI & Models.'),
            steps: [],
        };
    }
    if (status.provider === 'ollama') {
        return {
            headline: t('Can’t reach Ollama'),
            detail: status.error || t('Make sure Ollama is running on your system.'),
            steps: [
                t('Install Ollama from ollama.com'),
                t('Run: ollama pull {{model}}', { model: status.model }),
                t('Start: ollama serve'),
            ],
        };
    }
    // OpenAI-compatible endpoint (llama-swap / llama.cpp / LM Studio / OpenRouter…).
    // The server's error text already names the endpoint and likely cause, so lead
    // with it; otherwise fall back to a generic, provider-named message.
    const label = providerLabel(status);
    return {
        headline: t('Can’t reach {{provider}}', { provider: label }),
        detail: status.error || t('Make sure the model server at {{url}} is running.', { url: status.baseUrl }),
        steps: [],
    };
}
