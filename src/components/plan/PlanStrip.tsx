import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2 } from 'lucide-react';
import type { PaceVerdict, WeekSoFar } from '../../types';
import { useElementWidth } from '../../hooks/useElementWidth';
import { useRootFontSize } from '../../hooks/useRootFontSize';
import { useNumberFormat } from '../../hooks/useNumberFormat';
import { TONE_TEXT, placeLabels, stripFacts, weekLine, type StripFacts, type StripLabel, type StripLane } from './verdict';

/** Where each lane's labels sit, from the strip's top. */
const LANE_TOP: Record<StripLane, string> = { above: '0', below: '3.4rem', under: '4.75rem' };

/**
 * The plan's look forward: one strip from today to a little past the later of
 * the learner's date and the likely finish, with the "likely done" range the
 * recent pace gives and a flag on the date; under it, this week's work against
 * what the date needs a week.
 */
export default function PlanStrip({ verdict, week, today }: {
    verdict: PaceVerdict;
    week: WeekSoFar | null | undefined;
    today: string;
}) {
    const { t } = useTranslation();
    const num = useNumberFormat();
    const facts = stripFacts(verdict, t, num, today);
    const line = weekLine(verdict, week, t, num);
    if (!facts && !line) return null;
    return (
        <figure className="m-0">
            {/* Its own component, mounted with the strip: it measures its box
                on mount, and a panel that opens on a passed date gets one later. */}
            {facts && <Strip facts={facts} band={verdict.band} />}
            {line && (
                <p data-strip="week" className={`${facts ? 'mt-2' : ''} flex items-center gap-1.5 text-sm text-slate-700 dark:text-slate-200`}>
                    {line.met && <CheckCircle2 className={`h-4 w-4 shrink-0 ${TONE_TEXT.on_pace}`} aria-hidden="true" />}
                    <span>{line.text}</span>
                </p>
            )}
        </figure>
    );
}

/**
 * The strip itself, built from rem and the measured width. Time runs left to
 * right in every interface language, as on the app's other time charts, and
 * the labels are placed by `left` (a logical inset would follow a label's own
 * direction).
 */
function Strip({ facts, band }: { facts: StripFacts; band: PaceVerdict['band'] }) {
    const { t } = useTranslation();
    const box = useRef<HTMLDivElement>(null);
    const width = useElementWidth(box);
    const rem = useRootFontSize();

    const refs = { today: useRef<HTMLSpanElement>(null), date: useRef<HTMLSpanElement>(null), range: useRef<HTMLSpanElement>(null) };
    const [widths, setWidths] = useState<Record<StripLabel, number>>({ today: 0, date: 0, range: 0 });
    const texts = `${t("Today")}|${t("Your date")}|${facts.rangeLabel ?? ''}`;
    // Each label's own width, read from its text (an inner span that is never
    // cut), rounded up: the box a label is cut to would read back as its width
    // and never grow again once the strip or the text does.
    useLayoutEffect(() => {
        const w = (id: StripLabel) => Math.ceil(refs[id].current?.getBoundingClientRect().width ?? 0);
        const next = { today: w('today'), date: w('date'), range: w('range') };
        setWidths(cur => (cur.today === next.today && cur.date === next.date && cur.range === next.range ? cur : next));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [texts, rem, width]);

    const pad = Math.round(0.5 * rem);
    const span = facts.endDay * 1.06;
    const xOf = (day: number) => pad + (Math.max(0, day) / span) * Math.max(0, width - 2 * pad);
    const range = facts.range;
    const placed = width > 0 && widths.today > 0 ? placeLabels([
        { id: 'today', x: 0, w: widths.today, start: true, lanes: ['below', 'above', 'under'] },
        { id: 'date', x: xOf(facts.dateDay), w: widths.date, start: false, lanes: ['below', 'above', 'under'] },
        ...(range ? [{ id: 'range' as const, x: (xOf(range.fromDay) + xOf(range.toDay)) / 2, w: widths.range, start: false, lanes: ['above', 'below', 'under'] as StripLane[] }] : []),
    ], width, Math.round(0.5 * rem)) : {};
    const deep = Object.values(placed).some(p => p?.lane === 'under');
    // No label above the track (no range, or each label fitted below): the
    // empty lane is taken back, so the strip does not hang a gap under the text.
    const lift = width > 0 && widths.today > 0 && !Object.values(placed).some(p => p?.lane === 'above');
    const labelStyle = (id: StripLabel) => {
        const p = placed[id];
        // A label never runs past the strip: only one wider than it is cut,
        // to the strip's width, ending in "…" (its title holds it whole).
        const cut = p && p.width < widths[id] ? { maxWidth: p.width } : {};
        return p ? { left: p.left, top: LANE_TOP[p.lane], ...cut } : { left: 0, top: 0, visibility: 'hidden' as const };
    };
    const label = 'absolute truncate text-sm leading-5';

    return (
        <div ref={box} role="img" aria-label={facts.sentence} dir="ltr" className="relative" style={{ height: deep ? '6rem' : '4.75rem', marginTop: lift ? '-1.25rem' : undefined }}>
            {width > 0 && (
                <>
                    {/* The track from today on. */}
                    <div aria-hidden="true" className="absolute rounded-full bg-slate-200 dark:bg-slate-700"
                        style={{ left: xOf(0), right: 0, top: '2.3rem', height: '0.4rem' }} />
                    {range && (
                        <div aria-hidden="true" data-strip="range"
                            className="absolute rounded-md border border-slate-500 bg-slate-400/40 dark:border-slate-300 dark:bg-slate-400/45"
                            style={{
                                left: xOf(range.fromDay),
                                width: Math.max(0.5 * rem, xOf(range.toDay) - xOf(range.fromDay)),
                                top: '2.05rem', height: '0.9rem',
                            }} />
                    )}
                    <span aria-hidden="true" data-strip="today"
                        className="absolute rounded-full bg-slate-700 ring-2 ring-white dark:bg-slate-200 dark:ring-slate-800"
                        style={{ left: xOf(0) - 0.375 * rem, top: '2.125rem', width: '0.75rem', height: '0.75rem' }} />
                    {/* The flag: a stem through the track, its pennant pointing
                        forward in time. */}
                    <span aria-hidden="true" data-strip="date" data-tone={band} className={TONE_TEXT[band]}>
                        <span className="absolute bg-current"
                            style={{ left: xOf(facts.dateDay) - 1, top: '1.35rem', width: 2, height: '1.95rem' }} />
                        <svg viewBox="0 0 12 10" className="absolute fill-current"
                            style={{ left: xOf(facts.dateDay) + 1, top: '1.35rem', width: '0.8rem', height: '0.65rem' }}>
                            <path d="M0 0 H12 L8.5 5 L12 10 H0 Z" />
                        </svg>
                    </span>
                </>
            )}
            <span aria-hidden="true" dir="auto" title={t("Today")} className={`${label} text-slate-600 dark:text-slate-300`} style={labelStyle('today')}>
                <span ref={refs.today}>{t("Today")}</span>
            </span>
            <span aria-hidden="true" dir="auto" title={t("Your date")} className={`${label} font-medium text-slate-800 dark:text-slate-100`} style={labelStyle('date')}>
                <span ref={refs.date}>{t("Your date")}</span>
            </span>
            {facts.rangeLabel && (
                <span aria-hidden="true" dir="auto" title={facts.rangeLabel} className={`${label} font-medium text-slate-800 dark:text-slate-100`} style={labelStyle('range')}>
                    <span ref={refs.range}>{facts.rangeLabel}</span>
                </span>
            )}
        </div>
    );
}
