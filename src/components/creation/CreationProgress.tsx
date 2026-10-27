/**
 * Where one AI project creation is, in words, and how long it has left.
 *
 * Two pieces, drawn in two places on the run screen:
 *
 *  - `RunStatus`, the screen's fixed head: what it is doing (the current
 *    stage, by name), the count and the time left, and ONE bar. It never
 *    scrolls, so the answer to "how far is it, how long is left" is on screen
 *    whatever the reader is looking at underneath.
 *  - `RunSteps`, the top of the Activity log: every stage as a labelled row with its own
 *    duration. Five icon-only circles of equal width would mislead — the first
 *    three stages take seconds between them and the fourth takes everything
 *    else (minutes to an hour) — so a stage's WEIGHT is its time, stated beside
 *    it, never an equal share of a bar.
 *
 * Time left is the run's own measurement (server/creationEta.js), counted down
 * between frames and never below what is left after the call in flight. Until
 * the run has measured enough, it says it is estimating — never a made-up
 * number, and never a prediction before the run starts.
 */
import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import { durationParts } from '../../utils/taskPlace';
import type { CreationTrack } from '../../api';
import { plainCause } from '../../utils/failureCause';
import { type CreationRun, isRunLive } from './creationRuns';

type StageKey = NonNullable<CreationTrack['stage']>;
const ORDER: StageKey[] = ['queued', 'think', 'prepare', 'outline', 'build', 'done'];

/** Ticks once a second while `on`, so clocks and countdowns move between frames. */
function useNow(on: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!on) return;
        const id = window.setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [on]);
    return on ? now : Date.now();
}

/**
 * The milliseconds left to SHOW: the server's figure counted down from when it
 * arrived, never under the floor (what is left after the call in flight), so an
 * overrunning call holds the number rather than running it to zero.
 */
export function shownEta(track: CreationTrack | null, trackAt: number, now: number): number | null {
    if (!track || track.etaMs == null) return null;
    const counted = track.etaMs - Math.max(0, now - trackAt);
    return Math.max(track.etaFloorMs ?? 0, counted, 0);
}

/** Everything both pieces read off one run, on one clock. */
function useRunProgress(run: CreationRun) {
    const { t } = useTranslation();
    const fmt = useNumberFormat();
    const live = isRunLive(run);
    const now = useNow(live);
    const track = run.track;

    const span = (ms: number) => {
        const d = durationParts(ms);
        return t(d.key, d.params);
    };

    const queued = run.queuePosition != null || !!track?.stageTimes?.queued;
    const stages = ORDER.filter(s => s !== 'queued' || queued);
    const current: StageKey = run.status === 'complete' ? 'done'
        : run.queuePosition != null ? 'queued'
            : (track?.stage ?? 'think');
    const failed = run.status === 'error' || run.status === 'cancelled';

    const label = (s: StageKey, done: boolean): string => {
        switch (s) {
            case 'queued': return done ? t("Waited for a free model slot") : t("Waiting for a free model slot");
            case 'think': return t("Understanding the request");
            case 'prepare': return t("Setting up the project");
            case 'outline':
                return done && track?.phases
                    ? t("{{n}} phases planned", { count: track.phases, n: fmt(track.phases) })
                    : t("Planning the phases");
            case 'build': return track?.linksOn === false ? t("Writing sections and topics") : t("Writing topics and finding links");
            case 'done': return t("Ready to study");
        }
    };

    const buildCount = (): string | null => {
        if (!track) return null;
        const parts: string[] = [];
        if (track.phases && track.phaseIndex != null) {
            parts.push(t("Phase {{n}} of {{total}}", { n: fmt(track.phaseIndex + 1), total: fmt(track.phases) }));
        }
        if (track.topicsTotal != null && track.topicsTotal > 0) {
            const done = fmt(track.topicsDone);
            const n = fmt(track.topicsTotal);
            parts.push(track.topicsExact
                ? t("{{done}} of {{n}} topics", { count: track.topicsTotal, done, n })
                : t("{{done}} of about {{n}} topics", { count: track.topicsTotal, done, n }));
        } else if (track.topicsDone > 0) {
            parts.push(t("{{n}} topics written", { count: track.topicsDone, n: fmt(track.topicsDone) }));
        }
        return parts.length ? parts.join(' · ') : null;
    };

    const activeMs = track ? track.activeMs + (live && current !== 'queued' ? Math.max(0, now - run.trackAt) : 0) : 0;
    const eta = live && current !== 'queued' ? shownEta(track, run.trackAt, now) : null;
    // Server clock → now, for a stage still running.
    const serverNow = track ? track.at + Math.max(0, now - run.trackAt) : now;

    return { t, fmt, live, track, span, stages, current, failed, label, buildCount, activeMs, eta, serverNow };
}

/**
 * The screen's fixed head: what, how far, how long, one bar — nothing more.
 * The topic in hand is the highlighted row of the Outline and the running line
 * of the Activity log, so it is not said a third time here, and how long the
 * run has gone on is in the log's steps: on a phone each extra line here was
 * a line less of the list.
 */
