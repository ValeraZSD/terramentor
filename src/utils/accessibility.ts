/**
 * The accessibility preferences: what each one is called in the settings
 * table, what it may hold, and how it reaches the page.
 *
 * Every visual preference lands as ONE attribute on `<html>`, resolved:
 *   data-motion="reduce|full"      every animation, transition and arrival
 *   data-contrast="more|standard"  the surface ramp (store.ts applyThemeToDom)
 *   data-letter-spacing / data-word-spacing / data-line-spacing
 *                                  "wider" or "widest" (index.css)
 * "Follow the system" is resolved HERE, from the media query, so the rest of
 * the app reads one attribute and never a media query of its own: a reader who
 * turned motion back on in the app must get motion even when the system asks
 * for less, and the other way round. `motionReduced()` is that reading for
 * script; the `motion-on:`/`motion-off:` variants are the same reading
 * for classes (tailwind.config.js).
 *
 * The resolved values are mirrored to localStorage and replayed by
 * public/theme-boot.js before the first paint, as the theme is.
 *
 * A leaf: no React, no store, so the boot path, the store and a gate can all
 * import it.
 */

export type Follow = 'system';
export type MotionPref = Follow | 'reduce' | 'full';
export type ContrastPref = Follow | 'more' | 'standard';
export type SpacingLevel = 'normal' | 'wider' | 'widest';

export interface A11yPrefs {
    motion: MotionPref;
    contrast: ContrastPref;
    letterSpacing: SpacingLevel;
    wordSpacing: SpacingLevel;
    lineSpacing: SpacingLevel;
    /** A band that follows the line being read in a lesson. */
    readingLine: boolean;
    /** A "Read aloud" button beside cards, questions, lessons and replies. */
    readAloud: boolean;
    /** Speaking speed, percent of the voice's normal rate. */
    speechRate: number;
    /** Card audio starts by itself when a card is shown. */
    cardAudioAutoplay: boolean;
    /** A press on an answer or a rating selects it; a second press confirms. */
    confirmAnswers: boolean;
}

/** The settings row behind each field (server/settingsSchema.js). */
export const A11Y_KEYS = {
    motion: 'motion',
    contrast: 'contrast',
    letterSpacing: 'letter_spacing',
    wordSpacing: 'word_spacing',
    lineSpacing: 'line_spacing',
    readingLine: 'reading_line',
    readAloud: 'read_aloud',
    speechRate: 'speech_rate',
    cardAudioAutoplay: 'card_audio_autoplay',
    confirmAnswers: 'confirm_answers',
} as const satisfies Record<keyof A11yPrefs, string>;

export const MOTION_PREFS: readonly MotionPref[] = ['system', 'full', 'reduce'];
export const CONTRAST_PREFS: readonly ContrastPref[] = ['system', 'standard', 'more'];
export const SPACING_LEVELS: readonly SpacingLevel[] = ['normal', 'wider', 'widest'];
export const MIN_SPEECH_RATE = 50;
export const MAX_SPEECH_RATE = 200;
export const SPEECH_RATE_STEP = 10;

export const DEFAULT_A11Y: A11yPrefs = {
    motion: 'system',
    contrast: 'system',
    letterSpacing: 'normal',
    wordSpacing: 'normal',
    lineSpacing: 'normal',
    readingLine: false,
    readAloud: false,
    speechRate: 100,
    cardAudioAutoplay: true,
    confirmAnswers: false,
};

const pick = <T extends string>(allowed: readonly T[], value: unknown, fallback: T): T =>
    (allowed as readonly unknown[]).includes(value) ? value as T : fallback;

export const clampSpeechRate = (value: unknown): number => {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return DEFAULT_A11Y.speechRate;
    return Math.max(MIN_SPEECH_RATE, Math.min(MAX_SPEECH_RATE, n));
};

/** The preferences a settings snapshot holds; anything absent or unknown is
 *  the default, so a row from a later build never leaves a field undefined. */
export function readA11yPrefs(settings: Record<string, string | null | undefined>): A11yPrefs {
    return {
        motion: pick(MOTION_PREFS, settings.motion, DEFAULT_A11Y.motion),
        contrast: pick(CONTRAST_PREFS, settings.contrast, DEFAULT_A11Y.contrast),
        letterSpacing: pick(SPACING_LEVELS, settings.letter_spacing, 'normal'),
        wordSpacing: pick(SPACING_LEVELS, settings.word_spacing, 'normal'),
        lineSpacing: pick(SPACING_LEVELS, settings.line_spacing, 'normal'),
        readingLine: settings.reading_line === 'true',
        readAloud: settings.read_aloud === 'true',
        speechRate: settings.speech_rate == null || settings.speech_rate === '' ? DEFAULT_A11Y.speechRate : clampSpeechRate(settings.speech_rate),
        cardAudioAutoplay: settings.card_audio_autoplay !== 'false',
        confirmAnswers: settings.confirm_answers === 'true',
    };
}

