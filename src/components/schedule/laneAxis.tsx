import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Axis, buildAxis, buildTicks, buildYears, daysBetween, markerLabelPx, placeMarkerLabels } from '../../utils/scheduleAxis';
import { useRootFontSize } from '../../hooks/useRootFontSize';

/**
 * The time axis of a project's Timeline — and, deliberately, nothing else.
 *
 * WHY NOT A GANTT. A scrolling gantt — a pinned label column, a chart
 * measured in px/day, a zoom control and bars you drag to change dates — has
 * every part wrong for what these screens are actually for.
 *
 *  • A ZOOM is a control over a problem the screen creates for itself. Zoom
 *    in and the chart no longer fits, so it scrolls sideways — and a chart you
 *    have to scroll cannot answer the one question a shared axis exists to
 *    answer, which is what overlaps what. So the axis ALWAYS fits: positions
 *    are percentages of the lane, not pixels on a scroller, and there is no
 *    zoom control to get wrong at several sizes.
 *  • px/day geometry forces a two-renderer split — a real chart on a desktop,
 *    a plain list on a phone, written twice and drifting. A lane that is a
 *    percentage of whatever width it is given is the SAME lane at 360px and at
 *    2560px, so both platforms get one code path and the phone gets the
 *    comparison instead of losing it.
 *  • DRAGGING a bar to set a date is imprecise where it matters most: at any
 *    zoom that shows a multi-year plan, one day is under a pixel, which calls
 *    for hold-to-arm gestures, slop thresholds, floating readouts and nudge
 *    buttons for when the drag cannot hit the day you meant. Two date fields do
 *    the whole job, on both platforms, and a phone gets its own OS date picker
 *    for free.
 *
 * What is left is small: an axis fitted to the data, ticks that thin
 * themselves, a year row, and two lines that run through every row — today
 * and the deadline — each NAMED in the header. An unlabelled red line was read
 * as "something is wrong here", and a deadline nobody drew left a plan that
 * ends two weeks early looking like it ends on time. The geometry is still
 * `utils/scheduleAxis.ts` — DOM-free.
 */

