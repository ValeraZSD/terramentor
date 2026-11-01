import { parseDate, formatDate } from './tree';
import { uiLocale } from './locale';

/**
 * Date arithmetic for the schedule screens, and the geometry of a project's
 * Timeline, drawn on one fitted axis (`components/schedule/laneAxis.tsx`).
 *
 * Extracted from the component so the layout can be checked against real
 * project data without a browser — a timeline's failures are geometric
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
 *
 * Every label is a MONTH; the years are their own row (`buildYears`). A year
 * printed only on January left a plan that runs August to December with no
 * year anywhere on its axis. Once the ticks thin to one a year the month row
 * has nothing to say ("Jan Jan Jan") and its labels are empty: the year row
 * carries the axis alone.
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
            out.push({
                label: step === 12 ? ''
                    : cur.toLocaleDateString(uiLocale(), { month: 'short', timeZone: 'UTC' }),
                x: daysBetween(axis.from, formatDate(cur)) * pxPerDay,
                major: m === 0,
            });
        }
        cur.setUTCMonth(m + 1);
    }
    return out;
}

/** Narrower than this and two year labels ("2026", "2027") would touch. */
const YEAR_GAP_PX = 40;

/**
 * One label per calendar year the axis touches, at the year's first day — or
 * at the axis's own start for the year it opens in, so the first months on
 * screen always say which year they are. When the opening year's stretch is
 * too short for its label (an axis that opens in December), that label gives
 * way to the next year's, at a real January. Any other label too close to the
 * one before it is skipped, so a long plan on a narrow lane keeps every other
 * year rather than only its last.
 */
export function buildYears(axis: Axis, pxPerDay: number): { label: string; x: number }[] {
    const first = parseDate(axis.from).getUTCFullYear();
    const last = parseDate(axis.to).getUTCFullYear();
    const out: { label: string; x: number }[] = [];
    let partialOpening = false;
    for (let y = first; y <= last; y++) {
        const jan = `${y}-01-01`;
        const x = jan <= axis.from ? 0 : daysBetween(axis.from, jan) * pxPerDay;
        if (out.length && x - out[out.length - 1].x < YEAR_GAP_PX) {
            if (out.length === 1 && partialOpening) out.pop();
            else continue;
        }
        if (y === first) partialOpening = jan < axis.from;
        out.push({ label: String(y), x });
    }
    return out;
}

/** Roughly how wide a `text-2xs` semibold pill label paints, px, at the
 *  current root font size (`ui_scale` moves it). A CJK character is about
 *  1em; other characters about 0.58em; plus the pill's 0.375rem padding each
 *  side. Enough to keep two labels apart, not a layout measurement. */
export function markerLabelPx(text: string, rootPx: number): number {
    const em = 0.6875 * rootPx;
    let w = 0;
    for (const ch of text) w += /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/.test(ch) ? em : 0.58 * em;
    return w + 0.75 * rootPx;
}

/**
 * Where the "Today" and "Deadline" labels go, in px from the lane's left
 * edge: centred on their lines, kept inside the lane, and — when the two lines
 * are close — set side by side rather than on top of each other, each on its
 * own line's side. Null drops a label (the line stays): only the deadline's,
 * and only when the lane cannot hold both.
 */
export function placeMarkerLabels(
    laneW: number,
    today: { pct: number; w: number } | null,
    deadline: { pct: number; w: number } | null,
): { today: number | null; deadline: number | null } {
    const clampX = (x: number, w: number) => Math.max(0, Math.min(laneW - w, x));
    const at = (m: { pct: number; w: number }) => clampX((m.pct / 100) * laneW - m.w / 2, m.w);
    let t = today ? at(today) : null;
    let d = deadline ? at(deadline) : null;
    if (today && deadline && t !== null && d !== null) {
        const GAP = 6;
        const overlap = Math.min(t + today.w, d + deadline.w) - Math.max(t, d) + GAP;
        if (overlap > 0) {
            const tLine = (today.pct / 100) * laneW;
            const dLine = (deadline.pct / 100) * laneW;
            // Split at the midpoint between the lines, each label on its own side.
            const mid = (tLine + dLine) / 2;
            const [leftW, rightW] = tLine <= dLine ? [today.w, deadline.w] : [deadline.w, today.w];
            let left = mid - GAP / 2 - leftW;
            let right = mid + GAP / 2;
            if (left < 0) { right += -left; left = 0; }
            if (right + rightW > laneW) { left -= right + rightW - laneW; right = laneW - rightW; }
            if (left < 0) d = null; // no room for both: today's label wins
            else if (tLine <= dLine) { t = left; d = right; } else { d = left; t = right; }
        }
    }
    return { today: t, deadline: d };
}

/* `pxPerDayFor` lived here to serve the zoom presets. The Timeline now fits
 * its panel by construction (`components/schedule/laneAxis.tsx` positions in
 * percent), so there is no preset to convert and no viewport to divide. */
