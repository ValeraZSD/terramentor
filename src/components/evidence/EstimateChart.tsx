import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { EvidenceRow } from '../../types';
import { useElementWidth } from '../../hooks/useElementWidth';
import { useRootFontSize } from '../../hooks/useRootFontSize';
import { MENU_SURFACE } from '../ui/Popover';

/**
 * How sure the app was about one topic, answer by answer: one line over time,
 * a dot per answer that moved it, and a dashed line where proof starts.
 *
 * The points are the trail's own steps (`row.after`, the gate's replay), so
 * the line ends where the newest step does. Practice has no step and is not
 * drawn. Hovering or arrowing through the dots names the answer behind each.
 *
 * Drawn in pixels from the measured width, not a stretched viewBox: a
 * stretched one would squash the dots and the line's width on a phone. Every
 * label is HTML, so the interface text size reaches it.
 */

export interface ChartPoint {
    row: EvidenceRow;
    at: number;
    value: number;
}

/** The rows that moved the estimate, in the order the replay ran them (by id). */
export function chartPoints(rows: EvidenceRow[]): ChartPoint[] {
    return rows
        .filter(r => r.after != null && r.type !== 'placement')
        .map(r => ({ row: r, at: new Date(r.at).getTime(), value: r.after as number }))
        .sort((a, b) => a.row.id - b.row.id);
}

const pct = (x: number) => Math.round(x * 100);

