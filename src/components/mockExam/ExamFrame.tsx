import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronLeft, ChevronRight, Eye, EyeOff, LayoutGrid } from 'lucide-react';
import { useStore } from '../../store';
import { Button, IconButton } from '../ui/Button';
import { FOCUS_RING } from '../ui/vocabulary';
import { useElementWidth } from '../../hooks/useElementWidth';
import { useRootFontSize } from '../../hooks/useRootFontSize';
import { motionReduced } from '../../utils/accessibility';

/**
 * The screen a mock exam is answered on. While it is mounted the app's own
 * chrome steps aside (the header, the course tabs, the course tree, the
 * assistant: `examFocus` in the store), so the exam holds the whole window
 * the way a test-delivery app does: its own bar on top (a way out that keeps
 * the answers, the title, what is answered and the clock, Pause), the
 * question in the middle, and the navigation along the bottom.
 *
 * `data-owns-keyboard` keeps the app-wide letter shortcuts (the assistant's
 * `a`) from firing while a learner types an answer or moves by keys.
 */
export function ExamFrame({ title, status, actions, onLeave, leaveLabel, leaving = false, footer, frameRef, children }: {
    title: string;
    /** The frame's root: one element through pause and resume, so a width measured on it stays live. */
    frameRef?: RefObject<HTMLDivElement | null>;
    /** One line under the title: what is answered, the clock. */
    status?: ReactNode;
    /** Right of the bar (Pause). */
    actions?: ReactNode;
    onLeave: () => void;
    /** The way out's words: "Save and leave" where leaving saves; a past paper's clock just goes "Back". */
    leaveLabel?: string;
    leaving?: boolean;
    footer?: ReactNode;
    children: ReactNode;
}) {
    const { t } = useTranslation();
    const setExamFocus = useStore(s => s.setExamFocus);
    useEffect(() => {
        setExamFocus(true);
        return () => setExamFocus(false);
    }, [setExamFocus]);

    const barRef = useRef<HTMLDivElement>(null);
    const width = useElementWidth(barRef);
    const rem = useRootFontSize();
    const outLabel = leaveLabel ?? t("Save and leave");
    // Three widths. Roomy: the title and the status between the two labelled
    // buttons. A phone: both buttons keep their words (a bare arrow reads as
    // "back, and lose it") and the status takes its own line under them; the
    // title gives way. Very narrow (large text on a small phone): icons only.
    const roomy = width >= EXAM_BAR_ROOMY * rem;
    const tiny = width > 0 && width < EXAM_BAR_TINY * rem;
    const statusLine = status && (
        <p className="text-balance text-sm tabular-nums text-slate-600 dark:text-slate-300">{status}</p>
    );

    return (
        <div ref={frameRef} data-owns-keyboard="" className="flex-1 min-h-0 flex flex-col bg-slate-100 dark:bg-slate-900">
            <div ref={barRef} className="shrink-0 safe-pt-0 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
                <div className="mx-auto w-full max-w-5xl flex flex-wrap items-center gap-x-2 px-2 sm:px-4 min-h-[3.5rem] py-1.5">
                    {tiny
                        ? <IconButton size="md" label={outLabel} icon={<ArrowLeft className="w-5 h-5" />} onClick={onLeave} disabled={leaving} />
                        : <Button variant="quiet" size="sm" busy={leaving} icon={<ArrowLeft className="w-4 h-4" aria-hidden="true" />} onClick={onLeave}>{outLabel}</Button>}
                    <div className="flex-1 min-w-0 px-1 text-center">
                        {roomy && <h2 className="truncate text-sm font-semibold text-slate-900 dark:text-white">{title}</h2>}
                        {(roomy || tiny) && statusLine}
                    </div>
                    {/* As wide as the way out when the title sits between them, so it sits at the true centre. */}
                    <div className={`flex justify-end ${roomy ? 'min-w-[9.5rem]' : ''}`}>{actions}</div>
                    {!roomy && !tiny && status && <div className="basis-full pb-1 text-center">{statusLine}</div>}
                </div>
            </div>
            <div className="flex-1 min-h-0 overflow-auto">{children}</div>
            {footer && (
                <div className="shrink-0 border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
                    {footer}
                </div>
            )}
        </div>
    );
}

