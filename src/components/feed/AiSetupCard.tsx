import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, RefreshCw } from 'lucide-react';
import { api } from '../../api';
import type { AIStatus } from '../../types';
import { describeAIUnavailable, isAIUsable } from '../../utils/aiStatus';
import { useTranslation } from 'react-i18next';
import { k } from '../../i18n';

const DISMISS_KEY = 'ai_setup_dismissed';

/**
 * The "no model reachable" state, designed rather than left to happen.
 *
 * A fresh install has no AI endpoint, and the app is built so that this is
 * fine — the planner, the feed over the learner's own material, flashcards
 * and paper practice all run without one. But nothing SAID so: the first feed
 * simply lacked lessons, the tutor button failed, and the only diagnosis was a
 * grey dot in Settings. A stranger reads that as broken.
 *
 * This card renders only while AI is enabled but unusable (no model chosen, or
 * the endpoint does not answer). Turning AI off in Settings is a decision, not
 * a problem, so that state shows nothing. "Continue without AI" dismisses it
 * for good on this library (a setting, so the phone agrees with the desktop);
 * a later working endpoint retires it anyway, because the check is live.
 *
 * The size table is deliberately in classes, never model names: model names
 * rot in weeks, and the app's rule is that guidance is by size and the list
 * comes from the provider (Settings → AI & Models).
 */
const SIZE_TABLE: { hardware: string; size: string; experience: string }[] = [
    { hardware: k("8 GB GPU / laptop"), size: '7–9B', experience: k("Works. Lessons and questions pass the checks; leans on the repair loop; advanced visuals off.") },
    { hardware: k("12–16 GB GPU"), size: '12–14B', experience: k("Good. Fewer repairs, better diagrams.") },
    { hardware: k("24 GB+ GPU or a hosted model"), size: '30B+', experience: k("The full experience, including sandboxed widgets and sketches.") },
];

export default function AiSetupCard() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [status, setStatus] = useState<AIStatus | null | undefined>(undefined);
    const [dismissed, setDismissed] = useState<boolean | null>(null);
    const [checking, setChecking] = useState(false);

    const check = useCallback(async () => {
        setChecking(true);
        try {
            const s = await api.getAIStatus();
            setStatus(s);
            // Only a library that actually needs the card pays for the second
            // request; a working endpoint never asks whether it was dismissed.
            if (!isAIUsable(s) && s.enabled) {
                const settings = await api.getSettings();
                setDismissed(settings[DISMISS_KEY] === 'true');
            }
        } catch {
            setStatus(null);
        } finally {
            setChecking(false);
        }
    }, []);

    useEffect(() => { void check(); }, [check]);

    if (status === undefined || status === null) return null;   // still checking, or no server
    if (!status.enabled || isAIUsable(status)) return null;
    if (dismissed !== false) return null;

    const info = describeAIUnavailable(status);

    const dismiss = async () => {
        setDismissed(true);
        try { await api.setSetting(DISMISS_KEY, 'true'); } catch { /* cosmetic only */ }
    };

    return (
        <section
            aria-label={t("Set up AI")}
            className="rounded-2xl border border-amber-300/60 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/5 overflow-hidden"
        >
            <div className="flex items-start gap-3 px-4 sm:px-5 pt-4 pb-3">
                <span className="p-1.5 rounded-lg bg-amber-100 dark:bg-amber-500/15 shrink-0 mt-0.5">
                    <Bot className="w-4 h-4 text-amber-700 dark:text-amber-300" aria-hidden="true" />
                </span>
                <div className="flex-1 min-w-0">
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                        {info.headline}
                    </h2>
                    <p className="text-sm text-slate-600 dark:text-slate-300 mt-0.5">
                        {info.detail}
                    </p>
                    <p className="text-sm text-slate-600 dark:text-slate-300 mt-2">
                        {t("Everything else works without a model: planning and pace, your own notes and saved questions as reading cards, flashcards with spaced repetition, and paper practice marked by hand. A model adds lessons, questions, a tutor and visuals.")}
                    </p>
                </div>
            </div>

            <div className="px-4 sm:px-5 pb-4 space-y-3">
                {info.steps.length > 0 && (
                    <ol className="text-xs text-slate-700 dark:text-slate-200 space-y-1 list-decimal pl-5">
                        {info.steps.map(step => <li key={step}>{step}</li>)}
                    </ol>
                )}

                {/* A list, not a table: three rows with one long cell each is a
                    table only in shape, and on a phone the long cell became a
                    column of single words. */}
                <ul className="divide-y divide-amber-200/60 dark:divide-amber-500/15 text-xs">
                    {SIZE_TABLE.map(row => (
                        <li key={row.size} className="py-1.5 flex flex-col sm:flex-row sm:items-baseline sm:gap-3">
                            <span className="sm:w-56 shrink-0 text-slate-700 dark:text-slate-200">
                                {t(row.hardware)}
                                <span className="text-slate-500 dark:text-slate-400" aria-hidden="true"> · </span>
                                <span className="font-semibold text-slate-900 dark:text-white">{row.size}</span>
                            </span>
                            <span className="text-slate-600 dark:text-slate-300">{t(row.experience)}</span>
                        </li>
                    ))}
                </ul>

                <div className="flex flex-wrap items-center gap-2">
                    <button
                        onClick={() => navigate('/settings#ai')}
                        className="px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent/90 transition"
                    >
                        {t("Set up AI")}
                    </button>
                    <button
                        onClick={() => void check()}
                        disabled={checking}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-white dark:hover:bg-slate-800 transition disabled:opacity-60"
                    >
                        <RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} aria-hidden="true" />
                        {t("Check again")}
                    </button>
                    <button
                        onClick={dismiss}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800 transition"
                    >
                        {t("Continue without AI")}
                    </button>
                </div>
            </div>
        </section>
    );
}
