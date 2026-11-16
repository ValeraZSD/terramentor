import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Eye, EyeOff, FileText } from 'lucide-react';
import { api } from '../../api';
import { useStore } from '../../store';
import { Button, ButtonLink } from '../ui/Button';
import Stepper from '../ui/Stepper';
import ProgressBar from '../ui/ProgressBar';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import { useElementWidth } from '../../hooks/useElementWidth';
import { useRootFontSize } from '../../hooks/useRootFontSize';
import { uiLocale } from '../../utils/locale';
import { Panel } from './Panel';
import { useDuration } from './mockFormat';
import type { MockDetail } from './mockExamTypes';

/** One mock, whichever moment it is at: writing, marking or done. */
export default function MockSittingScreen({ sittingId, onClose }: { sittingId: number; onClose: () => void }) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const [detail, setDetail] = useState<MockDetail | null>(null);

    const load = useCallback(() => {
        api.getMock(sittingId).then(setDetail).catch(e => { addToast('error', e.message); onClose(); });
    }, [sittingId, addToast, onClose]);
    useEffect(() => { load(); }, [load]);
    // A re-read when the page shows again: a failure (a phone waking with no
    // signal) keeps the screen and its last reading; only the first load closes.
    const refresh = useCallback(() => { api.getMock(sittingId).then(setDetail).catch(() => {}); }, [sittingId]);

    return (
        <div className="flex-1 overflow-auto">
            <div className="mx-auto w-full max-w-4xl px-4 py-6 space-y-4">
                <div>
                    <Button variant="quiet" size="sm" icon={<ArrowLeft className="w-4 h-4" aria-hidden="true" />} onClick={onClose}>
                        {t("Mock exams")}
                    </Button>
                </div>
                {!detail && <Panel><div className="h-40" aria-busy="true" /></Panel>}
                {detail?.sitting.status === 'writing' && <ClockScreen detail={detail} onChange={setDetail} reload={refresh} />}
                {detail?.sitting.status === 'marking' && <MarkingScreen detail={detail} onChange={setDetail} />}
                {detail?.sitting.status === 'done' && <ResultScreen detail={detail} onDone={onClose} />}
            </div>
        </div>
    );
}

// ---- writing: the clock on the desk -------------------------------------------

