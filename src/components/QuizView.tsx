import { useState, useEffect, useRef } from 'react';
import { api, newAttemptId } from '../api';
import { Quiz, QuizQuestion, GhostResult, DrawnQuestion } from '../types';
import { useStore } from '../store';
import { ArrowLeft, Check, ChevronRight, Award, RotateCcw, Loader2, History } from 'lucide-react';
import QuestionStem from './QuestionStem';
import AnswerInput from './answer/AnswerInput';
import AnswerReviewItem from './answer/AnswerReviewItem';
import { formatOf, defaultAnswer, hasUsableKey } from './answer/formats';
import UncheckedKeyNote, { isUnchecked, askedEntry } from './UncheckedKeyNote';
import { gradeAnswer } from '../utils/grading';
import { useTranslation } from 'react-i18next';

/** What an unanswered question is graded as: what the learner gave, else what an untouched input already answers. */
const effectiveAnswer = (question: QuizQuestion, given: string | undefined): string =>
    given || defaultAnswer(question);

interface Props {
    quiz: Quiz;
    onClose: () => void;
}

interface AnswerResult {
    correct: boolean;
    explanation?: string;
}

/**
 * A saved quiz bigger than this is worked through in SITTINGS drawn by the
 * server (never-asked first, then least recently asked) rather than sat in
 * one go — an imported topic carries up to a hundred questions, and a
 * hundred-question practice quiz is a thing nobody finishes. Mirrors
 * `PRACTICE_SESSION_SIZE` in server/questionLog.js.
 */
const SESSION_SIZE = 15;

