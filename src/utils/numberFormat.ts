// How a number is WRITTEN — the separators, and nothing else.
//
// Two problems, one of which nobody reported:
//
//  1. Of 44 places that printed a number, 41 called `.toLocaleString()` with no
//     argument, which follows the DEVICE locale — the operating system's
//     regional settings — while three passed `uiLocale()`, which follows the
//     interface language. So one screen could say "5,168 cards" beside another
//     saying "5 168", on the same machine, and neither followed the language
//     the person chose to read the app in. `locale.ts` had already settled that
//     question for dates ("the locale follows the interface language — not the
//     device locale"); numbers were left half-converted.
//  2. The language is not always the right answer anyway. Reading the chrome in
//     English does not mean wanting 1,234.5: someone working through Dutch
//     material writes 1.234,5, and physics is written 1 234,5 or 1 234.5 with a
//     space, which no locale produces by default.
//
// So the separators are a preference with the language as its DEFAULT, and this
// is the one place a number becomes a string.
//
// **It is display only.** `parseNumber` (`components/answer/formats.ts`) stays
// generous whatever is set here — it accepts both separators from everyone,
// always. Narrowing what a learner may TYPE to match a display preference would
// mark a correct answer wrong for writing 0.5 under a comma setting, and a
// preference about how digits look must never decide whether someone knows
// physics. `answer-format-gates.mjs` pins that.

import { uiLocale } from './locale';

/** A non-breaking space: a grouped number must never break across two lines. */
const NBSP = ' ';

export interface NumberStyle {
    id: string;
    /** Between thousands. Empty means no grouping at all. */
    group: string;
    decimal: string;
}

/**
 * The offered conventions. Deliberately short: these are the four separator
 * pairs in real use plus "no grouping", not every combination the characters
 * allow (grouping and decimal must differ, or 1.234.5 is unreadable).
 *
 * There is no label for any of them, in any language. The option IS the
 * example — `1,234.5` says what it does to anyone, in a way "comma group,
 * point decimal" does not, and it needs no translation.
 */
export const NUMBER_STYLES: NumberStyle[] = [
    { id: '1,234.5', group: ',', decimal: '.' },
    { id: '1.234,5', group: '.', decimal: ',' },
    { id: '1 234,5', group: NBSP, decimal: ',' },
    { id: '1 234.5', group: NBSP, decimal: '.' },
    { id: '1234.5', group: '', decimal: '.' },
];

/** The stored preference: a style id, or `auto` to follow the interface language. */
export const AUTO = 'auto';

export const isNumberStyle = (value: string | null | undefined): boolean =>
    value === AUTO || NUMBER_STYLES.some(s => s.id === value);

/** The style a preference resolves to, or null when it follows the language. */
export const numberStyle = (preference: string | null | undefined): NumberStyle | null =>
    NUMBER_STYLES.find(s => s.id === preference) ?? null;

export interface NumberOptions {
    /** Exact number of digits after the separator (both ends), for a key that claims a precision. */
    decimals?: number;
}

/**
 * Write one number the way this reader has asked for.
 *
 * An explicit style groups the digits HERE rather than borrowing a locale that
 * happens to use the right characters and then swapping them: naming a locale
 * would tie a display choice to a region's other conventions, and `i18n-gates`
 * rightly fails any hardcoded English locale tag in the client, because that is
 * exactly how a screen ends up ignoring the interface language. Three digits
 * from the right is the whole rule for every convention offered.
 */
export function formatNumber(value: number, preference: string | null | undefined, options: NumberOptions = {}): string {
    if (!Number.isFinite(value)) return String(value);
    const style = numberStyle(preference);
    if (!style) {
        return value.toLocaleString(uiLocale(), options.decimals !== undefined
            ? { minimumFractionDigits: options.decimals, maximumFractionDigits: options.decimals }
            : {});
    }
    const magnitude = Math.abs(value);
    // `String()` gives exponential notation past 1e21 and for very small
    // numbers; nothing in the app counts that high, but a number that arrives
    // there is handed back to Intl rather than printed as "1e+21" with a
    // thousands separator bolted on.
    const plain = options.decimals !== undefined
        ? magnitude.toFixed(options.decimals)
        // Matching `toLocaleString`'s own default, so switching away from "same
        // as the language" never lengthens a number: at most three decimals.
        : String(Math.round(magnitude * 1000) / 1000);
    if (plain.includes('e')) return value.toLocaleString(uiLocale());
    const [whole, fraction] = plain.split('.');
    const grouped = style.group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, style.group) : whole;
    return (value < 0 ? '-' : '') + grouped + (fraction ? style.decimal + fraction : '');
}

/**
 * The reader's current preference, for the few call sites that are NOT React
 * components — a widget's build log, a repair's progress line, the deck
 * palette's `fmt`. The store writes it on every settings load and on every
 * change; components use `useNumberFormat()` instead, which also re-renders
 * them when it changes.
 */
let preference: string = AUTO;
const listeners = new Set<() => void>();

export const setNumberPreference = (value: string | null | undefined) => {
    const next = isNumberStyle(value) ? String(value) : AUTO;
    if (next === preference) return;
    preference = next;
    for (const listener of listeners) listener();
};
export const getNumberPreference = (): string => preference;

/**
 * Told when the preference changes, so `useNumberFormat` can re-render through
 * `useSyncExternalStore`.
 *
 * Deliberately NOT the Zustand store. The hook is used by leaf components — a
 * visual block, a progress counter — and having it import `store.ts` pulled the
 * entire application state, the api client and the i18n runtime into their
 * bundles, which `visual-block-gates` noticed by failing to build one at all.
 * A preference that is one string does not need the app's state container; the
 * store still OWNS it (it is what reads it from the server and writes it back)
 * and simply pushes it here.
 */
export const subscribeNumberPreference = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

export const num = (value: number, options: NumberOptions = {}): string =>
    formatNumber(value, preference, options);

/**
 * How many digits a written number claims after its separator — so a key
 * authored as "4.170" is not re-printed as "4.17", losing the significant
 * figure that says how precisely it was measured.
 */
export function writtenDecimals(written: string): number | undefined {
    const m = String(written ?? '').replace(/[  \s]/g, '').match(/[.,](\d+)(?:[eE][-+]?\d+)?$/);
    return m ? m[1].length : undefined;
}
