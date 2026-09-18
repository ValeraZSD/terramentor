import { useState } from 'react';
import { useStore } from '../../store';
import { FeedHeaderData } from '../../types';
import { parseDate } from '../../utils/tree';
import TodayActivityModal from './TodayActivityModal';
import { CalendarClock, CheckCircle2, RefreshCw, Target } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { uiLocale } from '../../utils/locale';

interface Props {
    header: FeedHeaderData;
    loading: boolean;
}

/** One chip, whether it counts or navigates. `min-h-0` deliberately: this row
 *  must stay one line tall on a phone, so the 44px touch rule is met by the
 *  header's own padding rather than by growing the chips. */
const CHIP = 'inline-flex min-h-6 items-center gap-1 px-2.5 py-0.5 rounded-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 shrink-0 whitespace-nowrap transition hover:border-slate-300 dark:hover:border-slate-500 hover:text-slate-900 dark:hover:text-white';

/** Separators projects title themselves with: "Physics — Higher Level / Mock Exam". */
const TITLE_TAIL = /\s+[—–|/]\s+|\s+-\s+|:\s+/;

/** First segment of a project name, so a chip ellipsis never eats a word mid-way. */
function shortProjectName(name: string): string {
    const head = name.split(TITLE_TAIL)[0]?.trim();
    return head && head.length >= 3 ? head : name;
}

/**
 * Slim sticky strip above the feed: date, today's activity, the most-pressed
 * deadline. One chip row — it must not wrap on a phone.
 * Deliberately no lists, no per-project breakdown — the feed IS the plan.
 *
 * **Every chip is a control**, because each one is a counter over records the
 * app still holds and a number you cannot open is a number you cannot check.
 * The activity chips open today's ledger (every card, question, lesson and
 * closed topic, with its timestamp); the deadline chip opens the project it is
 * warning about — it named a project and then asked the reader to go and find
 * it, which is the one thing the chip already knew.
 */
