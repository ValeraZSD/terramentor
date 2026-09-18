import type { DeckData } from '../../types';
import { DECK_STATES, PROGRESS_ORDER, STATE, fmt } from './deckPalette';
import { useTranslation } from 'react-i18next';

/**
 * The whole deck as one bar: how much of it is still a stranger, how much is
 * being learned, how much is holding.
 *
 * This replaces a percentage. "0% complete" was the curriculum dashboard's
 * answer for a deck, and it was both true and useless — a deck is never
 * "complete", it is a body of material in four states at once, and the shape of
 * those four is the actual answer to "how am I doing". A single number cannot
 * carry it: 1,400 new and 100 mature is a different situation from 700 new and
 * 800 young, and both are "0% complete".
 *
 * Segments below a visible width are floored rather than dropped, because a
 * segment that disappears reads as "there are none of those" when there are six
 * — and six mature cards on day one is exactly the number a learner is looking
 * for. The legend prints every count regardless, so nothing depends on the bar.
 *
 * It fills earned-first, like every other bar on this page. Lifecycle order —
 * new, learning, young, mature — is the natural way to *list* the four and is
 * what the legend below still uses, but as a fill it puts the green on the
 * right, and a stage bar directly underneath puts it on the left (its ticks are
 * in deck order, and the cards you have studied are the ones at the front). Two
 * bars of the same four colours filling opposite ways on one screen is a page
 * that has to be re-read to be believed.
 */
export default function DeckBar({ totals, matureDays }: { totals: DeckData['totals']; matureDays: number }) {
    const { t } = useTranslation();
    const total = Math.max(1, totals.cards);
    const segments = PROGRESS_ORDER
        .map(key => ({ ...STATE[key], count: totals[key] ?? 0 }))
        .filter(s => s.count > 0);

    return (
        <div>
            <div
                className="flex h-3 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
                role="img"
                aria-label={segments.map(s => `${fmt(s.count)} ${t(s.label)}`).join(', ') || t("No cards")}
            >
                {segments.map(s => (
                    <div
                        key={s.key}
                        className={s.bar}
                        style={{ width: `${Math.max(1.5, (s.count / total) * 100)}%` }}
                    />
                ))}
            </div>

            {/* Sized by the CONTAINER, not the viewport: with the detail panel
                open beside it the dashboard is a narrow column on a wide
                screen, and four fixed columns printed "4,2890" as one number. */}
            <dl className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-x-4 gap-y-2">
                {DECK_STATES.map(s => (
                    <div key={s.key} className="min-w-0">
                        <dt className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                            <span className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} aria-hidden="true" />
                            <span className="truncate">{t(s.label)}</span>
                        </dt>
                        <dd className={`mt-0.5 text-lg font-semibold tabular-nums ${s.text}`}>
                            {fmt(totals[s.key] ?? 0)}
                        </dd>
                        <dd className="text-[11px] leading-tight text-slate-500 dark:text-slate-400">
                            {s.key === 'mature' ? t("{{matureDays}}+ days between reviews", { matureDays }) : t(s.hint)}
                        </dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}
