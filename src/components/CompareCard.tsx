import { createContext, Fragment, memo, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Check, Copy } from 'lucide-react';
import { IconButton } from './ui/Button';
import { copyText } from '../utils/clipboard';
import { useElementWidth } from '../hooks/useElementWidth';
import { useRootFontSize } from '../hooks/useRootFontSize';
import {
    compareCard, editOrder, flowOf, langOfLabel, sideMarkdown, wordDiff, SIDE_ROLES,
    type CompareBlock, type CompareCardProposal, type CompareSide, type DiffRun, type SideRole,
} from '../utils/compareBlocks';
import { k } from '../i18n';

/**
 * Two related texts the assistant wrote, side by side (src/utils/compareBlocks.ts):
 * a sentence and its translation, a sentence before and after a fix, the same
 * idea in two programming languages.
 *
 * Side by side when the CONTAINER has room for two columns (a phone, or the
 * docked drawer at its narrowest, stacks them), because comparison works when
 * both cases are in view at once and their parts line up (Rittle-Johnson,
 * Star & Durkin 2017). Code needs wider columns than a sentence before it
 * stops wrapping every line, so it splits later.
 *
 * The words are real text in reading order — title, first name, first text,
 * second name, second text, the note — inside one labelled group, so a screen
 * reader and a Copy read the same thing. A fix's changed words are marked in
 * <del> (struck through) and <ins>, each named in words for a screen reader;
 * which side is the fix comes from what the sides are called, not their
 * order. Two versions that are both right (two registers, two spellings) get
 * the same highlight on both sides, never "removed" and "added".
 *
 * An arrow on the line between the sides only when one was made from the
 * other (a fix, a translation the learner asked for), never for two that only
 * stand side by side: it would say one became the other.
 */

export type { CompareCardProposal };

/**
 * What the assistant draws under a pair that names a topic: its Add card
 * press. Given by the drawer, which owns the card door; nothing here writes.
 */
export const CompareFootContext = createContext<((card: CompareCardProposal) => ReactNode) | null>(null);

const ROLE_LABELS: Record<SideRole, string> = {
    before: k("Before"), after: k("After"), original: k("Original"), translation: k("Translation"), wrong: k("Wrong"), correct: k("Correct"),
};


/** Columns a pair needs before it goes side by side, in rem. */
const SPLIT_TEXT_REM = 28;
const SPLIT_CODE_REM = 44;

interface CompareCardProps {
    block: CompareBlock;
    /** A text side's markdown, drawn by the renderer that holds this card. */
    renderText: (markdown: string) => ReactNode;
    /** A code side, highlighted with no box of its own. */
    renderCode: (language: string, code: string) => ReactNode;
}