export default function FeedHeader({ header, loading }: Props) {
    const { t } = useTranslation();
    const loadFeed = useStore(s => s.loadFeed);
    const openProject = useStore(s => s.openProject);
    const [showActivity, setShowActivity] = useState(false);

    // The interface locale, not the device locale: the date is read under chrome in
    // the language the reader chose, and a Dutch date under English labels (or
    // the reverse) reads as a bug.
    const dateLabel = parseDate(header.date).toLocaleDateString(uiLocale(), {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
    });
    const { stats, deadline } = header;
    const accuracyPct = stats.accuracyToday != null ? Math.round(stats.accuracyToday * 100) : null;

    return (
        // The dialog is a SIBLING of the sticky strip, never a child of it.
        // `backdrop-blur-sm` is a backdrop-filter, and like a transform that
        // makes the element the containing block for every `position: fixed`
        // descendant — so a modal mounted inside it is centred in a 76px-tall
        // strip instead of the viewport, which drew it clipped and half
        // off-screen. Same trap as a fixed dialog inside a transformed ancestor.
        <>
        <div className="sticky top-0 z-10 bg-slate-100/95 dark:bg-slate-900/95 backdrop-blur-sm border-b border-slate-200/60 dark:border-slate-700/60">
            <div className="max-w-2xl mx-auto px-3 sm:px-4 py-2">
                {/* One line from `sm` up (date · chips · reload). Below that the chips
                    drop to their own line via order-last + basis-full, never wrapping among themselves. */}
                <div className="flex flex-wrap sm:flex-nowrap items-center gap-x-2 sm:gap-x-3 gap-y-1">
                    <h2 className="text-sm sm:text-lg font-bold text-slate-900 dark:text-white truncate shrink-0 max-w-full">{dateLabel}</h2>

                    <div className="order-last sm:order-none basis-full sm:basis-auto sm:flex-1 min-w-0 flex items-center gap-1.5 text-xs overflow-hidden">
                        <button
                            onClick={() => setShowActivity(true)}
                            title={t("See everything you did today")}
                            className={CHIP}
                        >
                            <CheckCircle2 className="w-3 h-3 text-emerald-500" aria-hidden="true" />
                            {t("{{itemsDoneToday}} done", { itemsDoneToday: stats.itemsDoneToday })}
                        </button>
                        {accuracyPct != null && (
                            <button
                                onClick={() => setShowActivity(true)}
                                className={CHIP}
                                title={t("{{accuracyPct}}% correct today — see which", { accuracyPct })}
                            >
                                <Target className="w-3 h-3 text-accent-fg" aria-hidden="true" />
                                {accuracyPct}%<span className="hidden sm:inline">{t("correct")}</span>
                            </button>
                        )}
                        {stats.cardsReviewedToday > 0 && (
                            <button
                                onClick={() => setShowActivity(true)}
                                title={t("See the cards you reviewed today")}
                                className={`hidden sm:inline-flex ${CHIP}`}
                            >
                                {t("{{cardsReviewedToday}} cards", { cardsReviewedToday: stats.cardsReviewedToday })}
                            </button>
                        )}
                        {deadline && (() => {
                            // The chip picks the project under the MOST time pressure
                            // (worst pace, then most days behind, then soonest
                            // deadline). It used to show days-LEFT regardless, which
                            // buried the reason it was amber: "30d" reads as relaxed
                            // while the colour is shouting. Behind → show how far
                            // behind, which is the number that explains the colour and
                            // the one the learner can act on; on track → days left,
                            // which is then the only interesting fact about it.
                            const behind = deadline.daysBehind > 0 && deadline.paceStatus !== 'on_track';
                            // An English template literal handed to t() as a
                            // {{placeholder}} translates the frame and never the
                            // sentence: the chip would read "22d behind" inside a
                            // fully Ukrainian header. The day counts are composed
                            // through the shared plural key so a language with
                            // more than two forms gets them.
                            const metric = behind
                                ? t("{{daysBehind}}d behind", { daysBehind: deadline.daysBehind })
                                : t("{{daysLeft}}d left", { daysLeft: deadline.daysLeft });
                            const daysLeftText = t("{{count}} days", { count: deadline.daysLeft });
                            const tooltip = behind
                                ? t("{{name}} — {{behindText}} behind schedule, {{daysLeftText}} until the deadline", {
                                    name: deadline.name,
                                    behindText: t("{{count}} days", { count: deadline.daysBehind }),
                                    daysLeftText,
                                })
                                : t("{{name}} — on track, {{daysLeftText}} left", { name: deadline.name, daysLeftText });
                            return (
                            <button
                                onClick={() => openProject(deadline.projectId)}
                                className={`inline-flex min-h-6 items-center gap-1 min-w-0 px-2.5 py-0.5 rounded-full border whitespace-nowrap transition hover:brightness-95 dark:hover:brightness-125 ${deadline.paceStatus === 'critical'
                                    ? 'bg-red-50 dark:bg-red-900/15 border-red-200 dark:border-red-800/50 text-red-700 dark:text-red-300'
                                    : deadline.paceStatus === 'falling_behind'
                                        ? 'bg-amber-50 dark:bg-amber-900/15 border-amber-200 dark:border-amber-800/50 text-amber-700 dark:text-amber-300'
                                        : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}`}
                                title={t("{{tooltip}} — open the project", { tooltip })}
                            >
                                <CalendarClock className="w-3 h-3 shrink-0" aria-hidden="true" />
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: deadline.color }} aria-hidden="true" />
                                <span className="truncate">{shortProjectName(deadline.name)}</span>
                                <span className="shrink-0">· {metric}</span>
                            </button>
                            );
                        })()}
                    </div>

                    <button
                        onClick={() => loadFeed()}
                        title={t("Rebuild the feed")}
                        aria-label={t("Rebuild the feed")}
                        className="ml-auto sm:ml-0 p-1.5 -mr-1 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-slate-700 dark:hover:text-slate-200 transition shrink-0"
                    >
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                </div>
            </div>
        </div>

        {showActivity && (
            <TodayActivityModal date={header.date} onClose={() => setShowActivity(false)} />
        )}
        </>
    );
}