export function RunStatus({ run }: { run: CreationRun }) {
    const { t, fmt, track, span, current, label, buildCount, activeMs, eta } = useRunProgress(run);

    let headline: string;
    let right: string | null = null;
    let detail: string | null = null;
    let bar: number | null = null;
    // A failure in words, from the server's record of it; the raw message
    // stays beside it, small, for anyone who has to report it.
    const cause = run.status === 'error' && run.error
        ? plainCause(run.failure ?? { message: run.error })
        : null;
    if (run.status === 'complete') {
        headline = t("Project fully created!");
        right = activeMs > 0 ? t("Took {{time}}", { time: span(activeMs) }) : null;
        if (track && track.topicsDone > 0) {
            detail = [
                t("{{n}} topics written", { count: track.topicsDone, n: fmt(track.topicsDone) }),
                ...(run.totalResources > 0 ? [t("{{count}} links found", { count: run.totalResources })] : []),
            ].join(' · ');
        }
    } else if (run.status === 'cancelled') {
        headline = t("Creation cancelled — partial content saved");
    } else if (run.status === 'error') {
        headline = t("An error occurred");
    } else if (current === 'queued') {
        headline = t("Waiting for another generation to finish");
        detail = run.queuePosition != null ? t("Place in line: {{n}}", { n: fmt(run.queuePosition) }) : null;
    } else {
        // The stage by name is the headline: "running for 3 min" said how long,
        // never what — and "what" is the first thing a reader wants.
        headline = label(current, false);
        right = eta != null ? t("~{{duration}} left", { duration: span(eta) }) : t("Estimating time left…");
        detail = current === 'build' ? buildCount() : null;
        bar = current === 'build' && track?.topicsTotal ? Math.min(1, track.topicsDone / track.topicsTotal) : null;
    }

    const headTone = run.status === 'complete' ? 'text-emerald-700 dark:text-emerald-300'
        : run.status === 'error' ? 'text-red-700 dark:text-red-300'
            : run.status === 'cancelled' ? 'text-amber-800 dark:text-amber-200'
                : 'text-slate-900 dark:text-white';
    const Icon = run.status === 'complete' ? CheckCircle2 : run.status === 'error' || run.status === 'cancelled' ? AlertCircle : Loader2;
    const iconTone = run.status === 'complete' ? 'text-emerald-500'
        : run.status === 'error' ? 'text-red-500'
            : run.status === 'cancelled' ? 'text-amber-500'
                : 'text-accent-fg animate-spin';

    return (
        <section aria-live="off">
            <div className="flex items-start gap-3">
                <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${iconTone}`} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                        <p className={`text-base font-semibold ${headTone}`}>{headline}</p>
                        {right && <p className="text-sm font-medium tabular-nums text-accent-fg">{right}</p>}
                    </div>
                    {detail && <p className="mt-0.5 text-sm tabular-nums text-slate-600 dark:text-slate-300">{detail}</p>}
                    {run.status === 'error' && run.error && (cause ? (
                        <>
                            <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">{t(cause.messageKey, cause.params)}</p>
                            <p className="mt-1 break-words text-xs text-slate-500 dark:text-slate-400">{run.error}</p>
                        </>
                    ) : (
                        <p className="mt-1 break-words text-sm text-red-700 dark:text-red-300">{run.error}</p>
                    ))}
                    {run.status === 'error' && run.projectId != null && (
                        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{t("What was written before it stopped is saved.")}</p>
                    )}
                </div>
            </div>
            {bar != null && (
                <div className="mt-3 h-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden"
                    role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(bar * 100)}
                    aria-label={t("Topics written")}>
                    <div className="h-full bg-accent rounded-full transition-[width] duration-500" style={{ width: `${Math.max(2, bar * 100)}%` }} />
                </div>
            )}
        </section>
    );
}

/** The top of the Activity log: every stage, labelled, with its own duration. */
export function RunSteps({ run }: { run: CreationRun }) {
    const { t, live, track, span, stages, current, failed, label, serverNow } = useRunProgress(run);
    const currentIdx = stages.indexOf(current);

    return (
        <ol className="space-y-2.5" aria-label={t("Steps")}>
            {stages.map((s, i) => {
                const isDone = run.status === 'complete' || i < currentIdx;
                const isCurrent = i === currentIdx && run.status !== 'complete';
                const stopped = isCurrent && failed;
                const times = track?.stageTimes?.[s];
                // The finish line is a moment, not a stage with a duration.
                const took = isDone && s !== 'done' && times && times.end != null ? times.end - times.start : null;
                const running = isCurrent && live && times ? Math.max(0, serverNow - times.start) : null;
                return (
                    <li key={s} className="flex items-start gap-3" aria-current={isCurrent ? 'step' : undefined}>
                        <span className="mt-0.5 shrink-0" aria-hidden="true">
                            {stopped ? (
                                <AlertCircle className={`w-4 h-4 ${run.status === 'error' ? 'text-red-500' : 'text-amber-500'}`} />
                            ) : isDone ? (
                                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                            ) : isCurrent ? (
                                <Loader2 className="w-4 h-4 text-accent-fg animate-spin" />
                            ) : (
                                <Circle className="w-4 h-4 text-slate-300 dark:text-slate-600" />
                            )}
                        </span>
                        <div className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
                            <span className={`text-sm ${isCurrent ? 'font-medium text-slate-900 dark:text-white'
                                : isDone ? 'text-slate-700 dark:text-slate-300'
                                    : 'text-slate-500 dark:text-slate-400'}`}>
                                {label(s, isDone)}
                            </span>
                            {(took != null || running != null) && (
                                <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                                    {span(took ?? running ?? 0)}
                                </span>
                            )}
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}