export default function EstimateChart({ points, threshold, day, describe }: {
    points: ChartPoint[];
    threshold: number;
    day: (iso: string) => string;
    /** What the answer behind a point was: "Feed question · Wrong". */
    describe: (row: EvidenceRow) => string;
}) {
    const { t } = useTranslation();
    const box = useRef<HTMLDivElement>(null);
    const width = useElementWidth(box);
    const rem = useRootFontSize();
    const [active, setActive] = useState<number | null>(null);

    // The plot's frame: a gutter on the left for 0/50/100, room above and
    // below so a dot at 0% or 100% is not cut in half.
    const height = Math.round(8 * rem);
    const gutter = Math.round(2.5 * rem);
    const pad = Math.round(0.5 * rem);
    const left = gutter + pad;
    const right = Math.max(left + 1, width - pad);
    const top = pad;
    const bottom = height - pad;

    const xy = useMemo(() => {
        if (points.length === 0 || width === 0) return [];
        // The order is the replay's (id); a synced or imported row can carry
        // an earlier time than the row before it, so time never runs back.
        let latest = -Infinity;
        const at = points.map(p => (latest = Math.max(latest, p.at)));
        const first = at[0];
        const span = at[at.length - 1] - first;
        return points.map((p, i) => ({
            x: span > 0 ? left + ((at[i] - first) / span) * (right - left) : (left + right) / 2,
            y: bottom - p.value * (bottom - top),
        }));
    }, [points, width, left, right, top, bottom]);

    const yOf = (v: number) => bottom - v * (bottom - top);
    const line = xy.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

    // The dot nearest the pointer along time, so sliding across the chart
    // walks the dots in order at any height. Answers on one day, or a row
    // held back to its neighbour's time above, share an x: among those the
    // pointer's height picks, and a full tie goes to the newer dot.
    const nearest = (clientX: number, clientY: number) => {
        const rect = box.current?.getBoundingClientRect();
        if (!rect || xy.length === 0) return null;
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        const dx = (i: number) => Math.abs(xy[i].x - x);
        const dy = (i: number) => Math.abs(xy[i].y - y);
        // Two passes, so the half-pixel band is measured from the nearest
        // time itself and cannot creep from dot to dot.
        let closest = Infinity;
        for (let i = 0; i < xy.length; i++) closest = Math.min(closest, dx(i));
        let best = -1;
        for (let i = 0; i < xy.length; i++) {
            if (dx(i) - closest > 0.5) continue;
            if (best < 0 || dy(i) <= dy(best)) best = i;
        }
        return best;
    };
    const onMove = (e: PointerEvent) => setActive(nearest(e.clientX, e.clientY));
    const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
        e.preventDefault();
        const last = points.length - 1;
        setActive(cur => {
            if (e.key === 'Home') return 0;
            if (e.key === 'End') return last;
            if (cur == null) return last;
            return Math.min(last, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1)));
        });
    };

    const first = points[0];
    const last = points[points.length - 1];
    const shown = active != null ? points[active] : null;
    const at = active != null ? xy[active] : null;
    // The tooltip sits beside its dot, flipped to the dot's left in the right
    // half so it never runs off the chart, and below a high dot / above a low
    // one: a rising line leaves that side empty, so it hides less of the line.
    const tipLeft = at ? (at.x > width / 2 ? undefined : at.x + 12) : undefined;
    const tipRight = at && at.x > width / 2 ? width - at.x + 12 : undefined;
    // Never wider than the room on its side of the dot: a dot just right of
    // the middle on a phone leaves less than the box's usual 14rem.
    const tipMax = at ? Math.min(14 * rem, Math.max(0, (tipRight != null ? at.x : width - at.x) - 12)) : undefined;
    const high = at != null && at.y < (top + bottom) / 2;
    const tipTop = at && high ? at.y + 10 : undefined;
    const tipBottom = at && !high ? height - at.y + 10 : undefined;
    // The proof line's name goes on the side of the line the first dot is not on.
    const labelBelow = first.value >= threshold;

    return (
        <figure className="m-0">
            <figcaption className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {t("How sure the app was over time")}
            </figcaption>
            <div
                ref={box}
                // pan-y: a finger moving up and down still scrolls the dialog;
                // across the chart, it moves between the dots.
                className="relative mt-1.5 touch-pan-y rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent-fg"
                style={{ height }}
                role="group"
                tabIndex={0}
                aria-label={t("How sure the app was: {{from}}% on {{start}}, {{to}}% on {{end}}", {
                    from: pct(first.value), start: day(first.row.at), to: pct(last.value), end: day(last.row.at),
                })}
                onPointerMove={onMove}
                onPointerDown={onMove}
                // A lifted finger leaves too: on touch the tapped dot stays
                // named until the next tap or a tap elsewhere (blur).
                onPointerLeave={e => { if (e.pointerType === 'mouse') setActive(null); }}
                onBlur={() => setActive(null)}
                onKeyDown={onKey}
            >
                {width > 0 && (
                    <svg width={width} height={height} className="absolute inset-0 overflow-visible" aria-hidden="true">
                        {/* Recessive grid: 0, 50 and 100 only. */}
                        {[0, 0.5, 1].map(v => (
                            <line key={v} x1={left} x2={right} y1={yOf(v)} y2={yOf(v)}
                                className="stroke-slate-200 dark:stroke-slate-700" strokeWidth={1} />
                        ))}
                        {/* Where proof starts. */}
                        <line x1={left} x2={right} y1={yOf(threshold)} y2={yOf(threshold)}
                            className="stroke-slate-500 dark:stroke-slate-400" strokeWidth={1} strokeDasharray="4 3" />
                        {at && (
                            <line x1={at.x} x2={at.x} y1={top} y2={bottom}
                                className="stroke-slate-400 dark:stroke-slate-500" strokeWidth={1} />
                        )}
                        <path d={line} fill="none" className="stroke-accent-fg" strokeWidth={2}
                            strokeLinejoin="round" strokeLinecap="round" />
                        {xy.map((p, i) => (
                            <circle key={points[i].row.id} cx={p.x} cy={p.y} r={active === i ? 5 : 4}
                                className="fill-accent-fg stroke-white dark:stroke-slate-800" strokeWidth={2} />
                        ))}
                    </svg>
                )}
                {/* Labels in HTML: 100 / 50 / 0 in the gutter, the proof line's name at its right end. */}
                {[1, 0.5, 0].map(v => (
                    <span key={v} aria-hidden="true"
                        className="absolute -translate-y-1/2 text-right text-2xs tabular-nums text-slate-500 dark:text-slate-400"
                        style={{ top: yOf(v), left: 0, width: gutter }}>
                        {t("{{pct}}%", { pct: pct(v) })}
                    </span>
                ))}
                {/* At the left end (the newest dot sits at the right one), on
                    the side of the line the oldest dot leaves free. */}
                <span aria-hidden="true"
                    className={`absolute pl-1 text-2xs text-slate-500 dark:text-slate-400 ${labelBelow ? 'pt-0.5' : '-translate-y-full pb-0.5'}`}
                    style={{ top: yOf(threshold), left }}>
                    {t("Proven")}
                </span>
                {shown && at && (
                    <div
                        aria-hidden="true"
                        // The app's one floating surface (menus, the hover card).
                        className={`pointer-events-none absolute z-10 w-max px-2.5 py-1.5 text-xs ${MENU_SURFACE}`}
                        style={{ top: tipTop, bottom: tipBottom, left: tipLeft, right: tipRight, maxWidth: tipMax }}
                    >
                        <p className="text-slate-500 dark:text-slate-300">{day(shown.row.at)} · {describe(shown.row)}</p>
                        <p className="font-medium tabular-nums text-slate-900 dark:text-white">
                            {t("After this the app was {{pct}}% sure", { pct: pct(shown.value) })}
                        </p>
                    </div>
                )}
            </div>
            {/* The dot the keyboard is on, read out once (the tooltip is hidden
                from screen readers). One sentence, so each language orders it. */}
            <p className="sr-only" aria-live="polite">
                {shown ? t("{{day}}, {{what}}. After this the app was {{pct}}% sure", {
                    day: day(shown.row.at), what: describe(shown.row), pct: pct(shown.value),
                }) : ''}
            </p>
            <div aria-hidden="true" className="mt-1 flex justify-between text-2xs tabular-nums text-slate-500 dark:text-slate-400"
                style={{ paddingLeft: left - pad }}>
                <span>{day(first.row.at)}</span>
                {points.length > 1 && <span>{day(last.row.at)}</span>}
            </div>
        </figure>
    );
}
