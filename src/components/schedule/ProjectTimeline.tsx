import { useMemo, useRef, useState } from 'react';
import { onActivateKey } from '../../utils/a11y';
import { useStore } from '../../store';
import { buildGanttData, todayStr } from '../../utils/tree';
import { pretty } from '../../utils/scheduleAxis';
import { GanttItem } from '../../types';
import { useScrollToSelected } from '../../hooks/useScrollToSelected';
import { useFittedAxis, AxisHeader, Lane } from './laneAxis';
import { ChevronRight, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { k } from '../../i18n';

/**
 * One project's plan on a time axis — the schedule screen zoomed in from
 * "which projects run when" to "which topics run when". It shares that
 * screen's fitted axis and lane (`laneAxis.tsx`); what is here is the tree.
 *
 * TWO THINGS WERE BROKEN, and both are the point of the screen.
 *
 *  1. THE DETAIL LEVEL DID NOTHING. Phases / Topics / All decided which depth
 *     was open BY DEFAULT — but it deferred to `expanded`, the store map the
 *     navigation sidebar writes to, and by the time anyone opens the timeline
 *     that map is full of `true`s from clicking around the tree. An explicit
 *     `true` beat the level, so on any real project all three buttons drew the
 *     same thing. The level now owns its own override map, and choosing a
 *     level CLEARS the overrides — so the control always does something, and
 *     the chevrons still open one branch deeper without unfolding the rest.
 *
 *  2. IT WAS A CHART WITH NO NUMBERS. Every row was a title and a bar; the
 *     dates were in a `title` attribute (a desktop-only hover) or, on a phone,
 *     in a completely different renderer. Since the axis has to compress a
 *     multi-year plan into one screen, the bar can only ever say "roughly
 *     here, roughly this long" — the actual dates have to be written down. They
 *     are, on every row, on both platforms.
 */

/** Detail levels: the tree depth open by default. */
const LEVELS = [
    { key: 'phases' as const, label: k("Phases"), depth: 0 },
    { key: 'topics' as const, label: k("Topics"), depth: 1 },
    { key: 'all' as const, label: k("All"), depth: 99 },
];

/** Above this many rows, the view opens collapsed to phases. */
const BIG_PROJECT_ROWS = 60;

/** See the note on the board's copy: proportional, because this panel is often
 *  only ~400px wide inside a workspace and a fixed label column ate the lane. */
const ROW_GRID = 'grid grid-cols-1 md:grid-cols-[minmax(10rem,1fr)_minmax(8rem,1.3fr)] md:items-center gap-x-4';

export default function ProjectTimeline() {
    const { t } = useTranslation();
    const tree = useStore(s => s.tree);
    const projects = useStore(s => s.projects);
    const currentProjectId = useStore(s => s.currentProjectId);
    const selectNode = useStore(s => s.selectNode);
    const selectedNodeId = useStore(s => s.selectedNodeId);

    const [levelKey, setLevelKey] = useState<typeof LEVELS[number]['key'] | null>(null);
    /** Branches the reader opened or shut BY HAND, on this screen. Local, and
     *  cleared whenever the level changes — see the note at the top. */
    const [overrides, setOverrides] = useState<Record<number, boolean>>({});

    const scrollRef = useRef<HTMLDivElement>(null);
    useScrollToSelected(selectedNodeId, scrollRef);

    const project = projects.find(p => p.id === currentProjectId);
    const today = todayStr();

    const items = useMemo(
        () => (project?.start_date && project?.deadline ? buildGanttData(tree) : []),
        [tree, project?.start_date, project?.deadline],
    );

    // Untouched control → size-appropriate default. Small plans show
    // everything; large ones would otherwise open as a wall of rows.
    const level = LEVELS.find(l => l.key === levelKey)
        ?? (items.length > BIG_PROJECT_ROWS ? LEVELS[0] : LEVELS[2]);

    const chooseLevel = (key: typeof LEVELS[number]['key']) => {
        setOverrides({});
        setLevelKey(key);
    };

    const isOpen = (item: GanttItem) =>
        overrides[item.id] ?? item.depth < level.depth;

    const visibleItems = useMemo<GanttItem[]>(() => {
        const result: GanttItem[] = [];
        const skipDepths: number[] = [];
        for (const item of items) {
            while (skipDepths.length > 0 && item.depth <= skipDepths[skipDepths.length - 1]) {
                skipDepths.pop();
            }
            if (skipDepths.length > 0) continue;
            result.push(item);
            if (item.hasChildren && !isOpen(item)) skipDepths.push(item.depth);
        }
        return result;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [items, overrides, level.depth]);

    /** The project's own window belongs on the axis even where no topic reaches
     *  it, or a plan whose topics stop in March draws as if it ended in March. */
    const spans = useMemo(
        () => [
            [project?.start_date, project?.deadline],
            ...items.map(i => [i.scheduledStart, i.scheduledEnd]),
        ],
        [project?.start_date, project?.deadline, items],
    );
    const geom = useFittedAxis(spans, today);

    if (!project?.start_date || !project?.deadline) {
        return (
            <div className="flex-1 flex items-center justify-center text-slate-500 dark:text-slate-400">
                <div className="text-center">
                    <Clock className="w-12 h-12 mx-auto mb-3 opacity-50" />
                    <p className="text-lg font-medium">{t("No schedule set")}</p>
                    <p className="text-sm mt-1">{t("Set a schedule to lay this project out on a timeline")}</p>
                </div>
            </div>
        );
    }

    /** The one colour cue that survives a lane too short to read. */
    function statusDot(status: string, isOverdue: boolean) {
        if (status === 'skipped') return 'bg-slate-400 dark:bg-slate-500';
        if (isOverdue) return 'bg-red-500';
        if (status === 'completed') return 'bg-emerald-500';
        if (status === 'in_progress') return 'bg-amber-500';
        return 'bg-slate-300 dark:bg-slate-600';
    }

    const renderRow = (row: GanttItem) => {
        const open = isOpen(row);
        const selected = row.id === selectedNodeId;
        const dates = row.scheduledStart && row.scheduledEnd
            ? `${pretty(row.scheduledStart)} → ${pretty(row.scheduledEnd)}`
            : t("not scheduled");

        return (
            <li
                key={row.id}
                data-node-id={row.id}
                className={`border-b border-slate-100 dark:border-slate-800 ${selected
                    ? 'bg-accent/15'
                    : row.isOverdue
                        ? 'bg-red-50/40 dark:bg-red-900/10'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-700/30'}`}
            >
                <div className={`${ROW_GRID} px-2 sm:px-4 py-1.5`}>
                    <div
                        className="min-w-0 flex items-center gap-1.5 cursor-pointer"
                        style={{ paddingLeft: `${Math.min(row.depth, 5) * 14}px` }}
                        onClick={() => selectNode(row.id)}
                        onKeyDown={onActivateKey(() => selectNode(row.id))}
                        role="button"
                        tabIndex={0}
                    >
                        {row.hasChildren ? (
                            <button
                                onClick={e => { e.stopPropagation(); setOverrides(o => ({ ...o, [row.id]: !open })); }}
                                aria-expanded={open}
                                aria-label={open ? t("Collapse {{title}}", { title: row.title }) : t("Expand {{title}}", { title: row.title })}
                                className="shrink-0 grid place-items-center w-6 h-6 rounded hover:bg-slate-200 dark:hover:bg-slate-600"
                            >
                                <ChevronRight className={`w-3.5 h-3.5 transition-transform text-slate-400 ${open ? 'rotate-90' : ''}`} />
                            </button>
                        ) : (
                            <span className="w-6 shrink-0" />
                        )}
                        <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot(row.status, row.isOverdue)}`} aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                            <span className={`block truncate text-sm ${row.isOverdue ? 'text-red-600 dark:text-red-400 font-medium' : 'text-slate-700 dark:text-slate-200'} ${row.hasChildren ? 'font-medium' : ''}`}>
                                {row.title}
                            </span>
                            {/* The dates, in words, on every row and both
                                platforms — the bar can only ever say roughly. */}
                            <span className="block text-[11px] leading-tight text-slate-500 dark:text-slate-400 tabular-nums truncate">
                                {dates}
                            </span>
                        </span>
                    </div>

                    <Lane geom={geom} today={today} className="h-6 mt-1 md:mt-0">
                        {row.scheduledStart && row.scheduledEnd && (
                            <div
                                className={`absolute top-1/2 -translate-y-1/2 h-3 rounded-sm ${row.colorClass} ${row.hasChildren ? 'opacity-60' : ''}`}
                                style={{
                                    left: `${geom.pctOf(row.scheduledStart)}%`,
                                    width: `${geom.spanPct(row.scheduledStart, row.scheduledEnd)}%`,
                                }}
                                title={`${row.title}  •  ${dates}`}
                            />
                        )}
                    </Lane>
                </div>
            </li>
        );
    };

    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-2 sm:px-4 py-2 border-b border-slate-200 dark:border-slate-700 shrink-0">
                <div role="group" aria-label={t("Detail level")} className="flex items-center rounded-lg bg-slate-100 dark:bg-slate-700/60 p-0.5">
                    {LEVELS.map(l => (
                        <button
                            key={l.key}
                            onClick={() => chooseLevel(l.key)}
                            aria-pressed={level.key === l.key}
                            className={`px-3 h-8 rounded-md text-xs font-medium transition ${level.key === l.key
                                ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                                : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'}`}
                        >
                            {t(l.label)}
                        </button>
                    ))}
                </div>
                <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    {t("{{shown}} of {{total}} rows", { count: items.length, shown: visibleItems.length, total: items.length })}
                </span>
            </div>

            {visibleItems.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-slate-500 dark:text-slate-400 p-8">
                    <p>{t("No topics to lay out on this timeline.")}</p>
                </div>
            ) : (
                <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
                    <div className={`${ROW_GRID} sticky top-0 z-10 px-2 sm:px-4 pt-2 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700`}>
                        <AxisHeader geom={geom} today={today} label={t("Topic")} />
                    </div>
                    <ul>{visibleItems.map(renderRow)}</ul>
                </div>
            )}
        </div>
    );
}