export default function QuizView({ quiz, onClose }: Props) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    const sampled = quiz.questions.length > SESSION_SIZE;
    // The questions of THIS sitting, each carrying its index in the bank. A
    // question whose stored key cannot be graded is left out (the index is
    // taken first, so the ask-record still names the right ones), which also
    // keeps it out of the score's total. The server's draw does the same.
    const [session, setSession] = useState<{ questions: DrawnQuestion[]; bankSize: number } | null>(
        sampled ? null : {
            questions: quiz.questions.map((q, index) => ({ ...q, index })).filter(hasUsableKey),
            bankSize: quiz.questions.length,
        }
    );
    const [drawSeq, setDrawSeq] = useState(0);
    // A draw that failed: said on the page, not left as a spinner.
    const [loadFailed, setLoadFailed] = useState(false);
    useEffect(() => {
        if (!sampled) return;
        let cancelled = false;
        setSession(null);
        setLoadFailed(false);
        api.drawQuiz(quiz.id, SESSION_SIZE)
            .then(d => { if (!cancelled) setSession({ questions: d.questions, bankSize: d.bankSize }); })
            .catch(e => { if (!cancelled) { setLoadFailed(true); addToast('error', t("Failed to load quiz"), e.message); } });
        return () => { cancelled = true; };
    }, [quiz.id, sampled, drawSeq]);
    const questions: DrawnQuestion[] = session?.questions ?? [];
    // Topic + project names for the review screen's "teach me this" / video
    // search. A ghost question is about ANOTHER topic, so it carries its own.
    const nodeTitle = useStore(s => s.nodes.find(n => n.id === quiz.node_id)?.title ?? '');
    const projectName = useStore(s => s.projects.find(p => p.id === s.currentProjectId)?.name ?? null);

    const [currentIndex, setCurrentIndex] = useState(0);
    const [answers, setAnswers] = useState<Record<number, string>>({});
    const [answerResults, setAnswerResults] = useState<Record<number, AnswerResult>>({});
    const [showResults, setShowResults] = useState(false);
    const [, setSubmitted] = useState(false);
    // The pass mark the gate will use, learned from the submission. 0.8 until
    // then, which is the same default `mastery_check_pass` carries server-side —
    // so nothing moves for anyone who has not changed it.
    const [passMark, setPassMark] = useState(0.8);
    const [checking, setChecking] = useState(false);
    // One sitting with one set of answers, one attempt id: pressing Submit again
    // after a failed send resends the same one. Retry (a new sitting) or an answer
    // changed since that send makes a new one — the server answers a replayed id
    // with the score it stored, which would not be the score on this screen.
    const attemptRef = useRef<{ answers: string; id: string } | null>(null);

    const currentQuestion = questions[currentIndex];
    const totalQuestions = questions.length;

    const handleAnswer = (answer: string) => {
        setAnswers(prev => ({ ...prev, [currentIndex]: answer }));
    };

    const handleNext = () => {
        if (currentIndex < totalQuestions - 1) {
            setCurrentIndex(prev => prev + 1);
        }
    };

    const handlePrevious = () => {
        if (currentIndex > 0) {
            setCurrentIndex(prev => prev - 1);
        }
    };

    // Grade one answer: closed formats locally, open ones (prose, code) through
    // the checker with an honest fallback — the same path the feed takes. An
    // assessment must produce a verdict, so the checker's "unsure" reads as
    // not-correct here (the explanation says so).
    const checkAnswer = async (question: QuizQuestion, userAnswer: string): Promise<AnswerResult> => {
        if (!userAnswer.trim()) return { correct: false, explanation: question.explanation };
        const graded = await gradeAnswer(question, userAnswer);
        return { correct: graded.correct, explanation: graded.explanation };
    };

    const handleSubmit = async () => {
        setChecking(true);

        try {
            // Check all answers
            const results: Record<number, AnswerResult> = {};
            let score = 0;

            for (let idx = 0; idx < questions.length; idx++) {
                const question = questions[idx];
                const userAnswer = effectiveAnswer(question, answers[idx]);

                const result = await checkAnswer(question, userAnswer);
                results[idx] = result;

                if (result.correct) {
                    score++;
                }
            }

            setAnswerResults(results);

            // Split primary vs ghost (review) questions. The recorded attempt reflects
            // only this quiz's own topic; ghost results refresh each decaying topic's
            // mastery separately (the "Remember" loop).
            let primaryScore = 0;
            let primaryTotal = 0;
            const ghostAgg: Record<number, { score: number; total: number }> = {};
            for (let idx = 0; idx < questions.length; idx++) {
                const q = questions[idx];
                const correct = results[idx]?.correct ? 1 : 0;
                if (q.isGhost && q.ghostNodeId) {
                    const agg = ghostAgg[q.ghostNodeId] || { score: 0, total: 0 };
                    agg.score += correct;
                    agg.total += 1;
                    ghostAgg[q.ghostNodeId] = agg;
                } else {
                    primaryScore += correct;
                    primaryTotal += 1;
                }
            }
            const ghostResults: GhostResult[] = Object.entries(ghostAgg).map(
                ([nodeId, v]) => ({ nodeId: Number(nodeId), score: v.score, total: v.total })
            );

            // Submit to backend (primary score for this node + ghost results for review topics)
            // Which bank entries this sitting asked, so the next draws the rest —
            // named by uuid, which a veto elsewhere in the row cannot move.
            const asked = questions.map((q, idx) => askedEntry(q, !!results[idx]?.correct));
            const answerKey = JSON.stringify(answers);
            if (attemptRef.current?.answers !== answerKey) attemptRef.current = { answers: answerKey, id: newAttemptId() };
            // What this sitting showed and how each went, kept so it can be
            // opened again from the day's ledger. This topic's questions only:
            // the record hangs on this topic's evidence row, and a review
            // question belongs to the topic it came from.
            const review = questions.flatMap((q, idx) => (q.isGhost ? [] : [{
                question: q,
                answer: effectiveAnswer(q, answers[idx]),
                correct: !!results[idx]?.correct,
                ...(results[idx]?.explanation ? { explanation: results[idx].explanation } : {}),
            }]));
            const attempt = await api.submitQuizAttempt(quiz.id, answers, primaryScore, primaryTotal, ghostResults, asked, attemptRef.current.id, review);
            // The learner's own pass mark, so the results screen congratulates on
            // the same number the gate refuses on. Raising it to 90% in Settings
            // used to score 5 of 6 in green and then be told "Not proven yet".
            if (typeof attempt?.passThreshold === 'number') setPassMark(attempt.passThreshold);
            setSubmitted(true);
            setShowResults(true);
        } catch (error: any) {
            addToast('error', t("Failed to submit quiz"), error.message);
        } finally {
            setChecking(false);
        }
    };

    const handleRetry = () => {
        attemptRef.current = null;
        setAnswers({});
        setAnswerResults({});
        setCurrentIndex(0);
        setShowResults(false);
        setSubmitted(false);
        // A sampled sitting is followed by the NEXT set, never the same one.
        if (sampled) setDrawSeq(s => s + 1);
    };

    // Headline score reflects only this quiz's own topic; ghost (review) questions
    // are scored separately so they don't distort the node's result.
    const primaryIndices = questions
        .map((q, idx) => ({ q, idx }))
        .filter(({ q }) => !q.isGhost);
    const ghostCount = questions.length - primaryIndices.length;
    const score = primaryIndices.filter(({ idx }) => answerResults[idx]?.correct).length;
    const primaryTotal = primaryIndices.length;
    const percentage = primaryTotal > 0 ? Math.round((score / primaryTotal) * 100) : 0;
    // Praise on the learner's own bar, not a hardcoded 80. The middle band is
    // three quarters of the way to it, so "good, keep practising" still means
    // the same thing when the bar moves.
    const passPct = Math.round(passMark * 100);
    const midPct = Math.round(passPct * 0.75);
    const ghostCorrect = questions
        .filter((q, idx) => q.isGhost && answerResults[idx]?.correct).length;

    if (!session || !currentQuestion) {
        // Loading only while a draw is actually on its way. A sitting that came
        // back with nothing to ask (every stored key unreadable) or a draw that
        // failed is said as such; a spinner there would never stop.
        const waiting = !session && !loadFailed;
        return (
            <div className="p-4 space-y-6">
                <button
                    onClick={onClose}
                    className="flex items-center gap-2 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"
                >
                    <ArrowLeft className="w-4 h-4" />
                    {t("Exit")}
                </button>
                {waiting ? (
                    <div className="flex items-center justify-center gap-2 py-12 text-slate-500 dark:text-slate-400">
                        <Loader2 className="w-5 h-5 animate-spin" />
                        {t("Loading…")}
                    </div>
                ) : (
                    <p role="status" className="py-12 text-center text-slate-600 dark:text-slate-300">
                        {loadFailed ? t("Failed to load quiz") : t("This quiz has no questions that can be asked.")}
                    </p>
                )}
            </div>
        );
    }

    if (showResults) {
        return (
            <div className="p-4 space-y-6">
                <button
                    onClick={onClose}
                    className="flex items-center gap-2 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"
                >
                    <ArrowLeft className="w-4 h-4" />
                    {t("Back to Study Tools")}
                </button>

                <div className="text-center py-8">
                    <div className={`w-24 h-24 mx-auto rounded-full flex items-center justify-center text-3xl font-bold ${percentage >= passPct ? 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400' :
                        percentage >= midPct ? 'bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30 dark:text-yellow-400' :
                            'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'
                        }`}>
                        {percentage}%
                    </div>
                    <p className="mt-4 text-lg font-medium text-slate-700 dark:text-slate-200">
                        {t("You scored {{score}} out of {{primaryTotal}}", { score, primaryTotal })}
                    </p>
                    <p className="text-slate-500 dark:text-slate-400 mt-1">
                        {percentage >= passPct ? t("Excellent work!") :
                            percentage >= midPct ? t("Good job! Keep practicing.") :
                                t("Keep studying, you'll get there!")}
                    </p>
                    {ghostCount > 0 && (
                        <p className="text-sm text-sky-600 dark:text-sky-400 mt-3 flex items-center justify-center gap-1.5">
                            <History className="w-4 h-4" />
                            {t("Plus {{ghostCorrect}}/{{ghostCount}} review questions from earlier topics", { count: ghostCount, ghostCorrect, ghostCount })}
                        </p>
                    )}
                </div>

                <div className="space-y-4">
                    <h3 className="font-medium text-slate-700 dark:text-slate-200">{t("Review Answers")}</h3>
                    {questions.map((q, idx) => (
                        <AnswerReviewItem
                            key={idx}
                            question={q}
                            answer={effectiveAnswer(q, answers[idx])}
                            correct={answerResults[idx]?.correct || false}
                            explanation={answerResults[idx]?.explanation}
                            nodeId={q.ghostNodeId ?? quiz.node_id}
                            nodeTitle={q.ghostNodeTitle || nodeTitle || undefined}
                            projectName={projectName}
                            surface="quiz-review"
                            badge={q.isGhost ? (
                                <span className="inline-flex items-center gap-1 mb-1 px-1.5 py-0.5 rounded text-3xs font-medium bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">
                                    <History className="w-2.5 h-2.5" />
                                    {t("Review: {{ghostNodeTitle}}", { ghostNodeTitle: q.ghostNodeTitle })}
                                </span>
                            ) : undefined}
                        />
                    ))}
                </div>

                <div className="flex gap-3">
                    <button
                        onClick={handleRetry}
                        className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-accent text-white rounded-xl hover:bg-accent/90"
                    >
                        <RotateCcw className="w-5 h-5" />
                        {sampled ? t("Next set") : t("Retry Quiz")}
                    </button>
                    <button
                        onClick={onClose}
                        className="flex-1 px-4 py-3 border border-slate-200 dark:border-slate-600 rounded-xl text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700"
                    >
                        {t("Done")}
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="p-4 space-y-6">
            <div className="flex items-center justify-between">
                <button
                    onClick={onClose}
                    className="flex items-center gap-2 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"
                >
                    <ArrowLeft className="w-4 h-4" />
                    {t("Exit")}
                </button>
                <span className="text-sm text-slate-500 dark:text-slate-400">
                    {/* One key: "Question" + a number + "of N" put the words in
                        English order, and a language that counts differently
                        could not be written in those three pieces. */}
                    {t("Question {{n}} of {{total}}", { n: currentIndex + 1, total: totalQuestions })}
                </span>
            </div>
            {sampled && (
                <p className="text-xs text-slate-500 dark:text-slate-400 -mt-4">
                    {t("A sitting of {{n}} from this topic's {{bank}} questions, the ones you have not been asked first", { count: session.bankSize, n: totalQuestions, bank: session.bankSize })}
                </p>
            )}

            {/* Progress bar */}
            <div className="h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                <div
                    className="h-full bg-accent transition-all"
                    style={{ width: `${((currentIndex + 1) / totalQuestions) * 100}%` }}
                />
            </div>

            {/* Question */}
            <div className="py-4">
                {currentQuestion.isGhost && (
                    <span className="inline-flex items-center gap-1.5 mb-2 px-2 py-0.5 rounded-full text-xs font-medium bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">
                        <History className="w-3 h-3" />
                        {t("Review: {{ghostNodeTitle}}", { ghostNodeTitle: currentQuestion.ghostNodeTitle })}
                    </span>
                )}
                <div className="text-lg font-medium text-slate-800 dark:text-slate-100">
                    <QuestionStem content={currentQuestion.question} nodeId={quiz.node_id} surface="quiz" media={currentQuestion.media} mediaSize="review" />
                </div>
                {/* A practice sitting — the whole row, or a draw from a bigger
                    one — asks stamped questions too; the server leaves those
                    out of the evidence (provenSitting), and the learner is
                    told first. */}
                {isUnchecked(currentQuestion) && <UncheckedKeyNote className="mt-2" />}
            </div>

            {/* The answer, in whatever form this question takes. Keyed on the
                index so moving between questions remounts the input rather than
                handing one question's editor the next question's value. */}
            <div className="space-y-2">
                <AnswerInput
                    key={currentIndex}
                    question={currentQuestion}
                    value={answers[currentIndex] || ''}
                    onChange={handleAnswer}
                />
                {formatOf(currentQuestion).hint && (
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                        {t(formatOf(currentQuestion).hint!)}
                    </p>
                )}
            </div>

            {/* Navigation */}
            <div className="flex gap-3">
                <button
                    onClick={handlePrevious}
                    disabled={currentIndex === 0}
                    className="px-4 py-2.5 border border-slate-200 dark:border-slate-600 rounded-xl text-slate-700 dark:text-slate-200 disabled:opacity-50 hover:bg-slate-50 dark:hover:bg-slate-700"
                >
                    {t("Previous")}
                </button>

                {currentIndex === totalQuestions - 1 ? (
                    <button
                        onClick={handleSubmit}
                        disabled={Object.keys(answers).length !== totalQuestions || checking}
                        className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-green-700 text-white rounded-xl hover:bg-green-600 disabled:opacity-50"
                    >
                        {checking ? (
                            <>
                                <Loader2 className="w-5 h-5 animate-spin" />
                                {t("Checking...")}
                            </>
                        ) : (
                            <>
                                <Award className="w-5 h-5" />
                                {t("Submit Quiz")}
                            </>
                        )}
                    </button>
                ) : (
                    <button
                        onClick={handleNext}
                        className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-accent text-white rounded-xl hover:bg-accent/90"
                    >
                        {t("Next")}
                        <ChevronRight className="w-5 h-5" />
                    </button>
                )}
            </div>
        </div>
    );
}