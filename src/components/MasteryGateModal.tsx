import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../api';
import { X, Trophy, AlertTriangle, CheckCircle, XCircle, Brain, Check } from 'lucide-react';
import { QuizQuestion } from '../types';
import MathText from './MathText';
import QuestionStem from './QuestionStem';
import AnswerHelp from './AnswerHelp';
import AnswerInput from './answer/AnswerInput';
import AnswerKey from './answer/AnswerKey';
import { formatOf, defaultAnswer } from './answer/formats';
import { gradeAnswer } from '../utils/grading';
import { useStore } from '../store';
import { aiRuntime, slowGenerationHint, timeoutHint } from '../utils/aiHints';
import { useTranslation } from 'react-i18next';
import { useNumberFormat } from '../hooks/useNumberFormat';

interface MasteryGateModalProps {
    isOpen: boolean;
    onClose: () => void;
    nodeId: number;
    nodeTitle: string;
    projectId: number;
    onPassed: () => void;
    /** Advisory mode lets the learner bypass the gate ("mark done anyway"). */
    advisory?: boolean;
    /** Complete the node without proving mastery (advisory override). */
    onMarkAnyway?: () => void;
    /** Mark the topic skipped (honestly closed, not verified). */
    onSkip?: () => void;
}

export default function MasteryGateModal({
    isOpen,
    onClose,
    nodeId,
    nodeTitle,
    projectId,
    onPassed,
    advisory = true,
    onMarkAnyway,
    onSkip,
}: MasteryGateModalProps) {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const [questions, setQuestions] = useState<QuizQuestion[]>([]);
    const [currentQ, setCurrentQ] = useState(0);
    const [answers, setAnswers] = useState<Record<number, string>>({});
    // Per-question correctness + explanation, so the results screen can show the
    // learner exactly which questions they missed (they can pass with a few wrong).
    const [answerResults, setAnswerResults] = useState<Record<number, { correct: boolean; explanation?: string }>>({});
    const [submitted, setSubmitted] = useState(false);
    const [result, setResult] = useState<{ score: number; total: number; passed: boolean; passThreshold: number } | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [generating, setGenerating] = useState<boolean | 'timeout'>(false);
    // Live count of characters the model has emitted while generating the quiz —
    // streamed over SSE so the loading state feels alive (as the Tutor chat does).
    const [charCount, setCharCount] = useState(0);
    // Running count of reasoning characters a thinking-capable model has produced
    // before the quiz JSON starts — mirrors AIPanel's "Reasoning… (N chars)".
    const [thinkingChars, setThinkingChars] = useState(0);
    // True while the model server is loading the model (cold swap) before the
    // first token — a reachable-but-warming state, distinct from a failure.
    const [loadingModel, setLoadingModel] = useState(false);
    // Progress of the post-generation answer check ({done, total}), null until it starts.
    const [verifying, setVerifying] = useState<{ done: number; total: number } | null>(null);
    const [rawOutput, setRawOutput] = useState<string | null>(null);
    const [showRawOutput, setShowRawOutput] = useState(false);

    // Whether the model runs on this machine or on a remote endpoint — the
    // waiting/timeout copy below differs, and guessing "local" is wrong for
    // anyone on an API endpoint or an Ollama `:cloud` model.
    // Project name — only used to disambiguate a thin topic title when the
    // review screen offers a video search ("Basics" alone is a useless query).
    const projectName = useStore(s => s.projects.find(p => p.id === projectId)?.name ?? null);
    const runtime = useStore(s => aiRuntime(s.aiProvider, s.aiModel));
    const runtimeRef = useRef(runtime);
    runtimeRef.current = runtime;

    const lastTriggerRef = useRef<string | null>(null);

    useEffect(() => {
        if (!isOpen || !nodeId) {
            if (!isOpen) lastTriggerRef.current = null;
            return;
        }

        const key = `${isOpen}:${nodeId}`;
        if (lastTriggerRef.current === key) return;
        lastTriggerRef.current = key;

        setLoading(true);
        setGenerating(true);
        setError(null);
        setQuestions([]);
        setCurrentQ(0);
        setAnswers({});
        setAnswerResults({});
        setSubmitted(false);
        setResult(null);
        setCharCount(0);
        setThinkingChars(0);
        setLoadingModel(false);
        setRawOutput(null);
        setShowRawOutput(false);

        let cancelled = false;
        const abort = new AbortController();

        // The "still working" copy should only kick in once the model is actually
        // loaded and generating — a cold model swap can itself take a minute, and
        // counting that time against the "should be done by now" window makes the
        // message fire while we're still just waiting for the model to warm up.
        let slowTimer: ReturnType<typeof setTimeout> | null = null;
        const armSlowTimer = () => {
            if (slowTimer) clearTimeout(slowTimer);
            setGenerating(true);
            slowTimer = setTimeout(() => {
                if (!cancelled) setGenerating('timeout');
            }, 10000);
        };
        const disarmSlowTimer = () => {
            if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
        };
        // Covers the (normally instant) saved-quiz lookup and the case where the
        // model is already warm and starts generating with no loading_model phase.
        armSlowTimer();

        (async () => {
            try {
                const quizzes: any[] = await api.getQuizzes(nodeId);
                if (cancelled) return;

                let allQuestions: QuizQuestion[] = [];
                if (quizzes && quizzes.length > 0) {
                    for (const quiz of quizzes) {
                        if (quiz.questions && Array.isArray(quiz.questions)) {
                            // Saved practice quizzes embed ghost (review) questions
                            // from OTHER topics — the Boss Fight must stay a pure
                            // assessment of this node, so exclude them.
                            allQuestions.push(...quiz.questions.filter((q: QuizQuestion) => !q.isGhost));
                        }
                    }
                }

                if (allQuestions.length === 0) {
                    // A cold model swap can drop the first (silent) request before
                    // any token arrives. The server-side probe already confirmed the
                    // AI server is up, so such a zero-token cancel means the model is
                    // now warming/warm — retry once automatically rather than failing.
                    const MAX_ATTEMPTS = 2;
                    let genErr: any = null;
                    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                        let receivedChars = 0;
                        // Tracks whether the model has moved past reasoning and started
                        // writing the actual questions — flips the "still working" clock
                        // to a fresh second countdown so it reflects this new stage
                        // rather than carrying over time spent waiting on reasoning.
                        let contentStarted = false;
                        setCharCount(0);
                        setThinkingChars(0);
                        setVerifying(null);
                        try {
                            // Stream generation so the loading state shows a live
                            // character count. The Boss Fight never includes ghost
                            // questions (it must stay a pure per-node assessment).
                            // Runs as a background task (bossFight labels it in the
                            // task dock): closing the modal only detaches — the
                            // generation continues, the quiz is saved server-side,
                            // and reopening the modal reattaches to the same task.
                            const generated = await api.streamGenerateQuiz(
                                nodeId, 10, 'both', false,
                                (chars) => {
                                    if (cancelled) return;
                                    receivedChars = chars;
                                    setLoadingModel(false);
                                    setCharCount(chars);
                                    if (!contentStarted && chars > 0) {
                                        // Reasoning (if any) has ended and actual question
                                        // text is now flowing — start the second timer here
                                        // instead of counting the reasoning time against it.
                                        contentStarted = true;
                                        armSlowTimer();
                                    }
                                },
                                abort.signal,
                                (chars) => { if (!cancelled) { receivedChars = chars; setLoadingModel(false); setThinkingChars(chars); } },
                                (phase, _waited, detail) => {
                                    if (cancelled) return;
                                    if (phase === 'loading_model') { setLoadingModel(true); disarmSlowTimer(); }
                                    else if (phase === 'generating') { setLoadingModel(false); armSlowTimer(); }
                                    else if (phase === 'verifying') {
                                        // Generation is done; every question is now being
                                        // solved cold by a second pass. Its own clock, or
                                        // the "still working" hint would blame the wrong step.
                                        setLoadingModel(false);
                                        armSlowTimer();
                                        setVerifying({ done: detail?.verified ?? 0, total: detail?.verifyTotal ?? 0 });
                                    }
                                },
                                { bossFight: true },
                            );
                            if (cancelled) return;
                            if (generated && generated.questions) {
                                allQuestions = generated.questions;
                            }
                            genErr = null;
                            break;
                        } catch (err: any) {
                            if (abort.signal.aborted) return; // user closed the modal
                            genErr = err;
                            const msg = err?.message || '';
                            // Retry only a zero-token drop (cold-swap casualty), not a
                            // genuine generation failure that already produced output —
                            // and never an explicit cancel from the task dock.
                            const transientDrop =
                                !err?.cancelled &&
                                receivedChars === 0 &&
                                /cancel|abort|connection to the AI server closed/i.test(msg);
                            if (attempt < MAX_ATTEMPTS && transientDrop) {
                                setLoadingModel(true);
                                disarmSlowTimer();
                                continue;
                            }
                            break;
                        }
                    }

                    if (genErr) {
                        if (!cancelled) {
                            setLoadingModel(false);
                            const raw = genErr?.rawResponse || genErr?.data?.raw_response || null;
                            setRawOutput(raw);

                            const reason = genErr?.message || 'Unknown error';
                            // The explanation is translated; the raw `reason` in
                            // brackets is not, on purpose — it is the upstream
                            // message, and a translated copy of it would not match
                            // anything the learner can search for or paste into an
                            // issue. Same split the server's failure records use.
                            if (reason.includes('No JSON array') || reason.includes('not a JSON array')) {
                                setError(t("AI returned malformed response. Try again — the model may have generated invalid data. ({{reason}})", { reason }));
                            } else if (reason.includes('Failed to generate')) {
                                setError(t("AI model failed to generate questions. Check that your AI model server is running and the model is available. ({{reason}})", { reason }));
                            } else if (reason.includes('context') || reason.includes('description')) {
                                setError(t("Cannot generate questions: this node has no learning content. Add a description or resource material first. ({{reason}})", { reason }));
                            } else if (reason.includes('timeout') || reason.includes('timed out')) {
                                setError(`${t(timeoutHint(runtimeRef.current))} (${reason})`);
                            } else if (/cancel|abort|connection to the AI server closed/i.test(reason)) {
                                setError(t("Question generation was interrupted before it finished — the model may still be loading. Give it a moment and try again. ({{reason}})", { reason }));
                            } else if (reason.includes('fetch') || reason.includes('network') || reason.includes('connect') || reason.includes('listening')) {
                                setError(t("Cannot reach the AI server. Is your model server (Ollama / llama-swap / LM Studio) running? ({{reason}})", { reason }));
                            } else {
                                setError(t("Failed to generate quiz questions: {{reason}}", { reason }));
                            }
                            setLoading(false);
                            setGenerating(false);
                        }
                        return;
                    }
                }

                if (cancelled) return;

                if (allQuestions.length === 0) {
                    setError('Could not generate questions for this node.');
                    setLoading(false);
                    setGenerating(false);
                    return;
                }

                const shuffled = [...allQuestions].sort(() => Math.random() - 0.5);
                setQuestions(shuffled.slice(0, Math.min(10, shuffled.length)));
                setLoading(false);
                setGenerating(false);
            } catch (err: any) {
                if (!cancelled) {
                    setError(err.message || 'Failed to load questions');
                    setLoading(false);
                    setGenerating(false);
                }
            } finally {
                disarmSlowTimer();
            }
        })();

        return () => {
            cancelled = true;
            disarmSlowTimer();
            abort.abort();
            lastTriggerRef.current = null;
        };
    }, [isOpen, nodeId]);

    const handleAnswer = useCallback((questionIndex: number, answer: string) => {
        setAnswers(prev => ({ ...prev, [questionIndex]: answer }));
    }, []);

    const handleSubmit = useCallback(async () => {
        if (questions.length === 0) return;

        setLoading(true);
        try {
            let correct = 0;
            const results: Record<number, { correct: boolean; explanation?: string }> = {};
            for (let i = 0; i < questions.length; i++) {
                const q = questions[i];
                // Every format grades the way the practice quiz and the feed
                // grade it: closed ones locally, open ones (prose, code) through
                // the checker with an honest fallback — exact string comparison
                // on the highest-stakes surface would fail a correct answer in
                // other words. An unanswered question is graded as what an
                // untouched input already answers (an ordering: the served
                // order; anything else: nothing, which is wrong).
                const userAnswer = answers[i] || defaultAnswer(q);
                if (!userAnswer.trim()) { results[i] = { correct: false, explanation: q.explanation }; continue; }
                const graded = await gradeAnswer(q, userAnswer);
                if (graded.correct) correct++;
                results[i] = { correct: graded.correct, explanation: graded.explanation };
            }
            setAnswerResults(results);

            const total = questions.length;

            const result = await api.submitBossFight(projectId, nodeId, correct, total, questions);

            const passed = !!result.passed;

            setResult({
                score: correct,
                total,
                passed,
                passThreshold: typeof result.pass_threshold === 'number' ? result.pass_threshold : 0.8,
            });

            setSubmitted(true);
            // On pass we show the success screen; the actual completion write
            // (with override, so it always lands) happens in onPassed/Continue.
            // The Boss Fight already recorded raw evidence, so eligibility holds.
        } catch (err: any) {
            setError(err.message || 'Failed to submit boss fight');
        } finally {
            setLoading(false);
        }
    }, [questions, answers, nodeId, projectId, onPassed]);

    const answeredCount = Object.keys(answers).length;
    const allAnswered = answeredCount === questions.length;
    // Answering questions — the phase that gets the fixed frame, so its
    // furniture (progress bar, Previous/Next) doesn't move between a short
    // true/false question and a tall multiple choice one. Loading, errors and
    // the results review stay content-sized: they're read top-to-bottom once,
    // and there's nothing to hold still.
    const questionPhase = !loading && !error && !submitted && questions.length > 0;

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 dark:bg-black/80">
            <div className={`bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden border border-slate-200 dark:border-slate-700 ${questionPhase ? 'modal-frame-stable' : 'modal-shell'}`}>
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-accent/10">
                            <Trophy className="w-5 h-5 text-accent-fg" />
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
                                {t("Boss Fight: Mastery Gate")}
                            </h2>
                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                {nodeTitle}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        aria-label={t("Close")}
                        className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
                    >
                        <X className="w-5 h-5 text-slate-400" />
                    </button>
                </div>

                {/* Progress sits in the fixed chrome, above the scroll area, so it
                    stays put while a long question scrolls underneath it. */}
                {questionPhase && (
                    <div className="flex-shrink-0 px-6 pt-4 pb-3 border-b border-slate-200 dark:border-slate-700">
                        <div className="flex justify-between text-sm text-slate-500 dark:text-slate-400 mb-1">
                            <span>{t("Question {{n}} of {{total}}", { n: currentQ + 1, total: questions.length })}</span>
                            <span>{t("{{answeredCount}}/{{length}} answered", { answeredCount, length: questions.length })}</span>
                        </div>
                        <div className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-accent transition-all duration-300"
                                style={{ width: `${(answeredCount / questions.length) * 100}%` }}
                            />
                        </div>
                    </div>
                )}

                <div className="flex-1 min-h-0 overflow-auto px-6 py-4">
                    {loading && !submitted && (
                        <div className="flex flex-col items-center justify-center py-12">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
                            <span className="ml-3 text-slate-500 dark:text-slate-200">
                                {verifying
                                    ? t("Checking every answer…")
                                    : loadingModel && charCount === 0 && thinkingChars === 0
                                    ? t("Warming up the model…")
                                    : charCount > 0
                                        ? (generating === 'timeout' ? t("Still generating questions…") : t("Generating questions…"))
                                        : thinkingChars > 0
                                            ? (generating === 'timeout' ? t("Still reasoning about the topic…") : t("Reasoning about the topic…"))
                                            : (generating === 'timeout' ? t("Still working…") : t("Loading questions..."))}
                            </span>
                            {loadingModel && charCount === 0 && thinkingChars === 0 && (
                                <p className="mt-3 text-sm text-slate-500 dark:text-slate-300 max-w-sm text-center">
                                    {t("The first run after an idle period loads the model into memory, which can take up to a minute. Hang tight — this is normal.")}
                                </p>
                            )}
                            {charCount === 0 && thinkingChars > 0 && (
                                <span className="mt-2 text-xs font-mono tabular-nums text-accent-fg">
                                    {t("{{thinkingChars}} characters of reasoning so far", { thinkingChars: num(thinkingChars) })}
                                </span>
                            )}
                            {charCount > 0 && !verifying && (
                                <span className="mt-2 text-xs font-mono tabular-nums text-accent-fg">
                                    {t("{{charCount}} characters generated", { charCount: num(charCount) })}
                                </span>
                            )}
                            {verifying && (
                                <>
                                    <span className="mt-2 text-xs font-mono tabular-nums text-accent-fg">
                                        {t("{{done}} of {{total}} checked", { done: verifying.done, total: verifying.total })}
                                    </span>
                                    <p className="mt-3 text-sm text-slate-500 dark:text-slate-300 max-w-sm text-center">
                                        {t("Each question is being answered a second time, without its answer key. Anything the two passes disagree on — or that turns out to have more than one right answer — is thrown away rather than marked against you.")}
                                    </p>
                                </>
                            )}
                            {generating === 'timeout' && !loadingModel && charCount === 0 && thinkingChars > 0 && (
                                <p className="mt-3 text-sm text-slate-500 dark:text-slate-300 max-w-sm text-center">
                                    {t("Reasoning models work through the topic in detail before writing a single question, so this planning step can run a couple of minutes on complex topics — no questions written yet is expected here.")}
                                </p>
                            )}
                            {generating === 'timeout' && !loadingModel && charCount > 0 && (
                                <p className="mt-3 text-sm text-slate-500 dark:text-slate-400 max-w-sm text-center">
                                    {t(slowGenerationHint(runtime))}
                                </p>
                            )}
                        </div>
                    )}

                    {error && !submitted && (
                        <div className="flex flex-col items-center justify-center py-12 text-center px-4">
                            <AlertTriangle className="w-10 h-10 text-amber-500 mb-3" />
                            <p className="text-slate-600 dark:text-slate-300">{error}</p>

                            {showRawOutput && (
                                <div className="mt-4 w-full p-4 bg-slate-100 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700 text-left overflow-auto max-h-[30vh]">
                                    <pre className="text-xs text-slate-800 dark:text-slate-300 whitespace-pre-wrap font-mono">
                                        {rawOutput || t("No raw output was provided by the server. Check if your backend route includes \"rawResponse: ...\" in the error payload.")}
                                    </pre>
                                </div>
                            )}

                            <div className="flex gap-3 mt-6 justify-center w-full flex-wrap">
                                <button
                                    onClick={() => setShowRawOutput(!showRawOutput)}
                                    className="px-4 py-2 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors text-slate-700 dark:text-slate-300"
                                >
                                    {showRawOutput ? t("Hide Raw Output") : t("See Raw Output")}
                                </button>
                                <button
                                    onClick={onClose}
                                    className="px-4 py-2 bg-slate-100 dark:bg-slate-700 rounded-lg text-sm hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors text-slate-700 dark:text-slate-200"
                                >
                                    {t("Close")}
                                </button>
                            </div>
                            {/* The learner is never stuck: even with the AI unavailable,
                                they can move on honestly. */}
                            <div className="flex gap-3 mt-3 justify-center w-full flex-wrap">
                                {advisory && onMarkAnyway && (
                                    <button
                                        onClick={onMarkAnyway}
                                        className="px-4 py-2 text-sm rounded-lg bg-emerald-700 text-white hover:bg-emerald-600 transition-colors"
                                    >
                                        {t("Mark done anyway")}
                                    </button>
                                )}
                                {onSkip && (
                                    <button
                                        onClick={onSkip}
                                        className="px-4 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
                                    >
                                        {t("Skip this topic")}
                                    </button>
                                )}
                            </div>
                        </div>
                    )}

                    {questionPhase && (
                        <div>
                            {(() => {
                                const q = questions[currentQ];
                                return (
                                    <div>
                                        <div className="text-slate-800 dark:text-slate-100 font-medium mb-4">
                                            <QuestionStem content={q.question} nodeId={nodeId} surface="boss-fight" media={q.media} mediaSize="review" />
                                        </div>

                                        {/* Keyed on the question so moving on remounts the
                                            input instead of handing one question's editor the
                                            next question's value. */}
                                        <AnswerInput
                                            key={currentQ}
                                            question={q}
                                            value={answers[currentQ] || ''}
                                            onChange={(answer) => handleAnswer(currentQ, answer)}
                                        />
                                        {formatOf(q).hint && (
                                            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{t(formatOf(q).hint!)}</p>
                                        )}

                                        {/* Hitting an unfamiliar term mid-gate is the moment
                                            people leave to go and search. Say where the answer
                                            is coming from instead — the gate stays a real
                                            assessment, and nobody has to guess whether guessing
                                            is a dead end. */}
                                        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
                                            {t("Answer your best guess — after you submit, every missed question comes with a full explanation and a video link.")}
                                        </p>
                                    </div>
                                );
                            })()}
                        </div>
                    )}

                    {submitted && result && (
                        <div className="py-6">
                            <div className="text-center">
                                {result.passed ? (
                                    <>
                                        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 mb-4">
                                            <CheckCircle className="w-8 h-8 text-emerald-500" />
                                        </div>
                                        <h3 className="text-xl font-bold text-emerald-600 dark:text-emerald-400 mb-2">
                                            {t("Mastery Gate Passed!")}
                                        </h3>
                                        <p className="text-slate-600 dark:text-slate-300">
                                            {t("You scored {{score}}/{{total}} ({{round}}%)", { score: result.score, total: result.total, round: Math.round((result.score / result.total) * 100) })}
                                        </p>
                                        <p className="text-sm text-emerald-500 dark:text-emerald-400 mt-1">
                                            {t("You proved it — this topic will be marked completed.")}
                                        </p>
                                    </>
                                ) : (
                                    <>
                                        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-100 dark:bg-red-900/30 mb-4">
                                            <XCircle className="w-8 h-8 text-red-500" />
                                        </div>
                                        <h3 className="text-xl font-bold text-red-600 dark:text-red-400 mb-2">
                                            {t("Not Yet Mastered")}
                                        </h3>
                                        <p className="text-slate-600 dark:text-slate-300">
                                            {t("You scored {{score}}/{{total}} ({{round}}%)", { score: result.score, total: result.total, round: Math.round((result.score / result.total) * 100) })}
                                        </p>
                                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                                            {t("You need at least {{round}}% to pass the mastery gate.", { round: Math.round(result.passThreshold * 100) })}
                                        </p>
                                    </>
                                )}
                            </div>

                            {/* Even on a pass, a few answers may be wrong — surface them
                                with the correct answer + explanation so the learner leaves
                                the Boss Fight having closed the gaps, not just cleared it. */}
                            {questions.length > 0 && Object.keys(answerResults).length > 0 && (() => {
                                const wrongCount = questions.filter((_, i) => answerResults[i] && !answerResults[i].correct).length;
                                return (
                                    <div className="mt-8 text-left">
                                        <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">
                                            {t("Review Answers")}
                                            {wrongCount > 0 && (
                                                <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
                                                    {t("· {{wrongCount}} to revisit", { wrongCount })}
                                                </span>
                                            )}
                                        </h4>
                                        <div className="space-y-3">
                                            {questions.map((q, i) => {
                                                const res = answerResults[i];
                                                const userAnswer = answers[i] || defaultAnswer(q);
                                                const isCorrect = res?.correct ?? false;
                                                return (
                                                    <div key={i} className="p-4 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-700">
                                                        <div className="flex items-start gap-3">
                                                            <div className={`p-1 rounded-full flex-shrink-0 ${isCorrect ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'}`}>
                                                                {isCorrect ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <div className="font-medium text-slate-700 dark:text-slate-200"><QuestionStem content={q.question} nodeId={nodeId} surface="boss-fight-review" media={q.media} /></div>
                                                                {formatOf(q).blockAnswer && userAnswer ? (
                                                                    // Code and an ordering read as blocks: the input, locked
                                                                    // and painted with the verdict.
                                                                    <div className="mt-2">
                                                                        <p className="text-sm text-slate-500 dark:text-slate-400 mb-1">{t("Your answer:")}</p>
                                                                        <AnswerInput question={q} value={userAnswer} onChange={() => {}} result={{ correct: isCorrect, answer: userAnswer }} />
                                                                    </div>
                                                                ) : (
                                                                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                                                                        {t("Your answer:")}{' '}<span className={isCorrect ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>{userAnswer ? <MathText content={userAnswer} /> : t("(no answer)")}</span>
                                                                    </p>
                                                                )}
                                                                {!isCorrect && (
                                                                    <div className="mt-1.5">
                                                                        <AnswerKey question={q} />
                                                                    </div>
                                                                )}
                                                                {(res?.explanation || q.explanation) && (
                                                                    <p className="text-sm text-slate-600 dark:text-slate-300 mt-2 italic"><MathText content={res?.explanation || q.explanation || ''} /></p>
                                                                )}
                                                                {/* Learn it here rather than leaving to search
                                                                    for the term — offered on the answers that
                                                                    actually went wrong. */}
                                                                {!isCorrect && (
                                                                    <AnswerHelp
                                                                        nodeId={nodeId}
                                                                        nodeTitle={nodeTitle}
                                                                        question={q.question}
                                                                        correctAnswer={q.correct_answer}
                                                                        userAnswer={userAnswer}
                                                                        context={projectName}
                                                                    />
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                );
                            })()}

                            <div className="mt-8 flex gap-3 justify-center flex-wrap">
                                {result.passed ? (
                                    <button
                                        onClick={onPassed}
                                        className="px-6 py-2.5 bg-emerald-700 text-white rounded-lg hover:bg-emerald-600 transition-colors"
                                    >
                                        {t("Continue")}
                                    </button>
                                ) : (
                                    <>
                                        <button
                                            onClick={onClose}
                                            className="px-4 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
                                        >
                                            {t("Study More")}
                                        </button>
                                        <button
                                            onClick={() => {
                                                setSubmitted(false);
                                                setResult(null);
                                                setCurrentQ(0);
                                                setAnswers({});
                                                setAnswerResults({});
                                            }}
                                            className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
                                        >
                                            {t("Retry Boss Fight")}
                                        </button>
                                        {advisory && onMarkAnyway && (
                                            <button
                                                onClick={onMarkAnyway}
                                                className="px-4 py-2 text-sm rounded-lg bg-emerald-700 text-white hover:bg-emerald-600 transition-colors"
                                            >
                                                {t("Mark done anyway")}
                                            </button>
                                        )}
                                        {onSkip && (
                                            <button
                                                onClick={onSkip}
                                                className="px-4 py-2 text-sm rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                                            >
                                                {t("Skip topic")}
                                            </button>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {questionPhase && (
                    <div className="flex-shrink-0 px-6 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
                        {/* Navigation lives in the fixed footer rather than at the
                            end of the scrolling question, so Previous / Next are
                            always in the same spot and always reachable — on a
                            phone a four-option question used to push Submit below
                            the fold. */}
                        <div className="flex items-center justify-between gap-3">
                            <button
                                onClick={() => setCurrentQ(Math.max(0, currentQ - 1))}
                                disabled={currentQ === 0}
                                className="px-4 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 disabled:opacity-40 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
                            >
                                {t("Previous")}
                            </button>

                            {currentQ < questions.length - 1 ? (
                                <button
                                    onClick={() => setCurrentQ(currentQ + 1)}
                                    className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
                                >
                                    {t("Next")}
                                </button>
                            ) : (
                                <button
                                    onClick={handleSubmit}
                                    disabled={!allAnswered || loading}
                                    className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-40 transition-colors flex items-center gap-2"
                                >
                                    {loading ? (
                                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                                    ) : (
                                        <Brain className="w-4 h-4" />
                                    )}
                                    {t("Submit Boss Fight")}
                                </button>
                            )}
                        </div>

                        {(onSkip || (advisory && onMarkAnyway)) && (
                            <div className="flex gap-2 mt-1.5">
                                {advisory && onMarkAnyway && (
                                    <button
                                        onClick={onMarkAnyway}
                                        className="px-3 py-1.5 text-xs rounded-lg text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors"
                                    >
                                        {t("Mark done anyway")}
                                    </button>
                                )}
                                {onSkip && (
                                    <button
                                        onClick={onSkip}
                                        className="px-3 py-1.5 text-xs rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                                    >
                                        {t("Skip")}
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}