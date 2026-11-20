import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
    DndContext, DragEndEvent, DragOverEvent, DragOverlay, DragStartEvent, MeasuringStrategy, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors,
} from '@dnd-kit/core';
import {
    SortableContext, verticalListSortingStrategy, useSortable, arrayMove, sortableKeyboardCoordinates, type SortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import MathText from '../MathText';
import { IconButton } from '../ui/Button';
import { FOCUS_RING, cx } from '../ui/vocabulary';
import { useCanHover } from '../../utils/platform';
import { parseSequence } from './formats';
import { sequenceAsTiles } from './choiceLayout';
import type { AnswerInputProps } from './AnswerInput';

/** Tiles stay where they are while one is dragged (see `Tile`). */
const noShift: SortingStrategy = () => null;

/**
 * Put the items in order. The answer is the current order, as JSON, and it
 * exists from the first render — an untouched list is an answer too (the
 * served order is never the key, the server guarantees that), and there is no
 * "you have not answered" state to explain.
 *
 * Two ways to move a row, both always visible: drag by the handle (pointer or
 * keyboard through dnd-kit's sortable keyboard sensor), or the up/down pair —
 * which is the whole interface on a phone, where a drag inside a scrolling
 * feed fights the scroll. Hover reveals nothing here.
 *
 * Graded: each row is painted by whether it sits in its right place. The
 * correct order itself is shown by the verdict margin (`AnswerKey`), so the
 * learner sees both their order and the key, not one overwriting the other.
 *
 * Short items (`sequenceAsTiles`: a sentence's parts, dates, numbers) are
 * tiles in one wrapping line instead, read left to right like the answer
 * itself: five words in five full-width rows were a sentence spread down the
 * screen. Tiles only with a mouse (`Tile` says how one moves). Without a
 * mouse the up/down pair is the interface, and a tile wide enough to carry it
 * fits one to a phone's row, so a phone keeps the list. One layout per device
 * in every state, so Check moves nothing.
 */
export default function SequenceInput({ question, value, onChange, disabled, result }: AnswerInputProps) {
    const { t } = useTranslation();
    const locked = disabled || !!result;
    const order = useMemo(() => {
        const recorded = result ? parseSequence(result.answer) : null;
        return recorded ?? parseSequence(value) ?? (question.items ?? []);
    }, [question.items, value, result]);
    const key = useMemo(() => (result ? parseSequence(question.correct_answer) : null), [question.correct_answer, result]);
    const tiles = useCanHover() && sequenceAsTiles(order);
    // Tiles only: the one being dragged (drawn by the overlay), the order the
    // row shows while it is (where the drop would put it; the answer changes
    // only on the drop), and the one picked by a click, waiting for the click
    // that says where it goes.
    const [held, setHeld] = useState<string | null>(null);
    const [preview, setPreview] = useState<string[] | null>(null);
    const [picked, setPicked] = useState<string | null>(null);
    const shown = tiles && preview ? preview : order;

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );

    const commit = (next: string[]) => onChange(JSON.stringify(next));
    const move = (from: number, to: number) => {
        if (locked || from < 0 || to < 0 || to >= order.length) return;
        commit(arrayMove(order, from, to));
    };
    const onDragStart = ({ active }: DragStartEvent) => { setHeld(String(active.id)); setPreview(order); setPicked(null); };
    const onDragOver = ({ active, over }: DragOverEvent) => {
        if (!over || active.id === over.id) return;
        setPreview(prev => {
            const now = prev ?? order;
            const from = now.indexOf(String(active.id)), to = now.indexOf(String(over.id));
            return from < 0 || to < 0 ? now : arrayMove(now, from, to);
        });
    };
    const settle = () => { setHeld(null); setPreview(null); };
    const onDragEnd = ({ active, over }: DragEndEvent) => {
        if (tiles) {
            if (!locked && preview && preview.some((item, i) => item !== order[i])) commit(preview);
            settle();
            return;
        }
        if (locked || !over || active.id === over.id) return;
        move(order.indexOf(String(active.id)), order.indexOf(String(over.id)));
    };
    const onPick = (item: string) => {
        if (locked) return;
        if (picked === null || !order.includes(picked)) setPicked(item);
        else if (picked === item) setPicked(null);
        else { move(order.indexOf(picked), order.indexOf(item)); setPicked(null); }
    };

    return (
        <DndContext sensors={sensors} collisionDetection={closestCenter}
            measuring={tiles ? { droppable: { strategy: MeasuringStrategy.Always } } : undefined}
            onDragStart={tiles ? onDragStart : undefined} onDragOver={tiles ? onDragOver : undefined}
            onDragEnd={onDragEnd} onDragCancel={settle}>
            <SortableContext items={shown} strategy={tiles ? noShift : verticalListSortingStrategy}>
                <ol className={tiles ? 'flex flex-wrap gap-2' : 'space-y-2'} aria-label={t("Your order")}>
                    {shown.map((item, i) => {
                        const verdict = key ? (key[i]?.trim() === item.trim() ? 'right' : 'wrong') : null;
                        return tiles ? (
                            <Tile key={item} item={item} index={i} locked={locked} verdict={verdict}
                                picked={picked === item} onPick={() => onPick(item)} />
                        ) : (
                            <Row
                                key={item}
                                item={item}
                                index={i}
                                count={order.length}
                                locked={locked}
                                verdict={verdict}
                                onUp={() => move(i, i - 1)}
                                onDown={() => move(i, i + 1)}
                            />
                        );
                    })}
                </ol>
            </SortableContext>
            {tiles && createPortal(
                <DragOverlay dropAnimation={null}>
                    {held !== null && (
                        <span className={cx(TILE, 'border-accent bg-white dark:bg-slate-900 shadow-lg cursor-grabbing')}>
                            <TileFace item={held} />
                        </span>
                    )}
                </DragOverlay>,
                document.body,
            )}
        </DndContext>
    );
}

