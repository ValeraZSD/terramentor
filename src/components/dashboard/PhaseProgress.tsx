import { memo, useRef } from 'react';
import { Milestone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store';
import type { DashboardMilestone } from '../../types';
import { onActivateKey } from '../../utils/a11y';
import { useElementWidth } from '../../hooks/useElementWidth';
import { useRootFontSize } from '../../hooks/useRootFontSize';
import { DashboardSection } from './DashboardSection';
import ProgressBar, { PROGRESS_TRACK } from '../ui/ProgressBar';

/** From this list width a phase is ONE row (title, bar, count), in rem so
 *  `ui_scale` moves it with the type. Below it the bar goes under the title. */
const ROW_MIN_REM = 34;

/**
 * Each phase of the course with one tick per topic, the phase being worked on
 * marked.
 *
 * One measure per row: the count of topics FINISHED, which is exactly what the
 * ticks draw. The row used to print the progress percentage beside it ("4 of 7
 * finished · 76%"), and that percentage also credits cards met on unfinished
 * topics, so a bar of four filled ticks out of seven sat next to 76%. Three of
 * three outside readers took that for an arithmetic error. The share that
 * credits cards is the course's own figure in the header and the tree.
 */
export function PhaseProgress({ milestones }: { milestones: DashboardMilestone[] }) {
    const { t } = useTranslation();
    const selectNode = useStore(s => s.selectNode);
    const selectedNodeId = useStore(s => s.selectedNodeId);
    const listRef = useRef<HTMLDivElement>(null);
    const width = useElementWidth(listRef);
    const rootPx = useRootFontSize();
    const oneRow = width >= ROW_MIN_REM * rootPx;
    const activeIndex = milestones.findIndex(m => m.percentage < 100);

    return (
        <DashboardSection icon={Milestone} title={t("Phase progress")}>
            {/* Why nothing here is drawn in `project.color`, and why the
                unfinished state is not drawn in the accent either: a phase's
                bar is mostly UNFINISHED for most of a project's life, so the
                colour that has to be readable first is the empty one, and a
                user-picked colour has no contrast guarantee. The active row is
                marked with the clamped `accent`; the empty tick is a neutral
                slot that never varies with the project. */}
            {/* Wide: ONE grid for every row (each row a subgrid), so the bars
                of all phases start and end at the same x. The title column is
                as wide as the longest title up to 22rem and the bars take the
                rest; per-row grids put each bar wherever its own title ended.
                Narrow: the title wraps rather than being cut ("Phase 0: Exam
                Setup & L…"), the count is the line under it, and the bar takes
                the whole line below that, so every bar still starts and ends at
                the same x. A count beside the bar ended each bar where its own
                count began; beside the title it squeezed a long title to four
                lines in the side column. */}
            <div
                ref={listRef}
                className={oneRow
                    ? 'grid grid-cols-[minmax(0,max-content)_minmax(8rem,1fr)_auto] gap-x-4 gap-y-1'
                    : 'space-y-3'}
            >
                {milestones.map((milestone, idx) => {
                    const isActive = idx === activeIndex;
                    const title = (
                        <span className={`min-w-0 text-sm ${oneRow ? 'max-w-[22rem] truncate' : 'block break-words'} ${isActive
                            ? 'font-semibold text-slate-900 dark:text-white'
                            : 'font-medium text-slate-700 dark:text-slate-200'}`}
                            title={milestone.title}
                        >
                            {milestone.title}
                        </span>
                    );
                    const count = (
                        <span className={`shrink-0 text-xs font-medium tabular-nums ${isActive
                            ? 'text-slate-700 dark:text-slate-200'
                            : 'text-slate-500 dark:text-slate-400'}`}
                        >
                            {t("{{completed}} of {{count}} topics finished", {
                                completed: milestone.completed,
                                count: milestone.total,
                            })}
                        </span>
                    );
                    const bar = <PhaseBar milestone={milestone} isActive={isActive} selectedNodeId={selectedNodeId} onOpen={selectNode} />;
                    return (
                        <div
                            key={milestone.id}
                            className={`relative rounded-xl px-3 ${oneRow
                                ? 'col-span-3 grid grid-cols-subgrid items-center py-2'
                                : 'py-2.5'} ${isActive
                                ? 'bg-accent/10 dark:bg-accent/20 ring-1 ring-accent/50'
                                : ''}`}
                        >
                            {isActive && (
                                <span className="absolute left-0 top-2 bottom-2 w-1 rounded-r-full bg-accent-fg" aria-hidden="true" />
                            )}
                            {oneRow ? (
                                <>
                                    {title}
                                    {bar}
                                    {count}
                                </>
                            ) : (
                                <>
                                    {title}
                                    <div className="mt-0.5">{count}</div>
                                    <div className="mt-1.5">{bar}</div>
                                </>
                            )}
                        </div>
                    );
                })}
            </div>
        </DashboardSection>
    );
}

/** Memoised: the list re-renders on every width change while the detail panel
 *  is dragged, and a phase can draw ~100 ticks that have not changed. */
const PhaseBar = memo(function PhaseBar({ milestone, isActive, selectedNodeId, onOpen }: {
    milestone: DashboardMilestone;
    isActive: boolean;
    selectedNodeId: number | null;
    onOpen: (id: number) => void;
}) {
    if (milestone.segments && milestone.segments.length > 0) {
        /* One tick per leaf, and a phase can hold ~100 of them. A `border-2`
           per tick or a fixed gap would make the bar wider than a phone and
           scroll the whole PAGE sideways. So the outline is an inset ring (zero
           layout cost), the gap tightens as the count grows, `min-w-0` lets a
           tick shrink to nothing, and `overflow-hidden` guarantees that even an
           absurd phase can never push the page wide. */
        return (
            <div className={`flex h-3 w-full overflow-hidden ${milestone.segments.length > 60 ? 'gap-0'
                : milestone.segments.length > 24 ? 'gap-px' : 'gap-0.5'}`}
            >
                {milestone.segments.map((segment, i) => (
                    <div
                        key={i}
                        onClick={() => onOpen(segment.id)}
                        onKeyDown={onActivateKey(() => onOpen(segment.id))}
                        role="button"
                        tabIndex={0}
                        aria-label={segment.title}
                        title={segment.title}
                        /* A tick is a TOPIC, not a slice of a track, and a
                           focusable control besides. An unfinished one is an
                           empty progress track (`ui/ProgressBar`'s
                           PROGRESS_TRACK): a slot in the card, and the
                           emerald as what fills it. A slate-100 tick with a
                           slate-200 hairline measured 1.2:1 and drew no slot. */
                        className={`h-full min-w-0 flex-1 cursor-pointer rounded-sm ${segment.completed
                            ? (segment.skipped
                                /* Skipped is CLOSED, so it must out-ink an
                                   unfinished tick while staying out of the
                                   emerald that means proven. */
                                ? 'bg-slate-600 dark:bg-slate-300'
                                : 'bg-emerald-500 dark:bg-emerald-500')
                            : PROGRESS_TRACK
                        } ${segment.id === selectedNodeId
                            ? 'ring-2 ring-inset ring-slate-700 dark:ring-white'
                            : 'hover:ring-2 hover:ring-inset hover:ring-slate-700 dark:hover:ring-white'
                        }`}
                    />
                ))}
            </div>
        );
    }
    return (
        <div
            onClick={() => onOpen(milestone.id)}
            onKeyDown={onActivateKey(() => onOpen(milestone.id))}
            role="button"
            tabIndex={0}
            aria-label={milestone.title}
            title={milestone.title}
            className="w-full cursor-pointer rounded-full hover:opacity-80"
        >
            {/* The track carries the shape, so a phase with no leaves still
                draws its full length; only real progress is inked. */}
            <ProgressBar
                value={milestone.percentage}
                tone={milestone.percentage === 100 ? 'success' : isActive ? 'accent' : 'info'}
                size="lg"
                decorative
            />
        </div>
    );
});
