import { useState } from 'react';
import { FOCUS_RING } from './ui/vocabulary';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStore } from '../store';
import { isLeafNode, leafStatus, nextLeafStatus } from '../utils/tree';
import { useCanHover } from '../utils/platform';
import DropdownMenu from './DropdownMenu';
import Modal from './Modal';
import type { FlatItem } from '../utils/treeDnd';
import { useDropFlash } from '../hooks/useDropFlash';
import { useSiblingMove } from '../hooks/useDragA11y';
import {
    Circle, Clock, CheckCircle, Plus, Trash2, ChevronRight, ChevronDown,
    FileText, GripVertical, MoreVertical, MinusCircle, SkipForward, CornerDownRight, BookOpen, ArrowUp, ArrowDown,
} from 'lucide-react';
import HeadStartMark from './HeadStartMark';
import { useTranslation } from 'react-i18next';
import { Button, IconButton } from './ui/Button';
import { TextInput } from './ui/Field';
import { MenuItem } from './ui/Popover';

interface Props {
    item: FlatItem;
    projectedDepth: number | null;
    isActive: boolean;
    /** True when the dragged row would nest inside THIS item (highlight it). */
    isDropParent?: boolean;
    /** On the dragged row only: title of the item it will nest inside, or null for top level. */
    dropParentTitle?: string | null;
    /** The category card this row is drawn in; the board's one drag context finds a card's rows by it. */
    cardId: number;
}

