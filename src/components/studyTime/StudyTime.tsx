/**
 * The study clock's record, drawn: on a topic, on a project, on a day.
 *
 * Every figure here is time the clock COUNTED (src/utils/studyTime.ts) — a
 * lesson, a question, a card or a check in front of the learner while they
 * were using the app — and every place that shows one also says how it was
 * counted, in one sentence, because a number the reader cannot check is a
 * number they cannot trust. A course older than the clock says "counted
 * since", so part of its time is never passed off as all of it.
 *
 * Nothing is drawn as zero. A topic never studied says so in words; a project
 * with no time has no section; a day with none has an empty bar, not "0 min".
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { useStore } from '../../store';
import { k } from '../../i18n';
import { dateRangeLabel, uiLocale } from '../../utils/locale';
import { formatStudyTime, STUDY_ACTIVITIES, type StudyActivity } from '../../utils/studyTime';
import { flushStudyTime } from '../../hooks/useStudyClock';
import type { NodeStudyTime, ProjectStudyTime, StudyTimeByActivity } from '../../types';
import { Explain } from '../ui/Disclosure';
import { FOCUS_RING, cx } from '../ui/vocabulary';
import { DashboardSection } from '../dashboard/DashboardSection';

const ACTIVITY_LABEL: Record<StudyActivity, string> = {
    reading: k("Reading"),
    questions: k("Questions"),
    cards: k("Cards"),
    checks: k("Checks"),
    paper: k("Written work"),
};

/**
 * The rule, said once wherever a figure is shown, WITH its numbers
 * (`PAUSE_LIMIT_MS`): "a few minutes" begs the question — a figure you cannot
 * check against a rule is one you cannot trust.
 */
export const HOW_COUNTED = k("Only active time counts. A pause longer than 3 minutes counts as nothing (2 minutes on cards, 5 on questions and tests, 30 on written work), and so does time in another window.");

/** Milliseconds → "1 hr, 12 min" in the interface language. */
export function useDuration(): (ms: number) => string {
    const { t, i18n } = useTranslation();
    return useCallback(
        (ms: number) => formatStudyTime(ms, uiLocale(), t("less than a minute")),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [t, i18n.language],
    );
}

