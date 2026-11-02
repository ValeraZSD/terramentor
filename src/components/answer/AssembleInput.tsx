import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
    DndContext, DragOverlay, MouseSensor, TouchSensor, pointerWithin, rectIntersection,
    useDraggable, useDroppable, useSensor, useSensors,
    type Announcements, type CollisionDetection, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { X } from 'lucide-react';
import MathText from '../MathText';
import { FOCUS_RING, cx } from '../ui/vocabulary';
import type { QuizQuestion } from '../../types';
import { arrangementsOf, foldPiece, readPieces, templateParts } from './formats';
import type { AnswerInputProps } from './AnswerInput';

/**
 * Build the answer from pieces: a sentence with its words left out, an
 * equation with its coefficients left out, a list of labels with the names
 * left out. The answer is the filled gaps as a JSON list, `null` for a gap
 * still empty, and '' while every gap is empty. The feed's "Check" waits for
 * every gap (`answerIsComplete`); a mastery check takes a part-built answer
 * as the learner's best guess.
 *
 * One way of working on every device: there is always one MARKED gap (the
 * first empty one, or the one last tapped), and tapping a piece puts it there
 * and marks the next empty gap. Tapping a filled gap takes its piece back out
 * and marks that gap, which is also how a wrong piece is replaced. A keyboard
 * works it the same way, because every gap and piece is a button in reading
 * order. Dragging is extra, for a mouse or a long press: a piece onto a gap,
 * one gap's piece onto another to swap them, or back onto the pieces.
 *
 * A piece used up leaves a plain sunken patch of its own size in the bank, so
 * nothing there moves while the answer is built. It has no outline: a dashed
 * outline is what an empty GAP looks like, and two readers took the patches
 * for more gaps to fill. A reusable bank (the digits of an equation) is never
 * used up.
 *
 * Graded: each gap is painted by whether its piece is the one the key (or the
 * nearest declared other arrangement) puts there. The bank is gone — what is
 * left to read is the learner's answer, and the key under it (`AnswerKey`).
 */