export default function TreeItemRow({ item, projectedDepth, isActive, isDropParent, dropParentTitle, cardId }: Props) {
    const { t } = useTranslation();
    const { node } = item;
    const selectNode = useStore((s) => s.selectNode);
    const selectedNodeId = useStore((s) => s.selectedNodeId);
    const updateNode = useStore((s) => s.updateNode);
    const createNode = useStore((s) => s.createNode);
    const deleteNode = useStore((s) => s.deleteNode);
    const expanded = useStore((s) => s.expanded);
    const toggleExpanded = useStore((s) => s.toggleExpanded);
    const setExpanded = useStore((s) => s.setExpanded);
    const showConfirm = useStore((s) => s.showConfirm);
    const skipNode = useStore((s) => s.skipNode);

    const [showAddModal, setShowAddModal] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [isHovered, setIsHovered] = useState(false);
    // `onMouseEnter` never fires on a touchscreen, so gating the drag handle and
    // the ⋮ menu on `isHovered` alone hid them permanently there — Skip topic,
    // Add child and Delete were unreachable on a phone. Reveal them outright
    // wherever hovering isn't possible.
    const hoverCapable = useCanHover();
    // Revealed by the pointer, and by the keyboard too: a Tab into the row's
    // title must not leave its drag handle and ⋮ menu invisible. Nor may the
    // ⋮ vanish while its menu is open: the menu is portalled, so focus on its
    // rows is no longer within the row.
    const rowControls = !hoverCapable || isHovered ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100';

    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: node.id, data: { kind: 'row', cardId } });
    const style = { transform: CSS.Translate.toString(transform), transition };
    const flash = useDropFlash(`node:${node.id}`);

    // Two different questions: `hasChildren` drives the expand chevron (notes
    // are children you still want to unfold), while leafness — the status
    // cycle and the rollup icon — counts only structural (non-note) children.
    const hasChildren = node.children.length > 0;
    const studyNode = useStore(s => s.studyNode);
    const currentProjectId = useStore(s => s.currentProjectId);
    const move = useSiblingMove(node);
    const isLeaf = isLeafNode(node);
    const isNote = !!node.is_note;
    const isExpanded = expanded[node.id] ?? true;

    // While dragged, this row IS the snap-in-place placeholder: shown exactly
    // where, and at the nesting depth, it will land. `style` carries the
    // sortable's VERTICAL snap transform (so it moves to the target slot as you
    // drag). That transform is the sorting displacement, not a pointer-follow,
    // ONLY because an (invisible) DragOverlay is mounted; without one dnd-kit
    // would make this node chase the cursor and stretch the container.
    // It is the row's own markup, ringed, with its badge and its ⋮ hidden (the
    // height kept, so the row's): a separate ghost drew the title
    // 48 px left of where it lands and 11 px shorter, and the row jumped on
    // release. With no projection yet, or while held over a card that shows no
    // rows, it stands at its own depth with no badge, still ringed.
    const held = isActive || isDragging;

    const cycleStatus = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!isLeaf) return;
        // Shift-click is a shortcut to mark a topic "skipped".
        if (e.shiftKey) {
            await skipNode(node.id);
            return;
        }
        await updateNode(node.id, { status: nextLeafStatus(node) });
    };

    const handleAddChild = async () => {
        if (!newTitle.trim()) return;
        await createNode({ title: newTitle, parent_id: node.id });
        if (!expanded[node.id]) setExpanded(node.id, true);
        setShowAddModal(false);
        setNewTitle('');
    };

    const handleDelete = async () => {
        const confirmed = await showConfirm({
            title: t("Delete Item"),
            message: t("Delete \"{{title}}\"? This action cannot be undone.", { title: node.title }),
            confirmLabel: t("Delete"),
            variant: 'danger',
        });
        if (!confirmed) return;
        await deleteNode(node.id);
    };

    const getStatusIcon = () => {
        if (isNote) return <FileText className="w-4 h-4 text-slate-500 dark:text-slate-400" />;
        if (!isLeaf) {
            const progress = node.progress?.percentage || 0;
            // The course tree's percentage colours: text, so 4.5:1 in both themes.
            const color = progress === 100 ? 'text-green-600 dark:text-green-400' : progress > 0 ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400';
            return <span className={`text-xs font-medium ${color}`}>{progress}%</span>;
        }
        switch (leafStatus(node)) {
            case 'completed': return <CheckCircle className="w-4 h-4 text-green-500" />;
            case 'skipped': return <MinusCircle className="w-4 h-4 text-slate-500 dark:text-slate-400" />;
            case 'in_progress': return <Clock className="w-4 h-4 text-blue-500" />;
            default: return <Circle className="w-4 h-4 text-slate-400 dark:text-slate-500" />;
        }
    };

    const displayDepth = held ? projectedDepth ?? item.depth : item.depth;
    // The whole row is what a pointer drags (`rowDrag`): a mouse once it has
    // moved 5px, a finger after the press-and-hold. The grip stays for a
    // keyboard and shows only while focused: a grip in every row, 44px with
    // the larger setting, took width from every title (hidden under a mouse,
    // it still held its slot).
    const rowDrag = {
        onMouseDown: listeners?.onMouseDown as React.MouseEventHandler | undefined,
        onTouchStart: listeners?.onTouchStart as React.TouchEventHandler | undefined,
    };
    const handle = (
        <button data-drag-handle
            type="button"
            {...attributes}
            {...listeners}
            onClick={(e) => e.stopPropagation()}
            aria-label={t("Drag to reorder")}
            className={`shrink-0 cursor-grab active:cursor-grabbing touch-pan-y sr-only focus-visible:not-sr-only focus-visible:p-0.5 ${held ? 'text-accent' : 'text-slate-500 dark:text-slate-400'}`}
        >
            <GripVertical className="w-3.5 h-3.5" />
        </button>
    );
    // 24px to press (WCAG 2.5.8) around a 16px icon, centred on its 20px
    // column: the 2px it spills each side stays inside the row's padding and
    // its 6px gap; the row owns the height.
    const statusButton = (
        <button
            data-row-status
            type="button"
            onClick={cycleStatus}
            aria-label={isLeaf ? t("Cycle status of {{title}}", { title: node.title }) : undefined}
            title={isLeaf && hoverCapable ? t("Click to cycle status · Shift-click to skip") : undefined}
            className={`shrink-0 -my-1 p-1 rounded ${isLeaf ? 'cursor-pointer hover:scale-110 transition-transform' : ''}`}
            disabled={!isLeaf}
        >
            {getStatusIcon()}
        </button>
    );


    return (
        <>
            <div
                ref={setNodeRef}
                style={{ ...style, ...flash?.style, paddingLeft: `calc(min(${displayDepth} * var(--row-indent-outline), max(0px, 100% - var(--row-outline-reserve))) + var(--row-outline-start))` }}
                {...rowDrag}
                data-depth={displayDepth}
                data-tree-item-id={node.id}
                data-node-id={node.id}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
                // The row is a click target for the pointer, not a control: as
                // a button role holding the drag, expand, status and ⋮ buttons
                // it was buttons inside a button. The title below is the control.
                onClick={() => selectNode(node.id)}
                className={`group flex items-center gap-1.5 px-2 py-1.5 rounded-lg ${hoverCapable ? '' : 'select-none [-webkit-touch-callout:none]'} ${flash?.className ?? ''} ${held
                    ? 'drag-ring bg-accent/10'
                    : `cursor-pointer transition-colors ${isDropParent
                        ? 'drop-target -outline-offset-2 bg-accent/10'
                        : selectedNodeId === node.id
                            ? 'bg-accent/20'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'}`
                    }`}
            >
                {/* One column before the title, as in the course tree: the fold
                    chevron on a row with rows under it, the status mark on one
                    without. Each level is indented by the column and its gap. */}
                {hasChildren ? (
                    <button data-row-fold
                        type="button"
                        onClick={(e) => { e.stopPropagation(); toggleExpanded(node.id); }}
                        aria-label={t("Topics under {{title}}", { title: node.title })}
                        aria-expanded={isExpanded}
                        className="w-5 flex items-center justify-center py-0.5 hover:bg-slate-200 dark:hover:bg-slate-600 rounded shrink-0"
                    >
                        {isExpanded
                            ? <ChevronDown data-row-chevron className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                            : <ChevronRight data-row-chevron className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />}
                    </button>
                ) : (
                    <span data-fold-spacer className="w-5 shrink-0 flex items-center justify-center">
                        {statusButton}
                    </span>
                )}
                <button data-row="title"
                    type="button"
                    onClick={(e) => { e.stopPropagation(); selectNode(node.id); }}
                    data-larger-wraps
                    aria-current={selectedNodeId === node.id ? 'true' : undefined}
                    className={`flex-1 min-w-0 -mx-1 px-1 text-left text-sm truncate rounded ${FOCUS_RING} ${held || selectedNodeId === node.id ? 'font-medium text-accent-fg' : 'text-slate-700 dark:text-slate-200'}`}
                >
                    {node.title}
                </button>
                {isLeaf && <HeadStartMark node={node} />}
                {held && projectedDepth !== null && (
                    <span className="shrink-0 text-2xs font-medium text-white bg-accent px-1.5 py-0.5 rounded-full whitespace-nowrap shadow-sm flex items-center gap-1 max-w-[40%]">
                        {dropParentTitle ? (
                            <>
                                <CornerDownRight className="w-3 h-3 shrink-0" />
                                <span className="truncate">{t("Inside {{dropParentTitle}}", { dropParentTitle })}</span>
                            </>
                        ) : (
                            t("Top level")
                        )}
                    </span>
                )}
                {/* A row with rows under it: what is done at the row's end, as
                    the card's ring and the course tree show it. A topic whose
                    only children are notes is still a topic: its status mark,
                    pressable, goes there too. */}
                {hasChildren && (isLeaf ? statusButton : (
                    <span data-row-progress className="shrink-0 ml-1" aria-hidden="true">{getStatusIcon()}</span>
                ))}
                {handle}
                {/* Held, the ⋮ keeps only its height (the row's, on a phone too) and gives its width to the title. */}
                <div className={`flex items-center transition-opacity ${held ? 'invisible w-0 overflow-hidden' : rowControls}`}>
                    <DropdownMenu
                        /* A 14px glyph: the row is 32px tall and a bigger glyph
                           would shout. The TARGET is the vocabulary's `sm`
                           square, which grows to the touch floor on a phone,
                           where this menu is where "Study this topic" lives. */
                        trigger={<IconButton size="sm" tooltip={false} label={t("Actions for {{title}}", { title: node.title })} icon={<MoreVertical className="w-3.5 h-3.5" />} />}
                    >
                        {!node.is_note && currentProjectId != null && (
                            <MenuItem onSelect={() => studyNode(currentProjectId, node.id)} icon={<BookOpen className="w-4 h-4" />}>
                                {isLeaf ? t("Study this topic") : t("Study this section")}
                            </MenuItem>
                        )}
                        <MenuItem onSelect={() => setShowAddModal(true)} icon={<Plus className="w-4 h-4" />}>
                            {t("Add Child")}
                        </MenuItem>
                        {isLeaf && node.status !== 'skipped' && (
                            <MenuItem onSelect={() => skipNode(node.id)} icon={<SkipForward className="w-4 h-4" />}>
                                {t("Skip topic")}
                            </MenuItem>
                        )}
                        {move.up && (
                            <MenuItem onSelect={move.up} icon={<ArrowUp className="w-4 h-4" />}>
                                {t("Move up")}
                            </MenuItem>
                        )}
                        {move.down && (
                            <MenuItem onSelect={move.down} icon={<ArrowDown className="w-4 h-4" />}>
                                {t("Move down")}
                            </MenuItem>
                        )}
                        <MenuItem tone="danger" onSelect={handleDelete} icon={<Trash2 className="w-4 h-4" />}>
                            {t("Delete")}
                        </MenuItem>
                    </DropdownMenu>
                </div>
            </div>

            <Modal isOpen={showAddModal} onClose={() => setShowAddModal(false)} title={t("Add Child Item")} footer={<>
                <Button variant="quiet" onClick={() => setShowAddModal(false)}>{t("Cancel")}</Button>
                <Button variant="primary" onClick={handleAddChild} disabled={!newTitle.trim()}>{t("Add")}</Button>
            </>}>
                <TextInput
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder={t("Item title…")}
                    autoFocus
                    onKeyDown={(e) => e.key === 'Enter' && handleAddChild()}
                />
            </Modal>
        </>
    );
}