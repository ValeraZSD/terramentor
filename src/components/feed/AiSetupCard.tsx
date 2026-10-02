import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, ExternalLink, RefreshCw, X } from 'lucide-react';
import { api } from '../../api';
import type { AIStatus } from '../../types';
import { describeAIUnavailable, isAIUsable } from '../../utils/aiStatus';
import { connectOpenRouter } from '../../utils/openRouterConnect';
import { Button, IconButton } from '../ui/Button';
import { useTranslation } from 'react-i18next';

const DISMISS_KEY = 'ai_setup_dismissed';

/**
 * The "no model reachable" state, at the top of the feed.
 *
 * The app is built to be taught by a model: lessons, questions, visuals and the
 * tutor all come from one. A library with none is not a working app minus a
 * feature, it is the course shelf without the teacher, so this card says what
 * is missing and how to get it in one press. What still works without a model
 * (saved lessons, questions and flashcards) is said once, as a fact, not as the
 * headline.
 *
 * It renders only while AI is enabled but unusable (no model chosen, or the
 * endpoint does not answer). Turning AI off in Settings is a decision, not a
 * problem, so that state shows nothing. "Not now" hides it for good on this
 * library (a setting, so the phone agrees with the desktop); a later working
 * endpoint retires it anyway, because the check is live.
 *
 * A library that never chose a model gets "Connect OpenRouter" as its one
 * primary action — the same one-press path as the welcome screen. A library
 * whose chosen model has stopped answering is sent to its own settings, where
 * that model is.
 */
export default function AiSetupCard() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [status, setStatus] = useState<AIStatus | null | undefined>(undefined);
    const [dismissed, setDismissed] = useState<boolean | null>(null);
    const [checking, setChecking] = useState(false);
    const [connecting, setConnecting] = useState(false);

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

    // Never set up: the default provider with no model is not a choice anyone made.
    const neverChosen = status.provider === 'ollama' && !status.model;
    const info = describeAIUnavailable(status);

    const dismiss = async () => {
        setDismissed(true);
        try { await api.setSetting(DISMISS_KEY, 'true'); } catch { /* cosmetic only */ }
    };

    const connect = async () => {
        setConnecting(true);
        try { await connectOpenRouter('/'); } catch { setConnecting(false); navigate('/settings#ai'); }
    };

    return (
        <section
            aria-label={t("Set up AI")}
            className="rounded-2xl border border-amber-300/60 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/5 overflow-hidden"
        >
            <div className="flex items-start gap-3 px-4 sm:px-5 py-4">
                <span className="p-1.5 rounded-lg bg-amber-100 dark:bg-amber-500/15 shrink-0 mt-0.5">
                    <Bot className="w-4 h-4 text-amber-700 dark:text-amber-300" aria-hidden="true" />
                </span>
                <div className="flex-1 min-w-0">
                    {/* Re-check and dismiss are the card's own chrome, top-right
                        like the Getting started card below it. Four buttons of
                        mixed styles wrapping over two rows read as a toolbar
                        with no order. */}
                    <div className="flex items-start gap-2">
                        <h2 className="flex-1 min-w-0 pt-1 text-sm font-semibold text-slate-900 dark:text-white">
                            {neverChosen ? t("Connect an AI model to start learning") : info.headline}
                        </h2>
                        <IconButton
                            size="sm"
                            onClick={() => void check()}
                            busy={checking}
                            label={t("Check again")}
                            icon={<RefreshCw className="w-4 h-4" aria-hidden="true" />}
                            className="-mt-0.5"
                        />
                        <IconButton
                            size="sm"
                            onClick={dismiss}
                            label={t("Not now")}
                            icon={<X className="w-4 h-4" aria-hidden="true" />}
                            className="-mt-0.5 -mr-1.5"
                        />
                    </div>
                    <p className="text-sm text-slate-600 dark:text-slate-300 mt-0.5">
                        {neverChosen
                            ? t("The model writes your lessons, questions and visuals and answers your questions. A hosted model through OpenRouter takes one press to connect; Settings has every other way.")
                            : info.detail}
                    </p>
                    <p className="text-sm text-slate-600 dark:text-slate-300 mt-2">
                        {t("Until then you can still study what is already saved: lessons, questions and flashcards.")}
                    </p>

                    {!neverChosen && info.steps.length > 0 && (
                        <ol className="mt-3 text-sm text-slate-700 dark:text-slate-200 space-y-1 list-decimal pl-5">
                            {info.steps.map(step => <li key={step}>{step}</li>)}
                        </ol>
                    )}

                    {/* The text column's own left edge, so the buttons line up
                        with the heading rather than with the icon. */}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                    {neverChosen ? (
                        <>
                            <Button
                                size="sm"
                                variant="primary"
                                busy={connecting}
                                onClick={() => void connect()}
                                icon={<ExternalLink className="w-4 h-4" aria-hidden="true" />}
                            >
                                {t("Connect OpenRouter")}
                            </Button>
                            <Button size="sm" variant="quiet" onClick={() => navigate('/settings#ai')}>
                                {t("Other ways")}
                            </Button>
                        </>
                    ) : (
                        <Button size="sm" variant="primary" onClick={() => navigate('/settings#ai')}>
                            {t("Set up AI")}
                        </Button>
                    )}
                    </div>
                </div>
            </div>
        </section>
    );
}
