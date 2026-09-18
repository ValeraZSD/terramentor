import { parseDate, formatDate } from './tree';
import { uiLocale } from './locale';

/**
 * Geometry for both gantts — the cross-project schedule board and the
 * per-project timeline, which share one fitted axis (`components/schedule/laneAxis.tsx`).
 *
 * Extracted from the component so the layout can be checked against real
 * project data without a browser — a gantt's failures are geometric
 * (overprinted axis ticks, sub-pixel bars, a window that leaves the axis), and
 * every one of them is a number that can be asserted. Keep this module free of
 * React and of DOM access for exactly that reason.
 */

export const DAY_MS = 86400000;

export const daysBetween = (a: string, b: string) =>
    Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / DAY_MS);

export const shift = (date: string, days: number) =>
    formatDate(new Date(parseDate(date).getTime() + days * DAY_MS));

/** "30 Jul 2026" — unambiguous, unlike 07/30 vs 30/07. */
export const pretty = (d: string) =>
    parseDate(d).toLocaleDateString(uiLocale(), {
        day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    });

export interface Axis { from: string; to: string }

/**
 * The axis must span every project window AND every scheduled-topic extent, or
 * a project whose topics drifted outside its window would have that drift
 * drawn off-screen — which is the one thing the board must never hide.
 */
export function buildAxis(spans: (string | null | undefined)[][], today: string): Axis | null {
    const dates: string[] = [];
    spans.forEach(span => span.forEach(d => { if (d) dates.push(d); }));
    dates.push(today);
    if (dates.length <= 1) return null;
    const sorted = dates.slice().sort();
    const min = parseDate(sorted[0]);
    const max = parseDate(sorted[sorted.length - 1]);
    // SNAP TO MONTH BOUNDARIES rather than padding by N days. With day padding
    // the axis origin moved every time any project moved by a day, which
    // re-scaled the whole board and slid EVERY bar sideways — a one-day nudge
    // to one project visibly shifted the other seven. Snapping means the axis
    // only changes when an edit crosses a month, so edits stay local.
    return {
        from: formatDate(new Date(Date.UTC(min.getUTCFullYear(), min.getUTCMonth(), 1))),
        to: formatDate(new Date(Date.UTC(max.getUTCFullYear(), max.getUTCMonth() + 1, 0))),
    };
}

export interface Tick { label: string; x: number; major: boolean }

/**
 * Month ticks, thinned to quarters and then years as the axis compresses.
 *
 * A fitted multi-year plan is ~1px/day, where a month is ~30px and a "Sep"
 * label needs ~22px plus padding — so unthinned month ticks overprint into a
 * smear. The thresholds are label-width driven, not taste.
 */
export function buildTicks(axis: Axis, pxPerDay: number): Tick[] {
    const out: Tick[] = [];
    // Pick the densest step whose label gap still clears ~34px ("Sep" at 10px
    // plus padding). The quarter threshold is 11.5 rather than 16 because at
    // 16 a fitted phone axis fell through to years and rendered ONE label for
    // a 580-day plan — technically not overprinted, but useless as an axis.
    const monthPx = pxPerDay * 30;
    const step = monthPx >= 46 ? 1 : monthPx >= 11.5 ? 3 : 12;
    const cur = parseDate(axis.from);
    cur.setUTCDate(1);
    const end = parseDate(axis.to).getTime();
    while (cur.getTime() <= end) {
        const m = cur.getUTCMonth();
        if (step === 1 || m % step === 0) {
            const isJan = m === 0;
            out.push({
                label: isJan || step === 12 ? String(cur.getUTCFullYear())
                    : cur.toLocaleDateString(uiLocale(), { month: 'short', timeZone: 'UTC' }),
                x: daysBetween(axis.from, formatDate(cur)) * pxPerDay,
                major: isJan,
            });
        }
        cur.setUTCMonth(m + 1);
    }
    return out;
}

/* `pxPerDayFor` lived here to serve the zoom presets. Both charts now fit the
 * panel by construction (`components/schedule/laneAxis.tsx` positions in
 * percent), so there is no preset to convert and no viewport to divide. */
