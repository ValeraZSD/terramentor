import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ArrowUpRight, AlertTriangle } from 'lucide-react';
import type { AITaskSummary } from '../types';
import { useStore } from '../store';
import { useTranslation } from 'react-i18next';
import { k } from '../i18n';
import { uiLocale } from '../utils/locale';
import { taskPlace, taskEta, durationParts, KIND_LABEL } from '../utils/taskPlace';
import { Button } from './ui/Button';

/**
 * What one background task is, where it belongs, and what it is doing — the
 * dock chip's whole story on one screen.
 *
 * A chip has room for a label and a number, and the two facts a reader wants
 * from a bar of background work do not fit on it: when this started, and how
 * long it has left. For the jobs the app starts by itself — indexing, region
 * naming, PDF recovery, interval tuning — the chip is the only place they are
 * visible at all, so those two facts have nowhere else to be said.
 *
 * So every chip opens this from its progress badge, and a task with no screen
 * of its own opens it on the press rather than going nowhere. The controls come
 * with the facts: a runaway background job is stopped from where you noticed
 * it, not from wherever it was configured.
 */

/** How the state reads, as a whole word rather than a colour. */
function statusKey(task: AITaskSummary): string {
    switch (task.status) {
        case 'running': return k("Running");
        case 'queued': return k("Waiting its turn");
        case 'done': return k("Finished");
        case 'error': return k("Failed");
        default: return k("Cancelled");
    }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    if (children === null || children === undefined || children === '') return null;
    return (
        <div className="flex gap-3 py-2 text-sm">
            <dt className="w-32 shrink-0 text-slate-500 dark:text-slate-400">{label}</dt>
            <dd className="min-w-0 break-words text-slate-800 dark:text-slate-100">{children}</dd>
        </div>
    );
}

