// The interface's language — one runtime, natural-language keys, lazy locales.
//
// The KEY IS THE ENGLISH TEXT. `t('Mark done anyway')` reads as what it renders,
// a missing translation falls back to a sentence rather than to `feed.checkpoint.
// markDone`, and the extraction tool (tools/i18n-extract.mjs) could rewrite
// 1,600 call sites without anyone inventing 1,600 names. The cost is the one
// natural-key systems always pay: rewording the English orphans that key's
// translations. `tools/i18n-gates.mjs` reports orphans per locale so a reword
// is a visible, bounded chore rather than a silent regression.
//
// What this covers, and what it deliberately does not: the CHROME — every
// label, button, hint, toast and dialog the app itself writes. Content (lessons,
// questions, the tutor) is per-project and was multilingual before this existed
// (`projects.content_language`). Text the SERVER writes into a response — a
// failure record's plain-English cause, a feed notice — is still English; those
// are the next boundary and belong to a code+params contract, not to string
// replacement on the client.
//
// English needs no locale file, with ONE exception: with `keySeparator`/
// `nsSeparator` off the key IS the string, so a key resolves to itself — but a
// COUNT-based key has two English strings and can only be one of them, and
// `t('{{count}} cards', { count: 1 })` therefore returned "1 cards" in the
// app's own language. So English loads its plural forms and nothing else
// (`enPlurals.ts`, generated from en.json, ~6 KB); every other key still
// resolves to itself and an unknown key still falls back to its own text. The
// rest of en.json is for the tools — it is the source list every other locale
// is measured against. Other locales are split into their own chunks by Vite
// and fetched on first use.

import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import enPlurals from './enPlurals';

/** Locales the app can be read in. Native names, because a person looking for
 *  their language in a list is looking for it in their language. Order is by
 *  code, not by popularity — a ranking would be an editorial claim. */
export const LANGUAGES: { code: string; name: string }[] = [
    { code: 'en', name: 'English' },
    { code: 'de', name: 'Deutsch' },
    { code: 'es', name: 'Español' },
    { code: 'fr', name: 'Français' },
    { code: 'it', name: 'Italiano' },
    { code: 'ja', name: '日本語' },
    { code: 'nl', name: 'Nederlands' },
    { code: 'pl', name: 'Polski' },
    { code: 'pt', name: 'Português' },
    { code: 'ru', name: 'Русский' },
    { code: 'uk', name: 'Українська' },
    { code: 'zh', name: '中文' },
];

export const DEFAULT_LANGUAGE = 'en';
export const LANGUAGE_STORAGE_KEY = 'terramentor-lang';

/** Right-to-left scripts. No RTL locale ships yet; the direction attribute is
 *  set from this so the day one does, the layout knows. */
const RTL = new Set(['ar', 'he', 'fa', 'ur']);

const SUPPORTED = new Set(LANGUAGES.map((l) => l.code));
export const isSupportedLanguage = (code: unknown): code is string =>
    typeof code === 'string' && SUPPORTED.has(code);

/**
 * Which language to show. `auto` (the stored default) follows the browser's
 * preference list, matched on the language part only — `pt-BR` reads `pt`,
 * `zh-Hant` reads `zh`, which is a coarser answer than a region-aware one and
 * the right one while there is one file per language.
 */
export function detectLanguage(preference: string | null | undefined, navigatorLanguages: readonly string[]): string {
    if (isSupportedLanguage(preference) && preference !== 'auto') return preference;
    for (const tag of navigatorLanguages) {
        const base = String(tag || '').toLowerCase().split(/[-_]/)[0];
        if (SUPPORTED.has(base)) return base;
    }
    return DEFAULT_LANGUAGE;
}

/** Locale files, one chunk each, loaded on demand. `import.meta.glob` is Vite's,
 *  replaced at BUILD time — so it must be called, never inspected: a
 *  `typeof` test on it survives into the bundle, where the real
 *  `import.meta` has no `glob`, and evaluates to false in production (measured:
 *  every locale silently English). The jsdom harnesses bundle the same sources
 *  with esbuild, where `import.meta` is an empty object and the call throws —
 *  there the app is English and nothing else changes. */
function discoverLoaders(): Record<string, () => Promise<{ default: Record<string, string> }>> {
    try {
        return import.meta.glob<{ default: Record<string, string> }>('../locales/*.json');
    } catch {
        return {};
    }
}
const loaders = discoverLoaders();

const loaded = new Set<string>([DEFAULT_LANGUAGE]);

async function ensureLoaded(code: string): Promise<void> {
    if (loaded.has(code)) return;
    const load = loaders[`../locales/${code}.json`];
    if (!load) return;
    try {
        const mod = await load();
        i18next.addResourceBundle(code, 'translation', mod.default, true, true);
        loaded.add(code);
    } catch {
        // A missing or broken chunk means English for that reader, not a broken app.
    }
}

const readCachedLanguage = (): string | null => {
    try { return localStorage.getItem(LANGUAGE_STORAGE_KEY); } catch { return null; }
};
const cacheLanguage = (code: string) => {
    try { localStorage.setItem(LANGUAGE_STORAGE_KEY, code); } catch { /* private mode */ }
};

function applyToDocument(code: string) {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = code;
    document.documentElement.dir = RTL.has(code) ? 'rtl' : 'ltr';
}

/** The last language this device showed — read before the first render so a
 *  Dutch reader does not see an English frame for a moment on every load. */
const initial = detectLanguage(readCachedLanguage(), typeof navigator !== 'undefined' ? navigator.languages || [navigator.language] : []);

void i18next.use(initReactI18next).init({
    lng: DEFAULT_LANGUAGE,
    fallbackLng: DEFAULT_LANGUAGE,
    keySeparator: false,
    nsSeparator: false,
    returnEmptyString: false,
    interpolation: { escapeValue: false }, // React escapes
    resources: { [DEFAULT_LANGUAGE]: { translation: enPlurals } },
    react: { useSuspense: false },
    // Initialise NOW, not on the next tick: the resources are inline and there
    // is no backend to wait for, and a `t()` called before init returns the raw
    // key with its `{{placeholders}}` unfilled — which the jsdom harnesses,
    // which render synchronously after import, would show as "{{cards}} cards".
    initAsync: false,
});

/**
 * Switch the interface language. Loads the locale if needed, then changes it
 * — in that order, so the switch never renders keys while the file is in
 * flight. Records the choice on this device for the next boot.
 */
export async function setUiLanguage(code: string): Promise<void> {
    const lang = isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE;
    await ensureLoaded(lang);
    await i18next.changeLanguage(lang);
    applyToDocument(lang);
    cacheLanguage(lang);
}

/** Resolve a stored preference (`auto` or a code) to the language to show. */
export function resolveLanguagePreference(preference: string | null | undefined): string {
    return detectLanguage(preference, typeof navigator !== 'undefined' ? navigator.languages || [navigator.language] : []);
}

/** The BCP-47 tag to hand to `Intl` — dates, numbers, relative times. */
export function currentLocale(): string {
    return i18next.language || DEFAULT_LANGUAGE;
}

// Boot: the cached language, applied before React mounts (main.tsx awaits it).
export const i18nReady: Promise<void> = setUiLanguage(initial);

/**
 * Mark a string in a module-level table as a translation KEY without
 * translating it there. A table built once at import time cannot call `t()`
 * (the language may change later), so the table keeps the English and the
 * render site does `t(row.label)`; `k()` is what lets the extraction tools see
 * the key. Identity at runtime.
 */
export const k = (key: string): string => key;

export default i18next;
