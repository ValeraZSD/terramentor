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
 *  - the FOOT: Cancel while it runs, the way on once it has stopped.
 *
 * The box is the New course form's own (`COURSE_DIALOG_SIZE`): Create swaps
 * what is inside it and nothing else.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LocateFixed, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import { Button } from '../ui/Button';
import ScrollShade from '../ui/ScrollShade';
import SegmentedControl from '../ui/SegmentedControl';
import { useStore } from '../../store';
import { RunStatus, RunSteps } from './CreationProgress';
import { ActivityLog, LiveStructureTree, RUN_BODY_ATTR, stripMarkdown } from './CreationRunParts';
import type { LiveNode } from './liveTree';
import {
    COURSE_DIALOG_SIZE, cancelCreationRun, closeCreationView, isRunLive, reopenFormFrom, useCreationRuns,
} from './creationRuns';

type View = 'outline' | 'progress' | 'log';

/** The deepest node being written: the topic, not the phase that holds it. */
function activeLeaf(nodes: LiveNode[]): LiveNode | null {
    for (const node of nodes) {
        if (node.status !== 'generating') {
            const inner = activeLeaf(node.children);
            if (inner) return inner;
            continue;
        }
        return activeLeaf(node.children) ?? node;
    }
    return null;
}

/** Keys that move a scroller: pressed inside it, the reader is reading. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

export default function CreationRunView() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const openProject = useStore(s => s.openProject);
    const viewing = useCreationRuns(s => s.viewing);
    const run = useCreationRuns(s => (s.viewing ? s.runs[s.viewing] : undefined));

    const live = isRunLive(run);
    // Only a live run is writing anything: a failed one left its last topic
    // "generating" in the tree, and that row must not look busy afterwards.
    const activeNodeKey = useMemo(() => (run && live ? activeLeaf(run.tree)?.key ?? null : null), [run?.tree, live]);

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
    const stopFollowing = () => { if (follow) setFollow(false); };

    // One body, three views: a switch starts the new one at its top — except
    // the log, whose newest line is at the bottom.
    const body = () => document.querySelector<HTMLElement>(`[${RUN_BODY_ATTR}]`);
    const atEnd = useRef(false);
    useLayoutEffect(() => {
        const el = body();
        if (!el) return;
        el.scrollTop = view === 'log' ? el.scrollHeight : 0;
        atEnd.current = view === 'log';
    }, [view]);
    // The Progress notes and the Activity log grow at the bottom: a body
    // already at its end stays there, one scrolled up to read stays put.
    const growth = view === 'log' ? run?.log.length : view === 'progress' ? run?.thinking.length : undefined;
    useLayoutEffect(() => {
        const el = body();
        if (el && growth !== undefined && atEnd.current) el.scrollTop = el.scrollHeight;
    }, [growth]);

    if (!run) return null;

    const goToProject = (id: number) => {
        closeCreationView();
        openProject(id);
    };
    const openable = run.projectId != null && (run.status === 'complete' || run.status === 'cancelled' || run.status === 'error');
    const needsSetup = run.status === 'error' && run.projectId == null;
    const summary = stripMarkdown(run.summary);

    const views = [
        ...(hasOutline ? [{ value: 'outline' as const, label: t("Outline") }] : []),
        { value: 'progress' as const, label: t("Progress") },
        ...(run.log.length > 0 ? [{ value: 'log' as const, label: t("Activity log") }] : []),
    ];

    return (
        <Modal isOpen={!!viewing} onClose={closeCreationView} title={run.name} {...COURSE_DIALOG_SIZE} fill>
            <div className="shrink-0 space-y-3 border-b border-slate-200 px-6 pb-3 pt-4 dark:border-slate-700">
                <RunStatus run={run} />
                {views.length > 1 && (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <SegmentedControl<View> label={t("Show")} size="sm" value={view} options={views} onChange={setPicked} />
                        {view === 'outline' && live && !follow && activeNodeKey && (
                            <Button size="sm" variant="quiet" icon={<LocateFixed className="h-4 w-4" />} onClick={() => setFollow(true)}>
                                {t("Current topic")}
                            </Button>
                        )}
                    </div>
                )}
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
                }}
                tabIndex={0}
                aria-label={views.find(v => v.value === view)?.label}
            >
                {view === 'outline' && (
                    <div className="space-y-4">
                        {summary && <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">{summary}</p>}
                        <LiveStructureTree tree={run.tree} activeNodeKey={activeNodeKey} follow={follow && live} live={live} />
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
            </ScrollShade>

            <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-4 gap-y-2 border-t border-slate-200 px-6 py-3 dark:border-slate-700">
                {live ? (
                    <>
                        <p className="min-w-0 flex-1 basis-40 text-sm text-slate-500 dark:text-slate-400">
                            {t("Closing this window does not stop it: the task bar at the bottom keeps showing it.")}
                        </p>
                        <Button variant="danger" icon={<X className="w-4 h-4" />} onClick={() => cancelCreationRun(run.key)}>
                            {t("Cancel")}
                        </Button>
                    </>
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
