// Dates and numbers in the reader's language.
//
// The locale follows the interface language — not the device locale, which may
// differ from the language the person chose to read the app in.
//
// `timeZone: 'UTC'` travels with study dates: the app's dates are
// `YYYY-MM-DD` parsed as UTC midnight (see utils/tree.ts), and formatting them
// in a local zone west of Greenwich prints the day before.

import { currentLocale } from '../i18n';
import { parseDate } from './tree';

/** The BCP-47 tag for `Intl`, from the interface language. */
export const uiLocale = (): string => currentLocale();

/** "30 Jul 2026" — unambiguous, unlike 07/30 vs 30/07. */
export const pretty = (d: string) =>
    parseDate(d).toLocaleDateString(uiLocale(), {
        day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    });

/** "Icon, Colour and Name", in the interface's language. `Intl.ListFormat` is
 *  ES2021 and the project's `lib` is ES2020, hence the narrow cast. */
export function listFormat(items: string[]): string {
    const ListFormat = (Intl as unknown as {
        ListFormat?: new (locale: string, options: { style: string; type: string }) => { format(list: string[]): string };
    }).ListFormat;
    try {
        if (ListFormat) return new ListFormat(uiLocale(), { style: 'long', type: 'conjunction' }).format(items);
    } catch { /* an unknown locale: the plain join */ }
    return items.join(', ');
}

/**
 * Weekday names in the INTERFACE language: hardcoded English arrays would print
 * "MON TUE WED" above Russian chrome, and no extractor would see them.
 *
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
export function dateRangeLabel(start: Date, end: Date, { year = true }: {
    /** False for a span inside a period already on screen ("Oct 30 – Nov 2"),
     *  where the year is in the title above it. */
    year?: boolean;
} = {}): string {
    const fmt = rangeFormat(uiLocale(), year);
    if (typeof fmt.formatRange === 'function') return fmt.formatRange(start, end);
    return `${rangeFormat(uiLocale(), false).format(start)} – ${fmt.format(end)}`;
}

type RangeFormat = Intl.DateTimeFormat & { formatRange?: (from: Date, to: Date) => string };
const rangeFormats = new Map<string, RangeFormat>();

/** One formatter per language and shape: a chart of weeks asks for dozens of
 *  ranges a render, and building an `Intl.DateTimeFormat` is the slow part. */
function rangeFormat(locale: string, year: boolean): RangeFormat {
    const key = `${locale}|${year}`;
    let fmt = rangeFormats.get(key);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat(locale, {
            month: 'short', day: 'numeric', timeZone: 'UTC', ...(year ? { year: 'numeric' } : {}),
        }) as RangeFormat;
        rangeFormats.set(key, fmt);
    }
    return fmt;
}

/**
 * The short weekday name, by ISO day (1 = Monday … 7 = Sunday), for the
 * seven study-day toggles.
 *
 * A row built by hand would mix bare English letters no extractor can see
 * with translated keys. `short`, not `narrow`: one letter left Tuesday and
 * Thursday, Saturday and Sunday reading the same (T T, S S); the short forms
 * (Mon, ma, пн, 月) still fit seven to a phone row.
 */
export function isoDayShort(iso: number): string {
    // 2021-08-01 was a Sunday, so ISO 1 (Monday) is the 2nd.
    // The abbreviation's own dot goes ("lun." "niedz."): on a button it is
    // noise, and Polish Sunday touched its edges at phone width.
    return new Intl.DateTimeFormat(uiLocale(), { weekday: 'short', timeZone: 'UTC' })
        .format(new Date(Date.UTC(2021, 7, 1 + (iso % 7))))
        .replace(/\.$/, '');
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

/**
 * A day as a record names it: "12 Oct" this year, "12 Oct 2025" before it,
 * in the interface language. For "Finished 12 Oct" on a finished course.
 */
export function dayLabel(iso: string, now: Date = new Date()): string {
    const d = new Date(iso);
    // An imported course may carry any string: Intl throws on an Invalid Date.
    if (Number.isNaN(d.getTime())) return '';
    const sameYear = d.getFullYear() === now.getFullYear();
    return new Intl.DateTimeFormat(uiLocale(), { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).format(d);
}