function ClockScreen({ detail, onChange, reload }: { detail: MockDetail; onChange: (d: MockDetail) => void; reload: () => void }) {
    const { t } = useTranslation();
    const duration = useDuration();
    const addToast = useStore(s => s.addToast);
    const showConfirm = useStore(s => s.showConfirm);
    const { sitting, paper } = detail;
    const [hidden, setHidden] = useState(false);
    const [busy, setBusy] = useState(false);
    // The server's reading when it arrived, and when: the screen counts on
    // from there, so a reload or a second device shows the same time. Taken in
    // the render that first sees a new reading, so a Resume never counts the
    // paused minutes for a frame.
    const base = useMemo(() => ({ elapsed: sitting.elapsed, at: Date.now() }), [sitting]);
    const [, tick] = useState(0);
    useEffect(() => {
        if (!sitting.running) return;
        const id = window.setInterval(() => tick(n => n + 1), 1000);
        return () => window.clearInterval(id);
    }, [sitting.running]);
    const elapsed = base.elapsed + (sitting.running ? Math.floor((Date.now() - base.at) / 1000) : 0);
    const left = sitting.timeAllowed - elapsed;
    const timeUp = left <= 0;

    // The screen stays on while the clock runs: the device is the clock on the
    // desk. The browser drops the lock when the tab is hidden, so it is asked
    // for again when the tab comes back.
    useEffect(() => {
        if (!sitting.running || !('wakeLock' in navigator)) return;
        type Lock = { release: () => Promise<void> };
        const wake = (navigator as Navigator & { wakeLock: { request: (k: 'screen') => Promise<Lock> } }).wakeLock;
        let cancelled = false;
        let lock: Lock | null = null;
        const ask = () => {
            if (document.visibilityState !== 'visible') return;
            wake.request('screen')
                .then(l => { if (cancelled) void l.release().catch(() => {}); else lock = l; })
                .catch(() => { /* not granted: the clock still runs */ });
        };
        ask();
        document.addEventListener('visibilitychange', ask);
        return () => {
            cancelled = true;
            document.removeEventListener('visibilitychange', ask);
            void lock?.release().catch(() => {});
        };
    }, [sitting.running]);

    // Closing the tab or the app pauses the clock (MockExamView does that for
    // every running mock). When the page shows again (a restored tab, a phone
    // woken up) the screen re-reads the server's clock.
    useEffect(() => {
        const back = () => { if (document.visibilityState === 'visible') reload(); };
        window.addEventListener('pageshow', back);
        document.addEventListener('visibilitychange', back);
        return () => {
            window.removeEventListener('pageshow', back);
            document.removeEventListener('visibilitychange', back);
        };
    }, [reload]);

    const act = async (action: 'pause' | 'resume' | 'stop') => {
        if (action === 'stop') {
            const ok = await showConfirm({
                title: t("Stop the clock?"),
                message: t("You grade your paper next; the clock cannot be started again."),
                confirmLabel: t("Stop the clock"),
                variant: 'info',
            });
            if (!ok) return;
        }
        setBusy(true);
        api.mockClock(sitting.id, action)
            .then(r => onChange({ ...detail, sitting: r.sitting }))
            .catch(e => addToast('error', e.message))
            .finally(() => setBusy(false));
    };

    const what = sitting.question ? t("{{paper}}, question {{q}}", { paper: paper.title, q: sitting.question }) : paper.title;

    return (
        <Panel>
            <div className="flex flex-wrap items-start gap-3">
                <div className="flex-1 min-w-0">
                    <h2 className="text-base font-semibold text-slate-900 dark:text-white">{what}</h2>
                    <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">{t("Write on paper. The app keeps the time.")}</p>
                </div>
                {paper.paperDocumentId != null && (
                    <ButtonLink size="sm" href={api.documentOriginalUrl(paper.paperDocumentId)} target="_blank" rel="noopener" icon={<FileText className="w-4 h-4" aria-hidden="true" />}>
                        {t("Open the paper")}
                    </ButtonLink>
                )}
            </div>

            <div className="my-10 text-center" aria-live="off">
                {/* Time up wins over Paused and a hidden clock: there is nothing left to resume or hide. */}
                {timeUp ? (
                    <p className="text-3xl font-semibold text-slate-900 dark:text-white">{t("Time is up")}</p>
                ) : !sitting.running ? (
                    <p className="text-3xl font-semibold text-slate-900 dark:text-white">{t("Paused")}</p>
                ) : hidden ? (
                    <p className="text-3xl font-semibold text-slate-400 dark:text-slate-500">{t("Clock hidden")}</p>
                ) : (
                    <p className="text-5xl font-semibold tabular-nums text-slate-900 dark:text-white">{t("{{time}} left", { time: duration(left + 59) })}</p>
                )}
                {timeUp ? (
                    <p role="status" className="mt-3 text-sm text-slate-600 dark:text-slate-300">
                        {t("On the real exam you would hand in now. Finish your sentence, then grade what you wrote.")}
                    </p>
                ) : (
                    <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
                        {t("{{used}} used of {{allowed}}", { used: duration(elapsed), allowed: duration(sitting.timeAllowed) })}
                    </p>
                )}
                {sitting.running && !timeUp && (
                    <div className="mt-3">
                        <Button variant="quiet" size="sm" onClick={() => setHidden(h => !h)}
                            icon={hidden ? <Eye className="w-4 h-4" aria-hidden="true" /> : <EyeOff className="w-4 h-4" aria-hidden="true" />}>
                            {hidden ? t("Show the clock") : t("Hide the clock")}
                        </Button>
                    </div>
                )}
            </div>

            <div className="flex flex-wrap justify-end gap-2">
                {!timeUp && (
                    <Button busy={busy} onClick={() => act(sitting.running ? 'pause' : 'resume')}>
                        {sitting.running ? t("Pause") : t("Resume")}
                    </Button>
                )}
                <Button variant="primary" busy={busy} onClick={() => act('stop')}>{t("I am done")}</Button>
            </div>
        </Panel>
    );
}

// ---- marking: points per part beside the worked solution ------------------------