export default function TaskDetailModal({ task, onClose, onDismiss, onShowFailure }: {
    task: AITaskSummary;
    onClose: () => void;
    /** Clear a settled task THROUGH the dock, so it plays the same exit as the ✕. */
    onDismiss: (id: string) => void;
    /** Hand a failed task over to the failure record, which is a different question. */
    onShowFailure?: () => void;
}) {
    const { t } = useTranslation();
    const openAiTask = useStore(s => s.openAiTask);
    const cancelAiTask = useStore(s => s.cancelAiTask);
    // THE DOT IS THE CHIP'S DOT, so it takes the chip's own fallback. A task
    // with no project fell back here to `rgb(var(--accent-rgb))` — the ambient
    // variable, which carries the DARKENED accent the app writes onto `:root`
    // so white label text on a fill clears AA, up to 19 lightness points off
    // the swatch a reader matches against. `TaskDock`'s `useTaskAccent` exists
    // to keep that variable out of exactly this fallback: the store's value is
    // the colour as the app wears it, and it is the same answer on every
    // screen. Same expression here, so the dialog's dot and the chip that
    // opened it cannot drift apart.
    const appAccent = useStore(s => s.accentColor);
    const dotColor = task.projectColor || appAccent;
    const place = taskPlace(task);
    const active = task.status === 'running' || task.status === 'queued';

    // "Started 4 min ago" has to keep being true while the dialog is open, and
    // nothing else on it moves once a second — the task snapshots arrive at
    // ~4 Hz but they carry no clock. One interval, only while something is
    // still running: a finished task's numbers are fixed.
    const [, tick] = useState(0);
    useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => tick(n => n + 1), 1000);
        return () => window.clearInterval(timer);
    }, [active]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const now = Date.now();
    const since = (iso: string | null) => {
        if (!iso) return null;
        const at = Date.parse(iso);
        if (!Number.isFinite(at)) return null;
        const ms = now - at;
        if (ms < 10000) return t("just now");
        const d = durationParts(ms);
        return t("{{time}} ago", { time: t(d.key, d.params) });
    };
    const clock = (iso: string | null) => {
        if (!iso) return null;
        try { return new Date(iso).toLocaleTimeString(uiLocale()); } catch { return null; }
    };

    // The clock it has been on: the QUEUE time until it starts, the RUN time
    // after — a task that sat behind four others for two minutes has not been
    // "running for two minutes", and saying so is how a reader concludes the
    // model is slow when the queue is deep.
    const ranFor = task.startedAt
        ? (task.finishedAt ? Date.parse(task.finishedAt) : now) - Date.parse(task.startedAt)
        : null;
    const eta = taskEta(task, now);
    const percent = task.progress.percent;

    // What kind of job this is, and whose — the line the chip carries under the
    // label. The project is only added when the label does not already say it
    // ("Study material · Physics HAVO 5" over "Physics HAVO 5" is the name
    // twice), and a job that belongs to no project says so instead: a blank
    // line there reads as a project whose name failed to load.
    const kindLabel = t(KIND_LABEL[task.kind] ?? k("AI task"));
    const subtitle = [
        kindLabel,
        task.projectName
            ? (task.label.includes(task.projectName) ? null : task.projectName)
            : t("Across the whole library"),
    ].filter(Boolean).join(' · ');

    const goThere = () => {
        if (openAiTask(task)) onClose();
    };

    // Portalled to document.body for the same reason the failure record is: the
    // dock is `fixed` WITH a transform, and a transform makes that element the
    // containing block of every fixed descendant — rendered in place, this
    // dialog's `inset-0` would resolve to the dock's own pill instead of the
    // screen. See tools/dock-harness/run.mjs, which asserts it from the DOM.
    return createPortal(
        <div
            className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
            onClick={onClose}
            role="presentation"
        >
            <div
                className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl dark:bg-slate-800 sm:rounded-2xl"
                onClick={e => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={t("Task details")}
            >
                <div className="flex items-start gap-3 border-b border-slate-200 p-4 dark:border-slate-700">
                    <span
                        className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${task.status === 'running' ? 'animate-pulse' : ''}`}
                        style={{ backgroundColor: dotColor }}
                        aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                        <h2 className="truncate font-semibold text-slate-900 dark:text-white">{task.label}</h2>
                        <p className="truncate text-sm text-slate-500 dark:text-slate-400">
                            {subtitle}
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        aria-label={t("Close")}
                        className="rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    {/* The bar first: it is the answer to the question that made
                        anyone open this. A task with no percentage gets no bar
                        rather than an empty one pretending to be at zero. */}
                    {task.status === 'running' && percent != null && (
                        <div className="mb-4">
                            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                                <div
                                    className="h-full rounded-full bg-accent transition-[width] duration-500"
                                    style={{ width: `${Math.max(2, percent)}%` }}
                                />
                            </div>
                            <p className="mt-1 text-right text-xs tabular-nums text-slate-500 dark:text-slate-400">{percent}%</p>
                        </div>
                    )}

                    <dl className="divide-y divide-slate-100 dark:divide-slate-700/60">
                        <Row label={t("State")}>
                            {task.status === 'queued' && task.queuePosition
                                ? t("Waiting its turn — {{n}} in line", { n: task.queuePosition + 1 })
                                : t(statusKey(task))}
                        </Row>
                        <Row label={t("Started")}>
                            {task.startedAt
                                ? <>{since(task.startedAt)}<span className="text-slate-500 dark:text-slate-400"> · {clock(task.startedAt)}</span></>
                                : t("not yet — it is still waiting for the model")}
                        </Row>
                        {/* Only once it is over. While a task runs, how long it
                            has been running is the line above it said backwards,
                            and two rows that are the same number read as a bug. */}
                        <Row label={t("Ran for")}>
                            {task.finishedAt && ranFor != null && ranFor > 0
                                ? t(durationParts(ranFor).key, durationParts(ranFor).params)
                                : null}
                        </Row>
                        <Row label={t("Time left")}>
                            {eta
                                ? t("about {{time}}", { time: t(durationParts(eta.ms).key, durationParts(eta.ms).params) })
                                : (task.status === 'running' ? t("no estimate — this job does not report how much is left") : null)}
                        </Row>
                        {/* What it is doing right now: which topic, which part of
                            the batch. The chip has no room for it and the tooltip
                            does not exist on a phone. */}
                        <Row label={t("Now")}>{active ? (task.progress.message || null) : null}</Row>
                        <Row label={t("Written")}>
                            {task.progress.content > 0
                                // The dock's own key, so the number reads the
                                // same way here as it does on the chip.
                                ? t("{{chars}} chars", { count: task.progress.content, chars: task.progress.content })
                                : null}
                        </Row>
                    </dl>

                    {task.status === 'error' && task.error && (
                        <p className="mt-4 flex gap-2 rounded-lg bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span className="min-w-0 break-words">{task.error}</span>
                        </p>
                    )}

                    {!place && (
                        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
                            {t("The app started this one by itself, so there is no screen it came from.")}
                        </p>
                    )}
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 p-4 dark:border-slate-700">
                    {place && (
                        <Button variant="primary" onClick={goThere} trailing={<ArrowUpRight className="h-4 w-4" aria-hidden="true" />}>
                            {t(place.openKey)}
                        </Button>
                    )}
                    {task.status === 'error' && task.failure && onShowFailure && (
                        <Button variant="neutral" onClick={onShowFailure}>{t("Why it failed")}</Button>
                    )}
                    {active ? (
                        <Button variant="danger" onClick={() => { cancelAiTask(task.id); onClose(); }}>
                            {t("Stop this task")}
                        </Button>
                    ) : (
                        <Button variant="quiet" onClick={() => { onDismiss(task.id); onClose(); }}>
                            {t("Dismiss")}
                        </Button>
                    )}
                    <Button variant="quiet" className="ml-auto" onClick={onClose}>{t("Close")}</Button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
