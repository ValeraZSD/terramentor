import { Bot, WifiOff, RefreshCw } from 'lucide-react';
import type { AIStatus } from '../types';
import { describeAIUnavailable } from '../utils/aiStatus';
import ConnectAIActions from './ConnectAIActions';
import { Button } from './ui/Button';
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
    /** Runs before the connect buttons open Settings (`ConnectAIActions`). */
    onLeave?: () => void;
}

// One provider-aware "AI not available" notice, shared by every surface that gates
// on AI status. The copy comes from describeAIUnavailable(status), so it always
// matches the *selected* provider (never hardcodes Ollama).
export default function AIUnavailableNotice({ status, onRetry, variant = 'inline', className = '', onLeave }: Props) {
    const { t } = useTranslation();
    const info = describeAIUnavailable(status);
    const connect = info.connect && (
        <div className="mt-2"><ConnectAIActions returnTo={window.location.pathname} onLeave={onLeave} /></div>
    );

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
                {connect}
                {onRetry && (
                    <Button className="mt-3" icon={<RefreshCw className="w-4 h-4" aria-hidden="true" />} onClick={onRetry}>
                        {t("Retry connection")}
                    </Button>
                )}
            </div>
        );
    }

    // Nothing connected is a step to take, not a dropped connection: the home
    // card's robot rather than a crossed-out wifi (read as "no internet"), and
    // the headline and buttons without the card's paragraph, which sits beside
    // it on the home page and read as the same alarm twice.
    const Icon = info.connect ? Bot : WifiOff;
    return (
        <div className={`flex items-start gap-3 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-xl ${className}`}>
            <Icon className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-px" aria-hidden="true" />
            <div className="flex-1">
                <p className="text-sm font-medium text-amber-900 dark:text-amber-200">{info.headline}</p>
                {!info.connect && (
                    <p className="text-sm text-amber-800 dark:text-amber-300 mt-0.5">
                        {info.detail}
                        {onRetry && (
                            <> <button type="button" data-link="retry" onClick={onRetry} className="underline">{t("Retry")}</button></>
                        )}
                    </p>
                )}
                {connect}
            </div>
        </div>
    );
}
