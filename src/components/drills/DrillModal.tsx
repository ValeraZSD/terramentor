import { useCallback, useEffect } from 'react';
import MathText from '../MathText';
import { api } from '../../api';
import DrillPlayer from './DrillPlayer';
import type { DrillRoundResult, DrillSpec } from '../../types';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
    spec: DrillSpec;
    onClose: () => void;
}

/**
 * The drill surface: a full-screen sheet on mobile, a centred overlay panel on
 * desktop (exactly the placement the feature was asked for). Escape and the
 * backdrop close it; a completed FULL round records mastery evidence for the
 * node — tagged `drill` so it feeds the retention estimate and decay timer but,
 * unlike a real quiz/boss-fight, never satisfies the completion gate's raw-score
 * clause. Practice sharpens the estimate; proving still needs an assessment.
 */
export default function DrillModal({ spec, onClose }: Props) {
    const { t } = useTranslation();
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        // Lock body scroll while the drill is open.
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
    }, [onClose]);

    const handleRound = useCallback((result: DrillRoundResult) => {
        // Only full rounds are honest evidence; a "missed-only" retry is a biased
        // subset. Silent, best-effort — a drill is practice, not a graded task.
        if (result.full && spec.nodeId && result.total > 0) {
            api.recordDrillResult(spec.nodeId, result.correct, result.total).catch(() => { });
        }
    }, [spec.nodeId]);

    return (
        <div
            className="fixed inset-0 z-[60] flex items-stretch sm:items-center justify-center bg-black/60 dark:bg-black/80 sm:p-4"
            role="dialog"
            aria-modal="true"
            aria-label={spec.title || t("Practice drill")}
            onClick={onClose}
        >
            <div
                className="relative flex w-full flex-col bg-white dark:bg-slate-800 shadow-xl sm:max-w-lg sm:rounded-2xl sm:max-h-[90vh]"
                onClick={e => e.stopPropagation()}
            >
                {/* The close button is a ROW, not an overlay.

                    It used to be absolutely positioned at the top right, which
                    is where the playing screen puts its countdown — so on a
                    timed drill the X sat on top of the seconds remaining, the
                    one number the learner is watching. A dialog whose dismiss
                    control covers its own content has no safe position for it;
                    giving it a row of its own costs ~44px and can never collide
                    with anything. */}
                <div className="flex items-center justify-between gap-2 px-5 sm:px-6 pt-3 pb-1">
                    <p className="min-w-0 truncate text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        {spec.title ? <MathText content={spec.title} /> : t("Practice drill")}
                    </p>
                    <button
                        onClick={onClose}
                        aria-label={t("Close drill")}
                        className="-mr-2 shrink-0 rounded-lg p-2 text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>
                <div className="overflow-y-auto px-5 sm:px-6 pb-6 sm:pb-7 pt-1">
                    <DrillPlayer spec={spec} onRoundComplete={handleRound} />
                </div>
            </div>
        </div>
    );
}
