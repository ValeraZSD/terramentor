import { useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowRight, Clock, ListChecks, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store';
import type { DailyPlan, DailyPlanTask } from '../../types';
import { useOpenMasteryCheck } from '../../hooks/useOpenMasteryCheck';
import { pretty } from '../../utils/scheduleAxis';
import { Button } from '../ui/Button';
import { DashboardSection } from './DashboardSection';

/** Rows a group shows before "Show all". Enough to see what kind of backlog it
 *  is; the rest is one press away, never silently dropped. */
const VISIBLE = 5;

/**
 * The course's agenda for today (server/dailyPlan.js), as lists.
 *
 * - The topic "Next up" already names is left out, so the page does not offer
 *   the same topic and the same check twice a few centimetres apart.
 * - A group's count is the length of its list: the old tiles printed
 *   "Overdue (23)" over six of them with no way to see the other seventeen.
 * - No count chips under the lists. Each repeated a number shown elsewhere
 *   (the cards due are the Cards panel's) or named something nobody can act on
 *   from here; the stream brings fading topics back by itself.
 *
 * Renders nothing when, the hero aside, nothing is overdue or due today.
 */
export function TodaysPlan({ plan, heroId, projectId }: {
    plan: DailyPlan;
    heroId: number | null;
    projectId: number;
}) {
    const { t } = useTranslation();
    const openMasteryCheck = useOpenMasteryCheck();
    const notHero = (task: DailyPlanTask) => task.id !== heroId;
    const overdue = plan.overdueTasks.filter(task => !task.readyToProve && notHero(task));
    const ready = plan.overdueTasks.filter(task => task.readyToProve && notHero(task));
    const today = plan.todayTasks.filter(notHero);
    if (overdue.length + ready.length + today.length === 0) return null;

    return (
        <DashboardSection icon={ListChecks} title={t("Today's Plan")}>
            <div className="space-y-5">
                {overdue.length > 0 && (
                    <TaskGroup
                        heading={t("Overdue ({{length}})", { length: overdue.length })}
                        icon={<AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />}
                        tone="text-red-600 dark:text-red-400"
                        tasks={overdue}
                        dot="bg-red-500"
                        showDue
                    />
                )}
                {/* Past their dates and already known: what closes them is the
                    check, not another lesson (server/readyToProve.js). */}
                {ready.length > 0 && (
                    <TaskGroup
                        heading={t("Ready to prove ({{length}})", { length: ready.length })}
                        icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />}
                        tone="text-accent-fg"
                        tasks={ready}
                        dot="bg-accent"
                        action={task => (
                            // Named for its topic: a screen reader lists every
                            // row's button, and five "Take the mastery check"
                            // say nothing about which one opens what.
                            <Button
                                size="sm"
                                aria-label={t("Take the mastery check: {{topic}}", { topic: task.title })}
                                onClick={() => void openMasteryCheck(task.id, task.title, projectId)}
                            >
                                {t("Take the mastery check")}
                            </Button>
                        )}
                    />
                )}
                {today.length > 0 && (
                    <TaskGroup
                        heading={t("Due Today ({{length}})", { length: today.length })}
                        icon={<Clock className="h-3.5 w-3.5" aria-hidden="true" />}
                        tone="text-slate-600 dark:text-slate-300"
                        tasks={today}
                        dot="bg-accent"
                    />
                )}
            </div>
        </DashboardSection>
    );
}

function TaskGroup({ heading, icon, tone, tasks, dot, showDue = false, action }: {
    heading: string;
    icon: ReactNode;
    tone: string;
    tasks: DailyPlanTask[];
    dot: string;
    /** Print the date each one was due (an overdue list is read by how late). */
    showDue?: boolean;
    action?: (task: DailyPlanTask) => ReactNode;
}) {
    const { t } = useTranslation();
    const selectNode = useStore(s => s.selectNode);
    const [all, setAll] = useState(false);
    const shown = all ? tasks : tasks.slice(0, VISIBLE);

    return (
        <div>
            <h4 className={`mb-1 flex items-center gap-1.5 text-xs font-semibold ${tone}`}>
                {icon}
                {heading}
            </h4>
            <ul className="divide-y divide-slate-100 dark:divide-slate-700/60">
                {shown.map(task => (
                    // The action wraps under the title before the title is cut
                    // short: on a phone "Take the mastery check" kept its width
                    // and left the topic as "Exponential & L…".
                    <li key={task.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1">
                        <button
                            data-row="task"
                            type="button"
                            onClick={() => selectNode(task.id)}
                            className="group -mx-2 flex min-w-[12rem] flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-slate-50 dark:hover:bg-slate-700/40"
                        >
                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
                            {/* Two lines before an ellipsis: on a phone one line
                                left "Exponential & Logarithmic Functio…". */}
                            <span className="min-w-0 flex-1 line-clamp-2 break-words text-sm font-medium text-slate-700 dark:text-slate-200" title={task.title}>
                                {task.title}
                            </span>
                            {showDue && task.scheduled_end && (
                                <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                                    {pretty(task.scheduled_end)}
                                </span>
                            )}
                            {/* The Tools rows' arrow: a row of plain text and a
                                dot did not look like it opened anything until
                                the pointer was on it, and a phone has no hover. */}
                            <ArrowRight className="h-4 w-4 shrink-0 text-slate-400 transition group-hover:text-accent-fg" aria-hidden="true" />
                        </button>
                        {action && <div className="ml-auto shrink-0">{action(task)}</div>}
                    </li>
                ))}
            </ul>
            {tasks.length > VISIBLE && (
                // Outlined, not quiet: a quiet button at rest is plain text,
                // and this one hides most of the list.
                <Button size="sm" className="mt-2" aria-expanded={all} onClick={() => setAll(a => !a)}>
                    {all ? t("Show fewer") : t("Show all {{length}}", { length: tasks.length })}
                </Button>
            )}
        </div>
    );
}
