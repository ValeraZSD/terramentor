// The interface's language — one runtime, natural-language keys, lazy locales.
//
// The KEY IS THE ENGLISH TEXT. `t('Mark done anyway')` reads as what it renders,
// a missing translation falls back to a sentence rather than to `feed.checkpoint.
// markDone`, and the extraction tool (tools/i18n-extract.mjs) can rewrite every
// call site without anyone inventing key names. The cost is the one
// natural-key systems always pay: rewording the English orphans that key's
// translations. `tools/i18n-gates.mjs` reports orphans per locale so a reword
// is a visible, bounded chore rather than a silent regression.
//
// What this covers, and what it deliberately does not: the CHROME — every
// label, button, hint, toast and dialog the app itself writes. Content (lessons,
// questions, the tutor) is per-project and independent of the interface
// language (`projects.content_language`). Text the SERVER writes into a response — a
// failure record's plain-English cause, a feed notice — is still English; those
// are the next boundary and belong to a code+params contract, not to string
// replacement on the client.
//
// English needs no locale file, with ONE exception: with `keySeparator`/
// `nsSeparator` off the key IS the string, so a key resolves to itself — but a
// COUNT-based key has two English strings and can only be one of them, and
// `t('{{count}} cards', { count: 1 })` would return "1 cards" in the app's own
// language. So English loads its plural forms and nothing else
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
    { code: 'ar', name: 'العربية' },
    { code: 'de', name: 'Deutsch' },
    { code: 'es', name: 'Español' },
    { code: 'fr', name: 'Français' },
    { code: 'it', name: 'Italiano' },
    { code: 'ja', name: '日本語' },
    { code: 'nl', name: 'Nederlands' },
    { code: 'pl', name: 'Polski' },
    { code: 'pt', name: 'Português' },
    { code: 'ru', name: 'Русский' },
    { code: 'tr', name: 'Türkçe' },
    { code: 'uk', name: 'Українська' },
    { code: 'zh', name: '中文' },
];

export const DEFAULT_LANGUAGE = 'en';
export const LANGUAGE_STORAGE_KEY = 'terramentor-lang';

/** Right-to-left scripts: `<html dir="rtl">` for these, and the layout follows
 *  (logical classes everywhere, `tools/rtl-gates.mjs`). Arabic ships. */
const RTL = new Set(['ar', 'he', 'fa', 'ur']);

const SUPPORTED = new Set(LANGUAGES.map((l) => l.code));
export const isSupportedLanguage = (code: unknown): code is string =>
    typeof code === 'string' && SUPPORTED.has(code);

/** A language's name in another language ("Arabisch" for `ar` in `nl`), or ''
 *  where the browser has no name for it. */
function nameIn(code: string, locale: string): string {
    try {
        const name = new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? '';
        return name === code ? '' : name;
    } catch {
        return '';
    }
}

/**
 * How the picker names a language: in its own name first, so a reader finds
 * theirs whatever the screen is in, then in the interface's language, so a
 * reader who does not know the script still knows what it is
 * ("العربية — Arabisch" in a Dutch interface). The interface's own language,
 * and a name the two would spell alike, is said once.
 */
export function languageLabel(code: string, interfaceLocale: string): string {
    const own = LANGUAGES.find((l) => l.code === code)?.name ?? code;
    if (code === interfaceLocale) return own;
    const local = nameIn(code, interfaceLocale);
    return !local || local.toLocaleLowerCase(interfaceLocale) === own.toLocaleLowerCase(code) ? own : `${own} — ${local}`;
}

/** The interface language a name means: its own name ("Nederlands"), its
 *  English one ("Dutch") or its name in the language on screen ("niederländisch"
 *  in German). The assistant passes on whichever the learner used. */
export function languageByName(name: string, interfaceLocale: string): string | null {
    const v = foldName(name);
    for (const l of LANGUAGES) {
        const names = [l.name, nameIn(l.code, 'en'), nameIn(l.code, interfaceLocale)];
        if (names.some((n) => n && foldName(n) === v)) return l.code;
    }
    return null;
}

/** Case folded the same way whatever the device locale: Turkish "İngilizce"
 *  lowercases to an i with a dot above, typed "ingilizce" has none. */
const DOT_ABOVE = String.fromCharCode(0x307);
function foldName(s: string): string {
    return s.trim().normalize('NFD').toLowerCase().split(DOT_ABOVE).join('').replace(/ı/g, 'i');
}

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

/** Texts a client extension adds or replaces (src/clientExtension.ts), one
 *  file per language in src/extensions/texts/. Small, so read with the app. */
function discoverExtensionTexts(): Record<string, Record<string, string>> {
    try {
        const files = import.meta.glob<{ default: Record<string, string> }>('../extensions/texts/*.json', { eager: true });
        return Object.fromEntries(Object.entries(files).map(([path, mod]) => [path.replace(/^.*\/([^/]+)\.json$/, '$1'), mod.default]));
    } catch {
        return {};
    }
}
const extensionTexts = discoverExtensionTexts();

/** Laid over a language's own file, so an extension's text wins over the app's. */
function addExtensionTexts(code: string) {
    const texts = extensionTexts[code];
    if (texts) i18next.addResourceBundle(code, 'translation', texts, true, true);
}

const loaded = new Set<string>([DEFAULT_LANGUAGE]);

/** Which `setUiLanguage` call is the newest; an older one that finishes later
 *  must not apply. */
let latestRequest = 0;

async function ensureLoaded(code: string): Promise<void> {
    if (loaded.has(code)) return;
    const load = loaders[`../locales/${code}.json`];
    if (!load) return;
    try {
        const mod = await load();
        i18next.addResourceBundle(code, 'translation', mod.default, true, true);
        addExtensionTexts(code);
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
 *  reader of another language does not see an English frame on every load. */
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
addExtensionTexts(DEFAULT_LANGUAGE);

/**
 * Switch the interface language. Loads the locale if needed, then changes it
 * — in that order, so the switch never renders keys while the file is in
 * flight. Records the choice on this device for the next boot.
 *
 * If the locale cannot be loaded the reader stays on English and nothing is
 * cached on the device. The picker still shows the language that was chosen,
 * and the store still saves it, so the next boot asks for the chunk again.
 */
export async function setUiLanguage(code: string): Promise<void> {
    const lang = isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE;
    const request = ++latestRequest;
    await ensureLoaded(lang);
    // Two picks can overlap on a slow connection and their chunks arrive in any
    // order. Only the newest pick may apply, or the older one lands last and the
    // screen stays in a language the reader has already moved on from.
    if (request !== latestRequest) return;
    // A chunk that failed to load leaves English text, so everything else
    // (`<html lang>`, the `Intl` formats) says English too rather than a language
    // the words are not in. It is not cached: the next load tries the chunk again.
    const shown = loaded.has(lang) ? lang : DEFAULT_LANGUAGE;
    await i18next.changeLanguage(shown);
    if (request !== latestRequest) return;
    applyToDocument(shown);
    if (shown === lang) cacheLanguage(lang);
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
// A key the render site draws WITH a count is marked `k(key, { count: 0 })`:
// the extractor reads the `count` beside the key and keeps its plural forms.
export const k = (key: string, _plural?: { count: number }): string => key;

export default i18next;
