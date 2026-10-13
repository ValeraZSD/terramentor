import { useTranslation } from 'react-i18next';
import { ChevronRight, Laptop, Server } from 'lucide-react';
import { FOCUS_RING, cx } from '../../ui/vocabulary';
import type { ProviderInfo } from './providers';

/** A service's initials, or a machine's icon, on a plain tile. */
export function ProviderMark({ mono, active = false, size = 'md' }: { mono: string; active?: boolean; size?: 'sm' | 'md' }) {
    const box = size === 'sm' ? 'w-8 h-8 text-xs' : 'w-10 h-10 text-sm';
    const tone = active
        ? 'bg-accent text-white dark:text-white'
        : 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-100';
    const Icon = mono === 'laptop' ? Laptop : mono === 'server' ? Server : null;
    return (
        <span className={cx('inline-flex shrink-0 items-center justify-center rounded-lg font-semibold tracking-tight', box, tone)} aria-hidden="true">
            {Icon ? <Icon className={size === 'sm' ? 'w-4 h-4' : 'w-5 h-5'} /> : mono}
        </span>
    );
}

/** One service in the Connect dialog's first step. */
export default function ProviderTile({ provider, onClick }: { provider: ProviderInfo; onClick: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            data-tile="provider"
            onClick={onClick}
            className={cx(
                'group flex w-full items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 text-left transition-colors',
                'can-hover:hover:border-accent/60 can-hover:hover:bg-accent/5 dark:border-slate-700 dark:bg-slate-800 dark:can-hover:hover:bg-accent/10',
                'touch:min-h-11', FOCUS_RING,
            )}
        >
            <ProviderMark mono={provider.mono} />
            <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 font-medium text-slate-900 dark:text-white">
                    {provider.kind === 'custom' ? t(provider.name) : provider.name}
                    {provider.tag && (
                        <span className="rounded bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent-fg">{t(provider.tag)}</span>
                    )}
                </span>
                <span className="mt-0.5 block text-sm text-slate-500 dark:text-slate-400">{t(provider.blurb)}</span>
            </span>
            <ChevronRight className="mt-2.5 w-4 h-4 shrink-0 text-slate-400 can-hover:group-hover:text-accent-fg" aria-hidden="true" />
        </button>
    );
}
