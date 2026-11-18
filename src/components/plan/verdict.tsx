import type { TFunction } from 'i18next';
import { AlertTriangle, CalendarX, CheckCircle2, Hourglass, TrendingDown, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { k } from '../../i18n';
import type { PaceVerdict, VerdictBand } from '../../types';
import { parseDate } from '../../utils/tree';
import { uiLocale } from '../../utils/locale';

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

const TONE: Record<VerdictBand, string> = {
    on_pace: 'text-emerald-700 dark:text-emerald-300 bg-emerald-500/10',
    under_pace: 'text-amber-700 dark:text-amber-300 bg-amber-500/10',
    tight: 'text-amber-700 dark:text-amber-300 bg-amber-500/10',
    out_of_reach: 'text-red-700 dark:text-red-300 bg-red-500/10',
    passed: 'text-red-700 dark:text-red-300 bg-red-500/10',
    learning: 'text-slate-600 dark:text-slate-300 bg-slate-500/10',
    done: 'text-emerald-700 dark:text-emerald-300 bg-emerald-500/10',
    no_date: 'text-slate-600 dark:text-slate-300 bg-slate-500/10',
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
            className={`absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-slate-800 ${DOT[verdict.band]}`}
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
            className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONE[verdict.band]} ${className}`}
        >
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t(LABEL[verdict.band])}
        </span>
    );
}

/**
 * A weekly amount as it is read: whole numbers from 3 up ("25 a week"), one
 * decimal below that, where "0.4 a week" and "0 a week" say different things.
 */
export function perWeek(x: number | null | undefined): number {
    if (x == null || !Number.isFinite(x)) return 0;
    return x >= 3 ? Math.round(x) : Math.round(x * 10) / 10;
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
    const date = v.deadline ? shortDay(v.deadline, today) : '';
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
    out.push(t("That is {{n}} a week until {{date}}.", { n: rate(num, v.needed), date }));
    if (v.quietWeeks >= 2) {
        out.push(cards
            ? t("No new card met for {{n}} weeks.", { count: v.quietWeeks, n: num(v.quietWeeks) })
            : t("Nothing closed for {{n}} weeks.", { count: v.quietWeeks, n: num(v.quietWeeks) }));
    } else {
        out.push(t("Your recent pace is {{n}} a week.", { n: rate(num, v.recent) }));
    }
    if (v.band !== 'on_pace') out.push(t("Your best month was {{n}} a week.", { n: rate(num, v.best) }));
    if (v.band === 'out_of_reach' && v.fits != null) {
        out.push(t("At that pace {{fits}} of the {{open}} fit.", { fits: num(v.fits), open: num(v.open) }));
    }
    const range = v.ranges.recent;
    if (v.band === 'on_pace' && range) {
        out.push(t("Likely done between {{from}} and {{to}}.", { from: shortDay(range.from, today), to: shortDay(range.to, today) }));
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
