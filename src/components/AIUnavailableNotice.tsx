import { WifiOff, RefreshCw } from 'lucide-react';
import type { AIStatus } from '../types';
import { describeAIUnavailable } from '../utils/aiStatus';
import { useTranslation } from 'react-i18next';

interface Props {
    status: AIStatus | null;
    /** Retry callback — re-checks status. Omit to hide the retry control. */
    onRetry?: () => void;
    /**
     * `panel` — full-height block with numbered setup steps (AIPanel tutor pane).
     * `inline` — compact strip that sits above other content (dashboards/chat).
     */
    variant?: 'panel' | 'inline';
    className?: string;
}

// One provider-aware "AI not available" notice, shared by every surface that gates
// on AI status. The copy comes from describeAIUnavailable(status), so it always
// matches the *selected* provider (never hardcodes Ollama).
export default function AIUnavailableNotice({ status, onRetry, variant = 'inline', className = '' }: Props) {
    const { t } = useTranslation();
    const info = describeAIUnavailable(status);

    if (variant === 'panel') {
        return (
            <div className={`p-4 bg-amber-50 dark:bg-amber-900/20 rounded-xl ${className}`}>
                <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 mb-2">
                    <WifiOff className="w-5 h-5" />
                    <span className="font-medium">{info.headline}</span>
                </div>
                <p className="text-sm text-amber-600 dark:text-amber-500 mb-3">{info.detail}</p>
                {info.steps.length > 0 && (
                    <div className="text-sm text-amber-600 dark:text-amber-500 space-y-1">
                        {info.steps.map((step, i) => (
                            <p key={i}>{i + 1}. {step}</p>
                        ))}
                    </div>
                )}
                {onRetry && (
                    <button
                        onClick={onRetry}
                        className="mt-3 flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400 hover:underline"
                    >
                        <RefreshCw className="w-4 h-4" />
                        {t("Retry connection")}
                    </button>
                )}
            </div>
        );
    }

    return (
        <div className={`flex items-center gap-3 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-xl ${className}`}>
            <WifiOff className="w-5 h-5 text-amber-500 shrink-0" />
            <div className="flex-1">
                <p className="text-sm font-medium text-amber-700 dark:text-amber-300">{info.headline}</p>
                <p className="text-sm text-amber-600 dark:text-amber-400 mt-0.5">
                    {info.detail}
                    {onRetry && (
                        <> <button onClick={onRetry} className="underline">{t("Retry")}</button></>
                    )}
                </p>
            </div>
        </div>
    );
}
