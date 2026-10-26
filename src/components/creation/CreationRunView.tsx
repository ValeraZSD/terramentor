/**
 * The screen of ONE creation run. Opened from the task dock, the project card
 * or the header, over whatever page the reader is on — closing it never stops
 * the run (the dock keeps showing it), and a second run has a screen of its own.
 *
 * Three parts, and only one of them scrolls:
 *
 *  - the HEAD (`RunStatus`): what it is doing, how far, how long is left, one
 *    bar. Fixed, so the answer is on screen whatever is being read below it.
 *  - the BODY: one of three views — the Outline as it is written, the Progress
 *    of each stage with the model's planning notes, the Activity log. One
 *    switch, one scroll region. The four boxes it replaced (outline, log,
 *    notes, each with its own `max-h` scroll, inside a dialog that scrolled
 *    too) showed the outline three rows tall in a dialog this size.
 *  - the FOOT: Stop (which asks first) and Close while it runs, the way on
 *    once it has stopped.
 *
 * The box is the New course form's own (`COURSE_DIALOG_SIZE`): Create swaps
 * what is inside it and nothing else.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import { Button } from '../ui/Button';
import ScrollShade from '../ui/ScrollShade';
import SegmentedControl from '../ui/SegmentedControl';
import { useElementWidth } from '../../hooks/useElementWidth';
import { useStore } from '../../store';
import { RunStatus, RunSteps } from './CreationProgress';
import { ACTIVE_ROW_ATTR, ActivityLog, LiveStructureTree, RUN_BODY_ATTR, stripMarkdown } from './CreationRunParts';
import { activeLeaf } from './liveTree';
import {
    COURSE_DIALOG_SIZE, cancelCreationRun, closeCreationView, isRunLive, reopenFormFrom, useCreationRuns,
} from './creationRuns';

type View = 'outline' | 'progress' | 'log';

/** Below this the two buttons stack: each then fills its row, not two ragged widths. */
const ACTIONS_STACK_BELOW = 520;

/**
 * The foot while the run is live. Closing is the calm answer and says so on
 * the button; stopping hours of work names what it stops, and asks (`onStop`).
 * Its own component so the width is measured from the moment it mounts.
 */
function LiveActions({ onStop }: { onStop: () => void }) {
    const { t } = useTranslation();
    const ref = useRef<HTMLDivElement>(null);
    const width = useElementWidth(ref);
    const stacked = width > 0 && width < ACTIONS_STACK_BELOW;
    return (
        <div ref={ref} className="flex w-full flex-wrap items-center justify-end gap-x-4 gap-y-2">
            <Button variant="danger" block={stacked} onClick={onStop}>{t("Stop creating")}</Button>
            <Button variant="neutral" block={stacked} onClick={closeCreationView}>{t("Close — creation carries on")}</Button>
        </div>
    );
}

