/**
 * The screen of ONE creation run: its progress, the tree as it is written, the
 * log, the model's thinking and the summary. Opened from the task dock, the
 * project card or the header, over whatever page the reader is on — closing it
 * never stops the run (the dock keeps showing it), and a second run has a
 * screen of its own.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import { Button } from '../ui/Button';
import ScrollShade from '../ui/ScrollShade';
import { useStore } from '../../store';
import CreationProgress from './CreationProgress';
import { ActivityLog, LiveStructureTree, stripMarkdown } from './CreationRunParts';
import { findGeneratingNode } from './liveTree';
import {
    COURSE_DIALOG_SIZE, cancelCreationRun, closeCreationView, isRunLive, reopenFormFrom, useCreationRuns,
} from './creationRuns';

export default function CreationRunView() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const openProject = useStore(s => s.openProject);
    const viewing = useCreationRuns(s => s.viewing);
    const run = useCreationRuns(s => (s.viewing ? s.runs[s.viewing] : undefined));

    const live = isRunLive(run);
    const activeNodeKey = useMemo(() => (run ? findGeneratingNode(run.tree)?.key ?? null : null), [run?.tree]);

    // The thinking opens while the model is thinking and folds once the run
    // moves on — the reader can open it again.
    const thinkingLive = run?.phase === 'thinking';
    const [thinkingOpen, setThinkingOpen] = useState(false);
    useEffect(() => { setThinkingOpen(thinkingLive); }, [thinkingLive, viewing]);
    const thinkingRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = thinkingRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [run?.thinking]);

    if (!run) return null;

    const goToProject = (id: number) => {
        closeCreationView();
        openProject(id);
    };
    const openable = run.projectId != null && (run.status === 'complete' || run.status === 'cancelled' || run.status === 'error');
    const needsSetup = run.status === 'error' && run.projectId == null;

    return (
        // The form's box, kept: Create swaps what is inside it and nothing else.
        // One scroll region, the buttons pinned under it.
        <Modal isOpen={!!viewing} onClose={closeCreationView} title={run.name} {...COURSE_DIALOG_SIZE} fill>
            <ScrollShade frameClassName="flex min-h-0 flex-1 flex-col" className="min-h-0 flex-1 px-6 py-4">
            <div className="space-y-3">
                {live && (
                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                        <p className="min-w-0 flex-1 basis-60 text-sm text-slate-600 dark:text-slate-300">
                            {t("You can close this — the project keeps generating, and the task bar at the bottom shows how far it has got.")}
                        </p>
                        <Button variant="danger" size="sm" icon={<X className="w-4 h-4" />} onClick={() => cancelCreationRun(run.key)}>
                            {t("Cancel")}
                        </Button>
                    </div>
                )}

                <CreationProgress run={run} />

                <LiveStructureTree tree={run.tree} activeNodeKey={activeNodeKey} />

                <ActivityLog entries={run.log} />

                {run.thinking && (
                    <details
                        open={thinkingOpen}
                        onToggle={e => setThinkingOpen((e.currentTarget as HTMLDetailsElement).open)}
                        className="rounded-xl border border-accent/30 dark:border-accent/40 bg-accent/10 overflow-hidden"
                    >
                        <summary className="flex items-center gap-2 px-3 py-2 min-h-11 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-xs font-medium text-accent-fg">
                            <Bot className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                            {t("Model thinking")}
                            {thinkingLive && <span className="w-1.5 h-3.5 bg-accent animate-pulse rounded-sm" aria-hidden="true" />}
                        </summary>
                        <div
                            ref={thinkingRef}
                            className="max-h-48 overflow-y-auto px-3 pb-3 text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed"
                        >
                            {run.thinking}
                        </div>
                    </details>
                )}

                {/* "Preparing summary…" is a promise only a live run can keep. */}
                {(run.summary || live) && (
                    <details open className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden">
                        <summary className="flex items-center px-3 py-2 min-h-11 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-xs font-medium text-slate-500 dark:text-slate-400">
                            {t("Project summary")}
                        </summary>
                        <p className="px-3 pb-3 text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                            {stripMarkdown(run.summary) || t("Preparing summary...")}
                        </p>
                    </details>
                )}
            </div>
            </ScrollShade>

            {(openable || needsSetup) && (
                <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-slate-200 px-6 py-3 dark:border-slate-700">
                    {run.status === 'complete' && run.projectId != null && (
                        <Button variant="primary" size="lg" block onClick={() => goToProject(run.projectId!)}>
                            {t("Go to Project")}
                        </Button>
                    )}
                    {(run.status === 'cancelled' || run.status === 'error') && run.projectId != null && (
                        <Button variant="neutral" size="lg" block onClick={() => goToProject(run.projectId!)}>
                            {t("Open Partial Project")}
                        </Button>
                    )}
                    {/* A run that stopped before it made a project leaves two
                        things to do: fix what stopped it (almost always the
                        model) or go back to the form, still holding what was
                        typed. */}
                    {run.status === 'error' && run.projectId == null && (
                        <>
                            <Button variant="neutral" onClick={() => { reopenFormFrom(run.key); navigate('/projects', { state: { create: true } }); }}>
                                {t("Back")}
                            </Button>
                            <Button variant="primary" onClick={() => { closeCreationView(); navigate('/settings#ai'); }}>
                                {t("Set up AI")}
                            </Button>
                        </>
                    )}
                </div>
            )}
        </Modal>
    );
}
