// Dates and numbers in the reader's language.
//
// The locale follows the interface language — not the device locale, which may
// differ from the language the person chose to read the app in.
//
// `timeZone: 'UTC'` travels with study dates: the app's dates are
// `YYYY-MM-DD` parsed as UTC midnight (see utils/tree.ts), and formatting them
// in a local zone west of Greenwich prints the day before.

import { currentLocale } from '../i18n';

/** The BCP-47 tag for `Intl`, from the interface language. */
export const uiLocale = (): string => currentLocale();

/**
 * Month and weekday names in the INTERFACE language.
 *
 * Hardcoded English arrays would print "September 2026" and "MON TUE WED" above
 * Russian chrome, and no extractor would see them. `Intl` already knows every
 * language's names; all it needs is the locale the reader chose rather than the
 * one the machine has.
 */
export function monthName(month: number): string {
    return new Intl.DateTimeFormat(uiLocale(), { month: 'long', timeZone: 'UTC' })
        .format(new Date(Date.UTC(2021, month, 1)));
}

/**
 * Short weekday labels, ordered from the configured first day of the week.
 * The reference week starts at 2021-08-01, which was a Sunday, so index 0 is
 * Sunday and `weekStartDay` indexes it directly.
 */
export function dayHeaders(weekStartDay = 0): string[] {
    const fmt = new Intl.DateTimeFormat(uiLocale(), { weekday: 'short', timeZone: 'UTC' });
    const days = Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2021, 7, 1 + i))));
    return [...days.slice(weekStartDay), ...days.slice(0, weekStartDay)];
}

/**
 * A date RANGE, written the way the reader's language writes ranges.
 *
 * Joining two halves by hand — the start without a year, the end with one — is
 * the English shape and not everyone's: Chinese would come out as
 * "9月14日 – 2026年9月20日", with the year on the wrong end of the dash.
 * `Intl` knows the shape; `formatRange` is newer than this project's TS lib
 * target, so it is reached for by feature test and the manual join is the
 * fallback.
 */
export function dateRangeLabel(start: Date, end: Date): string {
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' };
    const fmt = new Intl.DateTimeFormat(uiLocale(), opts) as Intl.DateTimeFormat & {
        formatRange?: (from: Date, to: Date) => string;
    };
    if (typeof fmt.formatRange === 'function') return fmt.formatRange(start, end);
    const from = start.toLocaleDateString(uiLocale(), { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return `${from} – ${end.toLocaleDateString(uiLocale(), opts)}`;
}

/**
 * The narrowest weekday label, by ISO day (1 = Monday … 7 = Sunday) — for the
 * seven-tickbox study week, where the row has to fit on a phone.
 *
 * A row built by hand would mix bare English letters no extractor can see
 * with translated keys — a German reader would choose their study days from
 * "M Di W Do F Sa So". `Intl`'s `narrow` is one letter in the languages that have one and the
 * right short form in the ones that do not (ja 月火水, ru пн вт ср).
 */
export function isoDayLabel(iso: number): string {
    // 2021-08-01 was a Sunday, so ISO 1 (Monday) is the 2nd.
    return new Intl.DateTimeFormat(uiLocale(), { weekday: 'narrow', timeZone: 'UTC' })
        .format(new Date(Date.UTC(2021, 7, 1 + (iso % 7))));
}

/**
 * The full weekday name, by ISO day (1 = Monday … 7 = Sunday).
 *
 * Same reasoning as `isoDayLabel`, at the size a sentence needs: a weekday is
 * precisely the kind of word `Intl` already knows.
 */
export function weekdayName(iso: number): string {
    return new Intl.DateTimeFormat(uiLocale(), { weekday: 'long', timeZone: 'UTC' })
        .format(new Date(Date.UTC(2021, 7, 1 + (iso % 7))));
}
