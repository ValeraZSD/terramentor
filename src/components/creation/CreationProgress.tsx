/**
 * Where one AI project creation is, in words, and how long it has left.
 *
 * It replaced a row of five icon-only circles of equal width. Measured on a
 * real run, the first three stages took a few seconds between them and the
 * fourth took everything else (minutes to an hour), so four of five circles
 * lit up at once and the fifth sat there; with no text, the reader could not
 * tell which one was the long one or what it was doing. So:
 *
 *  - The stages are a LIST with their names, not a row of shapes, so a label
 *    never has to fit a fifth of a phone (the reason the circles lost theirs)
 *    and nothing can overlap in any language.
 *  - A stage's WEIGHT is its time, stated beside it: "3 s" beside a quick one,
 *    the running clock beside the long one — never an equal share of a bar.
 *  - The long stage carries its own progress: which phase, how many topics of
 *    how many, the bar, and what it is writing right now.
 *  - Time left is the run's own measurement (server/creationEta.js), counted
 *    down between frames and never below what is left after the call in
 *    flight. Until the run has measured enough, it says it is estimating —
 *    never a made-up number, and never a prediction before the run starts.
 */
import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import { durationParts } from '../../utils/taskPlace';
import type { CreationTrack } from '../../api';
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

export default function CreationProgress({ run }: { run: CreationRun }) {
    const { t } = useTranslation();
    const fmt = useNumberFormat();
    const live = isRunLive(run);
    const now = useNow(live);
    const track = run.track;

    const span = (ms: number) => {
        const d = durationParts(ms);
        return t(d.key, d.params);
    };
    // Server clock → now, for a stage still running.
    const serverNow = track ? track.at + Math.max(0, now - run.trackAt) : now;

    const queued = run.queuePosition != null || !!track?.stageTimes?.queued;
    const stages = ORDER.filter(s => s !== 'queued' || queued);
    const current: StageKey = run.status === 'complete' ? 'done'
        : run.queuePosition != null ? 'queued'
            : (track?.stage ?? 'think');
    const currentIdx = stages.indexOf(current);
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

    // What the long stage is doing right now, from the frame's structure — in
    // the app's words (phase › section › topic), never the server's prose.
    const action = (): string | null => {
        switch (run.phase) {
            case 'generating_elements':
                return run.currentCategory ? t('Writing the sections of “{{title}}”…', { title: run.currentCategory }) : t("Writing sections…");
            case 'generating_sub_elements': {
                const title = run.currentElement || run.currentCategory;
                return title ? t('Writing the topics of “{{title}}”…', { title }) : t("Writing topics…");
            }
            case 'finding_resources':
                return run.currentSubElement ? t('Finding links for "{{title}}"…', { title: run.currentSubElement }) : t("Finding links…");
            default:
                return null;
        }
    };

    const buildLine = (): string | null => {
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

    const eta = live && current !== 'queued' ? shownEta(track, run.trackAt, now) : null;
    const activeMs = track ? track.activeMs + (live && current !== 'queued' ? Math.max(0, now - run.trackAt) : 0) : 0;

    let headline: string;
    let right: string | null = null;
    if (run.status === 'complete') {
        headline = t("Project fully created!");
        right = activeMs > 0 ? t("Took {{time}}", { time: span(activeMs) }) : null;
    } else if (run.status === 'cancelled') {
        headline = t("Creation cancelled — partial content saved");
    } else if (run.status === 'error') {
        headline = t("An error occurred");
    } else if (current === 'queued') {
        headline = t("Waiting for another generation to finish");
    } else {
        headline = activeMs >= 1000 ? t("Running for {{time}}", { time: span(activeMs) }) : t("Starting…");
        right = eta != null ? t("~{{duration}} left", { duration: span(eta) }) : t("Estimating time left…");
    }

    const headTone = run.status === 'complete' ? 'text-emerald-700 dark:text-emerald-300'
        : run.status === 'error' ? 'text-red-700 dark:text-red-300'
            : run.status === 'cancelled' ? 'text-amber-800 dark:text-amber-200'
                : 'text-slate-900 dark:text-white';

    return (
        <section className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className={`text-sm font-semibold ${headTone}`}>{headline}</p>
                {right && (
                    <p className="text-sm font-medium tabular-nums text-accent-fg" aria-live="off">{right}</p>
                )}
            </div>
            {run.status === 'error' && run.error && (
                <p className="mt-1 text-sm text-red-700 dark:text-red-300 break-words">{run.error}</p>
            )}
            {run.status === 'complete' && track && track.topicsDone > 0 && (
                <p className="mt-0.5 text-xs tabular-nums text-slate-600 dark:text-slate-300">
                    {[
                        t("{{n}} topics written", { count: track.topicsDone, n: fmt(track.topicsDone) }),
                        ...(run.totalResources > 0 ? [t("{{count}} links found", { count: run.totalResources })] : []),
                    ].join(' · ')}
                </p>
            )}

            <ol className="mt-3 space-y-2" aria-label={t("Steps")}>
                {stages.map((s, i) => {
                    const isDone = run.status === 'complete' || i < currentIdx;
                    const isCurrent = i === currentIdx && run.status !== 'complete';
                    const stopped = isCurrent && failed;
                    const times = track?.stageTimes?.[s];
                    // The finish line is a moment, not a stage with a duration.
                    const took = isDone && s !== 'done' && times && times.end != null ? times.end - times.start : null;
                    const running = isCurrent && live && times ? Math.max(0, serverNow - times.start) : null;
                    const detail = isCurrent && live && s === 'build' ? buildLine() : null;
                    const doing = isCurrent && live
                        ? (s === 'build' ? action() : s === 'queued'
                            ? (run.queuePosition != null ? t("Place in line: {{n}}", { n: fmt(run.queuePosition) }) : null)
                            : (run.messageKey ? t(run.messageKey, run.params || undefined) : null))
                        : null;
                    const bar = isCurrent && live && s === 'build' && track?.topicsTotal
                        ? Math.min(1, track.topicsDone / track.topicsTotal) : null;
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
                            <div className="min-w-0 flex-1">
                                <div className="flex items-baseline justify-between gap-3">
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
                                {detail && (
                                    <p className="mt-0.5 text-xs font-medium tabular-nums text-slate-700 dark:text-slate-300">{detail}</p>
                                )}
                                {bar != null && (
                                    <div className="mt-1.5 h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden"
                                        role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(bar * 100)}
                                        aria-label={t("Topics written")}>
                                        <div className="h-full bg-accent rounded-full transition-[width] duration-500" style={{ width: `${Math.max(2, bar * 100)}%` }} />
                                    </div>
                                )}
                                {doing && (
                                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 break-words">{doing}</p>
                                )}
                            </div>
                        </li>
                    );
                })}
            </ol>
        </section>
    );
}
