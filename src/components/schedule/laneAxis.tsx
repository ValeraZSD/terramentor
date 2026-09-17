import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Axis, buildAxis, buildTicks, daysBetween } from '../../utils/scheduleAxis';

/**
 * The time axis both date charts share — and, deliberately, nothing else.
 *
 * WHAT THIS REPLACED, AND WHY. Both screens used to be a scrolling gantt:
 * a pinned label column, a chart measured in px/day, a four-way zoom
 * (Fit / Year / Quarter / Month) and bars you dragged to change dates. Every
 * part of that was wrong for what these screens are actually for.
 *
 *  • The ZOOM was a control over a problem the screen created for itself. Zoom
 *    in and the chart no longer fits, so it scrolls sideways — and a chart you
 *    have to scroll cannot answer the one question a shared axis exists to
 *    answer, which is what overlaps what. Zoom out to "Fit" and the four
 *    buttons are inert. So the axis ALWAYS fits: positions are percentages of
 *    the lane, not pixels on a scroller, and there is no zoom control to get
 *    wrong at four sizes.
 *  • The px/day geometry is what forced the two-renderer split — a real chart
 *    on a desktop, a plain list on a phone, written twice and drifting. A lane
 *    that is a percentage of whatever width it is given is the SAME lane at
 *    360px and at 2560px, so both platforms get one code path and the phone
 *    gets the comparison instead of losing it.
 *  • DRAGGING a bar to set a date is imprecise where it matters most: at any
 *    zoom that showed a multi-year plan, one day was under a pixel, so the
 *    board grew a hold-to-arm gesture, a slop threshold, a floating readout,
 *    a pointer-following tooltip and a bank of nudge buttons for when the drag
 *    could not hit the day you meant. Two date fields do the whole job, on
 *    both platforms, and a phone gets its own OS date picker for free.
 *
 * What is left is small: an axis fitted to the data, ticks that thin
 * themselves, and a lane that draws position. The geometry is still
 * `utils/scheduleAxis.ts` — DOM-free and asserted there.
 */

export interface FittedAxis {
    axis: Axis | null;
    totalDays: number;
    /** Where a date sits, 0–100, clamped to the axis. */
    pctOf: (date: string) => number;
    /** How wide a span is, in percent, with a floor so a one-day span is visible. */
    spanPct: (from: string, to: string) => number;
    ticks: { label: string; pct: number; major: boolean }[];
    /** Attach to ONE element the width of a lane — the header's — so the tick
     *  density can be chosen from real pixels. A callback ref, not an object
     *  one: the header is not mounted while the screen is loading or empty, so
     *  an effect keyed on mount would observe nothing and never re-run. */
    measureRef: (el: HTMLDivElement | null) => void;
}

/**
 * @param spans every start/end pair that must fit — rows AND anything drawn
 *              beside them (a project's own window, drifted topic extents).
 */
export function useFittedAxis(spans: (string | null | undefined)[][], today: string): FittedAxis {
    const [laneEl, setLaneEl] = useState<HTMLDivElement | null>(null);
    // 720 is only the value used for the first paint, before the observer
    // reports; it decides tick DENSITY, never position, so being wrong for one
    // frame costs a label, not a layout.
    // The tick labels are month names in the interface language, and `buildTicks`
    // reads that language when it runs — so the memo has to name it, or the axis
    // keeps the month names of whatever language was set when it first ran.
    const { i18n: { language } } = useTranslation();
    const [laneW, setLaneW] = useState(720);

    useEffect(() => {
        if (!laneEl) return;
        const ro = new ResizeObserver(() => setLaneW(laneEl.clientWidth || 720));
        ro.observe(laneEl);
        setLaneW(laneEl.clientWidth || 720);
        return () => ro.disconnect();
    }, [laneEl]);

    // `spans` is rebuilt on every render by every caller, so key the memo on its
    // content rather than its identity.
    const key = JSON.stringify(spans);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const axis = useMemo(() => buildAxis(spans, today), [key, today]);
    const totalDays = axis ? Math.max(1, daysBetween(axis.from, axis.to)) : 1;

    const pctOf = (date: string) => {
        if (!axis) return 0;
        const p = (daysBetween(axis.from, date) / totalDays) * 100;
        return Math.max(0, Math.min(100, p));
    };

    const spanPct = (from: string, to: string) => {
        // Inclusive end: a topic ending on the 27th fills through the 27th.
        const w = pctOf(to) - pctOf(from) + (100 / totalDays);
        return Math.max(0.6, Math.min(100 - pctOf(from), w));
    };

    const ticks = useMemo(
        () => (axis
            ? buildTicks(axis, laneW / totalDays).map(t => ({
                label: t.label, major: t.major, pct: (t.x / Math.max(1, laneW)) * 100,
            }))
            : []),
        [axis, laneW, totalDays, language],
    );

    return { axis, totalDays, pctOf, spanPct, ticks, measureRef: setLaneEl };
}

