import { useTranslation } from 'react-i18next';
import { useStore, isDarkTheme } from '../../store';
import MathText from '../MathText';
import SyntaxHighlighter, { highlightLanguage } from '../codeLanguages';
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark';
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light';
import type { QuizQuestion } from '../../types';
import { formatOf, parseSequence, prettyUnit, parseNumber } from './formats';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import { writtenDecimals } from '../../utils/numberFormat';

/**
 * The key, shown under a wrong answer: the option, the model answer, the
 * reference solution, the right order. Each format decides how its key reads —
 * a solution is code and must be highlighted as code, an ordering is a
 * numbered list — and the verdict margin that hosts this does not have to know.
 */
export default function AnswerKey({ question }: { question: QuizQuestion }) {
    const { t } = useTranslation();
    const dark = isDarkTheme(useStore(s => s.theme));
    const num = useNumberFormat();
    const label = t(formatOf(question).keyLabel);

    if (question.type === 'code') {
        return (
            <div className="text-sm text-slate-700 dark:text-slate-300">
                <span className="text-slate-500 dark:text-slate-400">{label}</span>
                <div className="mt-1.5 rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
                    <SyntaxHighlighter
                        style={dark ? oneDark : oneLight}
                        language={highlightLanguage(question.language || '')}
                        PreTag="div"
                        customStyle={{ margin: 0, padding: '0.75rem', fontSize: '0.85rem', background: 'transparent' }}
                        codeTagProps={{ style: { background: 'transparent' } }}
                    >
                        {question.correct_answer}
                    </SyntaxHighlighter>
                </div>
            </div>
        );
    }

    if (question.type === 'sequence') {
        const key = parseSequence(question.correct_answer) ?? [];
        return (
            <div className="text-sm text-slate-700 dark:text-slate-300">
                <span className="text-slate-500 dark:text-slate-400">{label}</span>
                <ol className="mt-1 list-decimal pl-6 space-y-0.5">
                    {key.map((item, i) => <li key={i} className="font-medium"><MathText content={item} /></li>)}
                </ol>
            </div>
        );
    }

    // A number's key carries its unit — the input showed the unit as furniture
    // beside the box, so the key must put it back or it reads as a bare
    // quantity — and the tolerance, because "you said 9.7, the answer is 9.81"
    // leaves the learner unable to tell a rounding slip from a real error.
    if (question.type === 'numeric') {
        const tolerance = Number(question.tolerance);
        // The key is written in the reader's own separators, but keeps the
        // DECIMALS it was authored with: a key of "4.170" claims three
        // significant figures, and reprinting it as 4,17 would quietly say the
        // answer was measured less precisely than it was.
        const value = parseNumber(question.correct_answer);
        const key = value === null
            ? question.correct_answer
            : num(value, { decimals: writtenDecimals(question.correct_answer) });
        return (
            <p className="text-sm text-slate-700 dark:text-slate-300">
                <span className="text-slate-500 dark:text-slate-400">{label}</span>{' '}
                <span className="font-medium tabular-nums">
                    {key}{question.unit ? ` ${prettyUnit(question.unit)}` : ''}
                </span>
                {Number.isFinite(tolerance) && tolerance > 0 && (
                    <span className="text-slate-500 dark:text-slate-400">
                        {' '}{t("(anything within {{tolerance}} counts)", { tolerance: num(tolerance) })}
                    </span>
                )}
            </p>
        );
    }

    return (
        <p className="text-sm text-slate-700 dark:text-slate-300">
            <span className="text-slate-500 dark:text-slate-400">{label}</span>{' '}
            <span className="font-medium"><MathText content={question.correct_answer} /></span>
        </p>
    );
}
