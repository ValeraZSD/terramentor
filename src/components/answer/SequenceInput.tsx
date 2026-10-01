import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
    DndContext, DragEndEvent, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import MathText from '../MathText';
import { IconButton } from '../ui/Button';
import { cx } from '../ui/vocabulary';
import { parseSequence } from './formats';
import type { AnswerInputProps } from './AnswerInput';

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
 */
export default function SequenceInput({ question, value, onChange, disabled, result }: AnswerInputProps) {
    const { t } = useTranslation();
    const locked = disabled || !!result;
    const order = useMemo(() => {
        const recorded = result ? parseSequence(result.answer) : null;
        return recorded ?? parseSequence(value) ?? (question.items ?? []);
    }, [question.items, value, result]);
    const key = useMemo(() => (result ? parseSequence(question.correct_answer) : null), [question.correct_answer, result]);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );

    const commit = (next: string[]) => onChange(JSON.stringify(next));
    const move = (from: number, to: number) => {
        if (locked || to < 0 || to >= order.length) return;
        commit(arrayMove(order, from, to));
    };
    const onDragEnd = ({ active, over }: DragEndEvent) => {
        if (locked || !over || active.id === over.id) return;
        move(order.indexOf(String(active.id)), order.indexOf(String(over.id)));
    };

    return (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={order} strategy={verticalListSortingStrategy}>
                <ol className="space-y-2" aria-label={t("Your order")}>
                    {order.map((item, i) => (
                        <Row
                            key={item}
                            item={item}
                            index={i}
                            count={order.length}
                            locked={locked}
                            verdict={key ? (key[i]?.trim() === item.trim() ? 'right' : 'wrong') : null}
                            onUp={() => move(i, i - 1)}
                            onDown={() => move(i, i + 1)}
                        />
                    ))}
                </ol>
            </SortableContext>
        </DndContext>
    );
}

function Row({ item, index, count, locked, verdict, onUp, onDown }: {
    item: string; index: number; count: number; locked: boolean;
    verdict: 'right' | 'wrong' | null; onUp: () => void; onDown: () => void;
}) {
    const { t } = useTranslation();
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item, disabled: locked });
    const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
    return (
        <li
            ref={setNodeRef}
            style={style}
            className={cx(
                'flex items-center gap-2 pl-2 pr-1 py-1 rounded-xl border-2 bg-white dark:bg-slate-900 text-sm text-slate-700 dark:text-slate-200',
                verdict === 'right' && 'border-emerald-400 dark:border-emerald-600 bg-emerald-50 dark:bg-emerald-900/20',
                verdict === 'wrong' && 'border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-900/20',
                !verdict && 'border-slate-200 dark:border-slate-600',
            )}
        >
            {locked ? (
                <span className="w-6 shrink-0 text-center text-xs tabular-nums text-slate-500 dark:text-slate-400" aria-hidden="true">{index + 1}</span>
            ) : (
                <button
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