export default function AssembleInput({ question, value, onChange, disabled, result }: AnswerInputProps) {
    const { t } = useTranslation();
    const rows = useMemo(() => templateRows(question.template), [question.template]);
    const gaps = templateParts(question.template).length - 1;
    const tokens = useMemo(() => (question.tokens ?? []).filter((p): p is string => typeof p === 'string'), [question.tokens]);
    const reuse = question.reuse === true;
    const locked = !!disabled || !!result;
    const fill = useMemo(() => readFill(result ? result.answer : value, gaps), [result, value, gaps]);
    const used = useMemo(() => (reuse ? tokens.map(() => false) : usedTokens(tokens, fill)), [reuse, tokens, fill]);
    const [chosen, setChosen] = useState<number | null>(null);
    // The marked gap: the one the learner picked while it is still empty,
    // otherwise the next empty one after it. Derived, so a drag that filled
    // the marked gap moves the mark without an effect to keep in step.
    const target = locked ? null : chosen !== null && fill[chosen] === null ? chosen : nextEmpty(fill, chosen ?? 0);
    const verdicts = useMemo(() => (result ? gapVerdicts(question, fill, result.correct) : null), [question, fill, result]);

    // Focus after a keyboard press: the button pressed may have just become
    // an empty outline, and focus left on it would fall to the page.
    const nodes = useRef(new Map<string, HTMLElement>());
    const refocus = useRef<string | null>(null);
    useEffect(() => {
        if (!refocus.current) return;
        nodes.current.get(refocus.current)?.focus();
        refocus.current = null;
    });
    const remember = (id: string) => (el: HTMLElement | null) => {
        if (el) nodes.current.set(id, el); else nodes.current.delete(id);
    };

    // Said aloud after each move. Focus goes on to the next piece, so a
    // screen reader would otherwise read that piece and never where the
    // pressed one went.
    const [said, setSaid] = useState('');
    const commit = (next: (string | null)[]) => onChange(next.every(p => p === null) ? '' : JSON.stringify(next));
    const place = (piece: number, gap: number) => {
        const next = [...fill];
        next[gap] = tokens[piece];
        commit(next);
        setChosen(nextEmpty(next, gap + 1));
        setSaid(t("Gap {{n}}: {{piece}}", { n: gap + 1, piece: tokens[piece] }));
        return next;
    };
    const takeOut = (gap: number) => {
        const next = [...fill];
        next[gap] = null;
        commit(next);
        setChosen(gap);
        setSaid(t("Gap {{n}}, empty", { n: gap + 1 }));
    };

    // A drag that ends where it began fires a click on the same element;
    // that click is the end of the drag, not a tap.
    const dragging = useRef(false);
    const onPiece = (piece: number, e: MouseEvent) => {
        if (locked || dragging.current || used[piece] || target === null) return;
        const next = place(piece, target);
        if (e.detail === 0) refocus.current = afterKeyboardPlace(piece, next, tokens, reuse);
    };
    const onGap = (gap: number) => {
        if (locked || dragging.current) return;
        if (fill[gap] !== null) takeOut(gap);
        else setChosen(gap);
    };

    const sensors = useSensors(
        // A mouse drags once it moves; a finger has to press and hold, so a
        // swipe over the pieces still scrolls the feed.
        useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    );
    const [lifted, setLifted] = useState<string | null>(null);
    const onDragStart = ({ active }: DragStartEvent) => {
        dragging.current = true;
        setLifted(String(active.id));
    };
    const settle = () => {
        setLifted(null);
        setTimeout(() => { dragging.current = false; }, 0);
    };
    const onDragEnd = ({ active, over }: DragEndEvent) => {
        settle();
        const from = String(active.id);
        const to = over ? String(over.id) : null;
        if (!to || locked) return;
        if (from.startsWith('piece:')) {
            if (to.startsWith('gap:')) place(Number(from.slice(6)), Number(to.slice(4)));
            return;
        }
        const gap = Number(from.slice(5));
        if (to === 'bank') takeOut(gap);
        else if (to.startsWith('gap:') && Number(to.slice(4)) !== gap) {
            const other = Number(to.slice(4));
            const next = [...fill];
            [next[gap], next[other]] = [next[other], next[gap]];
            commit(next);
        }
    };
    const liftedText = lifted?.startsWith('piece:') ? tokens[Number(lifted.slice(6))]
        : lifted?.startsWith('fill:') ? fill[Number(lifted.slice(5))] : null;

    const sentence = (
        <TemplateFlow rows={rows} gap={i => (
            <Gap
                key={i}
                index={i}
                piece={fill[i]}
                locked={locked}
                marked={target === i}
                verdict={verdicts ? verdicts[i] : null}
                lifted={lifted === `fill:${i}`}
                nodeRef={remember(`gap:${i}`)}
                onPress={() => onGap(i)}
            />
        )} />
    );

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={underPointer}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={settle}
            // Every move is also a button press; dnd-kit's own spoken
            // commentary is in English and describes a keyboard drag this
            // component does not offer.
            accessibility={{ announcements: SILENT, screenReaderInstructions: { draggable: '' } }}
        >
            {sentence}
            <span className="sr-only" aria-live="polite">{result ? '' : said}</span>
            {!result && <Bank label={t("Pieces")}>
                {tokens.map((piece, j) => (
                    <Piece
                        key={j}
                        index={j}
                        text={piece}
                        used={used[j]}
                        idle={locked || target === null}
                        lifted={lifted === `piece:${j}`}
                        nodeRef={remember(`piece:${j}`)}
                        onPress={e => onPiece(j, e)}
                    />
                ))}
            </Bank>}
            {createPortal(
                <DragOverlay dropAnimation={null}>
                    {liftedText != null && (
                        <span className={cx(TILE, 'border-accent bg-white dark:bg-slate-900 shadow-lg cursor-grabbing')}>
                            <Words text={liftedText} />
                        </span>
                    )}
                </DragOverlay>,
                document.body,
            )}
        </DndContext>
    );
}

