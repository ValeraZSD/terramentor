/**
 * What the finished-project screen SAYS — chosen once, drawn twice.
 *
 * The screen and the downloadable poster are two shapes of the same facts
 * (`certificate.ts` explains why they are not the same object), and the fastest
 * way for two shapes to start lying about one thing is to let each pick its own
 * numbers. So the picking happens here: which statistics are worth a tile, in
 * what order, what the sentence under them says, and what the caption under the
 * chart says. Both surfaces render the result and neither decides anything.
 *
 * Every rule in here is a rule about ABSENCE. A project with no cards has no
 * "cards met" tile rather than a tile reading 0; a project nobody ever answered
 * a question in has no accuracy, because 0% and "never asked" are different
 * facts and only one of them is true. That is why the tile list is built rather
 * than laid out: the grid has to hold two tiles as well as it holds six.
 */
import type { ProjectCompletion } from '../../types';
import { k } from '../../i18n';

export interface SummaryStat {
    /** Stable, for keys and for the gate to name a tile without its label. */
    key: string;
    value: string;
    label: string;
}

/** Above this the tiles stop being a glance and start being a table. */
export const MAX_STATS = 6;

export interface SummaryText {
    t: (key: string, vars?: Record<string, unknown>) => string;
    num: (value: number) => string;
    /** A date, long form, in the reader's language. */
    date: (day: string) => string;
    /** A date, short form, for a chart axis. */
    shortDate: (day: string) => string;
}

/**
 * The tiles, in priority order, capped at six.
 *
 * The order is what a person asks in: how much of the thing did I get through,
 * then how much work was that, then how well did it go, then how long did it
 * take. Streaks and proven-topic counts come last because they are the parts a
 * learner is least likely to be able to act on.
 */
export function completionStats(data: ProjectCompletion, text: SummaryText): SummaryStat[] {
    const { t, num } = text;
    const { topics, cards } = data.work;
    const e = data.effort;
    const out: SummaryStat[] = [];
    const add = (key: string, when: boolean, value: string, label: string) => {
        if (when && out.length < MAX_STATS) out.push({ key, value, label });
    };
    // "1 days studied" is the kind of thing that makes a keepsake look
    // machine-made. Both forms are written out because English loads no locale
    // file — the key IS the string, so i18next's plural suffixes never fire here
    // (see src/i18n/index.ts and memory english-is-the-key-no-plurals).
    // The two forms are wrapped in `k()` so the extraction tools can see them:
    // they scan for a literal inside `t(...)`/`k(...)`, and a string passed
    // through a helper is invisible to them — which silently orphaned five keys
    // the first time this was written.
    const plural = (n: number, one: string, many: string) => t(n === 1 ? one : many);

    // The count is topics PROVEN, not topics in the project: a course finished
    // with eleven topics skipped did not finish 48 of them, and the skipped ones
    // are named in the sentence below rather than folded into a bigger number.
    add('topics', topics.total > 0, num(topics.completed), plural(topics.completed, k('topic finished'), k('topics finished')));
    add('cards', cards.total > 0, num(cards.met), plural(cards.met, k('card met'), k('cards met')));
    add('reviews', e.reviews > 0, num(e.reviews), plural(e.reviews, k('card review'), k('card reviews')));
    add('answers', e.answers > 0, num(e.answers), plural(e.answers, k('question answered'), k('questions answered')));
    add('accuracy', e.accuracy != null, `${Math.round((e.accuracy ?? 0) * 100)}%`, t('answered correctly'));
    add('studyDays', !!data.span, num(data.span?.studyDays ?? 0), plural(data.span?.studyDays ?? 0, k('day studied'), k('days studied')));
    add('proven', data.mastery.proven > 0, num(data.mastery.proven), plural(data.mastery.proven, k('topic proven'), k('topics proven')));
    add('streak', (data.span?.longestStreak ?? 0) > 1, num(data.span?.longestStreak ?? 0), t('days in a row'));
    return out;
}

/**
 * The sentence under the tiles: how long it took, and how that sat against the
 * plan. Two sentences at most, and the second only when there was a deadline to
 * be early or late for.
 */
export function completionStory(data: ProjectCompletion, text: SummaryText): string {
    const { t, num, date } = text;
    const span = data.span;
    const parts: string[] = [];

    if (span) {
        if (span.calendarDays <= 1) {
            parts.push(t('All of it in a single day, {{date}}.', { date: date(span.lastDay) }));
        } else if (span.studyDays >= span.calendarDays) {
            parts.push(t('{{days}} days from {{first}} to {{last}} — and you studied on every one of them.', { count: span.calendarDays,
                days: num(span.calendarDays), first: date(span.firstDay), last: date(span.lastDay),
            }));
        } else {
            parts.push(t('{{days}} days from {{first}} to {{last}}, and you studied on {{studyDays}} of them.', { count: span.calendarDays,
                days: num(span.calendarDays), first: date(span.firstDay), last: date(span.lastDay),
                studyDays: num(span.studyDays),
            }));
        }
    }

    const schedule = data.schedule;
    if (schedule) {
        // Late is stated, never scolded: the date was a plan, and a plan that
        // slipped is the ordinary way a course gets finished at all.
        if (schedule.daysEarly > 0) {
            parts.push(t('You finished {{days}} days before the date you set.', { count: schedule.daysEarly, days: num(schedule.daysEarly) }));
        } else if (schedule.daysEarly < 0) {
            parts.push(t('That is {{days}} days past the date you set.', { count: -schedule.daysEarly, days: num(-schedule.daysEarly) }));
        } else {
            parts.push(t('Exactly on the date you set.'));
        }
    }

    return parts.join(' ');
}

/** The line under the chart: the busiest day, the longest run, or both. */
export function completionCaption(data: ProjectCompletion, text: SummaryText): string {
    const { t, num, shortDate } = text;
    const span = data.span;
    if (!span) return '';
    const parts: string[] = [];
    // The busiest of one day is not a fact about anything. Two days at least,
    // or the line says nothing the sentence below has not already said.
    if (span.bestDay.count > 0 && span.studyDays > 1) {
        // Hoisted, and it has to be: `tools/lib/i18nKeys.mjs` reads the word
        // `count` anywhere in the options object as "this key has plural forms",
        // and `span.bestDay.count` inline was enough to make it demand
        // `_one`/`_other` — forms that can never fire in English, because
        // English loads no resources and the key IS the string.
        const busiest = num(span.bestDay.count);
        parts.push(t('Busiest day {{date}} — {{done}} things done', { count: busiest, date: shortDate(span.bestDay.date), done: busiest }));
    }
    if (span.longestStreak > 1) {
        parts.push(t('{{days}} days in a row at the longest', { count: span.longestStreak, days: num(span.longestStreak) }));
    }
    return parts.join(' · ');
}

/**
 * The honest footnote, or nothing.
 *
 * A topic closed as "skipped" counts toward 100% — that is the progress rule,
 * and deliberately so — but it was not proven, and a summary that folded those
 * into "48 topics finished" would be the one number on this screen that the
 * learner knows is wrong.
 */
export function completionFootnote(data: ProjectCompletion, text: SummaryText): string {
    const { t, num } = text;
    const skipped = data.work.topics.skipped;
    if (skipped <= 0) return '';
    return t('{{skipped}} of them were skipped rather than proven.', { skipped: num(skipped) });
}

/** "Course complete" or "Deck complete" — a collection of cards is not a course. */
export function completionEyebrow(data: ProjectCompletion, text: SummaryText): string {
    return data.work.topics.total > 0 ? text.t('Course complete') : text.t('Deck complete');
}
