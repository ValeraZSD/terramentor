import type { DeckData } from '../../types';
import { fmt } from './deckPalette';
import { useTranslation } from 'react-i18next';
import { uiLocale } from '../../utils/locale';
import { addDays, parseDate, todayStr } from '../../utils/tree';

/**
 * What is coming back, day by day.
 *
 * Anki's forecast is the one chart on its statistics screen that changes
 * behaviour, because it is how a learner discovers that answering "Easy" to
 * everything today builds a wall three weeks out. It is a chart of a decision
 * they are about to make, not a record of one they made.
 *
 * Drawn as bars in DOM rather than a chart library: fourteen numbers do not
 * justify a dependency, and a `div` with a height is legible to a screen reader
 * when it carries its own label. The table underneath is not a fallback — the
 * bars are the summary and the numbers are the answer, which is why every bar
 * shows its count on hover AND the busiest day is called out in words.
 */
export default function DeckForecast({ forecast }: { forecast: DeckData['forecast'] }) {
    const { t } = useTranslation();
    const days = forecast.days;
    const peak = Math.max(1, ...days);
    const total = days.reduce((a, b) => a + b, 0);

    // THE BUCKETS ARE UTC DAYS, so the labels have to be too. `server/decks.js`
    // groups on `julianday(date(f.next_review)) - julianday(date(now))`, i.e.
    // whole UTC days — while this built its labels from a LOCAL `new Date()`
    // stepped by `setDate` and printed them without a time zone. East of
    // Greenwich, between local midnight and UTC midnight, the two disagree by a
    // day and every bar's tooltip names the wrong weekday. `todayStr` /
    // `addDays` / `parseDate` are the app's UTC date arithmetic (utils/tree.ts)
    // and `timeZone: 'UTC'` is what the rest of `src/` formats study dates with.
    const today = todayStr();
    const labelFor = (i: number) => parseDate(addDays(today, i));

    if (total === 0 && forecast.beyond === 0) {
        return (
            <p className="text-sm text-slate-500 dark:text-slate-400">
                {t("Nothing is scheduled to come back yet — the forecast fills in as you study.")}
            </p>
        );
    }

    return (
        <div>
            {/* `items-stretch`, not `items-end`. Aligning the columns to the end
                sizes each one to its content, and a percentage height against a
                parent with no definite height resolves to zero — so every day
                with cards due drew a 0px bar while every EMPTY day drew its 2px
                hairline, which is the chart inverted. The columns are stretched
                to the full 96px and each bar sits at the bottom of its own
                column instead. */}
            <div className="flex items-stretch gap-1 sm:gap-1.5" style={{ height: 96 }}>
                {days.map((n, i) => {
                    const d = labelFor(i);
                    const label = `${d.toLocaleDateString(uiLocale(), { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}: ${t("{{fmt}} cards", { count: n, fmt: fmt(n) })}`;
                    return (
                        <div key={i} className="flex min-w-0 flex-1 flex-col justify-end" title={label}>
                            {/* A day with nothing due still draws a hairline, so
                                the axis reads as fourteen days rather than as a
                                ragged run of bars with gaps of unknown width. */}
                            <div
                                className={`w-full rounded-t ${n > 0 ? 'bg-accent' : 'bg-slate-200 dark:bg-slate-700'}`}
                                style={{ height: n > 0 ? `${Math.max(6, (n / peak) * 100)}%` : 2 }}
                                role="img"
                                aria-label={label}
                            />
                        </div>
                    );
                })}
            </div>

            <div className="mt-1.5 flex justify-between text-[11px] text-slate-500 dark:text-slate-400">
                <span>{t("Today")}</span>
                <span>{t("In {{length}} days", { count: days.length, length: days.length })}</span>
            </div>

            <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
                <span className="font-semibold text-slate-900 dark:text-white tabular-nums">{fmt(total)}</span>
                {' '}{t("reviews due in the next {{length}} days", { count: total, length: days.length })}
                {forecast.beyond > 0 && (
                    <>{t(", and")}{' '}<span className="font-semibold tabular-nums">{fmt(forecast.beyond)}</span> {t("further out")}</>
                )}.
            </p>
        </div>
    );
}
