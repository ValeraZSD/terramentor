import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectionKind } from '../../../api';
import { useElementWidth } from '../../../hooks/useElementWidth';
import { useRootFontSize } from '../../../hooks/useRootFontSize';
import { PROVIDERS, PROVIDER_GROUPS, type ProviderGroup } from './providers';
import ProviderTile from './ProviderTile';
import { cx } from '../../ui/vocabulary';

/** Two columns from this width of the picker's own box, in rem. */
const TWO_COLUMNS_REM = 40;

/** Where each group stands when there are two columns: the long key list alone on the right. */
const WIDE_PLACE: Record<ProviderGroup['id'], string> = {
    signin: 'col-start-1 row-start-1',
    key: 'col-start-2 row-start-1 row-span-2',
    local: 'col-start-1 row-start-2',
};

function Group({ group, className, onChoose }: { group: ProviderGroup; className?: string; onChoose: (kind: ConnectionKind) => void }) {
    const { t } = useTranslation();
    const titleId = useId();
    return (
        <section className={className}>
            <h3 id={titleId} className={cx('text-sm font-medium text-slate-600 dark:text-slate-300', group.hint ? 'mb-0.5' : 'mb-1.5')}>{t(group.title)}</h3>
            {group.hint && <p className="mb-1.5 text-sm text-slate-500 dark:text-slate-400">{t(group.hint)}</p>}
            {/* role="list": Safari drops a styled list's semantics without it. */}
            <ul role="list" aria-labelledby={titleId} className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-700 dark:border-slate-700 dark:bg-slate-800">
                {PROVIDERS.filter(p => p.group === group.id).map(p => (
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
 * Narrow, one column in the order a newcomer should meet them; wide, the long
 * key group stands on its own on the right and the two short groups share the
 * left. Decided on the picker's own width (the panel and the dialog are
 * different widths on the same screen), one column until it is measured, and
 * only by classes, so crossing the line moves the rows without remounting
 * them and a focused row keeps its focus.
 */
export default function ProviderPicker({ onChoose }: { onChoose: (kind: ConnectionKind) => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const width = useElementWidth(ref);
    const rem = useRootFontSize();
    const wide = width >= TWO_COLUMNS_REM * rem;
    return (
        // The second row is 1fr so the key list's height lands there, and
        // "Run it yourself" sits right under "Sign in" instead of halfway down.
        <div ref={ref} className={cx('grid gap-4', wide && 'grid-cols-2 grid-rows-[auto_1fr] items-start')}>
            {PROVIDER_GROUPS.map(g => (
                <Group key={g.id} group={g} className={wide ? WIDE_PLACE[g.id] : undefined} onChoose={onChoose} />
            ))}
        </div>
    );
}
