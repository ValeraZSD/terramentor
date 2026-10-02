import { useEffect, useRef, useState } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { connectOpenRouter, takeOpenRouterReturnPath } from '../../utils/openRouterConnect';
import { Button } from '../ui/Button';

/**
 * Where openrouter.ai sends the browser back to (`/connect/openrouter?code=…`).
 *
 * It hands the code to the server, which trades it for a key and saves it, and
 * then RELOADS onto the page the learner left — a reload rather than a route
 * change, so every panel that read the old provider reads the new one. The
 * code is single-use, so the exchange runs once even under StrictMode's double
 * effect.
 */
export default function OpenRouterReturn() {
    const { t } = useTranslation();
    const [returnTo] = useState(takeOpenRouterReturnPath);
    const [error, setError] = useState<string | null>(null);
    const [retrying, setRetrying] = useState(false);
    const started = useRef(false);

    useEffect(() => {
        if (started.current) return;
        started.current = true;
        const code = new URLSearchParams(window.location.search).get('code');
        if (!code) {
            setError(t("OpenRouter sent no code back, so no key was made. The sign-in may have been cancelled."));
            return;
        }
        api.finishOpenRouterConnect(code)
            .then(() => window.location.replace(returnTo))
            .catch((e: any) => setError(e?.message || t("Could not connect OpenRouter")));
    }, [returnTo, t]);

    return (
        <div className="min-h-screen flex items-center justify-center bg-slate-100 dark:bg-slate-900 px-4">
            <div className="w-full max-w-sm bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-8 text-center">
                {error ? (
                    <>
                        <TriangleAlert className="w-7 h-7 mx-auto mb-3 text-amber-500" aria-hidden="true" />
                        <h1 className="text-lg font-semibold text-slate-900 dark:text-white">{t("OpenRouter is not connected")}</h1>
                        <p role="alert" className="mt-2 text-sm text-slate-600 dark:text-slate-300 break-words">{error}</p>
                        <div className="mt-5 flex flex-wrap justify-center gap-2">
                            <Button
                                variant="primary"
                                busy={retrying}
                                onClick={() => {
                                    setRetrying(true);
                                    connectOpenRouter(returnTo).catch((e: any) => { setRetrying(false); setError(e?.message || String(e)); });
                                }}
                            >
                                {t("Try again")}
                            </Button>
                            <Button variant="neutral" onClick={() => window.location.replace(returnTo)}>{t("Go back")}</Button>
                        </div>
                    </>
                ) : (
                    <p className="flex items-center justify-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> {t("Connecting OpenRouter…")}
                    </p>
                )}
            </div>
        </div>
    );
}