/** Keys that move a scroller: pressed inside it, the reader is reading. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

export default function CreationRunView() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const openProject = useStore(s => s.openProject);
    const showConfirm = useStore(s => s.showConfirm);
    const viewing = useCreationRuns(s => s.viewing);
    const run = useCreationRuns(s => (s.viewing ? s.runs[s.viewing] : undefined));

    const live = isRunLive(run);
    // The topic in hand — or, once a run has failed or been stopped, the one it
    // stopped on (left "generating" in the tree; the outline draws it as
    // stopped, not busy). The outline opens there: a failure opened at the
    // top of the course showed every topic ticked and the stopped one out of sight.
    const activeNodeKey = useMemo(() => (run ? activeLeaf(run.tree)?.key ?? null : null), [run?.tree]);

    // Which view: the run's own choice until the reader picks one — the
    // Progress while there is no outline yet (the model is planning, and its
    // notes are what there is to read), the Outline once there is one.
    const [picked, setPicked] = useState<View | null>(null);
    useEffect(() => { setPicked(null); }, [viewing]);
    const hasOutline = (run?.tree.length ?? 0) > 0;
    const view: View = picked ?? (hasOutline ? 'outline' : 'progress');

    // The outline follows the topic being written until the reader scrolls it.
    const [follow, setFollow] = useState(true);
    useEffect(() => { setFollow(true); }, [viewing]);
    // Only reading the OUTLINE stops it: scrolling the log, then switching back,
    // found the outline at its top and no longer following.
    const stopFollowing = () => { if (follow && view === 'outline') setFollow(false); };
    // Where that topic is while the reader is elsewhere: above the body, below
    // it, or in view (null) — the way back is offered only when it is out of
    // sight, and points at it.
    const [away, setAway] = useState<'up' | 'down' | null>(null);

    // One body, three views: a switch starts the new one at its top — except
    // the log, whose newest line is at the bottom.
    const body = () => document.querySelector<HTMLElement>(`[${RUN_BODY_ATTR}]`);
    const atEnd = useRef(false);
    useLayoutEffect(() => {
        const el = body();
        if (!el) return;
        el.scrollTop = view === 'log' ? el.scrollHeight : 0;
        // A view that fits is at its end too, so notes that outgrow it are followed.
        atEnd.current = view === 'log' || el.scrollHeight - el.clientHeight <= 24;
    }, [view]);
    // The Progress notes and the Activity log grow at the bottom: a body
    // already at its end stays there, one scrolled up to read stays put.
    const growth = view === 'log' ? run?.log.length : view === 'progress' ? run?.thinking.length : undefined;
    useLayoutEffect(() => {
        const el = body();
        if (el && growth !== undefined && atEnd.current) el.scrollTop = el.scrollHeight;
    }, [growth]);

    const measureActive = () => {
        const el = body();
        const row = el?.querySelector<HTMLElement>(`[${ACTIVE_ROW_ATTR}]`);
        if (!el || !row) { setAway(null); return; }
        const b = el.getBoundingClientRect();
        const r = row.getBoundingClientRect();
        setAway(r.bottom <= b.top + 8 ? 'up' : r.top >= b.bottom - 8 ? 'down' : null);
    };
    // The topic moves on (or the outline grows) while the reader holds still.
    useLayoutEffect(measureActive, [activeNodeKey, run?.tree, view]);

    if (!run) return null;

    const goToProject = (id: number) => {
        closeCreationView();
        openProject(id);
    };
    const openable = run.projectId != null && (run.status === 'complete' || run.status === 'cancelled' || run.status === 'error');
    const needsSetup = run.status === 'error' && run.projectId == null;
    const summary = stripMarkdown(run.summary);

    // All three, always, in one order: a view with nothing in it yet is
    // disabled, never left out — the Outline arriving in front of the others
    // moved them out from under the pointer.
    const views = [
        { value: 'outline' as const, label: t("Outline"), disabled: !hasOutline },
        { value: 'progress' as const, label: t("Progress") },
        { value: 'log' as const, label: t("Activity log"), disabled: run.log.length === 0 },
    ];
    const showJump = view === 'outline' && live && !follow && !!activeNodeKey && away != null;

    const stop = async () => {
        const ok = await showConfirm({
            title: t("Stop creating this course?"),
            message: t("What is written so far stays as a course you can open. The rest is not written."),
            // Short: the title says what stops, and two words each wrapped in
            // a dialog this narrow.
            confirmLabel: t("Stop"),
            cancelLabel: t("Continue"),
            variant: 'warning',
        });
        if (ok) cancelCreationRun(run.key);
    };

    return (
        <Modal isOpen={!!viewing} onClose={closeCreationView} title={run.name} {...COURSE_DIALOG_SIZE} fill>
            <div className="shrink-0 space-y-3 border-b border-slate-200 px-6 pb-3 pt-4 dark:border-slate-700">
                <RunStatus run={run} />
                <SegmentedControl<View> label={t("Show")} size="sm" value={view} options={views} onChange={setPicked} />
            </div>

            <ScrollShade
                frameClassName="flex min-h-0 flex-1 flex-col"
                className="min-h-0 flex-1 px-6 py-4"
                {...{ [RUN_BODY_ATTR]: '' }}
                onWheel={stopFollowing}
                onTouchMove={stopFollowing}
                onKeyDown={e => { if (SCROLL_KEYS.has(e.key)) stopFollowing(); }}
                // A press on the scroller itself (not on a row) is its scrollbar.
                onPointerDown={e => { if (e.target === e.currentTarget) stopFollowing(); }}
                // Capture, not onScroll: that one is ScrollShade's own shading.
                onScrollCapture={e => {
                    const el = e.currentTarget;
                    atEnd.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
                    if (view === 'outline') measureActive();
                }}
                tabIndex={0}
                role="region"
                aria-label={views.find(v => v.value === view)?.label}
            >
                {view === 'outline' && (
                    <div className="space-y-4">
                        {summary && <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">{summary}</p>}
                        <LiveStructureTree tree={run.tree} activeNodeKey={activeNodeKey} follow={follow} live={live} />
                    </div>
                )}
                {view === 'progress' && (
                    <div className="space-y-5">
                        <RunSteps run={run} />
                        {run.thinking && (
                            <section>
                                <h3 className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">{t("Model thinking")}</h3>
                                <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700 dark:text-slate-300">{run.thinking.trim()}</p>
                            </section>
                        )}
                        {summary && !hasOutline && (
                            <section>
                                <h3 className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">{t("Project summary")}</h3>
                                <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">{summary}</p>
                            </section>
                        )}
                    </div>
                )}
                {view === 'log' && <ActivityLog entries={run.log} />}
                {/* Floats on the list's bottom edge, so offering it moves
                    nothing (a row of its own pushed the list down mid-read)
                    and it covers only the row already fading out there. */}
                {showJump && (
                    <div className="pointer-events-none sticky -bottom-4 z-10 -mb-4 flex justify-center pb-1.5 pt-3">
                        <Button
                            size="sm"
                            variant="neutral"
                            // Opaque: the outline variant is see-through, and the row under it read through the label.
                            className="pointer-events-auto bg-white shadow-md dark:bg-slate-800"
                            icon={away === 'up' ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
                            onClick={() => setFollow(true)}
                        >
                            {t("Current topic")}
                        </Button>
                    </div>
                )}
            </ScrollShade>

            <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-4 gap-y-2 border-t border-slate-200 px-6 py-3 dark:border-slate-700">
                {live ? (
                    <LiveActions onStop={stop} />
                ) : openable ? (
                    <Button variant="primary" onClick={() => goToProject(run.projectId!)}>
                        {run.status === 'complete' ? t("Go to Project") : t("Open Partial Project")}
                    </Button>
                ) : needsSetup ? (
                    // A run that stopped before it made a project leaves two
                    // things to do: fix what stopped it (almost always the
                    // model) or go back to the form, still holding what was typed.
                    <>
                        <Button variant="neutral" onClick={() => { reopenFormFrom(run.key); navigate('/projects', { state: { create: true } }); }}>
                            {t("Back")}
                        </Button>
                        <Button variant="primary" onClick={() => { closeCreationView(); navigate('/settings#ai'); }}>
                            {t("Set up AI")}
                        </Button>
                    </>
                ) : (
                    <Button variant="neutral" onClick={closeCreationView}>{t("Close")}</Button>
                )}
            </div>
        </Modal>
    );
}
