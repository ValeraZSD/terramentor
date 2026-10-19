import { useTranslation } from 'react-i18next';
import { ChevronRight, Laptop, Server } from 'lucide-react';
import { FOCUS_RING, cx } from '../../ui/vocabulary';
import type { ProviderInfo } from './providers';

/** A service's initials, or a machine's icon, on a plain tile. */
export function ProviderMark({ mono, active = false, size = 'md' }: { mono: string; active?: boolean; size?: 'sm' | 'md' }) {
    const box = size === 'sm' ? 'w-8 h-8 text-xs' : 'w-10 h-10 text-sm';
    const tone = active
        ? 'bg-accent text-white dark:text-white'
        : 'bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-100';
    const Icon = mono === 'laptop' ? Laptop : mono === 'server' ? Server : null;
    return (
        <span className={cx('inline-flex shrink-0 items-center justify-center rounded-lg font-semibold tracking-tight', box, tone)} aria-hidden="true">
            {Icon ? <Icon className={size === 'sm' ? 'w-4 h-4' : 'w-5 h-5'} /> : mono}
        </span>
    );
}

/**
 * One service as a row of the picker's list. A row in the key group carries
 * the name alone: seven blurbs that all said "with your own key" made the
 * dialog a wall of text, and the form after the choice says it anyway.
 * The focus ring is drawn INSIDE the row because the list clips its corners.
 */
export default function ProviderTile({ provider, onClick }: { provider: ProviderInfo; onClick: () => void }) {
    const { t } = useTranslation();
    const blurb = provider.group !== 'key';
    return (
        <button
            type="button"
            data-tile="provider"
            onClick={onClick}
            className={cx(
                'group flex w-full items-center gap-3 px-3 text-left transition-colors',
                blurb ? 'py-2.5' : 'py-2',
                'can-hover:hover:bg-accent/5 dark:can-hover:hover:bg-accent/10',
                'touch:min-h-11', FOCUS_RING, 'focus-visible:ring-inset',
            )}
        >
            <ProviderMark mono={provider.mono} size="sm" />
            <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2 font-medium text-slate-900 dark:text-white">
                    <span>{provider.kind === 'custom' ? t(provider.name) : provider.name}</span>
                    {provider.family && (
                        <span className="text-sm font-normal text-slate-500 dark:text-slate-400">{provider.family}</span>
                    )}
                    {provider.tag && (
                        <span className="self-center whitespace-nowrap rounded bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent-fg">{t(provider.tag)}</span>
                    )}
                </span>
                {blurb && <span className="mt-0.5 block text-pretty text-sm text-slate-500 dark:text-slate-400">{t(provider.blurb)}</span>}
            </span>
            <ChevronRight className="w-4 h-4 shrink-0 text-slate-400 can-hover:group-hover:text-accent-fg" aria-hidden="true" />
        </button>
    );
}
