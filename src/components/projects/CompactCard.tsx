// The small card of the Projects page: a short course while it is studied, and
// every course, short or full, once it is finished or archived. Three to a row
// where the page is wide, one on a phone, in the same columns as the big cards
// (COMPACT_GRID shares their floor), so the two grids' edges line up.
//
// Mark and name on the first line with the menu; what it is under the name;
// the ring, one reading and the card's one action at the bottom, in the order
// the big card's footer has them.
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ProjectIcon } from '../ProjectIcon';
import { useAccentVars } from '../../hooks/useAccentVars';
import { cx, FOCUS_RING } from '../ui/vocabulary';

/** Same floor as the course grid (ProjectsGrid GRID), so columns match. */
export const COMPACT_GRID = 'grid gap-x-6 gap-y-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,21.25rem),1fr))]';

export function CompactCard({
    color, icon, name, meta, metaTone = 'plain', reading, action, menu, onOpen, data,
}: {
    color: string;
    icon: string;
    name: string;
    /** What it is: the source of a short course, "Course · 16 topics" for a full one. */
    meta: ReactNode;
    metaTone?: 'plain' | 'warn';
    /** Left of the footer: ring and the one number that matters in this state.
     *  A record has none: what it was and when it ended fit on the meta line. */
    reading?: ReactNode;
    /** Right of the footer: Study, Try again, Move to active; none for a record. */
    action?: ReactNode;
    menu: ReactNode;
    onOpen: () => void;
    data?: string;
}) {
    const { t } = useTranslation();
    const accent = useAccentVars(color) as CSSProperties;
    return (
        // The whole card opens the course for the pointer; the keyboard and a
        // screen reader reach that through the title.
        <div
            data-compact={data}
            style={accent}
            onClick={onOpen}
            className="h-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 flex flex-col gap-3 cursor-pointer hover:border-slate-300 dark:hover:border-slate-600 hover:shadow-sm transition-[border-color,box-shadow]"
        >
            <div className="flex items-start gap-3 min-w-0">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 text-white bg-accent">
                    <ProjectIcon icon={icon} className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                    <button
                        type="button"
                        onClick={e => { e.stopPropagation(); onOpen(); }}
                        aria-label={t("Open {{name}}", { name })}
                        title={name}
                        data-row="title"
                        className={cx('-mx-1 px-1 block max-w-full text-left rounded font-medium leading-snug text-slate-900 dark:text-white line-clamp-2', FOCUS_RING)}
                    >
                        {name}
                    </button>
                    <div className={cx('mt-0.5 text-sm flex items-center gap-1.5 min-w-0', metaTone === 'warn' ? 'text-amber-700 dark:text-amber-300' : 'text-slate-500 dark:text-slate-400')}>
                        {meta}
                    </div>
                </div>
                <div className="shrink-0 -mr-1 -mt-1" onClick={e => e.stopPropagation()}>{menu}</div>
            </div>
            {(reading || action) && (
                <div className="mt-auto flex items-center gap-3 min-h-10">
                    {reading}
                    {action && <div className="ml-auto shrink-0" onClick={e => e.stopPropagation()}>{action}</div>}
                </div>
            )}
        </div>
    );
}
