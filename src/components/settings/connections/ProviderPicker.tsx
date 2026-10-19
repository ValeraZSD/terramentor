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

/**
 * Where each group stands when there are two columns. The grid has four rows
 * (headings, first lists, second heading, second list) and each group takes
 * its rows through a subgrid. Both headings then share row 1, so the two
 * first lists start on one line. The key list spans rows 2-4, so both
 * columns end on one line; whichever side is shorter grows its rows evenly.
 */
const WIDE: Record<ProviderGroup['id'], { place: string; list?: string; head?: string }> = {
    signin: { place: 'col-start-1 row-start-1 row-span-2' },
    key: { place: 'col-start-2 row-start-1 row-span-4', list: 'row-span-3' },
    local: { place: 'col-start-1 row-start-3 row-span-2', head: 'mt-4' },
};

function Group({ group, wide, onChoose }: { group: ProviderGroup; wide: boolean; onChoose: (kind: ConnectionKind) => void }) {
    const { t } = useTranslation();
    const titleId = useId();
    const place = wide ? WIDE[group.id] : undefined;
    return (
        <section className={place && cx('grid grid-rows-subgrid', place.place)}>
            <div className={cx('mb-1.5', place?.head)}>
                <h3 id={titleId} className={cx('text-sm font-medium text-slate-600 dark:text-slate-300', group.hint && 'mb-0.5')}>{t(group.title)}</h3>
                {group.hint && <p className="text-sm text-slate-500 dark:text-slate-400">{t(group.hint)}</p>}
            </div>
            {/* role="list": Safari drops a styled list's semantics without it. */}
            <ul role="list" aria-labelledby={titleId} className={cx('flex flex-col divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-700 dark:border-slate-700 dark:bg-slate-800', place?.list)}>
                {PROVIDERS.filter(p => p.group === group.id).map(p => (
                    <li key={p.kind} className="flex flex-1"><ProviderTile provider={p} onClick={() => onChoose(p.kind)} /></li>
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
        // The last row is 1fr, so if the key list is the taller side, its
        // extra height goes to the local list and not between the groups.
        <div ref={ref} className={cx('grid', wide ? 'grid-cols-2 grid-rows-[auto_auto_auto_1fr] gap-x-4' : 'gap-4')}>
            {PROVIDER_GROUPS.map(g => (
                <Group key={g.id} group={g} wide={wide} onChoose={onChoose} />
            ))}
        </div>
    );
}
