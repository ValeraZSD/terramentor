import { useTranslation } from 'react-i18next';
import { ChevronRight, Laptop, Server } from 'lucide-react';
import { FOCUS_RING, cx } from '../../ui/vocabulary';
import type { ConnectionKind } from '../../../api';
import { providerOf, type ProviderInfo } from './providers';
import { brandPaint } from './brands';

/**
 * A service's initials, or a machine's icon.
 *
 * Where a service is PICKED (the Connect dialog, the empty Connections block)
 * the square's job is to be found, so a company wears its own published
 * colour (`brands.ts`), the same in both themes. In the list of saved
 * connections its job is state: plain, and the accent on the one in use. A
 * brand colour there competed with "in use" and lost (two outside reviews,
 * 13 Oct 2026).
 */
export function ProviderMark({ kind, place, inUse = false, size = 'md' }: {
    kind: ConnectionKind; place: 'pick' | 'saved'; inUse?: boolean; size?: 'sm' | 'md';
}) {
    const { mono } = providerOf(kind);
    const paint = place === 'pick' ? brandPaint(kind) : null;
    const box = size === 'sm' ? 'w-8 h-8 text-xs' : 'w-10 h-10 text-sm';
    const Icon = mono === 'laptop' ? Laptop : mono === 'server' ? Server : null;
    const plain = place === 'saved' && inUse
        ? 'bg-accent text-white dark:text-white'
        : 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-100';
    return (
        <span
            className={cx('inline-flex shrink-0 items-center justify-center rounded-lg font-semibold tracking-tight', box,
                !paint && plain)}
            style={paint ? { backgroundColor: paint.fill, color: paint.ink } : undefined}
            aria-hidden="true"
        >
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
            <ProviderMark kind={provider.kind} place="pick" />
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
