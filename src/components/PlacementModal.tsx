import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import { X, Compass, Check, ChevronRight, AlertTriangle, Undo2, Loader2 } from 'lucide-react';
import { PlacementProbe, PlacementQuestion, PlacementSummary } from '../types';
import MathText from './MathText';
import QuestionStem from './QuestionStem';
import { useStore } from '../store';
import { useTranslation } from 'react-i18next';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    projectId: number;
    projectName: string;
}

/**
 * "What do you already know?" — asked once, before the feed starts teaching.
 *
 * Three rules this screen exists to keep, all of them about not lying to the
 * learner about what a probe is:
 *
 *  1. **Answering is one-way.** The verdict and the explanation appear only
 *     after the answer is committed, and a committed answer is not editable.
 *     A probe you can revise while watching the feedback measures the feedback.
 *  2. **Getting one wrong costs nothing.** There is no score, no pass mark and
 *     no streak — a wrong answer simply means the topic gets taught, which is
 *     the ordinary case and must not read as a failure. So the running counter
 *     says "5 of 12 answered", never "3 correct".
 *  3. **It is undoable in full.** `Discard` reverses every head start and every
 *     evidence row. Without it, taking the probe carries a risk that skipping it
 *     does not, and the learner is quietly punished for engaging.
 *
 * Skipping a question is allowed and deliberately cheap: a probe abandoned
 * halfway still seeds what it measured, so "I don't know" is a legitimate,
 * useful answer rather than a reason to bail out of the whole thing.
 */