/** The key drawn into its template — what `AnswerKey` shows under a wrong answer. */
export function AssembledKey({ question }: { question: QuizQuestion }) {
    const key = readPieces(question.correct_answer) ?? [];
    return (
        <TemplateFlow rows={templateRows(question.template)} gap={i => (
            <span key={i} className={cx(SLOT, 'min-w-[2em]', SLOT_RIGHT)}>
                <Words text={key[i] ?? ''} />
            </span>
        )} />
    );
}

const SILENT: Announcements = {
    onDragStart: () => undefined,
    onDragOver: () => undefined,
    onDragEnd: () => undefined,
    onDragCancel: () => undefined,
};

/** Where the pointer is, then what the piece overlaps: a small gap is hit by aiming at it. */
const underPointer: CollisionDetection = args => {
    const hits = pointerWithin(args);
    return hits.length ? hits : rectIntersection(args);
};

/**
 * The template's type, and the line it is set on. A gap and the piece in it
 * take this same size, weight and colour, so an answer half built still reads
 * as one sentence, not as big boxes with small text between them. The line is
 * taller than the text, so a gap fits inside it and never pushes two lines of
 * the template apart.
 */
const FLOW = 'text-base leading-9 text-slate-700 dark:text-slate-200';
const NO_CALLOUT = 'select-none touch-manipulation [-webkit-touch-callout:none]';

/**
 * A gap: a blank on the line, as on a worksheet. A tinted slot the height of
 * the text with a rule under it, sized by the piece it holds (a little wider
 * while empty, so it reads as a place for a word). The key under a wrong
 * answer is drawn in the same slots.
 */
const SLOT = 'relative inline-flex items-baseline justify-center align-baseline max-w-full px-1 leading-6 rounded-t-md border-b-2';
/**
 * A gap's hit area reaches into the line spacing above and below. The tap
 * floor that counts on a phone is the bank's, where the frequent taps land;
 * a gap is pressed to choose it or take a piece back out.
 */
const SLOT_TARGET = cx("transition after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']", NO_CALLOUT);
// An empty gap's rule is the only edge it has, so it clears 3:1 against the card.
const SLOT_EMPTY = 'border-slate-500 dark:border-slate-400 bg-slate-100 dark:bg-slate-700/50';
const SLOT_MARKED = 'border-accent bg-accent/10';
const SLOT_FILLED = 'border-slate-300 dark:border-slate-500 bg-slate-50 dark:bg-slate-700/30';
const SLOT_RIGHT = 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/30';
const SLOT_WRONG = 'border-red-500 bg-red-50 dark:bg-red-900/30';

/**
 * A piece in the bank: a tile sized to its word, at the template's size. It
 * is drawn 40px tall; its hit area is the 44px touch floor.
 */
const TILE = cx(
    'relative inline-flex items-center justify-center max-w-full min-h-10 px-3 rounded-lg border text-base leading-6 text-slate-800 dark:text-slate-100',
    "after:absolute after:inset-x-0 after:top-1/2 after:-translate-y-1/2 after:h-[44px] after:content-['']",
    NO_CALLOUT,
);

