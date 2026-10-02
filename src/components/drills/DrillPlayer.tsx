import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import MathText from '../MathText';
import type { DrillMode, DrillRoundResult, DrillSpec } from '../../types';
import { answersMatch, buildOptions, closedOptionSet, drillBarFill, shuffle } from './parseDrill';
import { Check, X, Loader2, RotateCcw, Target, Timer, Trophy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
    spec: DrillSpec;
    /** Reports every COMPLETED round (full or missed-only) so the container can
     *  record mastery for full rounds. */
    onRoundComplete?: (result: DrillRoundResult) => void;
    /** Closes the surface the drill is playing in. The results screen needs it:
     *  a drill that is over has to offer the way out, not just the way round
     *  again. */
    onDone?: () => void;
}

/** One graded answer within the current round. */
interface Answered { itemIndex: number; given: string; correct: boolean; }

type Phase = 'intro' | 'playing' | 'results';

/**
 * The native drill loop — the fixed, reliable half of the D-023 split (the model
 * only supplies the item bank, this renders the game). Three phases: intro (pick
 * mode, start) → playing (prompt → answer → feedback → advance, with an optional
 * per-item countdown) → results (score, per-item review, Again / Only missed /
 * Done). "Only the ones I missed" is this exact lesson's advice made executable;
 * such biased rounds are played but never recorded as mastery evidence.
 */
