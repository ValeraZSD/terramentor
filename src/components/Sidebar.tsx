import { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import { onActivateKey } from '../utils/a11y';
import {
    DndContext, DragEndEvent, DragStartEvent, DragMoveEvent, DragOverEvent, DragOverlay,
    closestCenter, PointerSensor, TouchSensor, useSensor, useSensors, MeasuringStrategy,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStore } from '../store';
import { getVisibleNodes, todayStr, isLeafNode } from '../utils/tree';
import { hexToRgba } from '../utils/color';
import {
    FlatItem, flattenVisible, removeDescendants, getProjection, getDropPosition, isDescendantTarget,
} from '../utils/treeDnd';
import { useScrollToSelected } from '../hooks/useScrollToSelected';
import { ChevronRight, ChevronDown, Circle, Clock, CheckCircle, FileText, ChevronsUpDown, GripVertical, FolderOpen, AlertTriangle, MinusCircle, CornerDownRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Visual indent per depth level (px). Kept separate from the engine's default
// so the drop-line lands exactly under the rows.
const SIDEBAR_INDENT = 16;

interface SidebarRowProps {
    item: FlatItem;
    projectColor: string;
    isActive: boolean;
    /** Non-null only for the row being dragged: the live projected nesting depth. */
    projectedDepth: number | null;
    /** True when the dragged row would nest inside THIS row (highlight it). */
    isDropParent?: boolean;
    /** On the dragged row only: title of the row it will nest inside, or null for top level. */
    dropParentTitle?: string | null;
}

function SidebarRow({ item, projectColor, isActive, projectedDepth, isDropParent, dropParentTitle }: SidebarRowProps) {
    const { t } = useTranslation();
    const { node, depth } = item;
    const expanded = useStore(s => s.expanded);
    const toggleExpanded = useStore(s => s.toggleExpanded);
    // Nodes nothing is teaching are never hand-marked complete — they are proven
    // by their cards maturing — so the leaf-status percentage that describes a
    // taught topic reads a permanent, meaningless "0%" beside every row. The
    // card panel carries the numbers that ARE true of them. This asked "is the
    // project an Anki import" until 2026-09-09; it asks what the project is
    // doing now, so a deck whose topics are being taught shows its progress.
    const untaught = useStore(s => {
        const p = s.projects.find(x => x.id === s.currentProjectId);
        return !!p && p.teaches === false;
    });
    const selectedNodeId = useStore(s => s.selectedNodeId);
    const selectNode = useStore(s => s.selectNode);

    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: node.id,
    });

    const style = {
        transform: CSS.Translate.toString(transform),
        transition,
    };

    // Snap-in-place placeholder: a ghost of the row shown exactly where — and at
    // the nesting depth — it will land. `style` carries the sortable's VERTICAL
    // snap transform so it moves to the target slot as you drag. That's the
    // sorting displacement (not a pointer-follow) only because an invisible
    // DragOverlay is mounted; without one dnd-kit would make this node chase the
    // cursor and stretch the container.
    if (isActive && projectedDepth !== null) {
        return (
            <div ref={setNodeRef} style={style}>
                <div className="mx-1" style={{ paddingLeft: `${projectedDepth * SIDEBAR_INDENT + 8}px` }}>
                    <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg border-2 border-dashed border-accent bg-accent/10">
                        <GripVertical className="w-3 h-3 text-accent shrink-0" />
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

    const isExpanded = expanded[node.id] !== false;
    // `hasChildren` drives the expand chevron — notes are children worth
    // unfolding. Leafness (the status icon) ignores them: a topic
    // whose only children are notes is still the thing you prove.
    const hasChildren = node.children.length > 0;
    const isLeaf = isLeafNode(node);
    const isSelected = selectedNodeId === node.id;
    const isRoot = depth === 0;
    const isNote = !!node.is_note;

    const today = todayStr();
    const effectiveNodeStatus = node.effectiveStatus || (node.progress?.percentage === 100 ? 'completed' : node.progress?.percentage ? 'in_progress' : node.status);
    const isOverdue = !isNote &&
        !!node.scheduled_end &&
        node.scheduled_end < today &&
        effectiveNodeStatus !== 'completed' &&
        effectiveNodeStatus !== 'skipped';

    const getStatusIcon = () => {
        if (isNote) return <FileText className="w-4 h-4 text-slate-500 dark:text-slate-400" />;
        if (isOverdue) return <AlertTriangle className="w-4 h-4 text-red-500" />;
        if (!isLeaf) return null;
        switch (node.status) {
            case 'completed': return <CheckCircle className="w-4 h-4 text-green-500" />;
            case 'skipped': return <MinusCircle className="w-4 h-4 text-slate-500 dark:text-slate-400" />;
            case 'in_progress': return <Clock className="w-4 h-4 text-blue-500" />;
            default: return <Circle className="w-4 h-4 text-slate-400 dark:text-slate-500" />;
        }
    };

    const getStatusColor = () => {
        if (isNote) return 'text-slate-500 dark:text-slate-400';
        if (isOverdue) return 'text-red-500 dark:text-red-400';
        const progress = node.progress?.percentage || 0;
        if (progress === 100) return 'text-green-600 dark:text-green-400';
        if (progress > 0) return 'text-blue-600 dark:text-blue-400';
        return 'text-slate-500 dark:text-slate-400';
    };

    const rootBg = isRoot
        ? { backgroundColor: isSelected ? hexToRgba(projectColor, 0.3) : hexToRgba(projectColor, 0.15) }
        : {};

    return (
        <div ref={setNodeRef} style={{ ...style, opacity: isDragging ? 0.4 : 1 }}>
            <div
                data-node-id={node.id}
                onClick={() => selectNode(node.id)}
                onKeyDown={onActivateKey(() => selectNode(node.id))}
                role="button"
                tabIndex={0}
                aria-label={node.title}
                className={`flex items-center gap-1 px-2 py-1.5 cursor-pointer rounded-lg mx-1 transition-colors group ${isRoot ? 'font-medium' : ''
                    } ${isDropParent ? 'ring-2 ring-accent ring-inset bg-accent/10' : ''} ${isSelected && !isRoot && !isDropParent ? 'bg-accent/20' : ''} ${!isRoot && !isSelected && !isDropParent ? 'hover:bg-slate-100 dark:hover:bg-slate-800' : ''
                    } ${isOverdue && !isSelected && !isDropParent ? 'bg-red-50/50 dark:bg-red-900/5' : ''}`}
                style={{
                    paddingLeft: `${depth * SIDEBAR_INDENT + 8}px`,
                    ...rootBg,
                }}
            >
                <button
                    {...attributes}
                    {...listeners}
                    onClick={e => e.stopPropagation()}
                    aria-label={t("Drag to reorder")}
                    className="p-0.5 cursor-grab active:cursor-grabbing text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-opacity touch-none can-hover:opacity-0 can-hover:group-hover:opacity-100 can-hover:focus-visible:opacity-100"
                >
                    <GripVertical className="w-3 h-3" />
                </button>

                {hasChildren ? (
                    <button
                        onClick={(e) => { e.stopPropagation(); toggleExpanded(node.id); }}
                        className="p-0.5 hover:bg-slate-200 dark:hover:bg-slate-600 rounded shrink-0"
                    >
                        {isExpanded
                            ? <ChevronDown className="w-4 h-4 text-slate-400" />
                            : <ChevronRight className="w-4 h-4 text-slate-400" />
                        }
                    </button>
                ) : (
                    <span className="w-5 shrink-0" />
                )}

                {isRoot && (
                    <div
                        className="w-5 h-5 rounded flex items-center justify-center shrink-0"
                        style={{ backgroundColor: projectColor }}
                    >
                        <FolderOpen className="w-3 h-3 text-white" />
                    </div>
                )}

                <span className="shrink-0">
                    {hasChildren && !node.is_note && !isRoot && !untaught ? (
                        <span className={`text-xs font-medium ${getStatusColor()}`}>
                            {node.progress?.percentage || 0}%
                        </span>
                    ) : !isRoot && !untaught ? (
                        getStatusIcon()
                    ) : null}
                </span>

                <span className={`truncate text-sm ${isSelected ? 'font-medium' : ''} ${isRoot ? 'text-slate-900 dark:text-white' : isOverdue ? 'text-red-700 dark:text-red-100' : 'text-slate-700 dark:text-slate-300'
                    }`}>
                    {node.title}
                </span>

                {isRoot && !isNote && !untaught && (
                    <span className={`text-xs ml-auto ${getStatusColor()}`}>
                        {node.progress?.percentage || 0}%
                    </span>
                )}

                {isOverdue && isRoot && (
                    <span className="w-2 h-2 rounded-full bg-red-500 shrink-0 ml-1" title={t("Overdue")} />
                )}
            </div>
        </div>
    );
}

export default function Sidebar({ isDrawer = false }: { isDrawer?: boolean }) {
    const { t } = useTranslation();
    const tree = useStore(s => s.tree);
    const expanded = useStore(s => s.expanded);
    const selectedNodeId = useStore(s => s.selectedNodeId);
    const focusedNodeId = useStore(s => s.focusedNodeId);
    const selectNode = useStore(s => s.selectNode);
    const setFocusedNode = useStore(s => s.setFocusedNode);
    const setExpanded = useStore(s => s.setExpanded);
    const toggleAllExpanded = useStore(s => s.toggleAllExpanded);
    const sidebarWidth = useStore(s => s.sidebarWidth);
    const setSidebarWidth = useStore(s => s.setSidebarWidth);
    const moveNode = useStore(s => s.moveNode);
    const projects = useStore(s => s.projects);
    const currentProjectId = useStore(s => s.currentProjectId);

    const sidebarRef = useRef<HTMLDivElement>(null);
    const resizing = useRef(false);
    const [activeId, setActiveId] = useState<number | null>(null);
    const [overId, setOverId] = useState<number | null>(null);
    const [dragOffsetX, setDragOffsetX] = useState(0);

    const project = projects.find(p => p.id === currentProjectId);
    const projectColor = project?.color || '#8B5CF6';

    // Keep the sidebar scrolled to whatever node is selected (from any view).
    useScrollToSelected(selectedNodeId, sidebarRef);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        // Touch: press-and-hold so a normal swipe scrolls and only a deliberate
        // long-press starts a reorder.
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } })
    );

    // Flattened, currently-visible rows. During a drag we drop the active node's
    // own subtree so it can never be nested inside itself (and doesn't shift).
    const allFlatItems = useMemo(() => flattenVisible(tree, expanded, null, 0, []), [tree, expanded]);
    const flatItems = useMemo(() => {
        if (activeId == null) return allFlatItems;
        return removeDescendants(allFlatItems, activeId);
    }, [allFlatItems, activeId]);
    const flatIds = useMemo(() => flatItems.map(i => i.id), [flatItems]);

    const projection = useMemo(() => {
        if (activeId == null || overId == null) return null;
        return getProjection(flatItems, activeId, overId, dragOffsetX, null, SIDEBAR_INDENT);
    }, [flatItems, activeId, overId, dragOffsetX]);

    // The row the dragged node would nest INSIDE (depth > 0). At depth 0 it lands
    // at the top level (its own project root), so there's no parent row to mark.
    const dropParentId = projection && projection.depth > 0 ? projection.parentId : null;
    const dropParentTitle = dropParentId != null
        ? (allFlatItems.find(i => i.id === dropParentId)?.node.title ?? null)
        : null;

    const resetDrag = () => {
        setActiveId(null);
        setOverId(null);
        setDragOffsetX(0);
    };

    const handleDragStart = (event: DragStartEvent) => {
        const id = event.active.id as number;
        setActiveId(id);
        setOverId(id);
        setDragOffsetX(0);
    };

    const handleDragMove = (event: DragMoveEvent) => {
        setDragOffsetX(event.delta.x);
        if (event.over) setOverId(event.over.id as number);
    };

    const handleDragOver = (event: DragOverEvent) => {
        if (event.over) setOverId(event.over.id as number);
    };

    const handleDragEnd = async (event: DragEndEvent) => {
        const currentActiveId = activeId;
        const currentProjection = projection;
        const { over } = event;
        resetDrag();

        if (currentActiveId == null || !over || !currentProjection) return;
        const newParentId = currentProjection.parentId;
        if (isDescendantTarget(allFlatItems, currentActiveId, newParentId)) return;

        const overId = over.id as number;
        const position = getDropPosition(flatItems, currentActiveId, overId, currentProjection);
        await moveNode(currentActiveId, newParentId, position);
        if (newParentId != null) setExpanded(newParentId, true);
    };

    const handleDragCancel = () => resetDrag();

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        resizing.current = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    }, []);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!resizing.current) return;
            setSidebarWidth(e.clientX);
        };

        const handleMouseUp = () => {
            resizing.current = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [setSidebarWidth]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!sidebarRef.current?.contains(document.activeElement) && document.activeElement !== document.body) {
                return;
            }

            const visibleNodes = getVisibleNodes(tree, expanded);
            if (visibleNodes.length === 0) return;

            const currentIndex = focusedNodeId
                ? visibleNodes.findIndex(n => n.id === focusedNodeId)
                : -1;

            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    if (currentIndex < visibleNodes.length - 1) {
                        setFocusedNode(visibleNodes[currentIndex + 1].id);
                    } else if (currentIndex === -1 && visibleNodes.length > 0) {
                        setFocusedNode(visibleNodes[0].id);
                    }
                    break;

                case 'ArrowUp':
                    e.preventDefault();
                    if (currentIndex > 0) {
                        setFocusedNode(visibleNodes[currentIndex - 1].id);
                    }
                    break;

                case 'ArrowRight':
                    e.preventDefault();
                    if (focusedNodeId) {
                        const n = visibleNodes.find(n => n.id === focusedNodeId);
                        if (n && n.children.length > 0 && !expanded[n.id]) {
                            setExpanded(n.id, true);
                        }
                    }
                    break;

                case 'ArrowLeft':
                    e.preventDefault();
                    if (focusedNodeId) {
                        const n = visibleNodes.find(n => n.id === focusedNodeId);
                        if (n) {
                            if (expanded[n.id] && n.children.length > 0) {
                                setExpanded(n.id, false);
                            } else if (n.parent_id) {
                                setFocusedNode(n.parent_id);
                            }
                        }
                    }
                    break;

                case 'Enter':
                    e.preventDefault();
                    if (focusedNodeId) {
                        selectNode(focusedNodeId);
                    }
                    break;

                case 'Escape':
                    e.preventDefault();
                    selectNode(null);
                    setFocusedNode(null);
                    break;
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [tree, expanded, focusedNodeId, selectNode, setFocusedNode, setExpanded]);

    return (
        <div
            ref={sidebarRef}
            className={`bg-white dark:bg-slate-800 border-r border-slate-200 dark:border-slate-700 flex flex-col relative ${isDrawer ? 'w-full h-full' : 'shrink-0'}`}
            style={isDrawer ? undefined : { width: sidebarWidth }}
            tabIndex={0}
        >
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between shrink-0">
                <h2 className="font-semibold text-slate-800 dark:text-white text-sm">{t("Navigation")}</h2>
                <button
                    onClick={toggleAllExpanded}
                    className="p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded"
                    title={t("Toggle all")}
                >
                    <ChevronsUpDown className="w-4 h-4 text-slate-400" />
                </button>
            </div>

            <div className="flex-1 overflow-auto py-2" data-sidebar-node-list>
                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragStart={handleDragStart}
                    onDragMove={handleDragMove}
                    onDragOver={handleDragOver}
                    onDragEnd={handleDragEnd}
                    onDragCancel={handleDragCancel}
                    measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
                >
                    <SortableContext items={flatIds} strategy={verticalListSortingStrategy}>
                        {flatItems.map(item => (
                            <SidebarRow
                                key={item.id}
                                item={item}
                                projectColor={projectColor}
                                isActive={activeId === item.id}
                                projectedDepth={activeId === item.id && projection ? projection.depth : null}
                                isDropParent={dropParentId != null && item.id === dropParentId}
                                dropParentTitle={activeId === item.id ? dropParentTitle : null}
                            />
                        ))}
                    </SortableContext>
                    {/* Invisible overlay: keeps dnd-kit in "sorting" mode so the
                        in-list placeholder snaps vertically instead of chasing the
                        cursor. The placeholder is the only visible drag feedback. */}
                    <DragOverlay dropAnimation={null}>
                        {activeId != null ? <div className="h-7 opacity-0 pointer-events-none" /> : null}
                    </DragOverlay>
                </DndContext>
            </div>

            {!isDrawer && (
                <div
                    className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-accent transition-colors"
                    onMouseDown={handleMouseDown}
                />
            )}
        </div>
    );
}
