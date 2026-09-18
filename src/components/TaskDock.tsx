import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { useStore } from '../store';
import { AITaskSummary } from '../types';
import { X, Check, AlertTriangle, ChevronDown, ChevronUp, Sparkles } from 'lucide-react';
import TaskFailureModal from './TaskFailureModal';
import { useTranslation } from 'react-i18next';
import i18n, { k } from '../i18n';

// Show at most this many chips inline; the rest collapse behind a "+N" pill so
// a long queue can't overflow the bar (or re-render dozens of chips at the
// dock's ~4 Hz snapshot rate). Three is a bar you read at a glance — five was
// a wall, and on a phone it was most of the screen's width.
const MAX_VISIBLE = 3;

/**
 * How long a FINISHED chip stays before it clears itself. Every terminal state
 * clears, a FAILURE included — it just gets longer, because it is the one a
 * reader has to decide something about. Neither is a place things live: the
 * task is still there to open, and what ran, how long it took and what went
 * wrong is in the activity log (`ai.failed` / `ai.stream_failed` carry the
 * message), so nothing is lost when the chip goes. A failed chip used to stay
 * for ever on the grounds that it was the only record; that turned a bad
 * night's generations into a bar you had to clear by hand.
 *
 * The countdown is held while the pointer is on the chip and while its failure
 * report is open, so it can't take something out from under a reader.
 */
function autoDismissMs(status: AITaskSummary['status']): number {
    return status === 'error' ? 30000 : 10000;
}

// The exit: the chip's words fade out FIRST, then the chip itself collapses to
// nothing horizontally and the row closes over it. Two stages rather than one
// fade, because a chip that shrinks while still legible reads as the text being
// squeezed — letting the words go first makes it a card closing. The collapse
// is `1fr → 0fr` on a one-column grid (no measuring, no width to guess) and the
// negative margin eats the dock's own `gap` on the way out, so the last frame
// doesn't end on a 4px jump.
/**
 * How wide a chip's label may get. 13rem on any normal screen — but a chip is
 * `shrink-0` inside a horizontal scroller, so a cap wider than the bar itself
 * clips the FIRST chip rather than the second, and a chip cut through its own
 * status badge with its ✕ off the end reads as broken text, not as "there is
 * more to the right".
 *
 * The subtrahend is the rest of the bar at its narrowest: 1.5rem of page
 * gutter, 0.5rem of bar padding, the "+N" pill and the Minimize button at 2rem
 * each, 0.5rem of gaps between them, and about 7.5rem of the chip that is not
 * the label (the dot, the gaps, the status badge and the ✕). `100vw` rather
 * than a `sm:` breakpoint because the dock is a screen-level fixed bar whose
 * one narrowing influence is the docked assistant, which publishes its width.
 */
const LABEL_MAX = 'min(13rem, calc(100vw - var(--assistant-w, 0px) - 14rem))';

const EXIT_FADE_MS = 140;
const EXIT_COLLAPSE_MS = 200;
const EXIT_MS = EXIT_FADE_MS + EXIT_COLLAPSE_MS;

/** Whether the reader has asked for less movement. Read at the moment it
 *  matters, never cached — and it has to be read in JS rather than left to a
 *  `motion-reduce:` class, because these transitions are inline styles (they
 *  carry per-property delays) and an inline style beats any class. */