const CompareCard = memo(function CompareCard({ block, renderText, renderCode }: CompareCardProps) {
    const { t, i18n } = useTranslation();
    const ref = useRef<HTMLDivElement>(null);
    // The group names point at the visible words, so they are read once.
    const id = useId();
    const width = useElementWidth(ref);
    const rem = useRootFontSize();
    const footFor = useContext(CompareFootContext);

    const hasCode = block.sides.some(s => s.kind === 'code');
    // Columns that turned out too narrow for what is in them (an equation, a
    // long word): at this width and below, the pair stacks instead.
    const [crampedAt, setCrampedAt] = useState(0);
    // Not measured yet (0, and every server render) is the stacked layout,
    // which fits anywhere.
    const wide = width > 0 && width >= (hasCode ? SPLIT_CODE_REM : SPLIT_TEXT_REM) * rem && width > crampedAt;
    useLayoutEffect(() => {
        if (!wide || !ref.current) return;
        // Code scrolls inside its own box, as every code block does; text and
        // maths that do not fit a column are read whole, one above the other.
        const spill = (el: Element) => el.scrollWidth > el.clientWidth + 1;
        const bodies = ref.current.querySelectorAll('[data-compare-body="text"]');
        if ([...bodies].some(b => spill(b) || [...b.querySelectorAll('.katex-display')].some(spill))) setCrampedAt(width);
    });
    // The role words in the interface language, so a side named "Fout" in a
    // Dutch interface is the wrong one.
    const roleWords = useMemo(
        () => new Map<string, SideRole>(SIDE_ROLES.map(r => [t(ROLE_LABELS[r]).toLowerCase(), r])),
        [t, i18n.language],
    );
    const diff = useMemo(() => wordDiff(block.sides[0], block.sides[1]), [block]);
    const order = useMemo(() => editOrder(block, roleWords), [block, roleWords]);
    const flow = useMemo(() => flowOf(block, roleWords), [block, roleWords]);
    const card = useMemo(
        () => compareCard(block, i18n.language, roleWords, s => s.label || (s.role ? t(ROLE_LABELS[s.role]) : '')),
        [block, i18n.language, roleWords, t],
    );
    const foot = card && footFor ? footFor(card) : null;

    const names = block.sides.map((s, i) => s.label || (s.role ? t(ROLE_LABELS[s.role]) : (i === 0 ? t("First side") : t("Second side"))));
    const shown = block.sides.map(s => s.label || (s.role ? t(ROLE_LABELS[s.role]) : ''));

    const body = (side: CompareSide, i: number) => {
        const runs = diff?.[i];
        if (runs) return <MarkedText runs={runs} mark={order === null ? 'mark' : i === order ? 'del' : 'ins'} />;
        if (side.kind === 'code') return renderCode(side.lang ?? '', side.text);
        return renderText(side.text);
    };

    const head = (i: number) => (
        <div className="not-prose flex items-center justify-between gap-2 min-h-8">
            <span id={`${id}-side-${i}`} className="min-w-0 text-xs font-medium text-slate-500 dark:text-slate-400 break-words">{shown[i]}</span>
            <CopySide side={block.sides[i]} name={names[i]} />
        </div>
    );

    const side = (i: number, className: string) => {
        const s = block.sides[i];
        return (
            <div role="group" {...(shown[i] ? { 'aria-labelledby': `${id}-side-${i}` } : { 'aria-label': names[i] })} data-compare-side={i} className={`min-w-0 ${className}`}>
                {head(i)}
                {/* Code reads left to right in every interface language. A
                    text too wide for the phone scrolls inside its side, never
                    clipped by the card's rounded edge. */}
                <div
                    dir={s.kind === 'code' ? 'ltr' : 'auto'}
                    lang={s.kind === 'text' ? langOfLabel(s.label, i18n.language) : undefined}
                    data-compare-body={s.kind}
                    className={s.kind === 'text' ? 'min-w-0 overflow-x-auto' : 'min-w-0'}
                >
                    {body(s, i)}
                </div>
            </div>
        );
    };

    // The line between the sides; an arrow on it only when one side was made
    // from the other, pointing from that one, whichever side it stands on.
    const turn = wide
        ? (flow === 0 ? 'rtl:rotate-180' : 'rotate-180 rtl:rotate-0')
        : (flow === 0 ? 'rotate-90' : '-rotate-90');
    const seam = (
        <div aria-hidden="true" data-compare-seam={flow === null ? '' : 'flow'} className={`relative bg-slate-200 dark:bg-slate-700 ${wide ? 'w-px' : 'h-px'}`}>
            {flow !== null && (
                <span className="not-prose absolute left-1/2 top-1/2 z-10 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400">
                    <ArrowRight className={`h-3.5 w-3.5 ${turn}`} />
                </span>
            )}
        </div>
    );

    // One box holds the two sides and the note that explains them; the title
    // names the box from above, and Add card (the app's, not the answer's:
    // Read aloud skips it) sits under it.
    return (
        <div ref={ref} role="group" {...(block.title ? { 'aria-labelledby': `${id}-title` } : { 'aria-label': t("Comparison") })} data-compare className="my-4">
            {block.title && (
                <p id={`${id}-title`} className="not-prose mb-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100 break-words">{block.title}</p>
            )}
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden">
                <div className={wide ? 'grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]' : ''}>
                    {side(0, 'px-3 pb-3 pt-1')}
                    {seam}
                    {/* Room under a stacked arrow, so a long name never runs under it. */}
                    {side(1, `px-3 pb-3 ${!wide && flow !== null ? 'pt-3' : 'pt-1'}`)}
                </div>
                {block.note && (
                    <div data-compare-note className="border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 px-3 py-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                        {renderText(block.note)}
                    </div>
                )}
            </div>
            {foot && <div className="mt-1.5 empty:hidden" data-read-skip>{foot}</div>}
        </div>
    );
});

export default CompareCard;

/** A side's own Copy: its text alone, code without the card around it. */
function CopySide({ side, name }: { side: CompareSide; name: string }) {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        // `copyText`: `navigator.clipboard` is undefined over plain http,
        // which is how a phone on the LAN opens this.
        if (!await copyText(side.kind === 'code' ? side.text : sideMarkdown(side))) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };
    return (
        <IconButton
            size="sm"
            label={copied ? t("Copied!") : t("Copy {{side}}", { side: name })}
            icon={copied ? <Check className="w-4 h-4 text-green-600 dark:text-green-400" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
            onClick={copy}
        />
    );
}

/**
 * One version of a sentence with the words the other lacks marked: struck
 * and red on the wrong or earlier side, green on the fix, and one highlight
 * on both when neither is wrong. `<mark>` is announced as highlighted, so it
 * needs no words of its own.
 */
function MarkedText({ runs, mark }: { runs: DiffRun[]; mark: 'del' | 'ins' | 'mark' }) {
    const { t } = useTranslation();
    const said = mark === 'del' ? t("Removed:") : mark === 'ins' ? t("Added:") : null;
    const Tag = mark;
    const tint = mark === 'del'
        ? 'line-through decoration-red-800/70 dark:decoration-red-100/70 bg-red-100 text-red-900 dark:bg-red-500/25 dark:text-red-50'
        : mark === 'ins'
            ? 'no-underline bg-green-100 text-green-900 dark:bg-green-500/25 dark:text-green-50'
            : 'bg-amber-100 text-amber-950 dark:bg-amber-400/25 dark:text-amber-50';
    return (
        <p className="mb-0 leading-relaxed whitespace-pre-line">
            {runs.map((r, i) => r.changed ? (
                <Tag key={i} className={`rounded-sm px-0.5 ${tint}`}>
                    {said && <span className="sr-only" data-read-skip>{said} </span>}{r.text}
                </Tag>
            ) : <Fragment key={i}>{r.text}</Fragment>)}
        </p>
    );
}