/** The tick rules a lane sits on. Shared so the header and every row agree. */
export function LaneGrid({ ticks }: { ticks: FittedAxis['ticks'] }) {
    return (
        <>
            {ticks.map((t, i) => (
                <div
                    key={i}
                    aria-hidden="true"
                    className={`absolute top-0 bottom-0 w-px ${t.major
                        ? 'bg-slate-300/70 dark:bg-slate-600/70'
                        : 'bg-slate-200/60 dark:bg-slate-700/50'}`}
                    style={{ left: `${t.pct}%` }}
                />
            ))}
        </>
    );
}

/**
 * One row's slice of the axis: the rules, the today line, and whatever the
 * caller draws on top. Everything inside is positioned in percent, so the lane
 * is correct at any width without being measured.
 */
export function Lane({
    geom, today, className = '', children,
}: {
    geom: FittedAxis;
    today: string;
    className?: string;
    children?: ReactNode;
}) {
    const todayPct = geom.axis && today >= geom.axis.from && today <= geom.axis.to
        ? geom.pctOf(today)
        : null;
    return (
        <div className={`relative min-w-0 ${className}`}>
            <LaneGrid ticks={geom.ticks} />
            {todayPct !== null && (
                <div
                    aria-hidden="true"
                    className="absolute top-0 bottom-0 w-px bg-red-500/70"
                    style={{ left: `${todayPct}%` }}
                />
            )}
            {children}
        </div>
    );
}

/**
 * The axis header. `geom.measureRef` goes on its lane, because it is the one
 * element guaranteed to be exactly as wide as every row's lane.
 *
 * Labels are anchored by their LEFT edge at the tick, except the last one,
 * which is right-anchored — a year label at 100% would otherwise be drawn
 * outside the panel and clipped.
 */
export function AxisHeader({ geom, today, label }: { geom: FittedAxis; today: string; label?: string }) {
    const todayPct = geom.axis && today >= geom.axis.from && today <= geom.axis.to
        ? geom.pctOf(today)
        : null;
    return (
        <>
            {/* The column heading only means anything where there IS a column:
                below `md` the lane sits under the text, so a lone "Project"
                line is a row of chrome that names nothing beside it. */}
            <div className="hidden md:flex items-end pb-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                {label}
            </div>
            <div ref={geom.measureRef} className="relative h-6 min-w-0">
                {geom.ticks.map((t, i) => (
                    <span
                        key={i}
                        className={`absolute bottom-0.5 whitespace-nowrap text-[10px] leading-none ${t.major
                            ? 'font-semibold text-slate-600 dark:text-slate-300'
                            : 'text-slate-400 dark:text-slate-500'}`}
                        style={t.pct > 92
                            ? { right: `${100 - t.pct}%`, paddingRight: 2 }
                            : { left: `${t.pct}%`, paddingLeft: 3 }}
                    >
                        {t.label}
                    </span>
                ))}
                {todayPct !== null && (
                    <span
                        className="absolute -bottom-px h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-red-500"
                        style={{ left: `${todayPct}%` }}
                        aria-hidden="true"
                    />
                )}
            </div>
        </>
    );
}