/** Widths of the exam bar, in rem: the title shows from ROOMY, the buttons lose their words below TINY. */
export const EXAM_BAR_ROOMY = 34;
export const EXAM_BAR_TINY = 20;

export interface StripItem {
    answered: boolean;
    marked: boolean;
}

// Answered is a filled cell, not answered an empty outlined one: a shape
// difference that holds without colour. The fill is a tint of the accent, so
// a finished row reads as done, not as greyed out.
const ANSWERED = 'bg-accent/20 dark:bg-accent/35';
const OPEN = 'border-2 border-slate-400 bg-white dark:border-slate-500 dark:bg-slate-800';

/** One question's cell: its look is the same in the strip and the full grid. */
function cellClass(item: StripItem, current: boolean) {
    const state = current
        ? 'bg-accent text-white font-semibold'
        : item.answered
            ? `${ANSWERED} text-slate-900 dark:text-white can-hover:hover:bg-accent/30 dark:can-hover:hover:bg-accent/45`
            : `${OPEN} text-slate-700 dark:text-slate-200 can-hover:hover:bg-slate-100 dark:can-hover:hover:bg-slate-700`;
    return `relative shrink-0 inline-flex items-center justify-center rounded-lg text-sm tabular-nums transition-colors ${FOCUS_RING} focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-800 ${state}`;
}

export function cellName(t: (k: string, o?: Record<string, unknown>) => string, n: number, item: StripItem) {
    return [
        t("Question {{n}}", { n }),
        item.answered ? t("answered") : t("not answered"),
        item.marked ? t("marked to come back to") : null,
    ].filter(Boolean).join(', ');
}

/** The amber dot of "Come back to this", on the cell's corner so it reads on any fill. */
function MarkDot() {
    return <span aria-hidden="true" className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-500 ring-2 ring-white dark:ring-slate-800" />;
}

/**
 * Every question as a numbered cell in ONE row along the bottom. The row
 * scrolls sideways (swipe, wheel, the arrow buttons that appear when it
 * overflows) and keeps the current question in view. It is one stop on the
 * Tab path: the arrow keys, Home and End move along it, Enter opens.
 */
export function QuestionStrip({ items, current, onGo }: {
    items: StripItem[];
    current: number;
    onGo: (i: number) => void;
}) {
    const { t } = useTranslation();
    const scroller = useRef<HTMLDivElement>(null);
    const cells = useRef<(HTMLButtonElement | null)[]>([]);
    const [focusAt, setFocusAt] = useState(current);
    const [edges, setEdges] = useState({ start: false, end: false });
    useEffect(() => { setFocusAt(current); }, [current]);

    // Which ends have more behind them; the page arrows show only when the row overflows.
    useEffect(() => {
        const el = scroller.current;
        if (!el) return;
        const measure = () => setEdges({
            start: el.scrollLeft > 2,
            end: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
        });
        measure();
        el.addEventListener('scroll', measure, { passive: true });
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        if (el.firstElementChild) ro.observe(el.firstElementChild);
        return () => { el.removeEventListener('scroll', measure); ro.disconnect(); };
    }, [items.length]);

    // The current question is kept in view, centred when the row overflows.
    useLayoutEffect(() => {
        const el = scroller.current;
        const cell = cells.current[current];
        if (!el || !cell) return;
        const left = cell.offsetLeft - (el.clientWidth - cell.offsetWidth) / 2;
        el.scrollTo({ left: Math.max(0, left) });
    }, [current, items.length]);

    const page = (dir: -1 | 1) => {
        const el = scroller.current;
        if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: motionReduced() ? 'auto' : 'smooth' });
    };

    const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
        const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1
            : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
        if (to == null || to < 0 || to >= items.length) return;
        e.preventDefault();
        setFocusAt(to);
        cells.current[to]?.focus();
    };

    const overflow = edges.start || edges.end;
    return (
        <div className="flex-1 min-w-0 flex items-center gap-1">
            {overflow && (
                <IconButton size="sm" label={t("Earlier questions")} icon={<ChevronLeft className="w-4 h-4" />}
                    onClick={() => page(-1)} disabled={!edges.start} tooltip={false} />
            )}
            <div ref={scroller} className="relative flex-1 min-w-0 overflow-x-auto rail-scroll"
                data-fade={edges.start && edges.end ? 'both' : edges.start ? 'start' : edges.end ? 'end' : 'none'}>
                <ul className={`flex w-max gap-1.5 px-1.5 py-2 ${overflow ? '' : 'mx-auto'}`} aria-label={t("Questions")}>
                    {items.map((item, i) => (
                        <li key={i} className="shrink-0">
                            <button ref={el => { cells.current[i] = el; }} type="button" data-question-cell
                                tabIndex={i === focusAt ? 0 : -1}
                                onClick={() => onGo(i)} onKeyDown={e => onKey(e, i)}
                                aria-label={cellName(t, i + 1, item)} aria-current={i === current ? 'step' : undefined}
                                className={`${cellClass(item, i === current)} w-10 h-10`}>
                                {i + 1}
                                {item.marked && <MarkDot />}
                            </button>
                        </li>
                    ))}
                </ul>
            </div>
            {overflow && (
                <IconButton size="sm" label={t("Later questions")} icon={<ChevronRight className="w-4 h-4" />}
                    onClick={() => page(1)} disabled={!edges.end} tooltip={false} />
            )}
        </div>
    );
}

