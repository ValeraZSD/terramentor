import { useEffect, useState } from 'react';
import { ArrowLeft, Loader2, RotateCcw, ArrowUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { useStore } from '../../store';
import type { SittingReview } from '../../types';
import { uiLocale } from '../../utils/locale';
import { Button } from '../ui/Button';
import AnswerReviewItem from '../answer/AnswerReviewItem';
import { k } from '../../i18n';

const KIND_LABEL: Record<string, string> = {
    mastery_check: k("Mastery check"),
    quiz: k("Quiz"),
};

/**
 * One finished check or quiz, opened from the day's ledger: every question as
 * it was asked, what the learner answered, which were right, the key and the
 * explanation for the ones that were not — and a way to try again.
 *
 * It replaces the ledger INSIDE the same dialog (with Back) rather than opening
 * a second dialog over it: two stacked dialogs is two Escapes to leave and a
 * focus trap inside a focus trap.
 */
export default function SittingReviewView({ evidenceId, onBack, onLeave }: {
    evidenceId: number;
    onBack: () => void;
    /** The dialog closes before going somewhere else. */
    onLeave: () => void;
}) {
    const { t } = useTranslation();
    const openProjectNode = useStore(s => s.openProjectNode);
    const openMasteryGate = useStore(s => s.openMasteryGate);
    const [review, setReview] = useState<SittingReview | null>(null);
    const [failed, setFailed] = useState(false);
    const projectName = useStore(s => (review ? s.projects.find(p => p.id === review.projectId)?.name : null) ?? null);

    useEffect(() => {
        let cancelled = false;
        setReview(null);
        setFailed(false);
        api.getSittingReview(evidenceId)
            .then(r => { if (!cancelled) setReview(r); })
            .catch(() => { if (!cancelled) setFailed(true); });
        return () => { cancelled = true; };
    }, [evidenceId]);

    const back = (
        <Button variant="quiet" size="sm" onClick={onBack} icon={<ArrowLeft className="w-4 h-4" aria-hidden="true" />}>
            {t("Back to today")}
        </Button>
    );

    if (failed) {
        return (
            <div>
                {back}
                <p className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                    {t("The answers of this sitting could not be loaded.")}
                </p>
            </div>
        );
    }
    if (!review) {
        return (
            <div>
                {back}
                <p className="py-10 flex items-center justify-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> {t("Loading the answers…")}
                </p>
            </div>
        );
    }

    // Counted off the questions shown, so the line agrees with the list under it.
    const right = review.items.filter(i => i.correct).length;
    const wrong = review.items.length - right;
    const when = new Date(review.at).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit', hour12: false });

    const retake = async () => {
        // The learner's own gate setting, read on the press — never assumed.
        let advisory = true;
        try { advisory = (await api.getSettings()).mastery_gate_mode !== 'enforced'; } catch { /* advisory is the default */ }
        onLeave();
        openMasteryGate(review.nodeId, review.nodeTitle, advisory, review.projectId);
    };

    return (
        <div>
            {back}
            <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                        {t(KIND_LABEL[review.kind] ?? "Quiz")} · {when}
                    </p>
                    <h3 className="text-base font-semibold text-slate-900 dark:text-white">{review.nodeTitle}</h3>
                    <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
                        {t("{{score}} of {{total}} correct", { score: right, total: review.items.length })}
                        {wrong > 0 && <> · {t("{{count}} to revisit", { count: wrong })}</>}
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button variant="neutral" size="sm" onClick={() => void retake()} icon={<RotateCcw className="w-4 h-4" aria-hidden="true" />}>
                        {review.kind === 'mastery_check' ? t("Retake the check") : t("Take the mastery check")}
                    </Button>
                    <Button
                        variant="quiet"
                        size="sm"
                        onClick={() => { onLeave(); openProjectNode(review.projectId, review.nodeId); }}
                        icon={<ArrowUpRight className="w-4 h-4" aria-hidden="true" />}
                    >
                        {t("Open the topic")}
                    </Button>
                </div>
            </div>
            <div className="mt-4 space-y-3">
                {review.items.map((item, i) => (
                    <AnswerReviewItem
                        key={i}
                        question={item.question}
                        answer={item.answer}
                        correct={item.correct}
                        explanation={item.explanation}
                        nodeId={review.nodeId}
                        nodeTitle={review.nodeTitle}
                        projectName={projectName}
                        surface="sitting-review"
                    />
                ))}
            </div>
        </div>
    );
}