function Gap({ index, piece, locked, marked, verdict, lifted, nodeRef, onPress }: {
    index: number; piece: string | null; locked: boolean; marked: boolean;
    verdict: 'right' | 'wrong' | null; lifted: boolean;
    nodeRef: (el: HTMLElement | null) => void; onPress: () => void;
}) {
    const { t } = useTranslation();
    const n = index + 1;
    const drop = useDroppable({ id: `gap:${index}`, disabled: locked });
    const drag = useDraggable({ id: `fill:${index}`, disabled: locked || piece === null });
    const label = piece === null
        ? (marked ? t("Gap {{n}}, empty, next piece goes here", { n }) : t("Gap {{n}}, empty", { n }))
        : verdict === 'right' ? t("Gap {{n}}: {{piece}}, right", { n, piece })
        : verdict === 'wrong' ? t("Gap {{n}}: {{piece}}, wrong", { n, piece })
        : locked ? t("Gap {{n}}: {{piece}}", { n, piece }) : t("Gap {{n}}: {{piece}}. Press to take it out", { n, piece });
    return (
        <button data-assemble="gap"
            type="button"
            ref={el => { drop.setNodeRef(el); drag.setNodeRef(el); nodeRef(el); }}
            {...(locked ? {} : drag.listeners)}
            onClick={onPress}
            disabled={locked}
            aria-label={label}
            className={cx(
                SLOT,
                SLOT_TARGET,
                'disabled:cursor-default',
                FOCUS_RING,
                piece === null ? 'min-w-[3em]' : 'min-w-[2em]',
                verdict === 'right' && SLOT_RIGHT,
                verdict === 'wrong' && SLOT_WRONG,
                !verdict && marked && SLOT_MARKED,
                !verdict && !marked && piece === null && SLOT_EMPTY,
                !verdict && piece !== null && cx(SLOT_FILLED, 'can-hover:hover:border-accent/60'),
                !locked && piece !== null && 'cursor-grab',
                lifted && 'opacity-40',
            )}
        >
            {/* An empty slot holds an invisible letter, so it sits on the
                line's baseline like a filled one instead of on its bottom edge. */}
            {piece !== null ? <Words text={piece} /> : <span aria-hidden className="invisible">x</span>}
            {/* Wrong is not told by colour alone. A badge on the corner, raised
                clear of the word, so grading does not widen the gap and reflow
                the line. */}
            {verdict === 'wrong' && (
                <span aria-hidden className="absolute -top-2.5 -right-2 flex items-center justify-center w-3.5 h-3.5 rounded-full bg-red-500 text-white ring-2 ring-white dark:ring-slate-800">
                    <X className="w-2.5 h-2.5" strokeWidth={3.5} />
                </span>
            )}
        </button>
    );
}

function Piece({ index, text, used, idle, lifted, nodeRef, onPress }: {
    index: number; text: string; used: boolean; idle: boolean; lifted: boolean;
    nodeRef: (el: HTMLElement | null) => void; onPress: (e: MouseEvent) => void;
}) {
    const drag = useDraggable({ id: `piece:${index}`, disabled: used || idle });
    return (
        <button data-assemble="piece"
            type="button"
            ref={el => { drag.setNodeRef(el); nodeRef(el); }}
            {...(used || idle ? {} : drag.listeners)}
            onClick={onPress}
            disabled={used || idle}
            aria-hidden={used || undefined}
            tabIndex={used ? -1 : undefined}
            className={cx(
                TILE,
                'transition disabled:cursor-default',
                FOCUS_RING,
                // A used piece leaves a faint patch of its own size: the bank
                // does not reflow, and the patch is quieter than any tile.
                used
                    ? 'border-transparent bg-slate-100/70 dark:bg-slate-700/20'
                    : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700/50 shadow-sm can-hover:hover:border-accent/60 can-hover:hover:bg-accent/5 cursor-grab',
                // A full answer leaves nowhere for a piece to go: the bank
                // steps back until a gap is emptied again.
                !used && idle && 'opacity-50 cursor-default',
                lifted && 'opacity-40',
            )}
        >
            {/* An outline keeps its piece's width without showing the piece. */}
            <span className={used ? 'invisible' : undefined}><Words text={text} /></span>
        </button>
    );
}

function Bank({ label, children }: { label: string; children: ReactNode }) {
    const { setNodeRef } = useDroppable({ id: 'bank' });
    return (
        <div ref={setNodeRef} role="group" aria-label={label} className="mt-4 flex flex-wrap gap-2 min-h-10">
            {children}
        </div>
    );
}

/** The template's text with a node at each gap, one block per line of the template. */
function TemplateFlow({ rows, gap }: { rows: Bit[][]; gap: (index: number) => ReactNode }) {
    return (
        <div className={FLOW}>
            {rows.map((row, r) => (
                <div key={r}>
                    {row.map((bit, b) => bit.kind === 'gap' ? gap(bit.index) : <Words key={`t${b}`} text={bit.text} spaced />)}
                </div>
            ))}
        </div>
    );
}