function Row({ item, index, count, locked, verdict, onUp, onDown }: {
    item: string; index: number; count: number; locked: boolean;
    verdict: 'right' | 'wrong' | null; onUp: () => void; onDown: () => void;
}) {
    const { t } = useTranslation();
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item, disabled: locked });
    const style = { transform: CSS.Transform.toString(transform), transition };
    return (
        <li
            ref={setNodeRef}
            style={style}
            className={cx(
                'flex items-center gap-2 pl-2 pr-1 py-1 rounded-xl border-2 bg-white dark:bg-slate-900 text-sm text-slate-700 dark:text-slate-200',
                // Held: lifted, solid and above the rows it passes (later in the DOM);
                // at half opacity the row underneath showed through its text.
                isDragging && 'relative z-10 shadow-lg',
                verdict === 'right' && 'border-emerald-400 dark:border-emerald-600 bg-emerald-50 dark:bg-emerald-900/20',
                verdict === 'wrong' && 'border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-900/20',
                !verdict && 'border-slate-200 dark:border-slate-600',
            )}
        >
            {locked ? (
                <span className="w-6 shrink-0 text-center text-xs tabular-nums text-slate-500 dark:text-slate-400" aria-hidden="true">{index + 1}</span>
            ) : (
                <button data-drag-handle
                    type="button"
                    {...attributes}
                    {...listeners}
                    aria-label={t("Drag to move step {{n}}", { n: index + 1 })}
                    className="flex items-center justify-center w-6 min-h-11 shrink-0 cursor-grab active:cursor-grabbing text-slate-500 dark:text-slate-400 touch-none rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                    <GripVertical className="w-4 h-4" aria-hidden="true" />
                </button>
            )}
            <span className="flex-1 min-w-0 py-1.5"><MathText content={item} /></span>
            {!locked && (
                // Side by side, not stacked: two stacked 44px targets made every
                // row 90px tall on a phone, and four steps filled the screen.
                <span className="flex shrink-0">
                    <IconButton size="sm" variant="quiet" tooltip={false} label={t("Move up")} disabled={index === 0}
                        icon={<ChevronUp className="w-4 h-4" aria-hidden="true" />} onClick={onUp} />
                    <IconButton size="sm" variant="quiet" tooltip={false} label={t("Move down")} disabled={index === count - 1}
                        icon={<ChevronDown className="w-4 h-4" aria-hidden="true" />} onClick={onDown} />
                </span>
            )}
        </li>
    );
}

/** A tile is 44px tall in every state, so Check moves nothing. */
const TILE = 'inline-flex items-center gap-1 min-h-11 pl-1 pr-3 rounded-xl border-2 text-sm text-slate-700 dark:text-slate-200 whitespace-nowrap';

function TileFace({ item, index }: { item: string; index?: number }) {
    return (
        <>
            {index === undefined
                ? <GripVertical className="w-6 h-4 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                : <span className="w-6 shrink-0 text-center text-xs tabular-nums text-slate-500 dark:text-slate-400" aria-hidden="true">{index + 1}</span>}
            <MathText content={item} />
        </>
    );
}

/**
 * One item of a short ordering, as a tile sized to its word. The whole tile
 * is the control, and it moves three ways:
 * - dragged with the mouse: the overlay follows the pointer and a faded copy
 *   stands where the drop would put it, the row reflowing around it, so the
 *   sentence reads in its new order before the drop. The answer changes once,
 *   on the drop; Escape puts the row back. (Sliding tiles by transform, as
 *   the list does, overlaps tiles of different widths.)
 * - clicked, then another clicked: it takes that tile's place (a pointer
 *   alternative to dragging, WCAG 2.5.7);
 * - from the keyboard: Space lifts it, the arrows carry it, Space drops it.
 */
function Tile({ item, index, locked, verdict, picked, onPick }: {
    item: string; index: number; locked: boolean; verdict: 'right' | 'wrong' | null;
    picked: boolean; onPick: () => void;
}) {
    const { attributes, listeners, setNodeRef, isDragging } = useSortable({ id: item, disabled: locked });
    if (locked) {
        return (
            <li ref={setNodeRef} className={cx(TILE,
                verdict === 'right' && 'border-emerald-400 dark:border-emerald-600 bg-emerald-50 dark:bg-emerald-900/20',
                verdict === 'wrong' && 'border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-900/20',
                !verdict && 'border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900',
            )}>
                <TileFace item={item} index={index} />
            </li>
        );
    }
    return (
        <li ref={setNodeRef} className="flex">
            <button data-order-tile
                type="button"
                {...attributes}
                {...listeners}
                onClick={onPick}
                aria-pressed={picked}
                className={cx(TILE, 'transition cursor-grab select-none touch-none', FOCUS_RING,
                    picked || isDragging
                        ? 'border-dashed border-accent bg-accent/10'
                        : 'border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 can-hover:hover:border-accent/60',
                    isDragging && 'opacity-40',
                )}
            >
                <TileFace item={item} />
            </button>
        </li>
    );
}