function reducedMotion(): boolean {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/**
 * Global AI task dock — the small bar pinned to the bottom of the screen that
 * shows every background AI generation (tutor turns, boss fights, flashcards,
 * insights, briefings, project creation) wherever you are in the app.
 *
 * Each chip: a breathing dot in the owning project's colour while running
 * (grey while queued), the task label, and live progress (percent where a
 * real total exists, character counts otherwise). Clicking a chip navigates
 * to the surface the task belongs to; ✕ cancels an active task or dismisses
 * a finished one. Navigating away never cancels anything — generations run
 * server-side and the queue advances on its own.
 */

/** What KIND of job a chip is. Client-side and closed, so `k()` marks it and the
 *  chip reads it through `t()` — the dock said "Feed lessons" in every language. */
const KIND_LABEL: Record<AITaskSummary['kind'], string> = {
    chat: k("Tutor"),
    today_chat: k("Planner"),
    quiz: k("Quiz"),
    boss_fight: k("Boss Fight"),
    flashcards: k("Flashcards"),
    insights: k("Insights"),
    briefing: k("Briefing"),
    create_project: k("New project"),
    widget: k("Widget"),
    visual: k("Visual"),
    feed: k("Feed lessons"),
    embed: k("Indexing"),
    bulk: k("Study material"),
    recover: k("PDF recovery"),
    capture: k("Capture"),
    placement: k("Placement"),
    atlas: k("Atlas"),
    media_describe: k("Image descriptions"),
    srs_optimize: k("Review intervals"),
};

function formatChars(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** The number or word on the chip. Module-level, so it reads the language from
 *  i18next directly — these eight words were the dock's other English half. */
function progressText(task: AITaskSummary): string {
    // Queue position, counting the running task as #1 (so the first queued
    // chip reads #2). Falls back to a plain "queued" if position is unknown.
    if (task.status === 'queued') return task.queuePosition ? `#${task.queuePosition + 1}` : i18n.t("queued");
    if (task.status === 'done') return i18n.t("done");
    if (task.status === 'error') return i18n.t("failed");
    if (task.status === 'cancelled') return i18n.t("cancelled");
    // running
    const p = task.progress;
    if (p.percent != null) return `${p.percent}%`;
    if (p.phase === 'loading_model') return i18n.t("warming up…");
    if (p.content > 0) return i18n.t("{{chars}} chars", { chars: formatChars(p.content) });
    if (p.thinking > 0) return i18n.t("thinking {{chars}}", { chars: formatChars(p.thinking) });
    return i18n.t("starting…");
}

/**
 * Active first (running, then queue order), finished trail at the end — and the
 * order is also what gets CLIPPED, because only the first `MAX_VISIBLE` are
 * drawn. So the two groups sort opposite ways on purpose: a queue reads
 * oldest-first (the next one to run is the one you care about), a finished
 * trail reads NEWEST-first (the result that just landed is the one you came to
 * look at). Sorting the trail oldest-first kept the stalest chips on the bar
 * and hid the one that had just finished behind the "+N" pill.
 */
function sortTasks(tasks: AITaskSummary[]): AITaskSummary[] {
    const rank = (t: AITaskSummary) =>
        t.status === 'running' ? 0 : t.status === 'queued' ? 1 : 2;
    return [...tasks].sort((a, b) => {
        const r = rank(a) - rank(b);
        if (r !== 0) return r;
        if (a.status === 'queued' && b.status === 'queued') {
            return (a.queuePosition ?? 0) - (b.queuePosition ?? 0);
        }
        // A result is ordered by when it LANDED, not when it was asked for: a
        // long generation started first can finish last, and the chip you came
        // to look at is the one that just appeared. `finishedAt` is the
        // server's own stamp and is missing only on the client's optimistic
        // "cancelled", which falls back to where it sat in the queue.
        if (rank(a) === 2) {
            const x = a.finishedAt || a.createdAt, y = b.finishedAt || b.createdAt;
            return x < y ? 1 : -1;
        }
        return a.createdAt < b.createdAt ? -1 : 1;
    });
}

/**
 * The chip's place in the row, and its way out of it. One grid column: `1fr`
 * while the chip is here, `0fr` while it leaves, which is a width animation
 * with no width to measure — the inner box keeps `min-w-0 overflow-hidden` so
 * the chip is CLIPPED as the column closes rather than reflowing its own text.
 * The words go first (they are already gone by the time the clipping would
 * show), and the negative margin walks back the dock's `gap` so the row closes
 * the whole way instead of leaving a 4px hole where the chip was.
 */
function ChipExit({ leaving, children }: { leaving: boolean; children: React.ReactNode }) {
    const still = reducedMotion();
    const ref = useRef<HTMLDivElement | null>(null);
    // A chip on its way out is hidden from the accessibility tree and takes no
    // more clicks — but it is still in the DOM for a third of a second, and
    // leaving the keyboard inside an `aria-hidden` subtree is its own fault.
    // The focus goes where it would have gone had the chip simply vanished.
    useEffect(() => {
        if (!leaving) return;
        const active = document.activeElement as HTMLElement | null;
        if (active && ref.current?.contains(active)) active.blur();
    }, [leaving]);
    return (
        <div
            ref={ref}
            className="grid shrink-0 min-w-0"
            style={{
                gridTemplateColumns: leaving ? '0fr' : '1fr',
                marginRight: leaving ? '-0.25rem' : 0,
                transition: still ? 'none'
                    : `grid-template-columns ${EXIT_COLLAPSE_MS}ms ease ${EXIT_FADE_MS}ms,`
                        + ` margin-right ${EXIT_COLLAPSE_MS}ms ease ${EXIT_FADE_MS}ms`,
            }}
            aria-hidden={leaving || undefined}
        >
            <div
                className="min-w-0 overflow-hidden"
                style={{
                    opacity: leaving ? 0 : 1,
                    pointerEvents: leaving ? 'none' : undefined,
                    transition: still ? 'none' : `opacity ${EXIT_FADE_MS}ms ease`,
                }}
            >
                {children}
            </div>
        </div>
    );
}

interface TaskChipProps {
    task: AITaskSummary;
    /** Report that this chip must not be cleared yet (pointer on it, report open). */
    onHold: (id: string, held: boolean) => void;
    /** Clear a settled chip — through the dock, which plays the exit first. */
    onDismiss: (id: string) => void;
}

const TaskChip = memo(function TaskChip({ task, onHold, onDismiss }: TaskChipProps) {
    const { t: tr } = useTranslation();
    const openAiTask = useStore(s => s.openAiTask);
    // A failed task opens its own diagnosis rather than the generation view —
    // there is no output to look at, and "why" is the only question left.
    const [showFailure, setShowFailure] = useState(false);
    const cancelAiTask = useStore(s => s.cancelAiTask);

    const active = task.status === 'running' || task.status === 'queued';
    const failed = task.status === 'error';
    const dotColor = task.projectColor || 'rgb(var(--accent-rgb))';

    // Hovering holds the chip: the pointer is on its way to the result. So does
    // an open failure report — clearing the chip unmounts that modal, and the
    // countdown must not take the diagnosis out from under someone reading it.
    // The hold is registered with the DOCK rather than kept here, because the
    // dock is what owns the countdown: a chip clipped behind the "+N" pill is
    // not mounted at all, and a timer living in it would never fire.
    const [hovered, setHovered] = useState(false);
    useEffect(() => {
        onHold(task.id, hovered || showFailure);
        return () => onHold(task.id, false);
    }, [hovered, showFailure, task.id, onHold]);

    const detail = progressText(task);
    const kindLabel = tr(KIND_LABEL[task.kind] ?? k("AI task"));
    // The chip has room for a label and a number; the live detail line (which
    // topic, which part, how many of the batch are ready) goes in the tooltip.
    const tooltip = `${kindLabel}: ${task.label}` +
        (task.projectName ? ` · ${task.projectName}` : '') +
        (active && task.progress.message ? `\n${task.progress.message}` : '') +
        (task.error ? ` — ${task.error}` : '') +
        (failed ? `\n${tr("Tap for details")}` : '');

    return (
        <div
            // The chip carries a flat tint — no border, no shadow, nothing that
            // repeats the dock's own capsule — because two chips side by side
            // on a bare bar ran into each other and could not be told apart.
            // The dock is still the container; the tint only draws the seam.
            className={`flex items-center gap-1.5 pl-2.5 pr-0.5 h-9 rounded-lg bg-slate-100/80 dark:bg-slate-700/50 transition-colors
                ${task.status === 'queued' ? 'opacity-70' : ''}`}
            title={tooltip}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onFocusCapture={() => setHovered(true)}
            onBlurCapture={() => setHovered(false)}
        >
            <button
                type="button"
                onClick={() => (failed ? setShowFailure(true) : openAiTask(task))}
                className="flex items-center gap-2 min-w-0 h-9 px-1 -mx-1 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent"
                aria-label={failed
                    ? tr("Why the {{kindLabel}} \"{{label}}\" failed", { kindLabel: kindLabel.toLowerCase(), label: task.label })
                    : tr("Open {{kindLabel}} task: {{label}} ({{detail}})", { kindLabel: kindLabel.toLowerCase(), label: task.label, detail })}
            >
                {/* Status dot: breathing project colour while running, grey while
                    queued, ✓/! once finished. */}
                {task.status === 'running' ? (
                    <span
                        className="w-2.5 h-2.5 rounded-full animate-pulse shrink-0"
                        style={{ backgroundColor: dotColor }}
                        aria-hidden="true"
                    />
                ) : task.status === 'queued' ? (
                    <span className="w-2.5 h-2.5 rounded-full bg-slate-300 dark:bg-slate-600 shrink-0" aria-hidden="true" />
                ) : task.status === 'done' ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden="true" />
                ) : (
                    <AlertTriangle className={`w-3.5 h-3.5 shrink-0 ${task.status === 'error' ? 'text-red-500' : 'text-slate-400'}`} aria-hidden="true" />
                )}

                {/* What it IS, at the reading size; what KIND of job it is, muted
                    and smaller under it. One line at 12px made the two run
                    together, and the half that was cut short was the useful
                    half — which topic. */}
                <span className="min-w-0 flex flex-col items-start leading-tight" style={{ maxWidth: LABEL_MAX }}>
                    <span className={`text-sm font-medium truncate max-w-full ${task.status === 'queued'
                        ? 'text-slate-500 dark:text-slate-400'
                        : 'text-slate-800 dark:text-slate-100'}`}>
                        {task.label}
                    </span>
                    <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-full">
                        {kindLabel}
                    </span>
                </span>

                {/* The state, as its own tinted token: at a glance, which of
                    these is still working and which is finished. */}
                <span className={`shrink-0 px-1.5 py-0.5 rounded text-[11px] font-medium tabular-nums ${
                    task.status === 'running' ? 'bg-accent/15 text-accent-fg'
                        : task.status === 'done' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                            : failed ? 'bg-red-500/15 text-red-700 dark:text-red-300'
                                : 'bg-slate-500/10 text-slate-600 dark:text-slate-300'}`}>
                    {detail}
                </span>
            </button>

            <button
                type="button"
                onClick={() => (active ? cancelAiTask(task.id) : onDismiss(task.id))}
                aria-label={active ? tr("Cancel {{label}}", { label: task.label }) : tr("Dismiss {{label}}", { label: task.label })}
                title={active ? tr("Cancel") : tr("Dismiss")}
                className="shrink-0 grid place-items-center w-7 h-7 rounded-md text-slate-400 dark:text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-700 transition outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
                <X className="w-3.5 h-3.5" />
            </button>

            {showFailure && task.failure && (
                <TaskFailureModal failure={task.failure} onClose={() => setShowFailure(false)} />
            )}
        </div>
    );
}, (a, b) => {
    // Re-render a chip only when a field it actually shows changes — so one
    // task's progress tick doesn't re-render every other chip in the bar.
    const x = a.task, y = b.task;
    return x.id === y.id
        && x.status === y.status
        && x.queuePosition === y.queuePosition
        && x.label === y.label
        && x.projectColor === y.projectColor
        && x.error === y.error
        && x.progress.percent === y.progress.percent
        && x.progress.content === y.progress.content
        && x.progress.thinking === y.progress.thinking
        && x.progress.phase === y.progress.phase
        && x.progress.message === y.progress.message;
});

export default function TaskDock() {
    const { t: tr } = useTranslation();
    const aiTasks = useStore(s => s.aiTasks);
    const [collapsed, setCollapsed] = useState(false);
    // Centred on the *app column*, not the viewport: `--assistant-w` is the width
    // of the docked assistant panel (0 when closed), and a fixed element has no
    // other way to learn that the page it belongs to no longer fills the screen.
    const DOCK_CENTRE = { transform: 'translateX(calc(-50% - var(--assistant-w, 0px) / 2))' } as const;
    // When there are more than MAX_VISIBLE tasks, the overflow hides behind a
    // "+N" pill; clicking it reveals the full list (and clicking again re-hides).
    const [showAll, setShowAll] = useState(false);
    const dockRef = useRef<HTMLDivElement | null>(null);
    const dismissAiTask = useStore(s => s.dismissAiTask);

    // Which chips are on their way out, so they keep their place in the row for
    // the length of the exit. The id leaves the set at the same moment the task
    // leaves the list, so a dismiss the server refuses (a "cancelled" chip whose
    // task is still settling) comes back drawn normally rather than invisible.
    const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
    // Chips the reader is holding: the pointer is on one, or its failure report
    // is open. A ref, not state — nothing on screen changes when a hold starts,
    // and the countdown is the only thing that reads it.
    const holdsRef = useRef<Set<string>>(new Set());
    const holdTask = useCallback((id: string, held: boolean) => {
        if (held) holdsRef.current.add(id);
        else holdsRef.current.delete(id);
    }, []);
    // Every id whose dismissal has been asked for. The sweep below runs every
    // second, so without this one refused dismissal would be re-sent every
    // second for as long as the chip sat there.
    const askedRef = useRef<Set<string>>(new Set());

    // Start the exit. The chip stops being a control on THIS frame — it fades,
    // it goes aria-hidden, it takes no more clicks — and the store is told once
    // the animation is over. That is a fixed third of a second the dock spends
    // on its own animation, never a wait on an answer: the whole point of the
    // local-first dismiss is that a dropped SSE socket can make the server's
    // confirmation a minute away, and nothing here is timed by it.
    const beginExit = useCallback((id: string) => {
        if (askedRef.current.has(id)) return;
        askedRef.current.add(id);
        holdsRef.current.delete(id);
        setLeaving(prev => new Set(prev).add(id));
        window.setTimeout(() => {
            setLeaving(prev => {
                if (!prev.has(id)) return prev;
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
            dismissAiTask(id);
        }, reducedMotion() ? 0 : EXIT_MS);
    }, [dismissAiTask]);

    // The countdown lives HERE rather than inside each chip, because only the
    // first MAX_VISIBLE chips are mounted: a finished one clipped behind the
    // "+N" pill would otherwise sit in the list until the server's own (much
    // longer) TTL dropped it, and then reappear the moment the queue drained.
    // Timed from `finishedAt` — the server's own stamp — so a chip that was
    // clipped, revealed, re-sorted or re-mounted doesn't start its wait again.
    // A settled task with no `finishedAt` is the client's optimistic
    // "cancelled", still settling server-side; it waits for the real one.
    const anySettled = aiTasks.some(t => t.status !== 'running' && t.status !== 'queued');
    useEffect(() => {
        if (!anySettled) return;
        const sweep = () => {
            const now = Date.now();
            for (const task of useStore.getState().aiTasks) {
                if (task.status === 'running' || task.status === 'queued') continue;
                if (!task.finishedAt) continue;
                if (holdsRef.current.has(task.id) || askedRef.current.has(task.id)) continue;
                const since = Date.parse(task.finishedAt);
                if (Number.isFinite(since) && now - since >= autoDismissMs(task.status)) beginExit(task.id);
            }
        };
        const timer = window.setInterval(sweep, 1000);
        return () => window.clearInterval(timer);
    }, [anySettled, beginExit]);

    // Forget ids the list no longer carries, so neither set grows with the
    // session (and a task id that somehow returns is treated as new).
    useEffect(() => {
        const live = new Set(aiTasks.map(t => t.id));
        for (const id of askedRef.current) if (!live.has(id)) askedRef.current.delete(id);
        for (const id of holdsRef.current) if (!live.has(id)) holdsRef.current.delete(id);
    }, [aiTasks]);

    // The dock floats over everything (fixed, bottom-centre). On a phone that
    // puts it right on top of the tutor's chat box, swallowing taps meant for
    // the input. Publish the dock's real height to `--task-dock-h` so a
    // bottom-anchored input can reserve exactly that much room — measured, not
    // guessed, so it stays correct as chips wrap or the bar collapses. 0px
    // whenever the dock isn't on screen.
    useEffect(() => {
        const root = document.documentElement;
        const el = dockRef.current;
        if (!el) {
            root.style.setProperty('--task-dock-h', '0px');
            return;
        }
        const publish = () => root.style.setProperty('--task-dock-h', `${el.offsetHeight}px`);
        publish();
        const ro = new ResizeObserver(publish);
        ro.observe(el);
        return () => {
            ro.disconnect();
            root.style.setProperty('--task-dock-h', '0px');
        };
    }, [collapsed, aiTasks.length]);

    if (aiTasks.length === 0) return null;

    const tasks = sortTasks(aiTasks);
    const activeCount = tasks.filter(t => t.status === 'running' || t.status === 'queued').length;
    const running = tasks.find(t => t.status === 'running');
    const visible = showAll ? tasks : tasks.slice(0, MAX_VISIBLE);
    const overflow = tasks.length - visible.length;

    if (collapsed) {
        return (
            // `w-max` for the same reason as the open bar below: a left-50%
            // fixed box otherwise gets only the half-screen to its right, and
            // this pill's label is a translated sentence.
            <div ref={dockRef} className="fixed bottom-3 left-1/2 z-40 w-max" style={DOCK_CENTRE}>
                <button
                    type="button"
                    onClick={() => setCollapsed(false)}
                    aria-label={tr("Show AI tasks ({{length}})", { length: aiTasks.length })}
                    className="flex items-center gap-2 px-3 h-9 rounded-xl bg-white dark:bg-slate-800 ring-1 ring-slate-900/10 dark:ring-white/10 shadow-lg shadow-slate-900/10 dark:shadow-black/40 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                    {running ? (
                        <span
                            className="w-2.5 h-2.5 rounded-full animate-pulse"
                            style={{ backgroundColor: running.projectColor || 'rgb(var(--accent-rgb))' }}
                            aria-hidden="true"
                        />
                    ) : (
                        <Sparkles className="w-3.5 h-3.5 text-accent-fg" aria-hidden="true" />
                    )}
                    {activeCount > 0
                        ? tr("{{count}} AI tasks", { count: activeCount })
                        : tr("{{length}} finished", { length: aiTasks.length })}
                    <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
            </div>
        );
    }

    return (
        <div
            ref={dockRef}
            // `w-max` is load-bearing, not tidying. A `fixed` box with `left:
            // 50%` and no `right` shrink-to-fits into the space from its left
            // edge to the edge of the screen — half the screen — and the
            // `translateX(-50%)` that centres it happens afterwards, in paint,
            // where it cannot give layout the width back. So the bar was capped
            // at 50vw (measured: 720 / 640 / 450px of bar for a 738px row at
            // 1440 / 1280 / 900px of screen), the `max-w-` below never applied,
            // and the third chip, the "+N" pill and the minimize button sat off
            // the end of a horizontal scroller nobody scrolls. `width:
            // max-content` is not clamped by the available space, so the cap is
            // the only thing that limits it — which is what it was written for.
            className="fixed bottom-3 left-1/2 z-40 w-max max-w-[calc(100vw-1.5rem-var(--assistant-w,0px))]"
            style={DOCK_CENTRE}
            role="status"
            aria-label={tr("Background AI tasks")}
        >
            {/* Opaque, not /95: this floats over lesson prose, and body text
                showing through a status bar is why it read as part of the page.
                `rounded-xl` rather than a capsule, because it holds rows. */}
            <div className="flex items-center gap-1 p-1 rounded-xl bg-white dark:bg-slate-800 ring-1 ring-slate-900/10 dark:ring-white/10 shadow-lg shadow-slate-900/10 dark:shadow-black/40">
                {/* Only the CHIPS scroll. Three of them are about 740px and a
                    phone is 390: with the whole bar as one scroller, the "+N"
                    pill and Minimize sat off the right-hand end of it, and a
                    control you have to discover a sideways swipe to reach is a
                    control that is not there. They are pinned outside it now,
                    and the row of chips takes whatever is left (`min-w-0`, or a
                    flex item refuses to shrink below its content).

                    `rail-scroll` because the scroller is ALWAYS live on a phone
                    — three chips is 740px against 390 — and a platform that
                    paints its scrollbar over the content (Android does) draws a
                    grey bar across the bottom of the chips, inside a rounded
                    floating bar 40px tall. The header's tab rail hides its own
                    for the same reason; this strip is the only one that did
                    not. What is off the end is still reachable by swipe, and
                    the "+N" pill beside it is what says there is more. */}
                <div className="rail-scroll flex items-center gap-1 min-w-0 overflow-x-auto">
                    {visible.map(task => (
                        <ChipExit key={task.id} leaving={leaving.has(task.id)}>
                            <TaskChip task={task} onHold={holdTask} onDismiss={beginExit} />
                        </ChipExit>
                    ))}
                </div>
                {overflow > 0 && (
                    <button
                        type="button"
                        onClick={() => setShowAll(true)}
                        aria-label={tr("Show {{count}} more AI tasks", { count: overflow })}
                        title={tr("{{overflow}} more queued", { overflow })}
                        className="shrink-0 flex items-center justify-center min-w-[2rem] h-8 px-2 rounded-lg bg-slate-100 dark:bg-slate-700 text-xs font-semibold tabular-nums text-slate-600 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-600 transition outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                        +{overflow}
                    </button>
                )}
                {showAll && tasks.length > MAX_VISIBLE && (
                    <button
                        type="button"
                        onClick={() => setShowAll(false)}
                        aria-label={tr("Show fewer AI tasks")}
                        title={tr("Show fewer")}
                        className="shrink-0 flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-700 transition outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                        <ChevronDown className="w-4 h-4 rotate-90" />
                    </button>
                )}
                <button
                    type="button"
                    onClick={() => setCollapsed(true)}
                    aria-label={tr("Minimize AI task bar")}
                    title={tr("Minimize")}
                    className="shrink-0 flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-700 transition outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                    <ChevronDown className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
}
