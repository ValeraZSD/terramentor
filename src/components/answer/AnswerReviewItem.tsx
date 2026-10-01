import type { ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { QuizQuestion } from '../../types';
import MathText from '../MathText';
import QuestionStem from '../QuestionStem';
import AnswerHelp from '../AnswerHelp';
import AnswerInput from './AnswerInput';
import AnswerKey from './AnswerKey';
import { formatOf } from './formats';

/**
 * One answered question, read back: the verdict, the question, what the
 * learner answered, the key when they missed it, the explanation, and the
 * offer to learn the point where it went wrong.
 *
 * The practice quiz and the mastery check each drew this by hand, two copies a
 * few classes apart; the day's ledger now opens a finished sitting and needs the
 * same row a third time, so it is drawn here once.
 */
export default function AnswerReviewItem({ question, answer, correct, explanation, nodeId, nodeTitle, projectName, surface, badge }: {
    question: QuizQuestion;
    /** What the learner answered — for an unanswered ordering, the order served. */
    answer: string;
    correct: boolean;
    /** The grader's explanation; the question's own is the fallback. */
    explanation?: string;
    nodeId: number;
    /** With a title, a wrong answer offers `AnswerHelp`. */
    nodeTitle?: string;
    projectName?: string | null;
    surface: string;
    /** Above the question — the practice quiz marks a review question here. */
    badge?: ReactNode;
}) {
    const { t } = useTranslation();
    const said = explanation || question.explanation;
    return (
        <div className="p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-slate-200 dark:border-slate-700">
            <div className="flex items-start gap-3">
                <div className={`p-1 rounded-full shrink-0 ${correct
                    ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400'
                    : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'}`}
                >
                    {correct
                        ? <Check className="w-4 h-4" aria-label={t("Correct")} />
                        : <X className="w-4 h-4" aria-label={t("Wrong")} />}
                </div>
                <div className="flex-1 min-w-0">
                    {badge}
                    <div className="font-medium text-slate-700 dark:text-slate-200">
                        <QuestionStem content={question.question} nodeId={nodeId} surface={surface} media={question.media} />
                    </div>
                    {formatOf(question).blockAnswer && answer ? (
                        // Code and an ordering read as blocks: the input, locked
                        // and painted with the verdict.
                        <div className="mt-2">
                            <p className="text-sm text-slate-500 dark:text-slate-400 mb-1">{t("Your answer:")}</p>
                            <AnswerInput question={question} value={answer} onChange={() => {}} result={{ correct, answer }} />
                        </div>
                    ) : (
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                            {t("Your answer:")}{' '}
                            <span className={correct ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                                {answer ? <MathText content={answer} /> : t("(no answer)")}
                            </span>
                        </p>
                    )}
                    {!correct && (
                        <div className="mt-1.5">
                            <AnswerKey question={question} />
                        </div>
                    )}
                    {said && (
                        <p className="text-sm text-slate-600 dark:text-slate-300 mt-2 italic"><MathText content={said} /></p>
                    )}
                    {/* Learn it here rather than leaving to search for the
                        term — offered on the answers that actually went wrong. */}
                    {!correct && nodeTitle && (
                        <AnswerHelp
                            nodeId={nodeId}
                            nodeTitle={nodeTitle}
                            question={question.question}
                            correctAnswer={question.correct_answer}
                            userAnswer={answer}
                            context={projectName}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}
