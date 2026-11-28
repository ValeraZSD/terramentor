import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { LearnerPace, VerdictBand } from '../../types';
import { useElementWidth } from '../../hooks/useElementWidth';
import { useRootFontSize } from '../../hooks/useRootFontSize';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import { dateRangeLabel, uiLocale } from '../../utils/locale';
import { parseDate } from '../../utils/tree';
import { MENU_SURFACE } from '../ui/Popover';
import { bestKeyName, perWeek } from './verdict';

/** How far back the chart reaches: half a year of weeks. */
export const CHART_WEEKS = 26;

const NEEDED_STROKE: Partial<Record<VerdictBand, string>> = {
    on_pace: 'stroke-emerald-600 dark:stroke-emerald-400',
    under_pace: 'stroke-amber-600 dark:stroke-amber-400',
    tight: 'stroke-amber-600 dark:stroke-amber-400',
    out_of_reach: 'stroke-red-600 dark:stroke-red-400',
};

/**
 * The learner's own weeks as bars, with the two numbers the verdict compares
 * drawn across them: the pace the date needs (dashed, in the verdict's colour)
 * and the best four weeks ever (solid grey). The lines are named above the
 * drawing, each beside a sample of itself. Drawn in pixels from the measured
 * width, like the evidence chart, so text never stretches.
 *
 * Hover, a tap or the arrow keys name one week; the bars themselves are hidden
 * from screen readers, which get the same week in one sentence.
 */
