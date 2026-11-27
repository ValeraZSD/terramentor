import type { TFunction } from 'i18next';
import { AlertTriangle, CalendarX, CheckCircle2, Hourglass, TrendingDown, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { k } from '../../i18n';
import type { PaceVerdict, VerdictBand, WeekSoFar } from '../../types';
import { parseDate } from '../../utils/tree';
import { dateRangeLabel, uiLocale } from '../../utils/locale';

/**
 * One verdict, the same words everywhere it shows: the plan panel, the pill on
 * a Projects card and the line in the course header. The verdict itself is the
 * server's (`judgeDate`, server/paceModel.js); only the words are built here,
 * because server-written text stays English.
 *
 * The pill names the band with an icon and a word, never colour alone. The
 * colours are the status colours the app already uses: green on pace, amber
 * under pace or tight, red out of reach or passed, grey while it is learning.
 */

/**
 * The band's text colour: the pill's words, the headline's icon, the strip's
 * flag on the date and the tick beside a week that is met (on pace's green).
 */
export const TONE_TEXT: Record<VerdictBand, string> = {
    on_pace: 'text-emerald-700 dark:text-emerald-300',
    under_pace: 'text-amber-700 dark:text-amber-300',
    tight: 'text-amber-700 dark:text-amber-300',
    out_of_reach: 'text-red-700 dark:text-red-300',
    passed: 'text-red-700 dark:text-red-300',
    learning: 'text-slate-600 dark:text-slate-300',
    done: 'text-emerald-700 dark:text-emerald-300',
    no_date: 'text-slate-600 dark:text-slate-300',
};

/** The pill's tint behind those words. */
const TINT: Record<VerdictBand, string> = {
    on_pace: 'bg-emerald-500/10',
    under_pace: 'bg-amber-500/10',
    tight: 'bg-amber-500/10',
    out_of_reach: 'bg-red-500/10',
    passed: 'bg-red-500/10',
    learning: 'bg-slate-500/10',
    done: 'bg-emerald-500/10',
    no_date: 'bg-slate-500/10',
};

const ICON: Record<VerdictBand, LucideIcon> = {
    on_pace: CheckCircle2,
    under_pace: TrendingDown,
    tight: AlertTriangle,
    out_of_reach: XCircle,
    passed: CalendarX,
    learning: Hourglass,
    done: CheckCircle2,
    no_date: Hourglass,
};

export const LABEL: Record<VerdictBand, string> = {
    on_pace: k("On pace"),
    under_pace: k("Under pace"),
    tight: k("Tight"),
    out_of_reach: k("Out of reach"),
    passed: k("Date passed"),
    learning: k("Learning your pace"),
    done: k("Done"),
    no_date: k("No date"),
};

/** The bands where the date does not fit the learner's pace. */
export const MISSES: ReadonlySet<VerdictBand> = new Set(['under_pace', 'tight', 'out_of_reach']);

/** The band as a dot's fill, for the corner of the plan button. */
const DOT: Record<VerdictBand, string> = {
    on_pace: 'bg-emerald-500',
    under_pace: 'bg-amber-500',
    tight: 'bg-amber-500',
    out_of_reach: 'bg-red-500',
    passed: 'bg-red-500',
    learning: 'bg-slate-400',
    done: 'bg-emerald-500',
    no_date: 'bg-slate-400',
};

/**
 * The verdict where there is no room for its word: a dot on the corner of the
 * button that opens the plan. On a phone the pill took a tab's room
 * ("Dash…"), and its icon alone (a red ✕) read as a close button. The word
 * travels in the button's own name, so it is never colour alone.
 */
export function VerdictDot({ verdict }: { verdict: PaceVerdict }) {
    return (
        <span
            data-verdict={verdict.band}
            aria-hidden="true"
            className={`absolute -top-0.5 -end-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-slate-800 ${DOT[verdict.band]}`}
        />
    );
}

export function VerdictPill({ verdict, t, className = '' }: {
    verdict: PaceVerdict; t: TFunction; className?: string;
}) {
    const Icon = ICON[verdict.band];
    return (
        <span
            data-verdict={verdict.band}
            className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONE_TEXT[verdict.band]} ${TINT[verdict.band]} ${className}`}
        >
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t(LABEL[verdict.band])}
        </span>
    );
}

/**
 * The band's icon in its colour, for beside a sentence that already names the
 * band in words (the plan's headline): a pill there said "On pace" twice.
 */
export function VerdictIcon({ verdict, className = '' }: { verdict: PaceVerdict; className?: string }) {
    const Icon = ICON[verdict.band];
    // The pill's text colour only: no tint behind a bare icon.
    return <Icon className={`shrink-0 ${TONE_TEXT[verdict.band]} ${className}`} aria-hidden="true" />;
}

/**
 * A weekly amount as it is read: whole numbers from 3 up ("25 a week"), one
 * decimal below that, where "0.4 a week" and "0 a week" say different things.
 * Anything above zero stays above it: one topic left in half a year is 0.1, not
 * "needs 0 a week".
 */
export function perWeek(x: number | null | undefined): number {
    if (x == null || !Number.isFinite(x)) return 0;
    if (x >= 3) return Math.round(x);
    return x > 0 ? Math.max(0.1, Math.round(x * 10) / 10) : Math.round(x * 10) / 10;
}

/** "Dec 3", the year only when it is not this year. */
export function shortDay(date: string, today: string): string {
    const sameYear = date.slice(0, 4) === today.slice(0, 4);
    return parseDate(date).toLocaleDateString(uiLocale(), {
        month: 'short', day: 'numeric', timeZone: 'UTC', ...(sameYear ? {} : { year: 'numeric' }),
    });
}

/**
 * One full stop where an abbreviated date ends a sentence: German, French,
 * Russian, Ukrainian and Portuguese short months end in their own "." ("bis
 * zum 17. Dez.."). An ellipsis is left alone.
 */
export function oneStop(sentence: string): string {
    return sentence.replace(/(?<!\.)\.\.(?!\.)/g, '.');
}

type Num = (value: number, options?: { decimals?: number }) => string;
const rate = (num: Num, x: number | null | undefined) => {
    const r = perWeek(x);
    return num(r, { decimals: Number.isInteger(r) ? 0 : 1 });
};

/**
 * Whether the panel's sentences give the best month's rate: only where the
 * date misses the recent pace and the best one is the yardstick (tight, out
 * of reach, or under pace with the best within reach).
 */
export function sentencesGiveBest(band: VerdictBand): boolean {
    return MISSES.has(band);
}

const DAY_MS = 86_400_000;
const dayNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS);

/** The bands the plan's strip is drawn for: a date still ahead with work open (the server's STRIP_BANDS, server/paceModel.js). */
export const STRIP_BANDS: ReadonlySet<VerdictBand> = new Set(['on_pace', 'under_pace', 'tight', 'out_of_reach', 'learning']);

/** Where the learner's date falls against the likely-done range. */
export type DatePlace = 'before' | 'inside' | 'after';

/**
 * What the plan's forward strip shows: today, the "likely done" range when
 * there is one (from four weeks of study, and only while the recent pace can
 * finish at all), and the learner's date. Positions are days from today; the
 * strip ends a little past the later of the date and the range's end.
 */
export interface StripFacts {
    dateDay: number;
    range: { from: string; to: string; fromDay: number; toDay: number } | null;
    place: DatePlace | null;
    endDay: number;
    /** "Likely done Feb 22 – May 2", or null without a range. */
    rangeLabel: string | null;
    /** The strip in one sentence, for a screen reader. */
    sentence: string;
}

export function stripFacts(v: PaceVerdict, t: TFunction, num: Num, today: string): StripFacts | null {
    if (!STRIP_BANDS.has(v.band) || !v.deadline) return null;
    const dateDay = Math.max(0, dayNum(v.deadline) - dayNum(today));
    const r = v.ranges.recent;
    const range = r ? { from: r.from, to: r.to, fromDay: dayNum(r.from) - dayNum(today), toDay: dayNum(r.to) - dayNum(today) } : null;
    const place: DatePlace | null = !range ? null
        : dateDay < range.fromDay ? 'before' : dateDay > range.toDay ? 'after' : 'inside';
    // A week at least, so a date due today still has a strip to sit on.
    const endDay = Math.max(7, dateDay, range?.toDay ?? 0);
    let rangeLabel: string | null = null;
    let sentence: string;
    if (range) {
        const year = range.from.slice(0, 4) !== today.slice(0, 4) || range.to.slice(0, 4) !== today.slice(0, 4);
        const dates = dateRangeLabel(parseDate(range.from), parseDate(range.to), { year });
        rangeLabel = t("Likely done {{dates}}", { dates });
        sentence = place === 'before'
            ? t("Your date comes before the likely-done range, {{dates}}.", { dates })
            : place === 'after'
                ? t("Your date comes after the likely-done range, {{dates}}.", { dates })
                : t("Your date falls inside the likely-done range, {{dates}}.", { dates });
    } else if (dateDay === 0) {
        sentence = t("Your date is today.");
    } else {
        sentence = t("{{n}} days from today to your date.", { count: dateDay, n: num(dateDay) });
    }
    return { dateDay, range, place, endDay, rangeLabel, sentence: oneStop(sentence) };
}

/**
 * The line under the strip: this course's work so far this week against the
 * week's target, which the server fixes from Monday (`weeklyTarget`,
 * server/paceModel.js) so it does not shrink as the week's work is done. Null
 * where the strip is not drawn, the week is not known, or the target is under
 * one a week.
 */
export function weekLine(v: PaceVerdict, week: WeekSoFar | null | undefined, t: TFunction, num: Num): { text: string; met: boolean } | null {
    if (!STRIP_BANDS.has(v.band) || !week || week.target == null || week.target < 1) return null;
    const m = week.target;
    const n = week.count;
    const cards = v.unit === 'cards';
    if (n > m) {
        return {
            met: true,
            text: cards
                ? t("This week: {{n}} new cards, {{m}} needed", { count: n, n: num(n), m: num(m) })
                : t("This week: {{n}} topics, {{m}} needed", { count: n, n: num(n), m: num(m) }),
        };
    }
    return {
        met: n === m,
        text: cards
            ? t("This week: {{n}} of the {{m}} new cards your date needs", { count: m, n: num(n), m: num(m) })
            : t("This week: {{n}} of the {{m}} topics your date needs", { count: m, n: num(n), m: num(m) }),
    };
}

export type StripLabel = 'today' | 'date' | 'range';
export type StripLane = 'above' | 'below' | 'under';
export interface LabelAsk {
    id: StripLabel;
    /** Where the label belongs, in pixels from the strip's left edge. */
    x: number;
    /** Its measured width. */
    w: number;
    /** True: the label starts at x (today's); false: it is centred on x. */
    start: boolean;
    /** The lanes it may take, best first. */
    lanes: StripLane[];
}

/** Where a label goes, and its width: its own, or the strip's when it is wider. */
export interface PlacedLabel { left: number; lane: StripLane; width: number }

/**
 * Places the strip's labels: each, in the order given, takes the first of its
 * lanes where it stays `gap` clear of every label already there, kept inside
 * the strip. Three labels that each accept all three lanes never overlap.
 */
export function placeLabels(asks: LabelAsk[], width: number, gap: number): Partial<Record<StripLabel, PlacedLabel>> {
    const out: Partial<Record<StripLabel, PlacedLabel>> = {};
    const taken: { lane: StripLane; a: number; b: number }[] = [];
    for (const ask of asks) {
        // A label wider than the strip is cut to it (PlanStrip ends it in "…").
        const w = Math.min(ask.w, Math.max(0, width));
        const want = ask.start ? ask.x : ask.x - w / 2;
        const left = Math.max(0, Math.min(want, width - w));
        const free = (lane: StripLane) => taken.every(s => s.lane !== lane || left + w + gap <= s.a || s.b + gap <= left);
        const lane = ask.lanes.find(free) ?? ask.lanes[ask.lanes.length - 1];
        taken.push({ lane, a: left, b: left + w });
        out[ask.id] = { left, lane, width: w };
    }
    return out;
}

/** The panel's headline: the date and the verdict in one line. */
export function verdictHeadline(v: PaceVerdict, t: TFunction, today: string): string {
    const date = v.deadline ? shortDay(v.deadline, today) : '';
    switch (v.band) {
        case 'on_pace': return t("On pace for {{date}}", { date });
        case 'under_pace': return t("Under pace for {{date}}", { date });
        case 'tight': return t("{{date}} needs your best pace", { date });
        case 'out_of_reach': return t("{{date}} is out of reach", { date });
        case 'passed': return t("{{date}} has passed", { date });
        case 'done': return t("Nothing left before {{date}}", { date });
        default: return t("Too early to judge {{date}}", { date });
    }
}

/**
 * What is left, what the date asks and what the record says, as whole
 * sentences (each its own key, so word order is the translator's).
 */
export function verdictSentences(v: PaceVerdict, t: TFunction, num: Num, today: string): string[] {
    const cards = v.unit === 'cards';
    const out: string[] = [];
    if (v.band === 'done') {
        out.push(cards ? t("Every card in it has been met.") : t("Every topic in it is closed."));
        return out;
    }
    out.push(cards
        ? t("{{n}} cards are still new.", { count: v.open, n: num(v.open) })
        : t("{{n}} topics are left.", { count: v.open, n: num(v.open) }));
    if (v.band === 'passed') return out;
    if (v.band === 'learning') {
        out.push(v.early
            ? t("This date already needs at least twice your first week's pace.")
            : t("After two weeks of study the app compares this date with your own pace."));
        return out;
    }
    // What the date needs a week is the line under the strip; the likely
    // finish is the strip's own range.
    if (v.quietWeeks >= 2) {
        out.push(cards
            ? t("No new card met for {{n}} weeks.", { count: v.quietWeeks, n: num(v.quietWeeks) })
            : t("Nothing closed for {{n}} weeks.", { count: v.quietWeeks, n: num(v.quietWeeks) }));
    } else {
        out.push(t("Your recent pace is {{n}} a week.", { n: rate(num, v.recent) }));
    }
    if (sentencesGiveBest(v.band)) out.push(t("Your best month was {{n}} a week.", { n: rate(num, v.best) }));
    if (v.band === 'out_of_reach' && v.fits != null) {
        // "You finish", so the verb never agrees with the number.
        out.push(t("At that pace you finish {{fits}} of the {{open}} in time.", { fits: num(v.fits), open: num(v.open) }));
    }
    return out.map(oneStop);
}

/** The one line beside a pill on a card or in the course header; null when the pill says it all. */
export function verdictLine(v: PaceVerdict, t: TFunction, num: Num): string | null {
    const cards = v.unit === 'cards';
    switch (v.band) {
        case 'out_of_reach':
        case 'tight':
            return `${t("Needs {{n}} a week.", { n: rate(num, v.needed) })} ${t("Your best month was {{n}} a week.", { n: rate(num, v.best) })}`;
        case 'under_pace':
            return `${t("Needs {{n}} a week.", { n: rate(num, v.needed) })} ${v.quietWeeks >= 2
                ? (cards
                    ? t("No new card met for {{n}} weeks.", { count: v.quietWeeks, n: num(v.quietWeeks) })
                    : t("Nothing closed for {{n}} weeks.", { count: v.quietWeeks, n: num(v.quietWeeks) }))
                : t("Your recent pace is {{n}} a week.", { n: rate(num, v.recent) })}`;
        case 'on_pace':
            return `${t("Needs {{n}} a week.", { n: rate(num, v.needed) })} ${t("Your recent pace is {{n}} a week.", { n: rate(num, v.recent) })}`;
        case 'learning':
            return v.early ? t("This date already needs at least twice your first week's pace.") : null;
        case 'passed':
            return cards
                ? t("{{n}} cards are still new.", { count: v.open, n: num(v.open) })
                : t("{{n}} topics are left.", { count: v.open, n: num(v.open) });
        default:
            return null;
    }
}
