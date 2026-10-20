import { useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { FeedHeaderData } from '../../types';
import { parseDate } from '../../utils/tree';
import TodayActivityModal from './TodayActivityModal';
import { CalendarClock, CheckCircle2, Clock, RefreshCw, Target } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { uiLocale } from '../../utils/locale';
import { useStudyTimeToday } from '../../hooks/useStudyClock';
import { useDuration } from '../studyTime/StudyTime';
import { IconButton } from '../ui/Button';
// One chip, whether it counts or navigates: the row must stay one line tall on
// a phone, so the touch rule is met by the header's own padding (see `Chip`).
import { Chip } from '../ui/Chip';

interface Props {
    header: FeedHeaderData;
    loading: boolean;
}


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
    const studiedToday = useStudyTimeToday();
    const duration = useDuration();

    // The interface locale, not the device locale: the date is read under chrome in
    // the language the reader chose, and a Dutch date under English labels (or
    // the reverse) reads as a bug.
    const dateLabel = parseDate(header.date).toLocaleDateString(uiLocale(), {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
    });
    const { stats, deadline } = header;
    const accuracyPct = stats.accuracyToday != null ? Math.round(stats.accuracyToday * 100) : null;

    // When the row runs out of room, whole chips go, least useful first —
    // never the LAST chip cut mid-word. The deadline chip is last in the row, so
    // in a language with long unit words it would be the one clipped: its project
    // name shrinking to nothing and "· 457 дн. осталось" cut to "· 457 д".
    // `data-drop` is the order chips leave in: 1 the cards count (already
    // inside "N done" and the day's ledger) — also when the deadline's name
    // has been squeezed below two characters — then 2 the accuracy chip, on
    // overflow only. Measured on the row itself, so it holds in every language
    // and at every `ui_scale`.
    const chipRowRef = useRef<HTMLDivElement>(null);
    const deadlineNameRef = useRef<HTMLSpanElement>(null);
    useLayoutEffect(() => {
        const row = chipRowRef.current;
        if (!row) return;
        const fit = () => {
            const chips = [...row.querySelectorAll<HTMLElement>('[data-drop]')]
                .sort((a, b) => Number(a.dataset.drop) - Number(b.dataset.drop));
            chips.forEach(el => { el.style.display = ''; });
            const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
            const overflowing = () => row.scrollWidth > row.clientWidth + 1;
            const nameSqueezed = () => {
                const name = deadlineNameRef.current;
                return !!name && name.scrollWidth > name.clientWidth && name.clientWidth < 1.5 * rem;
            };
            for (const el of chips) {
                const needsRoom = overflowing() || (el.dataset.drop === '1' && nameSqueezed());
                if (!needsRoom) break;
                el.style.display = 'none';
            }
        };
        fit();
        const observer = new ResizeObserver(fit);
        observer.observe(row);
        return () => observer.disconnect();
    });

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

                    <div ref={chipRowRef} className="order-last sm:order-none basis-full sm:basis-auto sm:flex-1 min-w-0 flex items-center gap-1.5 text-xs overflow-hidden">
                        <Chip
                            onClick={() => setShowActivity(true)}
                            title={t("See everything you did today")}
                            icon={<CheckCircle2 className="w-3 h-3 text-emerald-500" aria-hidden="true" />}
                        >
                            {t("{{itemsDoneToday}} done", { itemsDoneToday: stats.itemsDoneToday })}
                        </Chip>
                        {/* Today's study time, live: it moves as the study clock
                            counts, and opens the same ledger, where the time
                            is broken down by topic and by day of the week. */}
                        {studiedToday != null && studiedToday > 0 && (
                            <Chip
                                onClick={() => setShowActivity(true)}
                                title={t("Time studied today — see where it went")}
                                data-drop="3"
                                icon={<Clock className="w-3 h-3 text-accent-fg" aria-hidden="true" />}
                            >
                                {/* Says what it is: "2 min" alone beside "0 done"
                                    was read as the last item's length. */}
                                <span className="tabular-nums">{t("{{time}} studied", { time: duration(studiedToday) })}</span>
                            </Chip>
                        )}
                        {accuracyPct != null && (
                            <Chip
                                onClick={() => setShowActivity(true)}
                                data-drop="2"
                                title={t("{{accuracyPct}}% correct today — see which", { accuracyPct })}
                                icon={<Target className="w-3 h-3 text-accent-fg" aria-hidden="true" />}
                            >
                                {accuracyPct}%<span className="hidden sm:inline">{t("correct")}</span>
                            </Chip>
                        )}
                        {stats.cardsReviewedToday > 0 && (
                            <Chip
                                onClick={() => setShowActivity(true)}
                                title={t("See the cards you reviewed today")}
                                className="hidden sm:inline-flex"
                                data-drop="1"
                            >
                                {t("{{cardsReviewedToday}} cards", { count: stats.cardsReviewedToday, cardsReviewedToday: stats.cardsReviewedToday })}
                            </Chip>
                        )}
                        {deadline && (() => {
                            // The chip picks the project under the MOST time pressure
                            // (worst pace, then most days behind, then soonest
                            // deadline). Showing days-LEFT regardless would bury the
                            // reason it is amber: "30d" reads as relaxed
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
                            <Chip
                                onClick={() => openProject(deadline.projectId)}
                                tone={deadline.paceStatus === 'critical' ? 'red' : deadline.paceStatus === 'falling_behind' ? 'amber' : 'neutral'}
                                shrink
                                title={t("{{tooltip}} — open the project", { tooltip })}
                                icon={<CalendarClock className="w-3 h-3 shrink-0" aria-hidden="true" />}
                            >
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: deadline.color }} aria-hidden="true" />
                                <span ref={deadlineNameRef} className="truncate">{shortProjectName(deadline.name)}</span>
                                <span className="shrink-0">· {metric}</span>
                            </Chip>
                            );
                        })()}
                    </div>

                    <IconButton
                        size="sm"
                        onClick={() => loadFeed()}
                        label={t("Rebuild the feed")}
                        className="ml-auto sm:ml-0 -mr-1"
                        icon={<RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />}
                    />
                </div>
            </div>
        </div>

        {showActivity && (
            <TodayActivityModal date={header.date} onClose={() => setShowActivity(false)} />
        )}
        </>
    );
}
