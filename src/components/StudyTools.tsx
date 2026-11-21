import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import { Quiz, Flashcard } from '../types';
import FlashcardView from './FlashcardView';
import FlashcardEditor from './FlashcardEditor';
import Modal from './Modal';
import MathText from './MathText';
import QuestionStem from './QuestionStem';
import AnswerInput from './answer/AnswerInput';
import { Button, IconButton } from './ui/Button';
import { Field, TextInput, Select } from './ui/Field';
import { Plus, Loader2, Trash2, RotateCcw, Pencil, Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNumberFormat } from '../hooks/useNumberFormat';
import { isReportedCard } from '../utils/srs';

interface Props {
    nodeId: number;
    /** The topic's title: a set named after its topic does not print it again. */
    topicTitle: string;
}

type QuestionType = 'multiple_choice' | 'true_false' | 'both' | 'code' | 'sequence' | 'assemble';

/**
 * A set's own questions. Sets written before this tab could carry copies of
 * other topics' questions for review (`isGhost`); listed and counted here they
 * would read as this topic's own.
 */
const ownQuestions = (quiz: Quiz) => quiz.questions.filter(q => !q.isGhost);

/**
 * A topic's questions and cards, in one tab: see them, edit them, make more.
 *
 * There is no quiz to take here and no score. The topic's Study (the panel
 * header) serves these questions and the due cards in its stream, and the
 * mastery check is the topic's proof; a second sitting with its own "Best: 90%"
 * was a second proof path beside the check, and a re-take of the same five
 * questions measured the five questions. What stays is one run through ALL of
 * the topic's cards, due or not, for the night before an exam: Study serves
 * only the due ones, and every flashcard app keeps this (Anki's custom study,
 * RemNote's Practice All, Mochi's Cram, Quizlet's sets).
 */