export interface FittedAxis {
    axis: Axis | null;
    totalDays: number;
    /** Where a date sits, 0–100, clamped to the axis. */
    pctOf: (date: string) => number;
    /** How wide a span is, in percent, with a floor so a one-day span is visible. */
    spanPct: (from: string, to: string) => number;
    ticks: { label: string; pct: number; major: boolean }[];
    years: { label: string; pct: number }[];
    /** Where the two lines run; null only while there is no axis (`buildAxis`
     *  always takes in today and the deadline). */
    todayPct: number | null;
    deadlinePct: number | null;
    /** The lane's measured width, px — for placing the header's labels. */
    laneW: number;
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
export function useFittedAxis(
    spans: (string | null | undefined)[][],
    today: string,
    deadline: string | null = null,
): FittedAxis {
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

    const onAxis = (date: string | null) => (axis && date && date >= axis.from && date <= axis.to ? pctOf(date) : null);

    const { ticks, years } = useMemo(() => {
        if (!axis) return { ticks: [], years: [] };
        const pxPerDay = laneW / totalDays;
        const toPct = (x: number) => (x / Math.max(1, laneW)) * 100;
        return {
            ticks: buildTicks(axis, pxPerDay).map(t => ({ label: t.label, major: t.major, pct: toPct(t.x) })),
            years: buildYears(axis, pxPerDay).map(y => ({ label: y.label, pct: toPct(y.x) })),
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [axis, laneW, totalDays, language]);

    return {
        axis, totalDays, pctOf, spanPct, ticks, years, laneW,
        todayPct: onAxis(today),
        // The deadline's whole day is inside the plan: the line goes at its END.
        deadlinePct: deadline && onAxis(deadline) !== null ? Math.min(100, pctOf(deadline) + 100 / totalDays) : null,
        measureRef: setLaneEl,
    };
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
                        ? 'bg-slate-300/80 dark:bg-slate-600/80'
                        : 'bg-slate-200/70 dark:bg-slate-700/60'}`}
                    style={{ left: `${t.pct}%` }}
                />
            ))}
        </>
    );
}

/** Today: ink, solid. The deadline: grey, dashed. Drawn over the bars so a
 *  line never disappears behind the row it crosses. Today is not the course's
 *  accent: a course whose accent is green drew it in the green that means
 *  "done", and a red one would say "late". */
function Markers({ geom }: { geom: FittedAxis }) {
    return (
        <>
            {geom.deadlinePct !== null && (
                <div
                    aria-hidden="true"
                    data-deadline-line
                    className="pointer-events-none absolute top-0 bottom-0 border-l border-dashed border-slate-500/80 dark:border-slate-400/70"
                    style={{ left: `${geom.deadlinePct}%` }}
                />
            )}
            {geom.todayPct !== null && (
                <div
                    aria-hidden="true"
                    data-today-line
                    className="pointer-events-none absolute top-0 bottom-0 w-0.5 -translate-x-1/2 bg-slate-800 dark:bg-slate-200"
                    style={{ left: `${geom.todayPct}%` }}
                />
            )}
        </>
    );
}

/**
 * One row's slice of the axis: the rules, whatever the caller draws, and the
 * two lines on top. Everything inside is positioned in percent, so the lane is
 * correct at any width without being measured. It stretches to the row's full
 * height, so the lines run unbroken from the header to the last row.
 */
export function Lane({
    geom, className = '', children,
}: {
    geom: FittedAxis;
    className?: string;
    children?: ReactNode;
}) {
    return (
        <div className={`relative min-w-0 ${className}`}>
            <LaneGrid ticks={geom.ticks} />
            {children}
            <Markers geom={geom} />
        </div>
    );
}

/**
 * The axis header: a year row, a month row, and the names of the two lines.
 * `geom.measureRef` goes on its lane, because it is the one element guaranteed
 * to be exactly as wide as every row's lane.
 *
 * Labels are anchored by their LEFT edge at the tick, except near the right
 * edge, where they are right-anchored — a label at 100% would otherwise be
 * drawn outside the panel and clipped.
 */
export function AxisHeader({ geom }: { geom: FittedAxis }) {
    const { t } = useTranslation();
    const rem = useRootFontSize();
    const todayText = t("Today");
    const deadlineText = t("Deadline");
    const place = placeMarkerLabels(
        geom.laneW,
        geom.todayPct !== null ? { pct: geom.todayPct, w: markerLabelPx(todayText, rem) } : null,
        geom.deadlinePct !== null ? { pct: geom.deadlinePct, w: markerLabelPx(deadlineText, rem) } : null,
    );
    const months = geom.ticks.some(tk => tk.label);
    const anchor = (pct: number) => (pct > 90
        ? { right: `${100 - pct}%`, paddingRight: 3 }
        : { left: `${pct}%`, paddingLeft: 4 });
    return (
        <div ref={geom.measureRef} className="relative min-w-0 pt-1">
            <div className="relative h-4">
                {geom.years.map((y, i) => (
                    <span
                        key={i}
                        className="absolute top-0 whitespace-nowrap text-xs font-semibold leading-4 text-slate-700 dark:text-slate-200 tabular-nums"
                        style={anchor(y.pct)}
                    >
                        {y.label}
                    </span>
                ))}
            </div>
            {months && (
                <div className="relative h-4">
                    {geom.ticks.map((tk, i) => tk.label && (
                        <span
                            key={i}
                            className="absolute top-0 whitespace-nowrap text-xs leading-4 text-slate-500 dark:text-slate-400"
                            style={anchor(tk.pct)}
                        >
                            {tk.label}
                        </span>
                    ))}
                </div>
            )}
            {/* The two lines, named where they start. */}
            <div className="relative h-6 mt-0.5">
                <Markers geom={geom} />
                {place.deadline !== null && (
                    <span
                        data-deadline-label
                        className="absolute top-1 whitespace-nowrap rounded px-1.5 text-2xs font-semibold leading-4 bg-slate-100 text-slate-700 ring-1 ring-slate-300 dark:bg-slate-700 dark:text-slate-200 dark:ring-slate-500"
                        style={{ left: place.deadline }}
                    >
                        {deadlineText}
                    </span>
                )}
                {place.today !== null && (
                    <span
                        data-today-label
                        className="absolute top-1 whitespace-nowrap rounded px-1.5 text-2xs font-semibold leading-4 bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900"
                        style={{ left: place.today }}
                    >
                        {todayText}
                    </span>
                )}
            </div>
        </div>
    );
}
