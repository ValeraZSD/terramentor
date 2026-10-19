import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectionKind } from '../../../api';
import { useElementWidth } from '../../../hooks/useElementWidth';
import { useRootFontSize } from '../../../hooks/useRootFontSize';
import { PROVIDERS, PROVIDER_GROUPS, type ProviderInfo } from './providers';
import ProviderTile from './ProviderTile';
import { cx } from '../../ui/vocabulary';

/** Two columns from this width of the picker's own box, in rem. */
const TWO_COLUMNS_REM = 40;

function Group({ id, title, hint, onChoose }: { id: ProviderInfo['group']; title: string; hint?: string; onChoose: (kind: ConnectionKind) => void }) {
    const { t } = useTranslation();
    return (
        <section>
            <h3 className={cx('text-sm font-medium text-slate-600 dark:text-slate-300', hint ? 'mb-0.5' : 'mb-1.5')}>{t(title)}</h3>
            {hint && <p className="mb-1.5 text-sm text-slate-500 dark:text-slate-400">{t(hint)}</p>}
            <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-700 dark:border-slate-700 dark:bg-slate-800">
                {PROVIDERS.filter(p => p.group === id).map(p => (
                    <li key={p.kind}><ProviderTile provider={p} onClick={() => onChoose(p.kind)} /></li>
                ))}
            </ul>
        </section>
    );
}

/**
 * Every way to connect a model, grouped by how the learner gets in. The same
 * list is the Connect dialog's first step and the empty Connections panel.
 *
 * Wide, the long key group stands on its own on the right and the two short
 * groups share the left; narrow, one column in the order a newcomer should
 * meet them. Decided on the picker's own width (the panel and the dialog are
 * different widths on the same screen), and one column until it is measured.
 */
export default function ProviderPicker({ onChoose }: { onChoose: (kind: ConnectionKind) => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const width = useElementWidth(ref);
    const rem = useRootFontSize();
    const wide = width >= TWO_COLUMNS_REM * rem;
    const group = (id: ProviderInfo['group']) => {
        const g = PROVIDER_GROUPS.find(x => x.id === id)!;
        return <Group key={id} id={id} title={g.title} hint={g.hint} onChoose={onChoose} />;
    };
    return (
        <div ref={ref}>
            {wide ? (
                <div className="grid grid-cols-2 items-start gap-4">
                    <div className="space-y-4">{group('signin')}{group('local')}</div>
                    {group('key')}
                </div>
            ) : (
                <div className="space-y-4">{PROVIDER_GROUPS.map(g => group(g.id))}</div>
            )}
        </div>
    );
}