/** A UTC day as "Oct 3" (or the locale's equivalent), in the interface language. */
export function useShortDay(): (day: string) => string {
    const { i18n } = useTranslation();
    return useMemo(() => {
        const locale = uiLocale();
        return (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(locale, {
            day: 'numeric', month: 'short', timeZone: 'UTC',
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [i18n.language]);
}

/**
 * "Reading 40 min · Questions 12 min" — what the time went on, largest first.
 * Shown for one activity too: "59 min" beside counters reading 0 is answered
 * by "Reading 59 min" and by nothing else on the screen.
 *
 * Each pair keeps its words together; the separators sit BETWEEN them, so a
 * phone wraps at a separator (inside the pair it ran past the card's edge).
 */
export function ActivitySplit({ byActivity }: { byActivity: StudyTimeByActivity }) {
    const { t } = useTranslation();
    const duration = useDuration();
    const parts = STUDY_ACTIVITIES
        .filter(a => (byActivity[a] ?? 0) > 0)
        .sort((a, b) => (byActivity[b] ?? 0) - (byActivity[a] ?? 0));
    if (!parts.length) return null;
    return (
        <p className="text-xs text-slate-600 dark:text-slate-300">
            {parts.map((a, i) => (
                <span key={a}>
                    {i > 0 && <span className="text-slate-400" aria-hidden="true"> · </span>}
                    <span className="whitespace-nowrap">
                        {t(ACTIVITY_LABEL[a])} <span className="tabular-nums">{duration(byActivity[a] ?? 0)}</span>
                    </span>
                </span>
            ))}
        </p>
    );
}

/**
 * One bar per day, its height the day's time against the busiest shown.
 *
 * With `onPick` each bar is a button that opens its day (the ledger's week);
 * without, a picture with the value in its name (the dashboard's fortnight).
 * `weekdays` labels each bar with its short weekday name, for a week; otherwise
 * the axis names the first and last day.
 */
export function DayBars({ days, selected, onPick, weekdays = false }: {
    days: { day: string; ms: number }[];
    selected?: string;
    onPick?: (day: string) => void;
    weekdays?: boolean;
}) {
    const { t, i18n } = useTranslation();
    const duration = useDuration();
    const shortDay = useShortDay();
    const weekday = useMemo(() => {
        const locale = uiLocale();
        // 'short', not 'narrow': "S S" and "T T" left the reader to work
        // out which Saturday-or-Sunday bar was which.
        return (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [i18n.language]);
    const max = Math.max(...days.map(d => d.ms), 1);
    const label = (d: { day: string; ms: number }) => d.ms > 0
        ? t("{{date}}: {{time}}", { date: shortDay(d.day), time: duration(d.ms) })
        : t("{{date}}: no study time", { date: shortDay(d.day) });

    const peak = Math.max(...days.map(d => d.ms), 0);

    return (
        <div>
            {/* The scale: a hairline at the top of the plot, labelled with the
                tallest bar's value, as an axis tick would be — bars with no
                number on them cannot be read. Nothing when the period is
                empty. */}
            {peak > 0 && (
                <div className="flex items-center gap-1.5" aria-hidden="true">
                    <span className="h-px flex-1 border-t border-dashed border-slate-300 dark:border-slate-600" />
                    <span className="text-2xs tabular-nums text-slate-500 dark:text-slate-400">{duration(peak)}</span>
                </div>
            )}
            <div className="flex h-16 items-end gap-1" role={onPick ? 'group' : 'img'} aria-label={onPick ? undefined : days.map(label).join(', ')}>
                {days.map(d => {
                    const on = selected === d.day;
                    // A day with time is never thinner than a sliver; a day
                    // without is a hairline, so the gap reads as a day, not a hole.
                    const fill = d.ms > 0
                        ? <span className={cx('block w-full rounded-t-sm bg-accent', selected && !on && 'opacity-50 dark:opacity-70')} style={{ height: `${Math.max(6, (d.ms / max) * 100)}%` }} />
                        : <span className="block h-px w-full bg-slate-300 dark:bg-slate-600" />;
                    return onPick ? (
                        <button
                            key={d.day}
                            type="button"
                            data-bar="study-day"
                            onClick={() => onPick(d.day)}
                            aria-pressed={on}
                            aria-label={label(d)}
                            title={label(d)}
                            className={cx('flex h-full min-w-6 flex-1 flex-col justify-end rounded-sm', FOCUS_RING)}
                        >
                            {fill}
                        </button>
                    ) : (
                        <span key={d.day} title={label(d)} className="flex h-full flex-1 flex-col justify-end" aria-hidden="true">
                            {fill}
                        </span>
                    );
                })}
            </div>
            {weekdays ? (
                <div className="mt-1 flex gap-1" aria-hidden="true">
                    {days.map(d => (
                        <span key={d.day} className={cx('min-w-6 flex-1 text-center text-2xs',
                            selected === d.day ? 'font-semibold text-slate-900 dark:text-white' : 'text-slate-500 dark:text-slate-400')}>
                            {weekday(d.day)}
                        </span>
                    ))}
                </div>
            ) : days.length > 1 && (
                <div className="mt-1 flex justify-between text-2xs text-slate-500 dark:text-slate-400" aria-hidden="true">
                    <span>{shortDay(days[0].day)}</span>
                    <span>{shortDay(days[days.length - 1].day)}</span>
                </div>
            )}
        </div>
    );
}

/** A topic's share of some time: its name (and course), its time; pressing it opens the topic. */
export function TimeRow({ title, context, color, ms, onOpen }: {
    title: string;
    context?: string;
    color?: string | null;
    ms: number;
    onOpen: () => void;
}) {
    const { t } = useTranslation();
    const duration = useDuration();
    return (
        <li>
            <button
                type="button"
                data-row="study-time"
                onClick={onOpen}
                title={t("{{nodeTitle}} — open the topic", { nodeTitle: title })}
                className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-slate-50 dark:hover:bg-slate-900/40 touch:min-h-11', FOCUS_RING)}
            >
                {color !== undefined && (
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color || '#94a3b8' }} aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm text-slate-800 dark:text-slate-100">
                    {title}
                    {context && <span className="text-xs text-slate-500 dark:text-slate-400"> · {context}</span>}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-slate-600 dark:text-slate-300">{duration(ms)}</span>
            </button>
        </li>
    );
}

/**
 * The topic panel's line: how long this topic (or everything under this
 * section) has taken, what doing, and on which days — the days behind a
 * disclosure, because they are what a reader checks, not what they glance at.
 */
export function TopicStudyTime({ nodeId }: { nodeId: number }) {
    const { t } = useTranslation();
    const duration = useDuration();
    const shortDay = useShortDay();
    const [data, setData] = useState<NodeStudyTime | null>(null);

    useEffect(() => {
        let cancelled = false;
        setData(null);
        // Send what the clock is still holding first, or a topic studied a
        // minute ago opens showing the time from before that minute.
        flushStudyTime()
            .then(() => api.getNodeStudyTime(nodeId))
            .then(d => { if (!cancelled) setData(d); })
            .catch(() => { /* a panel line, not worth a toast */ });
        return () => { cancelled = true; };
    }, [nodeId]);

    if (!data) return null;
    if (data.totalMs <= 0) {
        return (
            <p className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {data.predates && data.countedSince
                    ? t("No study time since {{date}}", { date: shortDay(data.countedSince) })
                    : t("No study time yet")}
            </p>
        );
    }

    return (
        <div className="space-y-1.5 rounded-lg border border-slate-200/60 bg-slate-50 p-3 dark:border-slate-700/60 dark:bg-slate-900/40">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                <span className="flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-300">
                    <Clock className="h-4 w-4 shrink-0 text-accent-fg" aria-hidden="true" />
                    {t("Time studied")}
                </span>
                <span className="font-semibold tabular-nums text-slate-900 dark:text-white">{duration(data.totalMs)}</span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                    {t("on {{count}} days", { count: data.studyDays })}
                    {data.lastDay && <> · {t("last studied {{date}}", { date: shortDay(data.lastDay) })}</>}
                </span>
            </p>
            <ActivitySplit byActivity={data.byActivity} />
            {data.predates && data.countedSince && (
                <p className="text-xs text-slate-500 dark:text-slate-400">{t("Counted since {{date}}", { date: shortDay(data.countedSince) })}</p>
            )}
            <Explain summary={t("Each day")}>
                <ul className="space-y-0.5 text-sm">
                    {data.days.map(d => (
                        <li key={d.day} className="flex justify-between gap-4">
                            <span className="text-slate-600 dark:text-slate-300">{shortDay(d.day)}</span>
                            <span className="tabular-nums text-slate-800 dark:text-slate-100">{duration(d.ms)}</span>
                        </li>
                    ))}
                </ul>
                {data.moreDays > 0 && (
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("and {{count}} earlier days", { count: data.moreDays })}</p>
                )}
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{t(HOW_COUNTED)}</p>
            </Explain>
        </div>
    );
}

/**
 * A project's time: the total, the last fortnight day by day, and where it
 * went. Absent until there is some — a section reading "0 min" is a section
 * about nothing.
 */
export function ProjectStudyTimeSection({ projectId, reloadKey }: { projectId: number; reloadKey?: unknown }) {
    const { t } = useTranslation();
    const duration = useDuration();
    const shortDay = useShortDay();
    const openProjectNode = useStore(s => s.openProjectNode);
    const [data, setData] = useState<ProjectStudyTime | null>(null);

    useEffect(() => {
        let cancelled = false;
        flushStudyTime()
            .then(() => api.getProjectStudyTime(projectId))
            .then(d => { if (!cancelled) setData(d); })
            .catch(() => { /* the dashboard goes on without it */ });
        return () => { cancelled = true; };
    }, [projectId, reloadKey]);

    if (!data || data.totalMs <= 0) return null;
    const perDay = data.studyDays > 0 ? data.totalMs / data.studyDays : 0;

    return (
        <DashboardSection icon={Clock} title={t("Time studied")}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <p className="text-2xl font-bold tabular-nums text-slate-900 dark:text-white">{duration(data.totalMs)}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                    {/* "in all": the chart under it is the last fortnight, and
                        without it this total reads as the fortnight's. */}
                    {t("in all")} · {t("on {{count}} days", { count: data.studyDays })}
                    {data.studyDays > 1 && <> · {t("about {{time}} a study day", { time: duration(perDay) })}</>}
                </p>
            </div>
            <div className="mt-1">
                <ActivitySplit byActivity={data.byActivity} />
            </div>

            <p className="mt-4 mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">{t("Last 14 days")}</p>
            <DayBars days={data.recent} />

            {data.topics.length > 0 && (
                <>
                    <p className="mt-4 mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">{t("Where the time went")}</p>
                    <ul className="-mx-2">
                        {data.topics.map(topic => (
                            <TimeRow
                                key={topic.nodeId}
                                title={topic.title}
                                ms={topic.ms}
                                onOpen={() => openProjectNode(projectId, topic.nodeId)}
                            />
                        ))}
                    </ul>
                </>
            )}

            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                {data.predates && data.countedSince && <>{t("Counted since {{date}}", { date: shortDay(data.countedSince) })}. </>}
                {t(HOW_COUNTED)}
            </p>
        </DashboardSection>
    );
}

/**
 * The head of the day's ledger: the day's total, what was finished, the week
 * up to it (each day a button that opens it), and every topic the time went
 * to. It stands on the dialog itself, not in a card of its own: a box around
 * it, with four boxed counters under it, was read as a dashboard kit.
 *
 * `done` is the line of things finished, absent when nothing was; `lead`
 * stands where the total would on a day with nothing at all ("Nothing
 * recorded on this day."), so an empty day is one sentence rather than a
 * dash and zeros. A day with things done but no time leads with `done`.
 */
export function DayStudyTime({ time, day, onPickDay, projectFilter, onOpenTopic, done, lead }: {
    time: import('../../types').TodayActivity['time'];
    day: string;
    onPickDay: (day: string) => void;
    projectFilter: number | null;
    onOpenTopic: (projectId: number, nodeId: number) => void;
    done?: React.ReactNode;
    lead?: React.ReactNode;
}) {
    const { t, i18n } = useTranslation();
    const duration = useDuration();
    // "Last 7 days: 3 hr, 40 min" under the week — the figure a weekly log
    // asks for, NAMED (a date range with a duration after it was read as a
    // caption), with the range itself in the tooltip.
    const week = time.week;
    const weekSum = week.reduce((s, d) => s + d.ms, 0);
    const weekRange = useMemo(() => (week.length
        ? dateRangeLabel(new Date(`${week[0].day}T00:00:00Z`), new Date(`${week[week.length - 1].day}T00:00:00Z`))
        : ''),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [week, i18n.language]);
    const topics = projectFilter == null ? time.topics : time.topics.filter(x => x.projectId === projectFilter);
    const total = topics.reduce((s, x) => s + x.ms, 0);

    return (
        <section>
            {/* Both halves carry a basis, so a narrow dialog WRAPS the week
                under the total; with a zero basis the week was squeezed beside
                the total and moved from one day to the next. The total takes
                three parts of any spare width to the week's one: beside it the
                week stays a strip, under it the week spans the dialog. */}
            <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
                <div className="min-w-0 grow-[3] basis-48">
                    {total > 0 ? (
                        <>
                            <p className="flex flex-wrap items-baseline gap-x-2">
                                <span className="text-3xl font-semibold tabular-nums text-slate-900 dark:text-white">{duration(total)}</span>
                                <span className="text-sm text-slate-500 dark:text-slate-400">{t("studied")}</span>
                            </p>
                            {/* The split is the whole day's; with one course picked it
                                would describe time the list below does not show. */}
                            {projectFilter == null && time.byActivity && (
                                <div className="mt-1"><ActivitySplit byActivity={time.byActivity} /></div>
                            )}
                        </>
                    ) : (lead || done)}
                </div>
                {time.week.some(d => d.ms > 0) && (
                    <div className="grow basis-64">
                        <DayBars days={time.week} selected={day} onPick={onPickDay} weekdays />
                        <p className="mt-1 text-center text-2xs text-slate-500 dark:text-slate-400" title={weekRange}>
                            {weekSum > 0 ? t("Last 7 days: {{time}}", { time: duration(weekSum) }) : t("Last 7 days")}
                        </p>
                    </div>
                )}
            </div>
            {/* Under both halves, not in the total's column: there it wrapped
                item by item beside the week. A day with no time puts it where
                the total would be instead. */}
            {total > 0 && done && <div className="mt-4">{done}</div>}
            {topics.length > 0 && (
                <ul className="-mx-2 mt-3">
                    {topics.map(x => (
                        <TimeRow
                            key={x.nodeId}
                            title={x.nodeTitle}
                            context={x.projectName}
                            color={x.projectColor}
                            ms={x.ms}
                            onOpen={() => onOpenTopic(x.projectId, x.nodeId)}
                        />
                    ))}
                </ul>
            )}
            {/* The rule is said wherever a figure is, but as a line to open:
                a paragraph of it under every day was read once and then only
                in the way. The week's minutes are figures too, so a day
                with none of its own still carries it under the week. */}
            {(total > 0 || weekSum > 0) && (
                <Explain summary={t("How time is counted")} className="mt-1">
                    {t(HOW_COUNTED)}
                </Explain>
            )}
        </section>
    );
}