export default function DrillPlayer({ spec, onRoundComplete, onDone }: Props) {
    const { t } = useTranslation();
    const bank = spec.items;
    const roundSize = Math.min(spec.target?.count || bank.length, bank.length);
    const seconds = spec.target?.secondsPerItem ?? null;
    const bothModes = spec.modes.includes('choice') && spec.modes.includes('type');

    const [phase, setPhase] = useState<Phase>('intro');
    const [mode, setMode] = useState<DrillMode>(spec.modes[0] ?? 'choice');
    // Indices into `bank` for this round, in play order.
    const [order, setOrder] = useState<number[]>([]);
    const [pos, setPos] = useState(0);
    const [answered, setAnswered] = useState<Answered[]>([]);
    // Whether this round is the full bank (recordable) or a missed-only retry.
    const [fullRound, setFullRound] = useState(true);
    const [startedAt, setStartedAt] = useState(0);

    // Per-item interaction state.
    const [typed, setTyped] = useState('');
    const [checking, setChecking] = useState(false);
    const [feedback, setFeedback] = useState<{ correct: boolean; given: string; note?: string } | null>(null);
    const [remaining, setRemaining] = useState<number | null>(null);

    const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const tick = useRef<ReturnType<typeof setInterval> | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);

    const clearTimers = useCallback(() => {
        if (advanceTimer.current) { clearTimeout(advanceTimer.current); advanceTimer.current = null; }
        if (tick.current) { clearInterval(tick.current); tick.current = null; }
    }, []);
    useEffect(() => clearTimers, [clearTimers]);

    const currentItem = order.length ? bank[order[pos]] : null;
    // A CLASSIFICATION drill answers every item from one small vocabulary
    // ("approaching or receding?"). There the buttons must not move between
    // questions — see closedOptionSet. Everything else keeps the per-item
    // shuffle, where a fixed order would be learnable.
    const closedSet = useMemo(() => closedOptionSet(bank), [bank]);
    // Shuffled once per ROUND, not per item and not fixed forever: stability is
    // owed inside a round, and a permanent order would be memorised across them.
    const [roundOptions, setRoundOptions] = useState<string[]>([]);
    const options = useMemo(
        () => {
            if (mode !== 'choice' || !currentItem) return [];
            if (closedSet) return roundOptions.length ? roundOptions : closedSet;
            return buildOptions(currentItem, bank);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [currentItem, mode, pos, closedSet, roundOptions],
    );

    const startRound = (indices: number[], full: boolean) => {
        clearTimers();
        if (closedSet) setRoundOptions(shuffle(closedSet));
        setOrder(indices);
        setFullRound(full);
        setPos(0);
        setAnswered([]);
        setTyped('');
        setFeedback(null);
        setChecking(false);
        setStartedAt(Date.now());
        setPhase('playing');
    };

    const begin = () => startRound(shuffle(bank.map((_, i) => i)).slice(0, roundSize), true);

    const finishRound = useCallback((all: Answered[], full: boolean) => {
        clearTimers();
        setAnswered(all);
        setPhase('results');
        onRoundComplete?.({
            correct: all.filter(a => a.correct).length,
            total: all.length,
            full,
            seconds: Math.round((Date.now() - startedAt) / 1000),
        });
    }, [clearTimers, onRoundComplete, startedAt]);

    const advance = useCallback((entry: Answered) => {
        const next = [...answered, entry];
        if (pos + 1 >= order.length) {
            finishRound(next, fullRound);
            return;
        }
        setAnswered(next);
        setPos(pos + 1);
        setTyped('');
        setFeedback(null);
        setChecking(false);
    }, [answered, pos, order.length, fullRound, finishRound]);

    // Record a graded answer: show feedback, then advance (auto for a correct
    // choice — keep the speed — otherwise wait for the learner to hit Next).
    const grade = useCallback((given: string, correct: boolean) => {
        if (!currentItem) return;
        clearTimers();
        setFeedback({ correct, given, note: currentItem.note });
        if (correct && mode === 'choice') {
            advanceTimer.current = setTimeout(() => advance({ itemIndex: order[pos], given, correct }), 650);
        }
    }, [currentItem, mode, clearTimers, advance, order, pos]);

    const gradeChoice = (option: string) => {
        if (feedback || checking || !currentItem) return;
        grade(option, answersMatch(option, currentItem.answer));
    };

    const gradeType = async () => {
        const given = typed.trim();
        if (!given || feedback || checking || !currentItem) return;
        if (answersMatch(given, currentItem.answer)) { grade(given, true); return; }
        // Not an exact match — let the AI grader judge meaning (a drill is retrieval
        // practice, not spelling). Fall back to the local verdict if it's offline.
        setChecking(true);
        try {
            const q = `${spec.promptLabel || 'What is the answer for'}: ${currentItem.prompt}`;
            const res = await api.checkAnswer(q, currentItem.answer, given);
            grade(given, !!res.correct);
        } catch {
            grade(given, false);
        } finally {
            setChecking(false);
        }
    };

    const nextAfterFeedback = () => {
        if (!feedback) return;
        advance({ itemIndex: order[pos], given: feedback.given, correct: feedback.correct });
    };

    // Per-item countdown (optional). Runs while the current item is unanswered;
    // on expiry the item is auto-graded wrong (hesitation = miss) and revealed.
    //
    // An answer STOPS the clock where it is; it does not clear it. Clearing it
    // (`remaining` → null) handed the bar to the round's progress for the
    // feedback beat, so on a press the countdown snapped to 0% on the first
    // item, lurched to 33% on the second, and the label jumped back to the full
    // "5s" — a clock that seems to run faster the moment you beat it. The same
    // holds while a typed answer is with the grader: the learner has answered.
    useEffect(() => {
        if (phase !== 'playing' || !currentItem || !seconds) {
            setRemaining(null);
            return;
        }
        if (feedback || checking) return;
        setRemaining(seconds);
        const startedTick = Date.now();
        tick.current = setInterval(() => {
            const left = seconds - (Date.now() - startedTick) / 1000;
            if (left <= 0) {
                if (tick.current) { clearInterval(tick.current); tick.current = null; }
                setRemaining(0);
                grade('', false); // timed out
            } else {
                setRemaining(left);
            }
        }, 100);
        return () => { if (tick.current) { clearInterval(tick.current); tick.current = null; } };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phase, pos, feedback, checking, seconds]);

    // Focus the input on each new type item.
    useEffect(() => {
        if (phase === 'playing' && mode === 'type' && !feedback) inputRef.current?.focus();
    }, [phase, mode, pos, feedback]);

    // ── Intro ────────────────────────────────────────────────────────────────
    if (phase === 'intro') {
        return (
            <div className="text-center py-4">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent-fg">
                    <Target className="h-7 w-7" aria-hidden="true" />
                </div>
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">{spec.title ? <MathText content={spec.title} /> : t("Quick practice drill")}</h3>
                {/* THE QUESTION BEING ASKED, before the first item.

                    A drill asks the SAME question of every item and prints only
                    the item — so a round that opens on "Galaxy spectral line
                    shifts to red" over two buttons leaves the learner working
                    out what is being asked while the clock runs. The prompt
                    label is the question; it belongs here, once, where there is
                    time to read it, and it stays above each item as a reminder
                    rather than as news. */}
                {spec.promptLabel && (
                    <p className="mt-2 text-base font-medium text-slate-700 dark:text-slate-200">
                        <MathText content={spec.promptLabel} />
                    </p>
                )}
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    {t("{{count}} items", { count: roundSize })}
                    {seconds ? t("· {{seconds}}s each", { seconds }) : ''}
                    {spec.source === 'flashcards' ? t("· from your flashcards") : ''}
                </p>

                {bothModes && (
                    <div className="mt-5 inline-flex rounded-xl border border-slate-200 dark:border-slate-600 p-1" role="tablist" aria-label={t("Answer mode")}>
                        {(['choice', 'type'] as DrillMode[]).map(m => (
                            <button
                                key={m}
                                role="tab"
                                aria-selected={mode === m}
                                onClick={() => setMode(m)}
                                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${mode === m
                                    ? 'bg-accent text-white'
                                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'}`}
                            >
                                {m === 'choice' ? t("Multiple choice") : t("Type the answer")}
                            </button>
                        ))}
                    </div>
                )}

                <div className="mt-6">
                    <button
                        onClick={begin}
                        className="px-6 py-2.5 min-h-11 bg-accent text-white rounded-xl text-sm font-semibold hover:brightness-90 transition"
                    >
                        {t("Start drill")}
                    </button>
                </div>
            </div>
        );
    }

    // ── Results ──────────────────────────────────────────────────────────────
    if (phase === 'results') {
        const correct = answered.filter(a => a.correct).length;
        const total = answered.length;
        const pct = total ? Math.round((correct / total) * 100) : 0;
        const missed = answered.filter(a => !a.correct);
        const strong = pct >= 80;
        return (
            <div className="py-2">
                <div className="text-center">
                    <div className={`mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl ${strong
                        ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300'
                        : 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-300'}`}
                    >
                        <Trophy className="h-7 w-7" aria-hidden="true" />
                    </div>
                    <p className="text-3xl font-bold text-slate-900 dark:text-white tabular-nums">{correct}<span className="text-slate-500 dark:text-slate-400">/{total}</span></p>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t("{{pct}}% correct", { pct })}{!fullRound ? t("· review round (not scored)") : ''}</p>
                </div>

                <ul className="mt-5 max-h-52 overflow-y-auto space-y-1.5 pr-1">
                    {answered.map((a, i) => {
                        const item = bank[a.itemIndex];
                        return (
                            <li key={i} className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${a.correct
                                ? 'bg-emerald-50 dark:bg-emerald-900/15'
                                : 'bg-red-50 dark:bg-red-900/15'}`}
                            >
                                {a.correct
                                    ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
                                    : <X className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-hidden="true" />}
                                <span className="min-w-0 text-slate-700 dark:text-slate-200">
                                    <span className="font-medium"><MathText content={item.prompt} /></span>
                                    <span className="text-slate-500 dark:text-slate-400"> → </span>
                                    <MathText content={item.answer} />
                                    {!a.correct && a.given && (
                                        <span className="text-red-500 dark:text-red-400"> {t("(you:")}{' '}{a.given || '—'})</span>
                                    )}
                                </span>
                            </li>
                        );
                    })}
                </ul>

                {/* WHAT TO DO NEXT DEPENDS ON WHAT JUST HAPPENED, and there is
                    always a way out. The screen used to offer `Again` in the
                    accent and `Only the 0 I missed` greyed out beside it — so a
                    perfect round's loudest control was "do that again", its
                    second was disabled, and closing meant finding the ✕ in the
                    title row. A round with everything right is FINISHED; the
                    round that asks to be repeated is the one with misses in it,
                    and then only the misses are worth repeating. So the primary
                    is Done when nothing was missed and the missed-only retry
                    when something was, `Again` is the quiet third either way,
                    and the disabled button is gone rather than greyed. */}
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                    {missed.length > 0 && (
                        <button
                            onClick={() => startRound(shuffle(missed.map(a => a.itemIndex)), false)}
                            className="inline-flex items-center gap-2 px-4 py-2 min-h-11 bg-accent text-white rounded-xl text-sm font-semibold hover:brightness-90 transition"
                        >
                            <Target className="h-4 w-4" aria-hidden="true" />
                            {t("Only the {{length}} I missed", { length: missed.length })}
                        </button>
                    )}
                    {onDone && (
                        <button
                            onClick={onDone}
                            className={missed.length === 0
                                ? 'inline-flex items-center gap-2 px-4 py-2 min-h-11 bg-accent text-white rounded-xl text-sm font-semibold hover:brightness-90 transition'
                                : 'px-4 py-2 min-h-11 rounded-xl border border-slate-200 dark:border-slate-600 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition'}
                        >
                            {missed.length === 0 && <Check className="h-4 w-4" aria-hidden="true" />}
                            {t("Done")}
                        </button>
                    )}
                    <button
                        onClick={begin}
                        className="inline-flex items-center gap-2 px-4 py-2 min-h-11 rounded-xl border border-slate-200 dark:border-slate-600 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition"
                    >
                        <RotateCcw className="h-4 w-4" aria-hidden="true" />
                        {t("Again")}
                    </button>
                </div>
            </div>
        );
    }

    // ── Playing ──────────────────────────────────────────────────────────────
    if (!currentItem) return null;
    const barPct = drillBarFill(seconds, remaining, pos, order.length);

    // Length-adaptive layout. A drill is meant for short, atomic items (Peru→Lima),
    // where a big centred headline reads as a flashcard. But the model sometimes
    // hands us a sentence-long prompt or paragraph options; a fixed 5xl headline and
    // centred pills turn that into a wall. So shrink the prompt type as it grows and,
    // once options get long, switch them from centred pills to left-aligned, lettered
    // rows that actually read as choices.
    // Measure RENDERED length, not raw markup — `$\frac{d}{dx}e^{x}$` is 20 raw
    // chars but renders about 7 glyphs wide; counting the LaTeX would demote a
    // compact formula to the small-type layout. Strip math delimiters, reduce
    // backslash commands to ~1 glyph, and drop grouping braces before counting.
    const visibleLen = (s: string) => s
        .replace(/\$\$?/g, '')
        .replace(/\\[a-zA-Z]+/g, 'x')
        .replace(/[{}^_]/g, '')
        .length;
    const promptLen = visibleLen(currentItem.prompt);
    const promptLong = promptLen > 120;
    const promptSize =
        promptLen <= 24 ? 'text-4xl sm:text-5xl'
        : promptLen <= 60 ? 'text-3xl sm:text-4xl'
        : promptLen <= 120 ? 'text-2xl sm:text-3xl'
        : 'text-xl sm:text-2xl';
    const longOptions = options.some(o => visibleLen(o) > 28);

    return (
        <div className="py-1">
            <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
                <span className="tabular-nums">{pos + 1} / {order.length}</span>
                {seconds && (
                    <span className="inline-flex items-center gap-1 tabular-nums">
                        <Timer className="h-3.5 w-3.5" aria-hidden="true" />
                        {Math.ceil(remaining ?? seconds)}s
                    </span>
                )}
            </div>
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700">
                <div
                    className={seconds ? 'h-full bg-accent transition-[width] duration-100 ease-linear' : 'h-full bg-accent transition-all'}
                    style={{ width: `${barPct}%` }}
                />
            </div>

            {spec.promptLabel && (
                <p className={`mt-5 text-xs font-semibold text-slate-500 dark:text-slate-400 ${promptLong ? 'text-left' : 'text-center'}`}><MathText content={spec.promptLabel} /></p>
            )}
            <div className={`mt-2 mb-5 font-semibold text-slate-900 dark:text-white break-words ${promptSize} ${promptLong ? 'text-left leading-snug' : 'text-center leading-tight'}`}>
                <MathText content={currentItem.prompt} />
            </div>

            {mode === 'choice' ? (
                <div className={longOptions ? 'grid grid-cols-1 gap-2' : 'grid grid-cols-1 sm:grid-cols-2 gap-2'}>
                    {options.map((option, idx) => {
                        const isAnswer = answersMatch(option, currentItem.answer);
                        const isPicked = feedback?.given === option;
                        let cls = 'border-slate-200 dark:border-slate-600 hover:border-accent/60 hover:bg-accent/5';
                        if (feedback) {
                            cls = isAnswer ? 'border-emerald-400 dark:border-emerald-600 bg-emerald-50 dark:bg-emerald-900/20'
                                : isPicked ? 'border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-900/20'
                                : 'border-slate-200 dark:border-slate-700 opacity-60';
                        }
                        return (
                            <button
                                key={idx}
                                onClick={() => gradeChoice(option)}
                                disabled={!!feedback}
                                className={`flex items-center gap-3 min-h-12 rounded-xl border-2 text-base font-medium text-slate-800 dark:text-slate-100 transition ${longOptions ? 'px-3.5 py-3 text-left' : 'px-4 py-3 justify-center text-center'} ${cls}`}
                            >
                                {longOptions && (
                                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-slate-100 dark:bg-slate-700 text-xs font-semibold text-slate-600 dark:text-slate-300">
                                        {String.fromCharCode(65 + idx)}
                                    </span>
                                )}
                                <span className="min-w-0"><MathText content={option} /></span>
                            </button>
                        );
                    })}
                </div>
            ) : (
                <div>
                    <input
                        ref={inputRef}
                        value={feedback ? feedback.given : typed}
                        onChange={e => setTyped(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); feedback ? nextAfterFeedback() : gradeType(); } }}
                        disabled={!!feedback || checking}
                        placeholder={spec.answerLabel ? t("Type the {{answerLabel}}…", { answerLabel: spec.answerLabel }) : t("Type your answer…")}
                        aria-label={t("Your answer")}
                        autoComplete="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        className="w-full px-4 py-3 text-center text-lg border border-slate-200 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-accent/60"
                    />
                    {!feedback && (
                        <div className="mt-3 flex justify-center">
                            <button
                                onClick={gradeType}
                                disabled={!typed.trim() || checking}
                                className="inline-flex items-center gap-2 px-5 py-2 min-h-11 bg-accent text-white rounded-xl text-sm font-semibold hover:brightness-90 disabled:opacity-50 disabled:cursor-not-allowed transition"
                            >
                                {checking && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                                {t("Check")}
                            </button>
                        </div>
                    )}
                </div>
            )}

            {feedback && (
                <div className={`mt-4 rounded-xl border p-3 ${feedback.correct
                    ? 'bg-emerald-50 dark:bg-emerald-900/15 border-emerald-200 dark:border-emerald-800/50'
                    : 'bg-red-50 dark:bg-red-900/15 border-red-200 dark:border-red-800/50'}`}
                >
                    <div className="flex items-center justify-between gap-3">
                        <p className={`flex items-center gap-1.5 text-sm font-semibold ${feedback.correct
                            ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}
                        >
                            {feedback.correct ? <Check className="h-4 w-4" aria-hidden="true" /> : <X className="h-4 w-4" aria-hidden="true" />}
                            {feedback.correct ? t("Correct") : (feedback.given ? t("Not quite") : t("Time!"))}
                        </p>
                        {/* Correct choices auto-advance; everything else waits for Next. */}
                        {!(feedback.correct && mode === 'choice') && (
                            <button
                                onClick={nextAfterFeedback}
                                className="px-4 py-1.5 min-h-9 bg-accent text-white rounded-lg text-sm font-medium hover:brightness-90 transition"
                            >
                                {pos + 1 >= order.length ? t("See results") : t("Next")}
                            </button>
                        )}
                    </div>
                    {!feedback.correct && (
                        <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
                            {t("Answer:")}{' '}<span className="font-medium"><MathText content={currentItem.answer} /></span>
                        </p>
                    )}
                    {feedback.note && (
                        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400"><MathText content={feedback.note} /></p>
                    )}
                </div>
            )}
        </div>
    );
}
