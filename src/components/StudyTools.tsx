import { useState, useEffect, useRef } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import { Quiz, Flashcard } from '../types';
import QuizView from './QuizView';
import FlashcardView from './FlashcardView';
import FlashcardEditor from './FlashcardEditor';
import Modal from './Modal';
import MathText from './MathText';
import AnswerInput from './answer/AnswerInput';
import { Brain, BookOpen, Plus, Loader2, Trash2, Award, RotateCcw, Pencil, Settings2, Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNumberFormat } from '../hooks/useNumberFormat';

interface Props {
    nodeId: number;
    mode: 'quiz' | 'flashcards';
    onCountsChange?: (quizCount: number, flashcardCount: number) => void;
}

type QuestionType = 'multiple_choice' | 'true_false' | 'both' | 'code' | 'sequence';

export default function StudyTools({ nodeId, mode, onCountsChange }: Props) {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const addToast = useStore(s => s.addToast);

    const [quizzes, setQuizzes] = useState<Quiz[]>([]);
    const [flashcards, setFlashcards] = useState<Flashcard[]>([]);
    const [loading, setLoading] = useState(false);
    const [generating, setGenerating] = useState(false);
    // Live reasoning/output character counts while a thinking-capable model
    // generates a quiz or flashcard set — mirrors AIPanel's "Reasoning… (N chars)".
    const [thinkingChars, setThinkingChars] = useState(0);
    const [progressChars, setProgressChars] = useState(0);
    const [selectedQuiz, setSelectedQuiz] = useState<Quiz | null>(null);
    const [studyingFlashcards, setStudyingFlashcards] = useState(false);

    // Quiz generation options
    const [showQuizOptions, setShowQuizOptions] = useState(false);
    const [questionCount, setQuestionCount] = useState(5);
    const [questionType, setQuestionType] = useState<QuestionType>('both');

    // Quiz view/edit modal
    const [viewingQuiz, setViewingQuiz] = useState<Quiz | null>(null);

    // Flashcard edit modal
    const [editingFlashcard, setEditingFlashcard] = useState<Flashcard | null>(null);

    // Abort controller for an in-flight quiz/flashcard generation stream.
    // Generation is a *background task* (it keeps running server-side and shows
    // in the task dock), so aborting here only DETACHES this component's SSE
    // connection — it never cancels the work. Detaching on node-switch / unmount
    // is what keeps us from leaking one open HTTP connection per fired task and
    // exhausting the browser's per-origin connection pool.
    const genAbortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        loadData();
    }, [nodeId]);

    // Detach the generation stream when the node changes or the panel unmounts.
    // (The task itself is unaffected; reopening the node reloads its finished
    // quizzes/flashcards via loadData.)
    useEffect(() => {
        return () => {
            genAbortRef.current?.abort();
            genAbortRef.current = null;
        };
    }, [nodeId]);

    // Notify parent of count changes
    useEffect(() => {
        onCountsChange?.(quizzes.length, flashcards.length);
    }, [quizzes.length, flashcards.length, onCountsChange]);

    const loadData = async () => {
        setLoading(true);
        try {
            const [quizData, flashcardData] = await Promise.all([
                api.getQuizzes(nodeId),
                api.getFlashcards(nodeId)
            ]);
            setQuizzes(quizData);
            setFlashcards(flashcardData);
        } catch (error) {
            console.error('Failed to load study tools:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleGenerateQuiz = async () => {
        genAbortRef.current?.abort();
        const controller = new AbortController();
        genAbortRef.current = controller;
        setGenerating(true);
        setThinkingChars(0);
        setProgressChars(0);
        try {
            // includeGhosts: practice quizzes interleave review of decaying topics
            // (the "Remember" loop). The mastery check gate deliberately does not.
            await api.streamGenerateQuiz(
                nodeId, questionCount, questionType, true,
                (chars) => setProgressChars(chars),
                controller.signal,
                (chars) => setThinkingChars(chars),
            );
            await loadData();
            addToast('success', t("Quiz generated!"));
            setShowQuizOptions(false);
        } catch (error: any) {
            // A detach (node switch / unmount) isn't a failure — the task keeps
            // running in the dock.
            if (!controller.signal.aborted) addToast('error', t("Failed to generate quiz"), error.message);
        } finally {
            if (genAbortRef.current === controller) genAbortRef.current = null;
            if (!controller.signal.aborted) setGenerating(false);
        }
    };

    const handleGenerateFlashcards = async () => {
        genAbortRef.current?.abort();
        const controller = new AbortController();
        genAbortRef.current = controller;
        setGenerating(true);
        setThinkingChars(0);
        setProgressChars(0);
        try {
            await api.streamGenerateFlashcards(
                nodeId, 10,
                (chars) => setProgressChars(chars),
                (chars) => setThinkingChars(chars),
                controller.signal,
            );
            await loadData();
            addToast('success', t("Flashcards generated!"));
        } catch (error: any) {
            if (!controller.signal.aborted) addToast('error', t("Failed to generate flashcards"), error.message);
        } finally {
            if (genAbortRef.current === controller) genAbortRef.current = null;
            if (!controller.signal.aborted) setGenerating(false);
        }
    };

    // Shared live counter shown under a Generate button while streaming:
    // "Reasoning… (N chars)" during the model's thinking phase, then
    // "Generating… (N chars)" once content starts arriving.
    const GenerationCounter = () => {
        const { t } = useTranslation();
        const num = useNumberFormat();
        if (!generating || (thinkingChars === 0 && progressChars === 0)) return null;
        return (
            <p className="text-xs font-mono tabular-nums text-accent-fg text-center -mt-1">
                {progressChars > 0
                    ? t("Generating… ({{progressChars}} chars)", { count: progressChars, progressChars: num(progressChars) })
                    : t("Reasoning… ({{thinkingChars}} chars)", { count: thinkingChars, thinkingChars: num(thinkingChars) })}
            </p>
        );
    };

    const handleDeleteQuiz = async (quizId: number) => {
        try {
            await api.deleteQuiz(quizId);
            setQuizzes(prev => prev.filter(q => q.id !== quizId));
            addToast('success', t("Quiz deleted"));
        } catch (error: any) {
            addToast('error', t("Failed to delete quiz"), error.message);
        }
    };

    const handleDeleteFlashcard = async (id: number) => {
        try {
            await api.deleteFlashcard(id);
            setFlashcards(prev => prev.filter(f => f.id !== id));
            addToast('success', t("Flashcard deleted"));
        } catch (error: any) {
            addToast('error', t("Failed to delete flashcard"), error.message);
        }
    };

    const handleEditFlashcard = (flashcard: Flashcard) => setEditingFlashcard(flashcard);

    /** The row is already gone from the server — stop counting it here. */
    const forgetFlashcard = (id: number) => setFlashcards(prev => prev.filter(f => f.id !== id));


    const getScoreColor = (score: number | null | undefined) => {
        if (score === null || score === undefined) return 'text-slate-500';
        if (score === 100) return 'text-green-600 dark:text-green-400';
        if (score === 0) return 'text-red-600 dark:text-red-400';
        return 'text-orange-600 dark:text-orange-400';
    };

    if (selectedQuiz) {
        return (
            <QuizView
                quiz={selectedQuiz}
                onClose={() => {
                    setSelectedQuiz(null);
                    loadData();
                }}
            />
        );
    }

    if (studyingFlashcards && flashcards.length > 0) {
        return (
            <FlashcardView
                flashcards={flashcards}
                onClose={() => {
                    setStudyingFlashcards(false);
                    loadData();
                }}
                onDelete={forgetFlashcard}
            />
        );
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center py-12 text-slate-500 dark:text-slate-400">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                {t("Loading...")}
            </div>
        );
    }

    return (
        <div className="p-4 space-y-4">
            {mode === 'quiz' && (
                <div className="space-y-3">
                    {/* Quiz Generation Options */}
                    {showQuizOptions ? (
                        <div className="p-4 bg-slate-50 dark:bg-slate-900/40 rounded-xl space-y-4">
                            <div className="flex items-center justify-between">
                                <h3 className="font-medium text-slate-700 dark:text-slate-200">{t("Quiz Options")}</h3>
                                <button
                                    onClick={() => setShowQuizOptions(false)}
                                    className="text-slate-500 dark:text-slate-400 hover:text-slate-600 text-sm"
                                >
                                    {t("Cancel")}
                                </button>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                                    {t("Number of Questions")}
                                </label>
                                <input
                                    type="number"
                                    min={1}
                                    max={20}
                                    value={questionCount}
                                    onChange={e => setQuestionCount(Math.max(1, Math.min(20, parseInt(e.target.value) || 5)))}
                                    className="w-full px-3 py-2 border border-slate-200 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-200"
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                                    {t("Question Type")}
                                </label>
                                <select
                                    value={questionType}
                                    onChange={e => setQuestionType(e.target.value as QuestionType)}
                                    className="w-full px-3 py-2 border border-slate-200 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-200"
                                >
                                    <option value="both">{t("Multiple Choice & True/False")}</option>
                                    <option value="multiple_choice">{t("Multiple Choice Only (Pick 1 of 4)")}</option>
                                    <option value="true_false">{t("True/False Only")}</option>
                                    <option value="code">{t("Write code")}</option>
                                    <option value="sequence">{t("Put steps in order")}</option>
                                </select>
                            </div>

                            <button
                                onClick={handleGenerateQuiz}
                                disabled={generating}
                                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-accent text-white rounded-xl hover:bg-accent/90 disabled:opacity-50 transition"
                            >
                                {generating ? (
                                    <Loader2 className="w-5 h-5 animate-spin" />
                                ) : (
                                    <Plus className="w-5 h-5" />
                                )}
                                {t("Generate Quiz")}
                            </button>
                            <GenerationCounter />
                        </div>
                    ) : (
                        <button
                            onClick={() => setShowQuizOptions(true)}
                            disabled={generating}
                            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-accent text-white rounded-xl hover:bg-accent/90 disabled:opacity-50 transition"
                        >
                            <Settings2 className="w-5 h-5" />
                            {/* Not "Generate Quiz from <title>": the panel header
                                already names the topic, and a long one wrapped this
                                button onto three lines. */}
                            {t("Generate Quiz")}
                        </button>
                    )}

                    {quizzes.length === 0 ? (
                        <div className="text-center py-8 text-slate-400">
                            <Brain className="w-12 h-12 mx-auto mb-3 opacity-50" />
                            <p>{t("No quizzes yet")}</p>
                            <p className="text-sm mt-1">{t("Generate a quiz to test your knowledge")}</p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {quizzes.map(quiz => (
                                <div
                                    key={quiz.id}
                                    className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900/40 rounded-xl"
                                >
                                    <div className="min-w-0 flex-1">
                                        <p className="font-medium text-slate-700 dark:text-slate-200 truncate">
                                            {quiz.title}
                                        </p>
                                        <div className="flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400 mt-1">
                                            <span>{t("{{length}} questions", { count: quiz.questions.length, length: quiz.questions.length })}</span>
                                            {quiz.best_score !== undefined && quiz.best_score !== null && (
                                                <span className={`flex items-center gap-1 ${getScoreColor(quiz.best_score)}`}>
                                                    <Award className="w-3.5 h-3.5" />
                                                    {t("Best: {{best_score}}%", { best_score: quiz.best_score })}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                                        <button
                                            onClick={() => setViewingQuiz(quiz)}
                                            className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded"
                                            title={t("View questions")}
                                        >
                                            <Eye className="w-4 h-4" />
                                        </button>
                                        <button
                                            onClick={() => setSelectedQuiz(quiz)}
                                            className="px-3 py-1.5 bg-accent text-white rounded-lg text-sm hover:bg-accent/90"
                                        >
                                            {t("Take Quiz")}
                                        </button>
                                        <button
                                            onClick={() => handleDeleteQuiz(quiz.id)}
                                            aria-label={t("Delete quiz")}
                                            className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {mode === 'flashcards' && (
                <div className="space-y-3">
                    <div className="flex gap-2">
                        <button
                            onClick={handleGenerateFlashcards}
                            disabled={generating}
                            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-accent text-white rounded-xl hover:bg-accent/90 disabled:opacity-50 transition"
                        >
                            {generating ? (
                                <Loader2 className="w-5 h-5 animate-spin" />
                            ) : (
                                <Plus className="w-5 h-5" />
                            )}
                            {t("Generate Flashcards")}
                        </button>
                    </div>
                    <GenerationCounter />
                    {/* Rendered only when there is something to study. An always-
                        present empty wrapper still collected a `space-y-3` gap,
                        so the empty state carried a band of dead space it had no
                        content for. */}
                    {flashcards.length > 0 && (
                        <div className="flex gap-2">
                            <button
                                onClick={() => setStudyingFlashcards(true)}
                                className="flex items-center gap-2 px-4 py-3 bg-green-700 text-white rounded-xl hover:bg-green-600 transition"
                            >
                                <RotateCcw className="w-5 h-5" />
                                {t("Study")}
                            </button>
                        </div>
                    )}

                    {flashcards.length === 0 ? (
                        <div className="text-center py-8 text-slate-400">
                            <BookOpen className="w-12 h-12 mx-auto mb-3 opacity-50" />
                            <p>{t("No flashcards yet")}</p>
                            <p className="text-sm mt-1">{t("Generate flashcards for spaced repetition")}</p>
                        </div>
                    ) : (
                        // No inner scroll box and no height cap: the tab that
                        // hosts this is already `flex-1 overflow-auto`, so a
                        // 400px lid gave a stunted, separately-scrolling list
                        // with dead space under it however tall the panel was.
                        // One scroll region per screen — this list is content,
                        // and the panel scrolls it.
                        <div className="space-y-2">
                            {flashcards.map(card => (
                                <div
                                    key={card.id}
                                    className="p-3 bg-slate-50 dark:bg-slate-900/40 rounded-xl group"
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        {/* Two lines, not one. Truncating to a
                                            single line made a set of cards that
                                            legitimately share an opening ("What
                                            are the boundary conditions for a…")
                                            render as identical rows — the words
                                            that tell them apart were exactly the
                                            ones cut off, so the list could not be
                                            used to find a card. */}
                                        <div className="min-w-0 flex-1 overflow-hidden">
                                            <p className="font-medium text-slate-700 dark:text-slate-200 text-sm line-clamp-2 break-words">
                                                <MathText content={card.front} />
                                            </p>
                                            <p className="text-slate-500 dark:text-slate-400 text-sm mt-1 line-clamp-2 break-words">
                                                <MathText content={card.back} />
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-1 flex-shrink-0 transition-opacity can-hover:opacity-0 can-hover:group-hover:opacity-100 can-hover:focus-within:opacity-100">
                                            <button
                                                onClick={() => handleEditFlashcard(card)}
                                                className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded"
                                                title={t("Edit")}
                                            >
                                                <Pencil className="w-4 h-4" />
                                            </button>
                                            <button
                                                onClick={() => handleDeleteFlashcard(card.id)}
                                                className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded"
                                                title={t("Delete")}
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* View Quiz Questions Modal */}
            <Modal
                isOpen={!!viewingQuiz}
                onClose={() => setViewingQuiz(null)}
                title={viewingQuiz?.title || t("Quiz Questions")}
            >
                <div className="space-y-4 max-h-[60vh] overflow-y-auto">
                    <p>{t("Correct answers:")}</p>
                    {viewingQuiz?.questions.map((q, idx) => (
                        <div key={idx} className="p-4 bg-slate-50 dark:bg-slate-900/40 rounded-xl">
                            <div className="flex items-start gap-3">
                                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-accent/10 text-accent-fg flex items-center justify-center text-sm font-medium">
                                    {idx + 1}
                                </span>
                                <div className="flex-1 min-w-0">
                                    <p className="font-medium text-slate-700 dark:text-slate-200">
                                        <MathText content={q.question} />
                                    </p>

                                    {/* The key, shown as the answered question would look:
                                        the winning option painted, the solution highlighted,
                                        the steps in their right order. One rendering for every
                                        format, so a new one previews without a new branch. */}
                                    <div className="mt-2">
                                        <AnswerInput
                                            question={q}
                                            value={q.correct_answer}
                                            onChange={() => {}}
                                            result={{ correct: true, answer: q.correct_answer }}
                                        />
                                    </div>

                                    {q.explanation && (
                                        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400 italic">
                                            <MathText content={q.explanation} />
                                        </p>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
                <div className="mt-4 flex justify-end">
                    <button
                        onClick={() => setViewingQuiz(null)}
                        className="px-4 py-2 border border-slate-200 dark:border-slate-600 rounded-lg text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700"
                    >
                        {t("Close")}
                    </button>
                </div>
            </Modal>

            {editingFlashcard && (
                <FlashcardEditor
                    card={editingFlashcard}
                    onClose={() => setEditingFlashcard(null)}
                    onSaved={updated => setFlashcards(prev => prev.map(f => (f.id === updated.id ? updated : f)))}
                    onDeleted={forgetFlashcard}
                />
            )}
        </div>
    );
}