function MarkingScreen({ detail, onChange }: { detail: MockDetail; onChange: (d: MockDetail) => void }) {
    const { t } = useTranslation();
    const duration = useDuration();
    const fmt = useNumberFormat();
    const addToast = useStore(s => s.addToast);
    const showConfirm = useStore(s => s.showConfirm);
    const { sitting, paper, result } = detail;
    const questions = useMemo(() => [...new Set(result.parts.map(p => p.question))], [result.parts]);
    const [index, setIndex] = useState(0);
    const [finishing, setFinishing] = useState(false);
    // What the steppers show: the learner's latest press, ahead of the server.
    // Writes go one at a time, in order, and only the newest answer is shown,
    // so fast presses never come back out of order.
    const [drafts, setDrafts] = useState<Record<number, number | null>>({});
    const chain = useRef<Promise<unknown>>(Promise.resolve());
    const seq = useRef(0);
    const earnedOf = (p: { id: number; earned: number | null }) => (p.id in drafts ? drafts[p.id] : p.earned);

    const q = questions[Math.min(index, questions.length - 1)];
    const parts = result.parts.filter(p => p.question === q);
    const qEarned = parts.reduce((a, p) => a + (earnedOf(p) ?? 0), 0);
    const qPoints = parts.reduce((a, p) => a + p.points, 0);
    const paperEarned = result.parts.reduce((a, p) => a + (earnedOf(p) ?? 0), 0);
    const unmarked = result.parts.filter(p => earnedOf(p) == null);
    const last = index >= questions.length - 1;

    const wrapRef = useRef<HTMLDivElement>(null);
    const width = useElementWidth(wrapRef);
    const rem = useRootFontSize();
    const solution = paper.solutionDocumentId != null ? api.documentOriginalUrl(paper.solutionDocumentId) : null;
    const side = width >= 48 * rem && solution != null && paper.solutionKind === 'pdf';

    // The newest press per part: a failed write drops its part's draft unless
    // that part was pressed again since, so the screen never shows a grade the
    // server did not keep.
    const partSeq = useRef<Record<number, number>>({});
    const mark = (partId: number, points: number | null) => {
        const mine = ++seq.current;
        partSeq.current[partId] = mine;
        setDrafts(d => ({ ...d, [partId]: points }));
        const write = chain.current.then(() => api.markMockPart(sitting.id, partId, points));
        chain.current = write.catch(() => {});
        return write
            .then(d => { if (mine === seq.current) { onChange(d); setDrafts({}); } })
            .catch(e => {
                addToast('error', e.message);
                if (partSeq.current[partId] === mine) setDrafts(d => { const next = { ...d }; delete next[partId]; return next; });
            });
    };

    const finish = async () => {
        // Count what the SERVER holds once every press has landed, never the
        // screen's drafts: the confirm and the grade must agree.
        setFinishing(true);
        let held: MockDetail;
        try {
            await chain.current;
            held = await api.getMock(sitting.id);
        } catch (e) {
            addToast('error', (e as Error).message);
            setFinishing(false);
            return;
        }
        onChange(held);
        setDrafts({});
        setFinishing(false);
        const ungraded = held.result.unmarked;
        const ok = ungraded > 0
            ? await showConfirm({
                title: t("{{count}} parts have no points yet", { count: ungraded }),
                message: t("They count as 0 in the grade. Give them 0 now, or go back and grade them."),
                confirmLabel: t("Give them 0"),
                cancelLabel: t("Go back"),
                variant: 'info',
            })
            : await showConfirm({
                title: t("See your result?"),
                message: t("Your points can't be changed after this."),
                confirmLabel: t("See my result"),
                variant: 'info',
            });
        if (!ok) return;
        setFinishing(true);
        try {
            // "Give them 0" and the finish are one write on the server.
            onChange(await api.finishMock(sitting.id, ungraded > 0));
        } catch (e) {
            addToast('error', (e as Error).message);
            setFinishing(false);
        }
    };

    return (
        <div ref={wrapRef} className="space-y-4">
            <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{t("Grade your paper")}</h2>
                <p className="text-sm text-slate-600 dark:text-slate-300">
                    {t("{{paper}} · written in {{used}} of {{allowed}}", { paper: paper.title, used: duration(sitting.elapsed), allowed: duration(sitting.timeAllowed) })}
                </p>
                <p className="text-sm text-slate-600 dark:text-slate-300">
                    {t("Points go in halves. Each one is saved as you set it, so you can leave and come back.")}
                </p>
            </div>
            <div className={side ? 'grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-4 items-start' : 'space-y-4'}>
                {side && solution && (
                    <iframe title={t("Worked solution")} src={solution} className="w-full h-[70vh] rounded-2xl border border-slate-200 dark:border-slate-700 bg-white" />
                )}
                <Panel>
                    <div className="flex items-baseline justify-between gap-3">
                        <h3 className="text-base font-semibold text-slate-900 dark:text-white">{t("Question {{q}}", { q })}</h3>
                        {questions.length > 1 && (
                            <span className="text-sm tabular-nums text-slate-500 dark:text-slate-400">{t("{{n}} of {{total}}", { n: index + 1, total: questions.length })}</span>
                        )}
                    </div>
                    {!side && solution && (
                        <div className="mt-3">
                            <ButtonLink size="sm" href={solution} target="_blank" rel="noopener" icon={<FileText className="w-4 h-4" aria-hidden="true" />}>
                                {t("Open the worked solution")}
                            </ButtonLink>
                        </div>
                    )}
                    <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-700">
                        {parts.map(p => (
                            <li key={p.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
                                <span className="text-sm text-slate-700 dark:text-slate-200">
                                    {p.part ? `${p.part} · ` : ''}{t("{{count}} points", { count: p.points })}
                                    {earnedOf(p) == null && <span className="block text-xs text-slate-500 dark:text-slate-400">{t("no points yet")}</span>}
                                </span>
                                <Stepper value={earnedOf(p) ?? 0} min={0} max={p.points} step={0.5} onChange={v => { void mark(p.id, Math.round(v * 2) / 2); }}
                                    label={t("Points for {{part}}", { part: `${q}${p.part}` })} className="w-36" />
                            </li>
                        ))}
                    </ul>
                    <div className="mt-3 rounded-xl bg-slate-100 dark:bg-slate-900/60 px-4 py-2 flex justify-between text-sm">
                        <span className="text-slate-700 dark:text-slate-200">{t("This question")}</span>
                        <span className="font-semibold tabular-nums text-slate-900 dark:text-white">{t("{{earned}} of {{total}}", { earned: fmt(qEarned), total: fmt(qPoints) })}</span>
                    </div>
                    {sitting.question == null && (
                        <div className="px-4 py-2 flex justify-between text-sm text-slate-600 dark:text-slate-300">
                            <span>{t("Whole paper")}</span>
                            <span className="tabular-nums">{t("{{earned}} of {{total}}", { earned: fmt(paperEarned), total: fmt(result.total) })}</span>
                        </div>
                    )}
                    {last && unmarked.length > 0 && (
                        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                            {t("{{count}} parts have no points yet. They count as 0 in the grade.", { count: unmarked.length })}
                        </p>
                    )}
                    <div className="mt-4 flex flex-wrap justify-end gap-2">
                        {index > 0 && <Button onClick={() => setIndex(i => i - 1)}>{t("Previous")}</Button>}
                        {last
                            ? <Button variant="primary" busy={finishing} onClick={finish}>{t("See my result")}</Button>
                            : <Button variant="primary" onClick={() => setIndex(i => i + 1)}>{t("Next question")}</Button>}
                    </div>
                </Panel>
            </div>
        </div>
    );
}

// ---- the result ------------------------------------------------------------------

function ResultScreen({ detail, onDone }: { detail: MockDetail; onDone: () => void }) {
    const { t } = useTranslation();
    const duration = useDuration();
    const fmt = useNumberFormat();
    const { sitting, paper, result } = detail;
    const date = useMemo(() => new Intl.DateTimeFormat(uiLocale(), { day: 'numeric', month: 'short' }).format(new Date(sitting.startedAt)), [sitting.startedAt]);
    const graded = result.grade != null;
    // Evidence was written only for graded parts that name a topic (server/mockExams.js finishSitting).
    const practised = result.parts.some(p => p.nodeId != null && p.earned != null);
    const span = paper.gradeMax != null && paper.gradeMin != null ? fmt(paper.gradeMax - paper.gradeMin, { decimals: 0 }) : '';

    return (
        <div className="space-y-4">
            <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                    {sitting.question ? t("{{paper}}, question {{q}}, {{date}}", { paper: paper.title, q: sitting.question, date }) : t("{{paper}}, {{date}}", { paper: paper.title, date })}
                </h2>
                <p className="text-sm text-slate-600 dark:text-slate-300">
                    {t("Written on paper in {{used}} of {{allowed}} · graded by you against the worked solution", { used: duration(sitting.elapsed), allowed: duration(sitting.timeAllowed) })}
                </p>
            </div>
            <Panel>
                {graded ? (
                    <div className="flex flex-wrap items-end justify-between gap-4">
                        <div>
                            <p className="text-sm text-slate-600 dark:text-slate-300">{t("Grade")}</p>
                            <p className="text-5xl font-semibold tabular-nums text-slate-900 dark:text-white">{fmt(result.grade!, { decimals: 1 })}</p>
                            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{t("{{earned}} of {{total}} points", { earned: fmt(result.earned), total: fmt(result.total) })}</p>
                        </div>
                        <p className="max-w-sm text-sm text-slate-600 dark:text-slate-300">
                            {t("grade = {{earned}} / {{total}} × {{span}} + {{min}}, the formula printed on the paper.", { earned: fmt(result.earned), total: fmt(result.total), span, min: fmt(paper.gradeMin!) })}
                            {result.passPoints != null && ` ${t("Pass at {{pass}}, which is {{points}} points.", { pass: fmt(paper.passGrade!, { decimals: 1 }), points: fmt(result.passPoints) })}`}
                        </p>
                    </div>
                ) : (
                    <div>
                        <p className="text-5xl font-semibold tabular-nums text-slate-900 dark:text-white">{t("{{earned}} of {{total}}", { earned: fmt(result.earned), total: fmt(result.total) })}</p>
                        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                            {sitting.question ? t("points on this question. One question has no grade: the paper's formula is for the whole paper.") : t("points")}
                        </p>
                    </div>
                )}
                {result.passed != null && result.passPoints != null && (
                    <p className="mt-4 text-sm text-slate-700 dark:text-slate-200">
                        {result.passed
                            ? t("That is {{points}} points above the pass line.", { count: result.earned - result.passPoints, points: fmt(result.earned - result.passPoints) })
                            : t("That is {{points}} points short of the pass line.", { count: result.passPoints - result.earned, points: fmt(result.passPoints - result.earned) })}
                        {' '}{t("One paper, graded by you: a guide, not a forecast.")}
                    </p>
                )}
                {result.unmarked > 0 && (
                    <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{t("{{count}} parts were not graded and count as 0.", { count: result.unmarked })}</p>
                )}
            </Panel>
            <Panel>
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">{t("Where the points went")}</h3>
                <p className="text-sm text-slate-600 dark:text-slate-300">{t("Most points lost first")}</p>
                <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-700">
                    {result.questions.map(q => (
                        <li key={q.question} className="py-3">
                            <div className="flex items-baseline gap-x-4">
                                <span className="w-24 shrink-0 text-sm font-medium text-slate-900 dark:text-white">{t("Question {{q}}", { q: q.question })}</span>
                                <span className="flex-1 min-w-0 text-sm text-slate-600 dark:text-slate-300">{q.topics.map(x => x.title).join(' · ')}</span>
                                <span className="shrink-0 text-right text-sm tabular-nums text-slate-700 dark:text-slate-200">{t("{{earned}} of {{total}}", { earned: fmt(q.earned), total: fmt(q.points) })}</span>
                            </div>
                            <ProgressBar value={q.earned} max={q.points} size="sm" className="mt-2" label={t("Question {{q}}", { q: q.question })} />
                        </li>
                    ))}
                </ul>
                {practised && (
                    <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
                        {t("This counts as practice for each topic. It never marks a topic as done.")}
                    </p>
                )}
            </Panel>
            <div className="flex flex-wrap justify-end gap-2">
                {paper.solutionDocumentId != null && (
                    <ButtonLink href={api.documentOriginalUrl(paper.solutionDocumentId)} target="_blank" rel="noopener" >
                        {t("See the worked solution")}
                    </ButtonLink>
                )}
                <Button variant="primary" onClick={onDone}>{t("Done")}</Button>
            </div>
        </div>
    );
}
