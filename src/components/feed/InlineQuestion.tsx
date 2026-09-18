import { useState } from 'react';
import QuestionStem from '../QuestionStem';
import AnswerHelp from '../AnswerHelp';
import MathText from '../MathText';
import AnswerInput from '../answer/AnswerInput';
import AnswerKey from '../answer/AnswerKey';
import { formatOf, defaultAnswer } from '../answer/formats';
import { Button } from '../ui/Button';
import { gradeAnswer, GradedAnswer } from '../../utils/grading';
import { QuizQuestion } from '../../types';
import { Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type { GradedAnswer };

interface Props {
    question: QuizQuestion;
    /** Already-recorded result (card re-rendered after being answered). */
    graded?: GradedAnswer | null;
    onGraded: (result: GradedAnswer) => void;
    /** Topic under test — context for a visual stem that has to repair itself. */
    nodeId?: number;
    /** Topic + project names, so a missed answer can offer "teach me this". */
    nodeTitle?: string;
    projectName?: string | null;
    /** Where the stem is read, and how a repaired spec is written back. */
    surface?: string;
    onRepaired?: (originalCode: string, repairedCode: string) => void;
}

/**
 * One self-grading question, embedded in a feed card. Sibling of QuizView's
 * per-question UI (kept separate on purpose — QuizView stays a multi-question
 * assessment surface): a closed format grades the moment it is chosen; an
 * open one (prose, code, an ordering) is submitted with the Check button.
 * Both go through `gradeAnswer`, which knows which formats grade locally and
 * which through the checker, so this component knows no format by name.
 */
export default function InlineQuestion({ question, graded = null, onGraded, nodeId, nodeTitle, projectName, surface, onRepaired }: Props) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState('');
    const [checking, setChecking] = useState(false);
    const result = graded;
    const format = formatOf(question);

    const grade = async (answer: string) => {
        if (!answer.trim() || result || checking) return;
        setChecking(true);
        try {
            onGraded(await gradeAnswer(question, answer));
        } finally {
            setChecking(false);
        }
    };

    // An untouched ordering is already an answer (the served order counts);
    // prose and code are answers once something is typed.
    const answer = draft.trim() ? draft : defaultAnswer(question);
    const submittable = !!answer;
    const submit = () => grade(answer);

    return (
        <div>
            <div className="text-base font-medium text-slate-800 dark:text-slate-100 mb-3">
                <QuestionStem content={question.question} nodeId={nodeId} surface={surface} onRepaired={onRepaired} media={question.media} />
            </div>

            <AnswerInput
                question={question}
                value={draft}
                onChange={setDraft}
                onCommit={format.commitsOnSelect ? grade : undefined}
                disabled={checking}
                result={result}
            />

            {!format.commitsOnSelect && !result && (
                <div className="flex items-center justify-between gap-3 mt-2">
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                        {format.hint ? t(format.hint) : ''}
                    </p>
                    <Button variant="primary" size="md" busy={checking} disabled={!submittable} onClick={submit} className="shrink-0">
                        {t("Check answer")}
                    </Button>
                </div>
            )}

            {/* The verdict is a MARGIN, not a box.
                A filled, bordered card wraps the expected answer, the
                explanation, and a second bordered card for "Teach me this",
                which can itself contain a chart in a third frame: four nested
                outlines around one wrong answer, each drawn to say "this
                belongs together" and collectively saying nothing. One coloured
                rule down the left carries the verdict just as loudly and leaves
                the content room to have structure of its own. */}
            {result && (
                <div className={`mt-4 pl-3 sm:pl-4 border-l-2 ${result.correct
                    ? 'border-emerald-500 dark:border-emerald-500'
                    : 'border-red-400 dark:border-red-500'}`}
                >
                    <p className={`flex items-center gap-1.5 text-sm font-semibold ${result.correct
                        ? 'text-emerald-700 dark:text-emerald-300'
                        : 'text-red-700 dark:text-red-300'}`}
                    >
                        {result.correct ? <Check className="w-4 h-4 shrink-0" /> : <X className="w-4 h-4 shrink-0" />}
                        {result.correct ? t("Correct") : result.unsure ? t("Not marked") : t("Not quite")}
                    </p>
                    {!result.correct && (
                        <div className="mt-1.5">
                            <AnswerKey question={question} />
                        </div>
                    )}
                    {result.explanation && (
                        <p className="text-sm leading-6 text-slate-600 dark:text-slate-400 mt-1.5">
                            <MathText content={result.explanation} />
                        </p>
                    )}
                    {/* Same escape hatch as the Boss Fight review: learn the thing
                        you just missed without leaving to go and search for it. */}
                    {!result.correct && nodeId != null && nodeTitle && (
                        <AnswerHelp
                            nodeId={nodeId}
                            nodeTitle={nodeTitle}
                            question={question.question}
                            correctAnswer={question.correct_answer}
                            userAnswer={result.answer}
                            context={projectName}
                        />
                    )}
                </div>
            )}
        </div>
    );
}
