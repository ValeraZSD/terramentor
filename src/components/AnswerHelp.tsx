import { useState } from 'react';
import { api } from '../api';
import Markdown from './Markdown';
import ExternalSearchButton from './ExternalSearchButton';
import { GraduationCap, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
    nodeId: number;
    nodeTitle: string;
    question: string;
    correctAnswer: string;
    userAnswer?: string;
    /** Project name — disambiguates a thin topic title for the video search. */
    context?: string | null;
}

/**
 * "I don't actually know this — teach me", attached to a reviewed answer.
 *
 * The gap this closes: hitting an unfamiliar term mid-assessment (a Nyquist
 * theorem you've never met) used to mean selecting it, leaving the app, and
 * searching — which ends the session. Now the two things the learner was
 * leaving for are on the answer itself: a full explanation written against this
 * topic's own context, and a video search already filled in.
 *
 * It appears only on the REVIEW screen, after the answer is submitted. That is
 * the whole design: during the questions it would be an answer key, so the
 * assessment stays honest and the teaching happens on the way out — then the
 * learner retakes the Boss Fight having actually closed the gap.
 */
export default function AnswerHelp({ nodeId, nodeTitle, question, correctAnswer, userAnswer, context }: Props) {
    const { t } = useTranslation();
    const [explanation, setExplanation] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const explain = async () => {
        if (loading || explanation) return;
        setLoading(true);
        setError(null);
        try {
            const res = await api.explainQuestion(nodeId, question, correctAnswer, userAnswer);
            setExplanation(res.explanation);
        } catch (e: any) {
            setError(e?.message || 'Could not reach the AI to explain this.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="mt-3">
            <div className="flex flex-wrap items-center gap-1">
                {!explanation && (
                    <button
                        onClick={explain}
                        disabled={loading}
                        className="inline-flex items-center gap-1.5 px-3 py-2 min-h-11 rounded-lg text-sm font-medium text-accent-fg hover:bg-accent/10 disabled:opacity-60 transition"
                    >
                        {loading
                            ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                            : <GraduationCap className="w-4 h-4" aria-hidden="true" />}
                        {loading ? t("Writing an explanation…") : t("Teach me this")}
                    </button>
                )}
                <ExternalSearchButton title={nodeTitle} context={context} surface="missed_answer" />
            </div>

            {error && (
                <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">{error}</p>
            )}

            {/* A rule, not a box. This always renders inside a review row that is
                already a tinted, bordered container, and an explanation can
                itself contain a chart or a code block with a frame of its own —
                so a card here made three nested borders around one paragraph.
                One hairline separates it from the verdict above; the depth of
                the block is carried by indentation, not by more chrome. */}
            {explanation && (
                <div className="mt-3 pt-3 border-t border-slate-200/70 dark:border-slate-700/70">
                    <Markdown
                        content={explanation}
                        nodeId={nodeId}
                        autoRepair
                        autoBuild={false}
                        className="text-sm leading-6 text-slate-700 dark:text-slate-200"
                    />
                </div>
            )}
        </div>
    );
}
