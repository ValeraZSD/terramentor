import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import type { BulkCandidate, BulkJobStatus, BulkKind } from '../types';
import {
    AlertTriangle, CheckCircle2, ChevronDown, Layers, Loader2, Pause, Search,
    ShieldCheck, Sparkles, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Checkbox from './Checkbox';

/**
 * "Make me the material for all of this" — the exam-week button.
 *
 * Three things shape the design, and the first two are why it was rebuilt.
 *
 *  1. THE KINDS ARE NOT PEERS, AND ONE OF THEM WAS MISLABELLED. A node's saved
 *     questions ARE its mastery check bank (`MasteryGateModal` reads every
 *     non-ghost question the node owns and only generates when it finds none),
 *     so "generate a quiz" was never making a throwaway practice quiz — it was
 *     pre-loading the one assessment that decides whether a topic counts as
 *     proven, and doing it at 5 questions where the gate itself asks for 10.
 *     Naming it "Quiz" made the valuable path look like the skippable one. It
 *     is a mastery check here, sized to clear the gate, and the card says what it
 *     unlocks: the gate opens instantly instead of generating while you wait.
 *  2. A FLAT LIST OF 96 LEAVES IS NOT A CHOICE. Real curricula name half their
 *     leaves "Introduction", so the picker groups by top-level section with a
 *     select-the-whole-section control and a search box. "Everything in
 *     Electricity and Magnetism" is one tap, which is what a learner actually
 *     means by "generate for this phase".
 *  3. THE COST IS STATED IN WHAT WILL HAPPEN, NOT IN MINUTES. The footer used
 *     to price the run from the server's rolling per-call average. It was a
 *     real measurement and still the wrong thing to print: the job pauses
 *     whenever the tutor is used, so the one number a learner would plan
 *     around is the one the app cannot hold itself to. It says how many topics
 *     and how many generations, and that it runs in the background. The live
 *     "~x left" stays — it reads the run in progress, for someone who has
 *     already pressed the button.
 *
 * Once running, the job belongs to the server: closing this dialog, navigating
 * away or reloading changes nothing, and material is committed topic by topic.
 */

type Preset = 'open' | 'overdue' | 'missing' | 'all' | 'none';

const QUESTION_CHOICES = [6, 10, 15];
const CARD_CHOICES = [5, 10, 15];

/** "~4 min" / "~1 h 10 min" — never seconds, which imply a precision we lack. */
function formatDuration(ms: number): string {
    const mins = Math.max(1, Math.round(ms / 60000));
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
}

const isOpen = (c: BulkCandidate) => c.status !== 'completed' && c.status !== 'skipped';

export default function BulkGenerateModal({ projectId, onClose }: { projectId: number; onClose: () => void }) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const [candidates, setCandidates] = useState<BulkCandidate[] | null>(null);
    const [max, setMax] = useState(60);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [kinds, setKinds] = useState<BulkKind[]>(['flashcards', 'mastery_check']);
    const [questionCount, setQuestionCount] = useState(10);
    const [cardCount, setCardCount] = useState(10);
    const [skipExisting, setSkipExisting] = useState(true);
    const [query, setQuery] = useState('');
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const [job, setJob] = useState<BulkJobStatus | null>(null);
    const [starting, setStarting] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [capped, setCapped] = useState(false);

    const today = new Date().toISOString().slice(0, 10);

    useEffect(() => {
        let alive = true;
        api.getBulkCandidates(projectId)
            .then(res => {
                if (!alive) return;
                setCandidates(res.candidates);
                setMax(res.max);
                // Default = still-open topics that are actually missing something.
                // Selecting work already done is how a learner spends twenty
                // minutes of GPU time on nothing.
                const want = res.candidates.filter(c => isOpen(c) && (!c.gateReady || c.flashcards === 0));
                setSelected(new Set(want.slice(0, res.max).map(c => c.nodeId)));
                setCapped(want.length > res.max);
            })
            .catch(e => { if (alive) setLoadError(e.message); });
        return () => { alive = false; };
    }, [projectId]);

    // Poll the server's job while one is live. The job is server-owned, so this
    // also picks up a run started before this dialog was even opened.
    useEffect(() => {
        let alive = true;
        let timer: number | undefined;
        const tick = async () => {
            try {
                const status = await api.getBulkStatus();
                if (!alive) return;
                setJob(status);
                if (status && status.status === 'running') timer = window.setTimeout(tick, 1500);
            } catch { /* a poll that fails is retried by the next one */ }
        };
        void tick();
        return () => { alive = false; if (timer) window.clearTimeout(timer); };
    }, [starting]);

    /** Does this topic still need the currently-chosen kinds? Mirrors `needsKind`. */
    const needs = useCallback((c: BulkCandidate) =>
        kinds.some(k => k === 'mastery_check' ? !c.gateReady : c.flashcards === 0), [kinds]);

    const applyPreset = useCallback((preset: Preset) => {
        if (!candidates) return;
        const pick = (fn: (c: BulkCandidate) => boolean) => {
            const hits = candidates.filter(fn);
            setCapped(hits.length > max);
            return new Set(hits.slice(0, max).map(c => c.nodeId));
        };
        if (preset === 'none') { setCapped(false); setSelected(new Set()); }
        else if (preset === 'all') setSelected(pick(() => true));
        else if (preset === 'open') setSelected(pick(isOpen));
        else if (preset === 'missing') setSelected(pick(c => isOpen(c) && needs(c)));
        else setSelected(pick(c => !!c.scheduledEnd && c.scheduledEnd <= today && isOpen(c)));
    }, [candidates, max, today, needs]);

    const toggle = (nodeId: number) => setSelected(prev => {
        const next = new Set(prev);
        if (next.has(nodeId)) next.delete(nodeId);
        else if (next.size < max) next.add(nodeId);
        return next;
    });

    /** Rows that survive the search box, grouped under their top-level section. */
    const groups = useMemo<Array<[string, BulkCandidate[]]>>(() => {
        if (!candidates) return [];
        const q = query.trim().toLowerCase();
        const rows = q
            ? candidates.filter(c => `${c.title} ${c.path}`.toLowerCase().includes(q))
            : candidates;
        const bySection = new Map<string, BulkCandidate[]>();
        for (const c of rows) {
            const key = c.section || 'Topics';
            if (!bySection.has(key)) bySection.set(key, []);
            bySection.get(key)!.push(c);
        }
        return [...bySection.entries()];
    }, [candidates, query]);

    // The honest cost of pressing the button: one model call per topic per
    // kind, minus whatever "only what's missing" takes off. Counted, not timed.
    const plan = useMemo(() => {
        if (!candidates) return { topics: 0, calls: 0, skipped: 0 };
        let calls = 0, topics = 0, skipped = 0;
        for (const c of candidates) {
            if (!selected.has(c.nodeId)) continue;
            const todo = kinds.filter(k => !skipExisting || (k === 'mastery_check' ? !c.gateReady : c.flashcards === 0));
            if (!todo.length) { skipped++; continue; }
            topics++;
            calls += todo.length;
        }
        return { topics, calls, skipped };
    }, [candidates, selected, kinds, skipExisting]);

    const running = job?.status === 'running';

    const start = async () => {
        setStarting(true);
        try {
            const status = await api.startBulkGeneration({
                projectId, nodeIds: [...selected], kinds, questionCount, cardCount, skipExisting,
            });
            setJob(status);
            addToast('info', t("Generating study material"),
                t("It runs in the background and pauses whenever you use the tutor. You can close this."));
        } catch (e: any) {
            addToast('error', t("Could not start"), e.message);
        } finally {
            setStarting(false);
        }
    };

    const cancel = async () => {
        try {
            await api.cancelBulkGeneration();
            addToast('info', t("Stopped"), t("Everything generated so far is saved."));
        } catch (e: any) {
            addToast('error', t("Could not stop it"), e.message);
        }
    };

    const toggleKind = (k: BulkKind) => setKinds(prev =>
        prev.includes(k) ? prev.filter(x => x !== k) : [...prev, k]);

    return (
        <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 sm:p-4"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
            role="dialog"
            aria-modal="true"
            aria-label={t("Generate study material")}
        >
            <div className="bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-3xl h-[92vh] sm:h-auto sm:max-h-[90vh] flex flex-col overflow-hidden">
                <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-200 dark:border-slate-700">
                    <div className="flex items-center gap-3 min-w-0">
                        <span className="w-10 h-10 rounded-xl bg-accent/15 flex items-center justify-center shrink-0">
                            <Sparkles className="w-5 h-5 text-accent-fg" aria-hidden="true" />
                        </span>
                        <div className="min-w-0">
                            <h2 className="font-semibold text-slate-900 dark:text-white leading-tight">{t("Generate study material")}</h2>
                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                {t("Mastery checks and flashcards for many topics at once")}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition"
                        aria-label={t("Close")}
                    >
                        <X className="w-4 h-4" />
                    </button>
                </header>

                {job && (running || job.done > 0) && (
                    <RunPanel job={job} running={!!running} onCancel={cancel} />
                )}

                <div className="flex-1 overflow-y-auto">
                    {/* 1 — what to make */}
                    <section className="px-5 py-4 space-y-3">
                        <StepLabel n={1} title={t("What to make")} />
                        <div className="grid sm:grid-cols-2 gap-3">
                            <KindCard
                                active={kinds.includes('mastery_check')}
                                onClick={() => toggleKind('mastery_check')}
                                icon={<ShieldCheck className="w-4 h-4" />}
                                label={t("Mastery check")}
                                blurb={t("Questions that prove the topic. Fills the mastery gate, so it opens instantly instead of generating while you wait.")}
                                countLabel={t("questions")}
                                choices={QUESTION_CHOICES}
                                value={questionCount}
                                onValue={setQuestionCount}
                            />
                            <KindCard
                                active={kinds.includes('flashcards')}
                                onClick={() => toggleKind('flashcards')}
                                icon={<Layers className="w-4 h-4" />}
                                label={t("Flashcards")}
                                blurb={t("Facts worth keeping. They join the daily review queue and are scheduled from the first answer.")}
                                countLabel={t("cards")}
                                choices={CARD_CHOICES}
                                value={cardCount}
                                onValue={setCardCount}
                            />
                        </div>
                    </section>

                    {/* 2 — which topics */}
                    <section className="px-5 pb-2 space-y-3">
                        <StepLabel n={2} title={t("Which topics")} />

                        <div className="flex flex-wrap items-center gap-2">
                            <label className="relative flex-1 min-w-[10rem]">
                                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                                <input
                                    value={query}
                                    onChange={e => setQuery(e.target.value)}
                                    placeholder={t("Search topics")}
                                    aria-label={t("Search topics")}
                                    className="w-full pl-8 pr-3 py-2 text-sm rounded-xl border border-slate-300 dark:border-slate-600 bg-transparent text-slate-700 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-accent/50"
                                />
                            </label>
                            <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300 px-1 min-h-[44px]">
                                <Checkbox checked={skipExisting} onChange={setSkipExisting} />
                                {t("Only what’s missing")}
                            </label>
                        </div>

                        <div className="flex items-center gap-2 text-xs overflow-x-auto rail-scroll -mx-1 px-1">
                            {([['missing', t("Missing material")], ['open', t("Still open")], ['overdue', t("Overdue")], ['all', t("Everything")], ['none', t("None")]] as const)
                                .map(([p, label]) => (
                                    <button
                                        key={p}
                                        onClick={() => applyPreset(p)}
                                        className="shrink-0 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:border-accent/50 hover:text-accent-fg transition"
                                    >
                                        {label}
                                    </button>
                                ))}
                            <span className="ml-auto shrink-0 text-slate-500 dark:text-slate-400 tabular-nums">
                                {selected.size}/{candidates?.length ?? 0}
                            </span>
                        </div>

                        {capped && (
                            <p className="text-sm text-amber-600 dark:text-amber-400">
                                {t("Capped at {{max}} topics per run — generate the rest in a second pass.", { max })}
                            </p>
                        )}
                    </section>

                    <div className="px-3 pb-2">
                        {loadError && <p className="p-4 text-sm text-red-500">{loadError}</p>}
                        {!candidates && !loadError && (
                            <div className="p-6 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
                        )}
                        {candidates?.length === 0 && (
                            <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
                                {t("This project has no topics to generate for yet.")}
                            </p>
                        )}
                        {candidates && candidates.length > 0 && groups.length === 0 && (
                            <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
                                {t("No topic matches “{{query}}”.", { query })}
                            </p>
                        )}
                        {groups.map(([section, rows]) => {
                            const on = rows.filter(r => selected.has(r.nodeId)).length;
                            const shut = collapsed.has(section);
                            return (
                                <div key={section} className="mb-1">
                                    <div className="flex items-center gap-2 px-2 sticky top-0 bg-white dark:bg-slate-800 z-10">
                                        <Checkbox
                                            checked={on === rows.length && rows.length > 0}
                                            indeterminate={on > 0 && on < rows.length}
                                            onChange={() => setSelected(prev => {
                                                const next = new Set(prev);
                                                if (on === rows.length) rows.forEach(r => next.delete(r.nodeId));
                                                else rows.forEach(r => { if (next.size < max) next.add(r.nodeId); });
                                                return next;
                                            })}
                                            aria-label={t("Select every topic in {{section}}", { section })}
                                        />
                                        <button
                                            onClick={() => setCollapsed(prev => {
                                                const next = new Set(prev);
                                                if (!next.delete(section)) next.add(section);
                                                return next;
                                            })}
                                            aria-expanded={!shut}
                                            className="flex-1 min-w-0 flex items-center gap-1.5 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 hover:text-accent-fg transition py-2.5"
                                        >
                                            <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${shut ? '-rotate-90' : ''}`} />
                                            <span className="truncate">{section}</span>
                                            <span className="shrink-0 font-normal normal-case tabular-nums text-slate-500 dark:text-slate-400">
                                                {on}/{rows.length}
                                            </span>
                                        </button>
                                    </div>
                                    {!shut && rows.map(c => (
                                        <TopicRow
                                            key={c.nodeId}
                                            c={c}
                                            section={section}
                                            on={selected.has(c.nodeId)}
                                            kinds={kinds}
                                            skipExisting={skipExisting}
                                            onToggle={() => toggle(c.nodeId)}
                                        />
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                </div>

                <footer className="px-5 py-4 border-t border-slate-200 dark:border-slate-700 flex flex-wrap items-center gap-3">
                    <p className="text-sm text-slate-500 dark:text-slate-400 min-w-0 flex-1">
                        {plan.calls === 0
                            ? kinds.length === 0
                                ? t("Pick at least one kind of material.")
                                : t("Nothing missing in the topics you picked.")
                            : <>
                                <span className="font-medium text-slate-700 dark:text-slate-200">
                                    {t("{{count}} topics", { count: plan.topics })} {t("· {{count}} generations", { count: plan.calls })}
                                </span>
                                {plan.skipped > 0 && <> {t("· {{skipped}} already covered", { skipped: plan.skipped })}</>}
                                <span className="block">{t("Runs in the background and pauses while you use the tutor.")}</span>
                            </>}
                    </p>
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-sm rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition"
                    >
                        {t("Close")}
                    </button>
                    <button
                        onClick={start}
                        disabled={running || starting || plan.calls === 0}
                        className="px-4 py-2 text-sm font-medium rounded-xl bg-accent text-white hover:brightness-90 disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center gap-2"
                    >
                        {starting && <Loader2 className="w-4 h-4 animate-spin" />}
                        {running ? t("Running…") : t("Generate")}
                    </button>
                </footer>
            </div>
        </div>
    );
}

/** The live run. It does not replace the picker — the next pass can be lined up. */
function RunPanel({ job, running, onCancel }: { job: BulkJobStatus; running: boolean; onCancel: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40">
            <div className="flex items-center gap-2 text-sm">
                {running
                    ? (job.waiting
                        ? <Pause className="w-4 h-4 text-amber-500 shrink-0" />
                        : <Loader2 className="w-4 h-4 text-accent-fg animate-spin shrink-0" />)
                    : <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />}
                <span className="font-medium text-slate-700 dark:text-slate-200 tabular-nums">
                    {job.done}/{job.total}
                </span>
                <span className="text-slate-500 dark:text-slate-400 truncate">
                    {job.waiting
                        ? t("paused while you use the model")
                        : job.current
                            ? `${job.current.title} — ${job.current.kind === 'mastery_check' ? t("mastery check") : t("flashcards")}`
                            : job.status === 'cancelled' ? t("stopped — everything finished is saved")
                                : t("finished")}
                </span>
                {running && job.etaMs != null && (
                    <span className="ml-auto shrink-0 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                        {t("~{{duration}} left", { duration: formatDuration(job.etaMs) })}
                    </span>
                )}
                {running && (
                    <button
                        onClick={onCancel}
                        className={`shrink-0 px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:border-red-400 hover:text-red-500 transition ${job.etaMs != null ? '' : 'ml-auto'}`}
                    >
                        {t("Stop")}
                    </button>
                )}
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                <div
                    className="h-full bg-accent transition-all"
                    style={{ width: `${job.total ? Math.round((job.done / job.total) * 100) : 0}%` }}
                />
            </div>
            {job.failed > 0 && (
                <p className="mt-2 text-sm text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>
                        {t("{{count}} topics failed and were skipped", { count: job.failed })}
                        {job.failures[0] ? ` — e.g. ${job.failures[0].title}: ${job.failures[0].error}` : ''}
                    </span>
                </p>
            )}
        </div>
    );
}

function StepLabel({ n, title }: { n: number; title: string }) {
    return (
        <h3 className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
            <span className="w-5 h-5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 flex items-center justify-center text-[10px]">
                {n}
            </span>
            {title}
        </h3>
    );
}

/**
 * One kind, its role, and its size. The count lives INSIDE the card because a
 * number in a shared toolbar has to be labelled twice over to say what it
 * counts — and it only means anything while that kind is selected.
 */
function KindCard({ active, onClick, icon, label, blurb, countLabel, choices, value, onValue }: {
    active: boolean; onClick: () => void; icon: React.ReactNode; label: string; blurb: string;
    countLabel: string; choices: number[]; value: number; onValue: (n: number) => void;
}) {
    return (
        <div
            className={`rounded-2xl border transition ${active
                ? 'bg-accent/10 border-accent/40'
                : 'border-slate-200 dark:border-slate-700'}`}
        >
            <button
                type="button"
                aria-pressed={active}
                onClick={onClick}
                className="w-full text-left p-3 flex items-start gap-3"
            >
                <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${active
                    ? 'bg-accent text-white'
                    : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400'}`}>
                    {icon}
                </span>
                <span className="min-w-0">
                    <span className={`block text-sm font-medium ${active
                        ? 'text-accent-fg' : 'text-slate-700 dark:text-slate-200'}`}>
                        {label}
                    </span>
                    <span className="block text-sm text-slate-500 dark:text-slate-400 mt-0.5">{blurb}</span>
                </span>
            </button>
            {active && (
                <div className="px-3 pb-3 flex items-center gap-2">
                    <span className="text-sm text-slate-500 dark:text-slate-400">{countLabel}</span>
                    <div className="flex rounded-lg overflow-hidden border border-slate-300 dark:border-slate-600" role="group" aria-label={countLabel}>
                        {choices.map(n => (
                            <button
                                key={n}
                                type="button"
                                aria-pressed={value === n}
                                onClick={() => onValue(n)}
                                className={`px-3 py-1.5 text-xs font-medium tabular-nums transition ${value === n
                                    ? 'bg-accent text-white'
                                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'}`}
                            >
                                {n}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * One topic. The chips say what it HAS in the vocabulary of the gate — "check
 * ready" means its mastery check can already run, which is the only fact that
 * decides whether generating for it is worth a model call.
 */
function TopicRow({ c, section, on, kinds, skipExisting, onToggle }: {
    c: BulkCandidate; section: string; on: boolean; kinds: BulkKind[];
    skipExisting: boolean; onToggle: () => void;
}) {
    const { t } = useTranslation();
    const sub = c.path.startsWith(section) ? c.path.slice(section.length).replace(/^\s*›\s*/, '') : c.path;
    const covered = kinds.length > 0
        && kinds.every(k => k === 'mastery_check' ? c.gateReady : c.flashcards > 0);
    return (
        <label
            className={`flex items-center gap-3 px-3 py-2 min-h-[44px] rounded-xl cursor-pointer transition ${on ? 'bg-accent/10' : 'hover:bg-slate-100 dark:hover:bg-slate-700/50'
                }`}
        >
            <Checkbox checked={on} onChange={onToggle} />
            <span className="min-w-0 flex-1">
                <span className="block text-sm text-slate-800 dark:text-slate-100 truncate">{c.title}</span>
                {sub && <span className="block text-sm text-slate-500 dark:text-slate-400 truncate">{sub}</span>}
            </span>
            <span className="shrink-0 flex items-center gap-1.5 text-[11px]">
                {c.flashcards > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 tabular-nums">
                        {t("{{count}} cards", { count: c.flashcards })}
                    </span>
                )}
                {c.gateReady ? (
                    <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                        {t("check ready")}
                    </span>
                ) : c.questions > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 tabular-nums">
                        {t("{{count}} questions", { count: c.questions })}
                    </span>
                )}
                {covered && skipExisting && on && <span className="text-amber-500">{t("skip")}</span>}
            </span>
        </label>
    );
}