/** The strip unfolded: every question at once, with what is answered and marked counted. */
export function QuestionGrid({ items, current, onGo }: {
    items: StripItem[];
    current: number;
    onGo: (i: number) => void;
}) {
    const { t } = useTranslation();
    const answered = items.filter(x => x.answered).length;
    const marked = items.filter(x => x.marked).length;
    return (
        <div>
            <p className="text-sm text-slate-700 dark:text-slate-200 tabular-nums">
                {t("{{answered}} of {{total}} answered", { answered, total: items.length })}
                {marked > 0 && <span className="text-slate-600 dark:text-slate-300"> · {t("{{count}} questions to come back to", { count: marked })}</span>}
            </p>
            <ul className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-2 p-1">
                {items.map((item, i) => (
                    <li key={i}>
                        <button type="button" data-question-cell onClick={() => onGo(i)}
                            aria-label={cellName(t, i + 1, item)} aria-current={i === current ? 'step' : undefined}
                            className={`${cellClass(item, i === current)} w-full h-11`}>
                            {i + 1}
                            {item.marked && <MarkDot />}
                        </button>
                    </li>
                ))}
            </ul>
            <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-600 dark:text-slate-300">
                <li className="flex items-center gap-1.5"><span aria-hidden="true" className={`w-4 h-4 rounded ${ANSWERED}`} />{t("Answered")}</li>
                <li className="flex items-center gap-1.5"><span aria-hidden="true" className={`w-4 h-4 rounded ${OPEN}`} />{t("Not answered")}</li>
                <li className="flex items-center gap-1.5"><span aria-hidden="true" className="w-2.5 h-2.5 rounded-full bg-amber-500" />{t("Come back to this")}</li>
            </ul>
        </div>
    );
}

/**
 * "Hide the clock" / "Show the clock", the same on the past paper's desk clock
 * and in a course mock's exam bar. In the bar it says only "Hide" or "Show"
 * beside the time, so the bar keeps one line on a phone; the full name is its
 * accessible label. An eye alone was read as decoration.
 */
export function ClockToggle({ hidden, onToggle, short = false, className }: { hidden: boolean; onToggle: () => void; short?: boolean; className?: string }) {
    const { t } = useTranslation();
    const label = hidden ? t("Show the clock") : t("Hide the clock");
    const icon = hidden ? <Eye className="w-4 h-4" aria-hidden="true" /> : <EyeOff className="w-4 h-4" aria-hidden="true" />;
    return (
        <Button variant="quiet" size="sm" icon={icon} onClick={onToggle} className={className} aria-label={short ? label : undefined}>
            {short ? (hidden ? t("Show") : t("Hide")) : label}
        </Button>
    );
}

/** The expand button beside the strip. */
export function GridButton({ onClick }: { onClick: () => void }) {
    const { t } = useTranslation();
    return <IconButton size="md" label={t("All questions")} icon={<LayoutGrid className="w-5 h-5" />} onClick={onClick} />;
}
