import { useState } from 'react';
import { onActivateKey } from '../utils/a11y';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStore } from '../store';
import { isLeafNode } from '../utils/tree';
import { useCanHover } from '../utils/platform';
import DropdownMenu from './DropdownMenu';
import Modal from './Modal';
import type { FlatItem } from '../utils/treeDnd';
import {
    Circle, Clock, CheckCircle, Plus, Trash2, ChevronRight, ChevronDown,
    FileText, GripVertical, MoreVertical, MinusCircle, SkipForward, CornerDownRight, BookOpen,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
    item: FlatItem;
    projectedDepth: number | null;
    isActive: boolean;
    indentationWidth: number;
    /** True when the dragged row would nest inside THIS item (highlight it). */
    isDropParent?: boolean;
    /** On the dragged row only: title of the item it will nest inside, or null for top level. */
    dropParentTitle?: string | null;
}

export default function TreeItemRow({ item, projectedDepth, isActive, indentationWidth, isDropParent, dropParentTitle }: Props) {
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
    const rowControls = !hoverCapable || isHovered ? 'opacity-100' : 'opacity-0';

    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: node.id });
    const style = { transform: CSS.Translate.toString(transform), transition };

    // Two different questions: `hasChildren` drives the expand chevron (notes
    // are children you still want to unfold), while leafness — the status
    // cycle and the rollup icon — counts only structural (non-note) children.
    const hasChildren = node.children.length > 0;
    const studyNode = useStore(s => s.studyNode);
    const currentProjectId = useStore(s => s.currentProjectId);
    const isLeaf = isLeafNode(node);
    const isNote = !!node.is_note;
    const isExpanded = expanded[node.id] ?? true;

    if (isActive && projectedDepth !== null) {
        // Snap-in-place placeholder: a ghost of the row shown exactly where — and
        // at the nesting depth — it will land. `style` carries the sortable's
        // VERTICAL snap transform (so it moves to the target slot as you drag).
        // That transform is the sorting displacement — not a pointer-follow —
        // ONLY because an (invisible) DragOverlay is mounted; without one dnd-kit
        // would make this node chase the cursor and stretch the container.
        return (
            <div ref={setNodeRef} style={style}>
                <div style={{ paddingLeft: `${projectedDepth * indentationWidth}px` }}>
                    <div className="flex items-center gap-1.5 px-2 py-1.5 my-0.5 rounded-lg border-2 border-dashed border-accent bg-accent/10">
                        <GripVertical className="w-3.5 h-3.5 text-accent shrink-0" />
                        <span className="flex-1 text-sm font-medium text-accent-fg truncate">{node.title}</span>
                        <span className="shrink-0 text-[11px] font-medium text-white bg-accent px-1.5 py-0.5 rounded-full whitespace-nowrap shadow-sm flex items-center gap-1 max-w-[55%]">
                            {dropParentTitle ? (
                                <>
                                    <CornerDownRight className="w-3 h-3 shrink-0" />
                                    <span className="truncate">{t("Inside {{dropParentTitle}}", { dropParentTitle })}</span>
                                </>
                            ) : (
                                t("Top level")
                            )}
                        </span>
                    </div>
                </div>
            </div>
        );
    }

    if (isDragging) {
        // Transient fallback before the first projection arrives.
        return (
            <div ref={setNodeRef} style={style}>
                <div className="h-7 rounded-lg bg-accent/20 dark:bg-accent/10 mx-1 my-0.5" />
            </div>
        );
    }

    const cycleStatus = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!isLeaf) return;
        // Shift-click is a shortcut to mark a topic "skipped".
        if (e.shiftKey) {
            await skipNode(node.id);
            return;
        }
        const nextStatus = {
            not_started: 'in_progress',
            in_progress: 'completed',
            completed: 'not_started',
            skipped: 'not_started',
        } as const;
        await updateNode(node.id, { status: nextStatus[node.status] });
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
            const color = progress === 100 ? 'text-green-500' : progress > 0 ? 'text-blue-500' : 'text-slate-400';
            return <span className={`text-xs font-medium ${color}`}>{progress}%</span>;
        }
        switch (node.status) {
            case 'completed': return <CheckCircle className="w-4 h-4 text-green-500" />;
            case 'skipped': return <MinusCircle className="w-4 h-4 text-slate-500 dark:text-slate-400" />;
            case 'in_progress': return <Clock className="w-4 h-4 text-blue-500" />;
            default: return <Circle className="w-4 h-4 text-slate-400 dark:text-slate-500" />;
        }
    };

    const displayDepth = item.depth;

    return (
        <>
            <div
                ref={setNodeRef}
                style={{ ...style, paddingLeft: `${displayDepth * indentationWidth}px` }}
                data-tree-item-id={node.id}
                data-node-id={node.id}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
                onClick={() => selectNode(node.id)}
                onKeyDown={onActivateKey(() => selectNode(node.id))}
                role="button"
                tabIndex={0}
                aria-label={node.title}
                className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${isDropParent
                    ? 'ring-2 ring-accent ring-inset bg-accent/10'
                    : selectedNodeId === node.id
                        ? 'bg-accent/20'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'
                    }`}
            >
                <button
                    {...attributes}
                    {...listeners}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={t("Drag to reorder")}
                    className={`p-0.5 cursor-grab active:cursor-grabbing text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-opacity touch-pan-y ${rowControls}`}
                >
                    <GripVertical className="w-3.5 h-3.5" />
                </button>
                {hasChildren ? (
                    <button onClick={(e) => { e.stopPropagation(); toggleExpanded(node.id); }} className="p-0.5 hover:bg-slate-200 dark:hover:bg-slate-600 rounded shrink-0">
                        {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                    </button>
                ) : (
                    <span className="w-4" />
                )}
                <button
                    onClick={cycleStatus}
                    aria-label={isLeaf ? t("Cycle status of {{title}}", { title: node.title }) : undefined}
                    title={isLeaf && hoverCapable ? t("Click to cycle status · Shift-click to skip") : undefined}
                    className={`shrink-0 ${isLeaf ? 'cursor-pointer hover:scale-110 transition-transform' : ''}`}
                    disabled={!isLeaf}
                >
                    {getStatusIcon()}
                </button>
                <span className={`flex-1 text-sm truncate ${selectedNodeId === node.id ? 'font-medium text-accent-fg' : 'text-slate-700 dark:text-slate-200'}`}>
                    {node.title}
                </span>
                <div className={`flex items-center transition-opacity ${rowControls}`}>
                    <DropdownMenu
                        trigger={<button className="p-1 hover:bg-slate-200 dark:hover:bg-slate-600 rounded text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"><MoreVertical className="w-3.5 h-3.5" /></button>}
                    >
                        {!node.is_note && currentProjectId != null && (
                            <button onClick={() => studyNode(currentProjectId, node.id)} className="w-full px-3 py-2 text-left text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-600 flex items-center gap-2">
                                <BookOpen className="w-4 h-4" /> {isLeaf ? t("Study this topic") : t("Study this section")}
                            </button>
                        )}
                        <button onClick={() => setShowAddModal(true)} className="w-full px-3 py-2 text-left text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-600 flex items-center gap-2">
                            <Plus className="w-4 h-4" /> {t("Add Child")}
                        </button>
                        {isLeaf && node.status !== 'skipped' && (
                            <button onClick={() => skipNode(node.id)} className="w-full px-3 py-2 text-left text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-600 flex items-center gap-2">
                                <SkipForward className="w-4 h-4" /> {t("Skip topic")}
                            </button>
                        )}
                        <button onClick={handleDelete} className="w-full px-3 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2">
                            <Trash2 className="w-4 h-4" /> {t("Delete")}
                        </button>
                    </DropdownMenu>
                </div>
            </div>

            <Modal isOpen={showAddModal} onClose={() => setShowAddModal(false)} title={t("Add Child Item")}>
                <div className="space-y-4">
                    <input
                        value={newTitle}
                        onChange={(e) => setNewTitle(e.target.value)}
                        placeholder={t("Item title…")}
                        className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-700 text-slate-900 dark:text-white focus:ring-2 focus:ring-accent"
                        autoFocus
                        onKeyDown={(e) => e.key === 'Enter' && handleAddChild()}
                    />
                    <div className="flex justify-end gap-3">
                        <button onClick={() => setShowAddModal(false)} className="px-4 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-xl">{t("Cancel")}</button>
                        <button onClick={handleAddChild} disabled={!newTitle.trim()} className="px-4 py-2 bg-slate-900 dark:bg-accent text-white rounded-xl hover:bg-slate-800 dark:hover:bg-accent/90 disabled:opacity-50">{t("Add")}</button>
                    </div>
                </div>
            </Modal>
        </>
    );
}