export default function PlacementModal({ isOpen, onClose, projectId, projectName }: Props) {
    const { t } = useTranslation();
    const [probe, setProbe] = useState<PlacementProbe | null>(null);
    const [summary, setSummary] = useState<PlacementSummary | null>(null);
    const [index, setIndex] = useState(0);
    const [draft, setDraft] = useState('');
    const [phase, setPhase] = useState<'idle' | 'authoring' | 'asking' | 'done'>('idle');
    const [progress, setProgress] = useState({ written: 0, total: 0 });
    const [verdict, setVerdict] = useState<{ correct: boolean; explanation: string; correctAnswer: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const addToast = useStore(s => s.addToast);
    const loadProjectData = useStore(s => s.loadProjectData);
    const currentProjectId = useStore(s => s.currentProjectId);

    const question: PlacementQuestion | undefined = probe?.questions[index];
    const answeredCount = probe?.questions.filter(q => q.answered).length ?? 0;

    // ---- start / resume ------------------------------------------------------
    const begin = useCallback(async () => {
        setError(null);
        setPhase('authoring');
        setProgress({ written: 0, total: 0 });
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const p = await api.startPlacement(
                projectId,
                (written, total) => setProgress({ written, total }),
                controller.signal,
            );
            setProbe(p);
            // Resume where the learner left off rather than at question 1.
            const next = p.questions.findIndex(q => !q.answered);
            setIndex(next === -1 ? 0 : next);
            setPhase(next === -1 && p.questions.length > 0 && p.answeredCount > 0 ? 'done' : 'asking');
        } catch (err: any) {
            if (err?.cancelled || controller.signal.aborted) { setPhase('idle'); return; }
            setError(err.message || 'The placement could not be prepared.');
            setPhase('idle');
        } finally {
            abortRef.current = null;
        }
    }, [projectId]);

    useEffect(() => {
        if (!isOpen) return;
        let cancelled = false;
        (async () => {
            try {
                const status = await api.getPlacement(projectId);
                if (cancelled) return;
                if (status.probe) {
                    setProbe(status.probe);
                    setSummary(status.summary);
                    if (status.probe.state === 'done') { setPhase('done'); return; }
                    if (status.probe.state === 'ready') {
                        const next = status.probe.questions.findIndex(q => !q.answered);
                        setIndex(next === -1 ? 0 : next);
                        setPhase(next === -1 ? 'done' : 'asking');
                        return;
                    }
                    // 'generating' or 'failed' — reattach / retry through start,
                    // which dedupes onto the run already in flight.
                    begin();
                }
            } catch (err: any) {
                if (!cancelled) setError(err.message || 'Could not read the placement status.');
            }
        })();
        return () => { cancelled = true; };
    }, [isOpen, projectId, begin]);

    useEffect(() => () => abortRef.current?.abort(), []);

    const close = useCallback(() => {
        abortRef.current?.abort();
        onClose();
    }, [onClose]);

    useEffect(() => {
        if (!isOpen) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isOpen, close]);

    // ---- answering -----------------------------------------------------------
    async function submit(answer: string) {
        if (!probe || !question || busy) return;
        setBusy(true);
        try {
            const res = await api.answerPlacement(probe.id, question.index, answer);
            setVerdict({ correct: res.correct, explanation: res.explanation, correctAnswer: res.correctAnswer });
            setProbe(res.probe);
        } catch (err: any) {
            setError(err.message || 'That answer could not be recorded.');
        } finally {
            setBusy(false);
        }
    }

    /** Move on — after an answer or past one the learner skipped. Skipping is
     *  the same motion deliberately: "I don't know" is a legitimate answer that
     *  simply seeds nothing, not a branch that needs its own bookkeeping. */
    function advance() {
        setVerdict(null);
        setDraft('');
        if (!probe) return;
        const next = probe.questions.findIndex((q, i) => i > index && !q.answered);
        if (next === -1) finish();
        else setIndex(next);
    }

    async function finish() {
        if (!probe) return;
        setBusy(true);
        try {
            const res = await api.finishPlacement(probe.id);
            setProbe(res.probe);
            setSummary(res.summary);
            setPhase('done');
            if (currentProjectId === projectId) loadProjectData(projectId);
        } catch (err: any) {
            setError(err.message || 'The placement could not be closed.');
        } finally {
            setBusy(false);
        }
    }

    async function discard() {
        setBusy(true);
        try {
            await api.discardPlacement(projectId);
            addToast('success', t("Placement discarded — every head start it gave has been removed."));
            if (currentProjectId === projectId) loadProjectData(projectId);
            close();
        } catch (err: any) {
            setError(err.message || 'The placement could not be discarded.');
        } finally {
            setBusy(false);
        }
    }

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/60 backdrop-blur-sm p-0 sm:p-4"
            onClick={close}>
            <div
                className="w-full sm:max-w-2xl max-h-[92vh] sm:max-h-[85vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-white dark:bg-slate-800 shadow-xl flex flex-col"
                onClick={e => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={t("Placement for {{projectName}}", { projectName })}
            >
                <header className="flex items-start gap-3 p-5 border-b border-slate-200 dark:border-slate-700">
                    <span className="mt-0.5 shrink-0 w-9 h-9 rounded-lg bg-accent/10 text-accent-fg flex items-center justify-center">
                        <Compass size={20} />
                    </span>
                    <div className="min-w-0 flex-1">
                        <h2 className="font-semibold text-slate-900 dark:text-slate-100">{t("Where should we start?")}</h2>
                        <p className="text-sm text-slate-500 dark:text-slate-400 truncate">{projectName}</p>
                    </div>
                    <button onClick={close} aria-label={t("Close")}
                        className="shrink-0 p-2 -m-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700">
                        <X size={18} />
                    </button>
                </header>

                {error && (
                    <div className="mx-5 mt-4 flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-3 text-sm text-amber-900 dark:text-amber-200">
                        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                {/* ---- the offer ---- */}
                {phase === 'idle' && (
                    <div className="p-5 space-y-4">
                        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                            {t("A few questions spread across this course, before any of it is taught. Topics you clearly already know start with a head start, so the feed spends its time on the rest.")}
                        </p>
                        <ul className="text-sm text-slate-500 dark:text-slate-400 space-y-1.5">
                            <li>{t("· Getting one wrong costs nothing — it just means that topic gets taught.")}</li>
                            <li>{t("· A head start is never a pass: you still prove every topic as you reach it.")}</li>
                            <li>{t("· You can undo the whole thing afterwards.")}</li>
                        </ul>
                        <button onClick={begin}
                            className="w-full rounded-lg bg-accent px-4 py-2.5 text-white font-medium hover:opacity-90">
                            {t("Start")}
                        </button>
                    </div>
                )}

                {/* ---- authoring ---- */}
                {phase === 'authoring' && (
                    <div className="p-8 flex flex-col items-center gap-3 text-center">
                        <Loader2 size={28} className="animate-spin text-accent" />
                        <p className="text-sm text-slate-600 dark:text-slate-300">
                            {progress.total
                                ? t("Writing question {{min}} of {{total}}…", { min: Math.min(progress.written + 1, progress.total), total: progress.total })
                                : t("Preparing the questions…")}
                        </p>
                        <p className="text-sm text-slate-500 dark:text-slate-400 max-w-sm">
                            {t("Each question is written and then solved again independently, so a broken one never reaches you. There's no hard timeout — it's fine to keep waiting.")}
                        </p>
                        <button onClick={close} className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 underline">
                            {t("Close — it keeps going in the background")}
                        </button>
                    </div>
                )}

                {/* ---- asking ---- */}
                {phase === 'asking' && question && (
                    <div className="p-5 space-y-4">
                        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                            {/* Answered, never "correct so far" — a probe has no score. */}
                            <span>{t("{{answeredCount}} of {{total}} answered", { answeredCount, total: probe?.total ?? 0 })}</span>
                            <span className="truncate max-w-[55%] text-right">{question.phaseTitle}</span>
                        </div>
                        <div className="h-1 rounded-full bg-slate-100 dark:bg-slate-700 overflow-hidden">
                            <div className="h-full bg-accent transition-all"
                                style={{ width: `${((answeredCount) / Math.max(1, probe?.total ?? 1)) * 100}%` }} />
                        </div>

                        <p className="text-xs font-medium text-accent-fg">{question.nodeTitle}</p>
                        <QuestionStem content={question.question} nodeId={question.nodeId} surface="placement" className="text-slate-900 dark:text-slate-100" />

                        {question.type === 'multiple_choice' ? (
                            <div className="space-y-2">
                                {question.options?.map(opt => {
                                    const isKey = verdict && opt === verdict.correctAnswer;
                                    return (
                                        <button
                                            key={opt}
                                            disabled={!!verdict || busy}
                                            onClick={() => submit(opt)}
                                            className={`w-full text-left rounded-lg border px-3 py-2.5 text-sm transition
                                                ${isKey
                                                    ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/20'
                                                    : 'border-slate-200 dark:border-slate-700 hover:border-accent can-hover:hover:bg-accent/5'}
                                                disabled:cursor-default`}
                                        >
                                            <MathText content={opt} />
                                        </button>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="space-y-2">
                                <textarea
                                    value={draft}
                                    onChange={e => setDraft(e.target.value)}
                                    disabled={!!verdict || busy}
                                    rows={3}
                                    placeholder={t("A sentence or two — or leave it and skip.")}
                                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 text-sm text-slate-900 dark:text-slate-100"
                                />
                                {!verdict && (
                                    <button
                                        onClick={() => submit(draft)}
                                        disabled={!draft.trim() || busy}
                                        className="w-full rounded-lg bg-accent px-4 py-2.5 text-white font-medium disabled:opacity-40"
                                    >
                                        {busy ? t("Checking…") : t("Answer")}
                                    </button>
                                )}
                            </div>
                        )}

                        {verdict && (
                            <div className={`rounded-lg p-3 text-sm ${verdict.correct
                                ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-900 dark:text-emerald-200'
                                : 'bg-slate-50 dark:bg-slate-900/40 text-slate-700 dark:text-slate-300'}`}>
                                <p className="font-medium mb-1">
                                    {/* Never "wrong" — the topic simply gets taught, and this
                                        screen must not turn that into a verdict on the learner. */}
                                    {verdict.correct ? t("You already have this one.") : t("We'll cover this one.")}
                                </p>
                                {verdict.explanation && <MathText content={verdict.explanation} />}
                            </div>
                        )}

                        <div className="flex gap-2 pt-1">
                            {verdict ? (
                                <button onClick={advance}
                                    className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-white font-medium hover:opacity-90 flex items-center justify-center gap-1.5">
                                    {t("Next")}{' '}<ChevronRight size={16} />
                                </button>
                            ) : (
                                <button onClick={advance} disabled={busy}
                                    className="flex-1 rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2.5 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50">
                                    {t("I don't know — skip")}
                                </button>
                            )}
                            <button onClick={finish} disabled={busy}
                                className="rounded-lg px-4 py-2.5 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300">
                                {t("Finish now")}
                            </button>
                        </div>
                    </div>
                )}

                {/* ---- done ---- */}
                {phase === 'done' && (
                    <div className="p-5 space-y-4">
                        <div className="flex items-start gap-3">
                            <span className="mt-0.5 w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 flex items-center justify-center shrink-0">
                                <Check size={18} />
                            </span>
                            <div>
                                <p className="font-medium text-slate-900 dark:text-slate-100">
                                    {summary?.headline ?? t("Placement finished.")}
                                </p>
                                {summary && (
                                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                                        {t("{{count}} questions answered.", { count: summary.answered })}
                                    </p>
                                )}
                            </div>
                        </div>
                        <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
                            {t("A head start lowers how much a topic is taught, never what it takes to prove it — every topic still goes through the same check before it counts as done.")}
                        </p>
                        <div className="flex gap-2">
                            <button onClick={close}
                                className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-white font-medium hover:opacity-90">
                                {t("Done")}
                            </button>
                            <button onClick={discard} disabled={busy}
                                className="rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2.5 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50 flex items-center gap-1.5">
                                <Undo2 size={15} /> {t("Discard")}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