export default function WeeklyChart({ pace, needed, band, unit }: {
    pace: LearnerPace;
    needed: number | null;
    band: VerdictBand;
    unit: 'topics' | 'cards';
}) {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const box = useRef<HTMLDivElement>(null);
    const width = useElementWidth(box);
    const rem = useRootFontSize();
    const [active, setActive] = useState<number | null>(null);
    const lineNamesId = useId();

    // Oldest on the left, so the newest week sits where "now" is read.
    const weeks = useMemo(() => pace.weeks.slice(0, CHART_WEEKS).reverse(), [pace.weeks]);
    const best = pace.best ?? 0;
    // A band with no needed line (done, learning, passed, no date) draws
    // none, so it neither scales the chart nor pushes the best line's name
    // aside. On pace keeps its line, in green: the bars standing above it are
    // what "on pace" means.
    const need = needed != null && NEEDED_STROKE[band] ? needed : 0;
    const top = Math.max(1, ...weeks.map(w => w.count), best, need) * 1.08;

    const height = Math.round(9 * rem);
    const gutter = Math.round(2 * rem);
    const padTop = Math.round(0.5 * rem); // the top bar clear of the box's edge
    const left = gutter;
    const right = Math.max(left + 1, width);
    const bottom = height;
    const yOf = (v: number) => bottom - (v / top) * (bottom - padTop);
    const slot = weeks.length ? (right - left) / weeks.length : 0;
    const barW = Math.max(2, slot * 0.72);

    const nice = (() => {
        // Two grid lines at round numbers under the top: 0 and one more.
        // Whole numbers only: a best week of 1 put a line at 0.5 labelled "1".
        const raw = top / 2;
        if (raw < 1) return 1;
        const p = Math.pow(10, Math.floor(Math.log10(raw)));
        return [1, 2, 5, 10].map(m => m * p).find(s => s >= raw * 0.8) ?? Math.ceil(raw);
    })();
    const grid = [0, nice, nice * 2].filter(v => v <= top);

    // Month names under the first week that starts in each month, skipped
    // when the one before is closer than 2.5rem.
    const lang = uiLocale();
    const monthShort = useMemo(() => new Intl.DateTimeFormat(lang, { month: 'short', timeZone: 'UTC' }), [lang]);
    const ticks = useMemo(() => {
        const out: Array<{ x: number; label: string }> = [];
        let lastX = -Infinity;
        weeks.forEach((w, i) => {
            const prev = weeks[i - 1];
            if (prev && prev.start.slice(0, 7) === w.start.slice(0, 7)) return;
            const x = left + i * slot;
            if (x - lastX < 2.5 * rem) return;
            out.push({ x, label: monthShort.format(parseDate(w.start)) });
            lastX = x;
        });
        return out;
    }, [weeks, left, slot, rem, monthShort]);

    const pick = (clientX: number) => {
        const rect = box.current?.getBoundingClientRect();
        if (!rect || !weeks.length || slot <= 0) return null;
        const i = Math.floor((clientX - rect.left - left) / slot);
        return i >= 0 && i < weeks.length ? i : null;
    };
    const onMove = (e: PointerEvent) => setActive(pick(e.clientX));
    const onKey = (e: KeyboardEvent) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const last = weeks.length - 1;
        setActive(cur => {
            if (e.key === 'Home') return 0;
            if (e.key === 'End') return last;
            if (cur == null) return last;
            return Math.min(last, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1)));
        });
    };

    if (!weeks.length) return null;

    const weekLabel = (i: number) => dateRangeLabel(parseDate(weeks[i].start), parseDate(weeks[i].end), { year: false });
    const countLabel = (n: number) => unit === 'cards'
        ? t("{{n}} new cards", { count: n, n: num(n) })
        : t("{{n}} topics closed", { count: n, n: num(n) });
    const shown = active != null ? weeks[active] : null;
    const barX = (i: number) => left + i * slot + (slot - barW) / 2;
    const tipX = active != null ? barX(active) + barW / 2 : 0;
    const tipOnLeft = tipX > width / 2;

    const r = (x: number) => { const v = perWeek(x); return num(v, { decimals: Number.isInteger(v) ? 0 : 1 }); };
    const neededName = need > 0 ? t("Needed: {{n}} a week", { n: r(need) }) : null;
    const bestName = best > 0 ? t("Your best month: {{n}} a week", { n: r(best) }) : null;
    // A sample of each line beside its name, drawn like the line itself.
    const sample = (stroke: string, dashed: boolean) => (
        <svg width={Math.round(1.5 * rem)} height={6} className="shrink-0" aria-hidden="true">
            <line x1={0} x2={Math.round(1.5 * rem)} y1={3} y2={3} className={stroke}
                strokeWidth={dashed ? 2 : 1.5} strokeDasharray={dashed ? '6 4' : undefined} />
        </svg>
    );

    return (
        <figure className="relative m-0">
            <figcaption className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {unit === 'cards' ? t("New cards you met each week, in all your courses") : t("Topics you closed each week, in all your courses")}
            </figcaption>
            {/* The lines' names sit above the drawing, not at the lines' ends:
                there they covered the newest weeks, the bars read first. */}
            {/* A number only where the sentences above leave it out: the
                needed rate is always there, the best month's not in every band. */}
            {(neededName || bestName) && (
                <div aria-hidden="true" className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-700 dark:text-slate-200">
                    {neededName && (
                        <span className="inline-flex items-center gap-1.5">{sample(NEEDED_STROKE[band]!, true)}{t("Pace needed")}</span>
                    )}
                    {bestName && (
                        <span className="inline-flex items-center gap-1.5">{sample('stroke-slate-500 dark:stroke-slate-400', false)}{bestKeyName(band, best, t, num)}</span>
                    )}
                </div>
            )}
            <div
                ref={box}
                // Weeks run left to right in every interface language: the
                // chart is drawn in pixels from the left, so it stays an island.
                dir="ltr"
                className="relative mt-1.5 touch-pan-y rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent-fg"
                style={{ height }}
                role="group"
                tabIndex={0}
                aria-label={t("Your last {{n}} weeks. Use the arrow keys to read one week.", { count: weeks.length, n: num(weeks.length) })}
                aria-describedby={lineNamesId}
                onPointerMove={onMove}
                onPointerDown={onMove}
                onPointerLeave={e => { if (e.pointerType === 'mouse') setActive(null); }}
                onBlur={() => setActive(null)}
                onKeyDown={onKey}
            >
                {width > 0 && (
                    <svg width={width} height={height} className="absolute inset-0 overflow-visible" aria-hidden="true">
                        {grid.map(v => (
                            <line key={v} x1={left} x2={right} y1={yOf(v)} y2={yOf(v)}
                                className="stroke-slate-200 dark:stroke-slate-700" strokeWidth={1} />
                        ))}
                        {weeks.map((w, i) => w.count > 0 && (
                            <rect key={w.start} x={barX(i)} y={yOf(w.count)} width={barW} height={Math.max(1, bottom - yOf(w.count))} rx={2}
                                className={active === i ? 'fill-accent-fg' : 'fill-accent-fg/80'} />
                        ))}
                        {best > 0 && (
                            <line x1={left} x2={right} y1={yOf(best)} y2={yOf(best)}
                                className="stroke-slate-500 dark:stroke-slate-400" strokeWidth={1.5} />
                        )}
                        {need > 0 && NEEDED_STROKE[band] && (
                            <line x1={left} x2={right} y1={yOf(need)} y2={yOf(need)}
                                className={NEEDED_STROKE[band]} strokeWidth={2} strokeDasharray="6 4" />
                        )}
                    </svg>
                )}
                {grid.map(v => (
                    <span key={v} aria-hidden="true"
                        className="absolute -translate-y-1/2 pe-1.5 text-end text-xs tabular-nums text-slate-500 dark:text-slate-400"
                        style={{ top: yOf(v), left: 0, width: gutter }}>
                        {num(Math.round(v))}
                    </span>
                ))}
                {shown && active != null && (
                    <div
                        aria-hidden="true"
                        dir="auto"
                        className={`pointer-events-none absolute z-10 w-max px-2.5 py-1.5 text-xs ${MENU_SURFACE}`}
                        style={{ top: padTop, left: tipOnLeft ? undefined : tipX + 8, right: tipOnLeft ? width - tipX + 8 : undefined }}
                    >
                        <p className="text-slate-500 dark:text-slate-300">{weekLabel(active)}</p>
                        <p className="font-medium tabular-nums text-slate-900 dark:text-white">{countLabel(shown.count)}</p>
                    </div>
                )}
            </div>
            {/* The two lines' names, read with the weeks: the weeks are read
                against them. */}
            <p id={lineNamesId} className="sr-only">
                {[neededName, bestName].filter(Boolean).join('. ')}
            </p>
            <p className="sr-only" aria-live="polite">
                {shown && active != null ? `${weekLabel(active)}: ${countLabel(shown.count)}` : ''}
            </p>
            <div aria-hidden="true" dir="ltr" className="relative mt-1 h-4 text-xs text-slate-500 dark:text-slate-400">
                {ticks.map(tk => (
                    <span key={`${tk.x}`} className="absolute top-0" style={{ left: tk.x }}>{tk.label}</span>
                ))}
            </div>
        </figure>
    );
}