export default function StudyTools({ nodeId, topicTitle }: Props) {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const addToast = useStore(s => s.addToast);
    const showConfirm = useStore(s => s.showConfirm);

    const [quizzes, setQuizzes] = useState<Quiz[]>([]);
    const [flashcards, setFlashcards] = useState<Flashcard[]>([]);
    const [loading, setLoading] = useState(false);
    // Which list is being written to, so only that section's button spins
    // and the other stays usable as a view.
    const [generating, setGenerating] = useState<'questions' | 'cards' | null>(null);
    // Live reasoning/output character counts while a thinking-capable model
    // generates questions or cards — mirrors AIPanel's "Reasoning… (N chars)".
    const [thinkingChars, setThinkingChars] = useState(0);
    const [progressChars, setProgressChars] = useState(0);
    const [practising, setPractising] = useState(false);

    // Question generation options
    const [showQuizOptions, setShowQuizOptions] = useState(false);
    const [questionCount, setQuestionCount] = useState(5);
    const [questionType, setQuestionType] = useState<QuestionType>('both');

    // A set's questions with their key
    const [viewingQuiz, setViewingQuiz] = useState<Quiz | null>(null);

    // Flashcard edit modal
    const [editingFlashcard, setEditingFlashcard] = useState<Flashcard | null>(null);

    // Abort controller for an in-flight question/card generation stream.
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
    // questions and cards via loadData.)
    useEffect(() => {
        return () => {
            genAbortRef.current?.abort();
            genAbortRef.current = null;
        };
    }, [nodeId]);

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
        setGenerating('questions');
        setThinkingChars(0);
        setProgressChars(0);
        try {
            // No review questions from other, fading topics (includeGhosts):
            // they were there to be credited by a quiz sitting, which is gone,
            // and in this list they would read as this topic's own questions.
            // Fading topics come back through the stream's own review round.
            await api.streamGenerateQuiz(
                nodeId, questionCount, questionType, false,
                (chars) => setProgressChars(chars),
                controller.signal,
                (chars) => setThinkingChars(chars),
            );
            await loadData();
            addToast('success', t("Questions generated"));
            setShowQuizOptions(false);
        } catch (error: any) {
            // A detach (node switch / unmount) isn't a failure — the task keeps
            // running in the dock.
            if (!controller.signal.aborted) addToast('error', t("Could not generate questions"), error.message);
        } finally {
            if (genAbortRef.current === controller) genAbortRef.current = null;
            if (!controller.signal.aborted) setGenerating(null);
        }
    };

    const handleGenerateFlashcards = async () => {
        genAbortRef.current?.abort();
        const controller = new AbortController();
        genAbortRef.current = controller;
        setGenerating('cards');
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
            if (!controller.signal.aborted) setGenerating(null);
        }
    };

    // Live counter shown under the section that is being written to:
    // "Reasoning… (N chars)" during the model's thinking phase, then
    // "Generating… (N chars)" once content starts arriving.
    const generationCounter = (section: 'questions' | 'cards') => {
        if (generating !== section || (thinkingChars === 0 && progressChars === 0)) return null;
        return (
            <p className="text-xs font-mono tabular-nums text-accent-fg">
                {progressChars > 0
                    ? t("Generating… ({{progressChars}} chars)", { count: progressChars, progressChars: num(progressChars) })
                    : t("Reasoning… ({{thinkingChars}} chars)", { count: thinkingChars, thinkingChars: num(thinkingChars) })}
            </p>
        );
    };

    // A bin beside an eye is one slip away: both deletes ask first, as the
    // card editor's does.
    const handleDeleteQuiz = async (quiz: Quiz) => {
        const ok = await showConfirm({
            title: t("Delete these {{count}} questions?", { count: ownQuestions(quiz).length }),
            message: t("They are removed from this topic for good."),
            confirmLabel: t("Delete"),
            variant: 'danger',
        });
        if (!ok) return;
        const quizId = quiz.id;
        try {
            await api.deleteQuiz(quizId);
            setQuizzes(prev => prev.filter(q => q.id !== quizId));
            addToast('success', t("Questions deleted"));
        } catch (error: any) {
            addToast('error', t("Could not delete the questions"), error.message);
        }
    };

    const handleDeleteFlashcard = async (id: number) => {
        const ok = await showConfirm({
            title: t("Delete this card?"),
            message: t("It is removed from this deck for good. Its review history goes with it."),
            confirmLabel: t("Delete"),
            variant: 'danger',
        });
        if (!ok) return;
        try {
            await api.deleteFlashcard(id);
            setFlashcards(prev => prev.filter(f => f.id !== id));
            addToast('success', t("Flashcard deleted"));
        } catch (error: any) {
            addToast('error', t("Failed to delete flashcard"), error.message);
        }
    };

    /** The row is already gone from the server — stop counting it here. */
    const forgetFlashcard = (id: number) => setFlashcards(prev => prev.filter(f => f.id !== id));
    // The run ends with its last card: left on, it would reopen by itself the
    // moment "More cards" wrote new ones.
    // A reported card is parked until it is fixed: Study does not show it and
    // a rating on it is refused, so the run leaves it out too.
    const runnable = useMemo(() => flashcards.filter(c => !isReportedCard(c)), [flashcards]);
    useEffect(() => {
        if (runnable.length === 0) setPractising(false);
    }, [runnable.length]);

    if (practising && runnable.length > 0) {
        return (
            <FlashcardView
                flashcards={runnable}
                onClose={() => {
                    setPractising(false);
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

    // A section's heading with its one way to add more on the same line:
    // making more is reached for now and then, so it is a small button there
    // rather than a full-width bar above the list.
    // Under it, one line on where the section's items are used: a list you
    // can only view and delete reads as a dead end without it.
    const sectionHead = (id: string, title: string, action: ReactNode, use: string) => (
        <div className="space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id={id} className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</h3>
                <div className="flex flex-wrap items-center gap-2">{action}</div>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400">{use}</p>
        </div>
    );

    return (
        <div className="p-4 space-y-6">
            <section aria-labelledby={`questions-${nodeId}`} data-section="questions" className="space-y-3">
                {sectionHead(`questions-${nodeId}`, t("Questions"), (
                    <Button
                        size="sm"
                        variant="neutral"
                        onClick={() => setShowQuizOptions(v => !v)}
                        disabled={generating !== null}
                        aria-expanded={showQuizOptions}
                        icon={<Plus className="w-4 h-4" />}
                    >
                        {t("More questions")}
                    </Button>
                ), t("Study asks a few of these each day."))}

                {showQuizOptions && (
                    <div className="p-4 bg-slate-50 dark:bg-slate-900/40 rounded-xl space-y-4">
                        <Field label={t("Number of Questions")}>
                            {id => (
                                <TextInput
                                    id={id}
                                    type="number"
                                    min={1}
                                    max={20}
                                    value={questionCount}
                                    onChange={e => setQuestionCount(Math.max(1, Math.min(20, parseInt(e.target.value) || 5)))}
                                />
                            )}
                        </Field>

                        <Field label={t("Question Type")}>
                            {id => (
                                <Select
                                    id={id}
                                    value={questionType}
                                    onChange={v => setQuestionType(v as QuestionType)}
                                >
                                    <option value="both">{t("Multiple Choice & True/False")}</option>
                                    <option value="multiple_choice">{t("Multiple Choice Only (Pick 1 of 4)")}</option>
                                    <option value="true_false">{t("True/False Only")}</option>
                                    <option value="code">{t("Write code")}</option>
                                    <option value="sequence">{t("Put steps in order")}</option>
                                    <option value="assemble">{t("Build from pieces")}</option>
                                </Select>
                            )}
                        </Field>

                        <div className="flex gap-2">
                            <Button variant="quiet" onClick={() => setShowQuizOptions(false)}>
                                {t("Cancel")}
                            </Button>
                            <Button
                                variant="primary"
                                className="flex-1"
                                onClick={handleGenerateQuiz}
                                busy={generating === 'questions'}
                            >
                                {t("Generate {{count}} questions", { count: questionCount })}
                            </Button>
                        </div>
                        {generationCounter('questions')}
                    </div>
                )}

                {quizzes.length === 0 ? (
                    !showQuizOptions && <p className="text-sm text-slate-500 dark:text-slate-400">{t("No questions yet")}</p>
                ) : (
                    <ul className="space-y-2">
                        {quizzes.map(quiz => {
                            // A set is usually titled after its topic, which the
                            // panel's header already names: then the row is its size.
                            const named = quiz.title.trim().toLowerCase() !== topicTitle.trim().toLowerCase();
                            return (
                            <li
                                key={quiz.id}
                                className="flex items-center justify-between gap-2 p-3 bg-slate-50 dark:bg-slate-900/40 rounded-xl"
                            >
                                <div className="min-w-0 flex-1">
                                    <p className="font-medium text-slate-700 dark:text-slate-200">
                                        {t("{{length}} questions", { count: ownQuestions(quiz).length, length: ownQuestions(quiz).length })}
                                    </p>
                                    {named && (
                                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 truncate">
                                            {quiz.title}
                                        </p>
                                    )}
                                </div>
                                <div className="flex items-center gap-2 flex-shrink-0">
                                    {/* A word, not a bare eye beside the bin: learners did not know what the eye did. */}
                                    <Button size="sm" variant="quiet" onClick={() => setViewingQuiz(quiz)} aria-label={t("View questions")} icon={<Eye className="w-4 h-4" />}>
                                        {t("View")}
                                    </Button>
                                    <IconButton size="sm" onClick={() => handleDeleteQuiz(quiz)} label={t("Delete these questions")} icon={<Trash2 className="w-4 h-4" />} />
                                </div>
                            </li>
                            );
                        })}
                    </ul>
                )}
            </section>

            <section aria-labelledby={`cards-${nodeId}`} data-section="cards" className="space-y-3">
                {sectionHead(`cards-${nodeId}`, t("Cards"), (
                    <>
                        {/* Every card of the topic, due or not, once through:
                            Study serves only the due ones, and this is the run
                            before an exam. A small button beside More cards,
                            not a bar: it is reached for now and then, and the
                            panel's Study is the everyday door. */}
                        {runnable.length > 0 && (
                            <Button
                                size="sm"
                                variant="neutral"
                                icon={<RotateCcw className="w-4 h-4" />}
                                onClick={() => setPractising(true)}
                            >
                                {t("Practise all")}
                            </Button>
                        )}
                        <Button
                            size="sm"
                            variant="neutral"
                            busy={generating === 'cards'}
                            disabled={generating === 'questions'}
                            onClick={handleGenerateFlashcards}
                            icon={<Plus className="w-4 h-4" />}
                        >
                            {t("More cards")}
                        </Button>
                    </>
                ), runnable.length > 0
                    ? t("Study shows each card on the day it is due. Practise all goes through every one now.")
                    : t("Study shows each card on the day it is due."))}
                {generationCounter('cards')}

                {flashcards.length === 0 ? (
                    <p className="text-sm text-slate-500 dark:text-slate-400">{t("No flashcards yet")}</p>
                ) : (
                    // No inner scroll box and no height cap: the tab that
                    // hosts this is already `flex-1 overflow-auto`, so a
                    // 400px lid gave a stunted, separately-scrolling list
                    // with dead space under it however tall the panel was.
                    // One scroll region per screen — this list is content,
                    // and the panel scrolls it.
                    <ul className="space-y-2">
                        {flashcards.map(card => (
                            <li
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
                                        <IconButton size="sm" onClick={() => setEditingFlashcard(card)} label={t("Edit")} icon={<Pencil className="w-4 h-4" />} />
                                        <IconButton size="sm" onClick={() => handleDeleteFlashcard(card.id)} label={t("Delete")} icon={<Trash2 className="w-4 h-4" />} />
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {/* A set's questions with their key */}
            <Modal
                isOpen={!!viewingQuiz}
                onClose={() => setViewingQuiz(null)}
                title={viewingQuiz?.title || t("Questions")}
                footer={(
                    <Button onClick={() => setViewingQuiz(null)}>
                        {t("Close")}
                    </Button>
                )}
            >
                {/* The dialog's body is the one scroller; Close stays in its foot. */}
                <div className="space-y-4">
                    <p>{t("Correct answers:")}</p>
                    {(viewingQuiz ? ownQuestions(viewingQuiz) : []).map((q, idx) => (
                        <div key={idx} className="p-4 bg-slate-50 dark:bg-slate-900/40 rounded-xl">
                            <div className="flex items-start gap-3">
                                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-accent/10 text-accent-fg flex items-center justify-center text-sm font-medium">
                                    {idx + 1}
                                </span>
                                <div className="flex-1 min-w-0">
                                    <div className="font-medium text-slate-700 dark:text-slate-200">
                                        <QuestionStem content={q.question} nodeId={viewingQuiz?.node_id} surface="quiz" media={q.media} mediaSize="review" />
                                    </div>

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