/** The string a field is stored as. */
export const storedA11yValue = (value: A11yPrefs[keyof A11yPrefs]): string =>
    typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);

// ---- What the system asks for ---------------------------------------------------

const query = (q: string): MediaQueryList | null => {
    try { return typeof matchMedia === 'function' ? matchMedia(q) : null; } catch { return null; }
};

export const systemReducesMotion = (): boolean => query('(prefers-reduced-motion: reduce)')?.matches ?? false;
export const systemWantsMoreContrast = (): boolean => query('(prefers-contrast: more)')?.matches ?? false;
export const systemPrefersDark = (): boolean => query('(prefers-color-scheme: dark)')?.matches ?? false;

/** Motion as the app plays it: the reader's choice, else the system's. */
export const resolveMotion = (pref: MotionPref): 'reduce' | 'full' =>
    pref === 'system' ? (systemReducesMotion() ? 'reduce' : 'full') : pref;

/** Contrast as the app paints it. */
export const resolveContrast = (pref: ContrastPref): 'more' | 'standard' =>
    pref === 'system' ? (systemWantsMoreContrast() ? 'more' : 'standard') : pref;

/**
 * True when motion is off. Reads the attribute, which is the one place the
 * reader's choice and the system's are already combined; before anything has
 * set it (a gate, a page with no boot script) it asks the system.
 */
export function motionReduced(): boolean {
    if (typeof document === 'undefined') return false;
    const v = document.documentElement.getAttribute('data-motion');
    return v ? v === 'reduce' : systemReducesMotion();
}

/** Calls `onChange` whenever one of the system's three answers changes. */
export function watchSystemPreferences(onChange: () => void): () => void {
    const lists = ['(prefers-reduced-motion: reduce)', '(prefers-contrast: more)', '(prefers-color-scheme: dark)']
        .map(query).filter((m): m is MediaQueryList => m != null);
    for (const m of lists) m.addEventListener?.('change', onChange);
    return () => { for (const m of lists) m.removeEventListener?.('change', onChange); };
}

// ---- Onto the page --------------------------------------------------------------

export const A11Y_STORAGE_KEY = 'terramentor-a11y';

/** What public/theme-boot.js replays: the preferences, unresolved, so a
 *  system that changed since the last visit is followed from the first paint. */
interface A11yCache {
    motion?: MotionPref;
    letterSpacing?: SpacingLevel;
    wordSpacing?: SpacingLevel;
    lineSpacing?: SpacingLevel;
}

/** Put the visual preferences on `<html>`. Contrast is painted by the theme
 *  (store.ts), which reads `resolveContrast` itself; its attribute is set here
 *  so CSS that is not a colour (a ring's width) can follow it too. */
export function applyA11yToDom(prefs: A11yPrefs): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.setAttribute('data-motion', resolveMotion(prefs.motion));
    root.setAttribute('data-contrast', resolveContrast(prefs.contrast));
    const spacing: [string, SpacingLevel][] = [
        ['data-letter-spacing', prefs.letterSpacing],
        ['data-word-spacing', prefs.wordSpacing],
        ['data-line-spacing', prefs.lineSpacing],
    ];
    for (const [attr, level] of spacing) {
        if (level === 'normal') root.removeAttribute(attr);
        else root.setAttribute(attr, level);
    }
    try {
        const cache: A11yCache = {
            motion: prefs.motion,
            letterSpacing: prefs.letterSpacing,
            wordSpacing: prefs.wordSpacing,
            lineSpacing: prefs.lineSpacing,
        };
        localStorage.setItem(A11Y_STORAGE_KEY, JSON.stringify(cache));
    } catch { /* private mode: the cache is an optimisation */ }
}

/** The last preferences this device saw, for the store's first state. */
export function cachedA11yPrefs(): A11yPrefs {
    try {
        const raw = localStorage.getItem(A11Y_STORAGE_KEY);
        const c = raw ? JSON.parse(raw) as A11yCache : {};
        return {
            ...DEFAULT_A11Y,
            motion: pick(MOTION_PREFS, c.motion, DEFAULT_A11Y.motion),
            letterSpacing: pick(SPACING_LEVELS, c.letterSpacing, 'normal'),
            wordSpacing: pick(SPACING_LEVELS, c.wordSpacing, 'normal'),
            lineSpacing: pick(SPACING_LEVELS, c.lineSpacing, 'normal'),
        };
    } catch {
        return { ...DEFAULT_A11Y };
    }
}
