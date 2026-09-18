import type { AIStatus } from '../types';
import { AI_HEALTH_DOT, aiHealth, providerLabel } from '../utils/aiStatus';
import { useTranslation } from 'react-i18next';

/**
 * "Which model am I talking to, and is it alive?" — one badge, every chat
 * surface (node tutor, global assistant).
 *
 * One badge because per-surface copies drift: a two-state dot makes an
 * unreachable server look the same as no model selected, and a provider hidden
 * in a tooltip hides half the answer. The union — provider · model · four-state
 * dot — is the whole answer to "what is answering me", identical wherever the
 * learner asks it.
 *
 * The dot's colour vocabulary lives in aiStatus.ts (grey off, amber warning,
 * red unreachable, green online) and is deliberately NOT redefined here.
 */
export default function AiModelBadge({
    status,
    loading = false,
    fallbackLabel = 'AI',
    className = '',
}: {
    status: AIStatus | null;
    /** A status check is in flight — the dot breathes instead of asserting. */
    loading?: boolean;
    /** Shown when there is no status at all (server unreachable). */
    fallbackLabel?: string;
    className?: string;
}) {
    const { t } = useTranslation();
    const health = aiHealth(status);
    return (
        <div className={`flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 min-w-0 ${className}`}>
            {status ? (
                <span
                    className="flex items-center gap-1.5 min-w-0"
                    title={`${providerLabel(status)} · ${health.detail}`}
                >
                    <span className="flex-shrink-0">{providerLabel(status)}</span>
                    {status.model && (
                        <>
                            <span className="text-slate-300 dark:text-slate-600 flex-shrink-0" aria-hidden="true">/</span>
                            <span className="text-slate-600 dark:text-slate-300 truncate">{status.model}</span>
                        </>
                    )}
                    <span
                        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${AI_HEALTH_DOT[health.level]} ${loading ? 'animate-pulse' : ''}`}
                        role="img"
                        aria-label={t("AI status: {{label}}", { label: health.label })}
                    />
                </span>
            ) : (
                <span title={health.detail}>{fallbackLabel}</span>
            )}
        </div>
    );
}