/**
 * Text between gaps, and a piece. Only text that carries maths goes through
 * `MathText`: it is Markdown, and a stretch like " + " between two gaps would
 * be read as a list marker. The spaces either side are kept outside it,
 * because Markdown trims them and "omdat___" would run into its gap.
 */
function Words({ text, spaced = false }: { text: string; spaced?: boolean }) {
    const core = text.trim();
    const lead = spaced && /^\s/.test(text) ? ' ' : '';
    const tail = spaced && core && /\s$/.test(text) ? ' ' : '';
    if (!core) return <>{lead}</>;
    return <>{lead}{/[$\\]/.test(core) ? <MathText content={core} /> : core}{tail}</>;
}

type Bit = { kind: 'text'; text: string } | { kind: 'gap'; index: number };

/** Lines of the template, each a run of text and gaps. */
export function templateRows(template: string | null | undefined): Bit[][] {
    const parts = templateParts(String(template ?? '').replace(/\r/g, ''));
    const rows: Bit[][] = [[]];
    parts.forEach((part, i) => {
        part.split('\n').forEach((line, j) => {
            if (j > 0) rows.push([]);
            if (line) rows[rows.length - 1].push({ kind: 'text', text: line });
        });
        if (i < parts.length - 1) rows[rows.length - 1].push({ kind: 'gap', index: i });
    });
    return rows.filter(row => row.length > 0);
}

/** The stored answer as one entry per gap; anything unreadable is an empty answer. */
function readFill(value: string, gaps: number): (string | null)[] {
    const read = value ? readPieces(value, { holes: true }) : null;
    return read && read.length === gaps ? read : Array.from({ length: gaps }, () => null);
}

/** Which bank pieces the answer has taken: each placed piece uses up the first unused copy of itself. */
function usedTokens(tokens: string[], fill: (string | null)[]): boolean[] {
    const used = tokens.map(() => false);
    for (const p of fill) {
        if (p === null) continue;
        const j = tokens.findIndex((t, k) => !used[k] && foldPiece(t) === foldPiece(p));
        if (j >= 0) used[j] = true;
    }
    return used;
}

/** The first empty gap at or after `from`, wrapping round; null when the answer is full. */
function nextEmpty(fill: (string | null)[], from: number): number | null {
    for (let k = 0; k < fill.length; k++) {
        const i = (from + k) % fill.length;
        if (fill[i] === null) return i;
    }
    return null;
}

/**
 * Where a keyboard user is put after placing piece `j`: the next piece still
 * in the bank (then the one before it), or — once every gap is filled and the
 * bank has stepped back — the last gap, the end of what they built.
 */
function afterKeyboardPlace(j: number, next: (string | null)[], tokens: string[], reuse: boolean): string {
    if (nextEmpty(next, 0) === null) return `gap:${next.length - 1}`;
    if (reuse) return `piece:${j}`;
    // Read from the answer as it now stands, not from before the press: with
    // two pieces of the same text the copy used up is the first one, which
    // need not be the one pressed, and focus sent to it would fall to the page.
    const free = usedTokens(tokens, next).map(u => !u);
    const after = free.findIndex((f, k) => f && k > j);
    const before = free.lastIndexOf(true);
    return `piece:${after >= 0 ? after : before >= 0 ? before : j}`;
}

/**
 * Right or wrong per gap. A right answer is right everywhere (it may be a
 * declared other arrangement, not the key). A wrong one is compared with the
 * arrangement it is closest to, so a learner who built the second accepted
 * order with one slip is shown that slip, not a row of red.
 */
function gapVerdicts(question: QuizQuestion, fill: (string | null)[], correct: boolean): ('right' | 'wrong')[] {
    if (correct) return fill.map(() => 'right');
    const same = (a: string | null, b: string) => a !== null && foldPiece(a) === foldPiece(b);
    let best: string[] | null = null;
    let bestScore = -1;
    for (const arrangement of arrangementsOf(question)) {
        const score = arrangement.filter((p, i) => same(fill[i] ?? null, p)).length;
        if (score > bestScore) { best = arrangement; bestScore = score; }
    }
    return fill.map((p, i) => (best && same(p, best[i] ?? '') ? 'right' : 'wrong'));
}
