import { useState } from 'react';
import { api } from '../api';
import { Quiz, QuizQuestion, GhostResult } from '../types';
import { useStore } from '../store';
import { ArrowLeft, Check, X, ChevronRight, Award, RotateCcw, Loader2, History } from 'lucide-react';
import MathText from './MathText';
import QuestionStem from './QuestionStem';
import AnswerHelp from './AnswerHelp';
import AnswerInput from './answer/AnswerInput';
import AnswerKey from './answer/AnswerKey';
import { formatOf, defaultAnswer } from './answer/formats';
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

export default function QuizView({ quiz, onClose }: Props) {
    const { t } = useTranslation();
    const addToast = useStore(s => s.addToast);
    // Topic + project names for the review screen's "teach me this" / video
    // search. A ghost question is about ANOTHER topic, so it carries its own.
    const nodeTitle = useStore(s => s.nodes.find(n => n.id === quiz.node_id)?.title ?? '');
    const projectName = useStore(s => s.projects.find(p => p.id === s.currentProjectId)?.name ?? null);

    const [currentIndex, setCurrentIndex] = useState(0);
    const [answers, setAnswers] = useState<Record<number, string>>({});
    const [answerResults, setAnswerResults] = useState<Record<number, AnswerResult>>({});
    const [showResults, setShowResults] = useState(false);
    const [, setSubmitted] = useState(false);
    const [checking, setChecking] = useState(false);

    const currentQuestion = quiz.questions[currentIndex];
    const totalQuestions = quiz.questions.length;

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

            for (let idx = 0; idx < quiz.questions.length; idx++) {
                const question = quiz.questions[idx];
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
            for (let idx = 0; idx < quiz.questions.length; idx++) {
                const q = quiz.questions[idx];
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
            await api.submitQuizAttempt(quiz.id, answers, primaryScore, primaryTotal, ghostResults);
            setSubmitted(true);
            setShowResults(true);
        } catch (error: any) {
            addToast('error', t("Failed to submit quiz"), error.message);
        } finally {
            setChecking(false);
        }
    };

    const handleRetry = () => {
        setAnswers({});
        setAnswerResults({});
        setCurrentIndex(0);
        setShowResults(false);
        setSubmitted(false);
    };

    // Headline score reflects only this quiz's own topic; ghost (review) questions
    // are scored separately so they don't distort the node's result.
    const primaryIndices = quiz.questions
        .map((q, idx) => ({ q, idx }))
        .filter(({ q }) => !q.isGhost);
    const ghostCount = quiz.questions.length - primaryIndices.length;
    const score = primaryIndices.filter(({ idx }) => answerResults[idx]?.correct).length;
    const primaryTotal = primaryIndices.length;
    const percentage = primaryTotal > 0 ? Math.round((score / primaryTotal) * 100) : 0;
    const ghostCorrect = quiz.questions
        .filter((q, idx) => q.isGhost && answerResults[idx]?.correct).length;

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
                    <div className={`w-24 h-24 mx-auto rounded-full flex items-center justify-center text-3xl font-bold ${percentage >= 80 ? 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400' :
                        percentage >= 60 ? 'bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30 dark:text-yellow-400' :
                            'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'
                        }`}>
                        {percentage}%
                    </div>
                    <p className="mt-4 text-lg font-medium text-slate-700 dark:text-slate-200">
                        {t("You scored {{score}} out of {{primaryTotal}}", { score, primaryTotal })}
                    </p>
                    <p className="text-slate-500 dark:text-slate-400 mt-1">
                        {percentage >= 80 ? t("Excellent work!") :
                            percentage >= 60 ? t("Good job! Keep practicing.") :
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
                    {quiz.questions.map((q, idx) => {
                        const userAnswer = effectiveAnswer(q, answers[idx]);
                        const result = answerResults[idx];
                        const isCorrect = result?.correct || false;

                        return (
                            <div key={idx} className="p-4 bg-slate-50 dark:bg-slate-800 rounded-xl">
                                <div className="flex items-start gap-3">
                                    <div className={`p-1 rounded-full flex-shrink-0 ${isCorrect ? 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'}`}>
                                        {isCorrect ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        {q.isGhost && (
                                            <span className="inline-flex items-center gap-1 mb-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">
                                                <History className="w-2.5 h-2.5" />
                                                {t("Review: {{ghostNodeTitle}}", { ghostNodeTitle: q.ghostNodeTitle })}
                                            </span>
                                        )}
                                        <div className="font-medium text-slate-700 dark:text-slate-200"><QuestionStem content={q.question} nodeId={quiz.node_id} surface="quiz-review" media={q.media} /></div>
                                        {formatOf(q).blockAnswer && userAnswer ? (
                                            // Code and an ordering read as blocks: the input, locked,
                                            // painted with the verdict — the learner's own solution
                                            // highlighted, each step marked in or out of place.
                                            <div className="mt-2">
                                                <p className="text-sm text-slate-500 dark:text-slate-400 mb-1">{t("Your answer:")}</p>
                                                <AnswerInput question={q} value={userAnswer} onChange={() => {}} result={{ correct: isCorrect, answer: userAnswer }} />
                                            </div>
                                        ) : (
                                            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                                                {t("Your answer:")}{' '}<span className={isCorrect ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>{userAnswer ? <MathText content={userAnswer} /> : t("(no answer)")}</span>
                                            </p>
                                        )}
                                        {!isCorrect && (
                                            <div className="mt-1.5">
                                                <AnswerKey question={q} />
                                            </div>
                                        )}
                                        {result?.explanation && (
                                            <p className="text-sm text-slate-700 dark:text-slate-200 mt-2 italic"><MathText content={result.explanation} /></p>
                                        )}
                                        {!isCorrect && (q.ghostNodeTitle || nodeTitle) && (
                                            <AnswerHelp
                                                nodeId={q.ghostNodeId ?? quiz.node_id}
                                                nodeTitle={q.ghostNodeTitle || nodeTitle}
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

                <div className="flex gap-3">
                    <button
                        onClick={handleRetry}
                        className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-accent text-white rounded-xl hover:bg-accent/90"
                    >
                        <RotateCcw className="w-5 h-5" />
                        {t("Retry Quiz")}
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