import { useState, useEffect, useRef, useMemo } from 'react';
import { DndContext, DragEndEvent, DragStartEvent, DragMoveEvent, DragOverEvent, DragOverlay, Over, pointerWithin, closestCenter, MouseSensor, TouchSensor, useSensor, useSensors, CollisionDetection, MeasuringStrategy } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { useStore } from '../store';
import { api } from '../api';
import Modal from './Modal';
import CategoryCard, { CardRowDrag } from './CategoryCard';
import { BoardHost, boardRows, boardProjection, cardOfNode, hostOver, settleRowDrop, INDENTATION_WIDTH } from '../utils/treeDnd';
import { categoryOrderAfterDrop, categoryDropSide, moveChangesPlace } from '../utils/dragOrder';
import { endDropFlash, flashAfterDrop } from '../utils/dropFlash';
import { Plus, Eye, Loader2 } from 'lucide-react';
import { useAICreationContext } from './aiCreationContext';
import { useScrollToSelected } from '../hooks/useScrollToSelected';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/Button';
import { TextInput } from './ui/Field';

export default function NodeTree() {
    const { t } = useTranslation();
    const tree = useStore(s => s.tree);
    const projects = useStore(s => s.projects);
    const loadProjects = useStore(s => s.loadProjects);
    const createNode = useStore(s => s.createNode);
    const reorderNodes = useStore(s => s.reorderNodes);
    const moveNode = useStore(s => s.moveNode);
    const setExpanded = useStore(s => s.setExpanded);
    const selectedNodeId = useStore(s => s.selectedNodeId);
    const currentProjectId = useStore(s => s.currentProjectId);
    const { isProjectGenerating, openGenerationModal } = useAICreationContext();

    // Scroll the selected node (a category card or a nested row) into view.
    const scrollRef = useRef<HTMLDivElement>(null);
    useScrollToSelected(selectedNodeId, scrollRef);

    // THIS project is being written by a creation run. Any other project's run
    // is no reason to say so here: several may be live, and this tree is not
    // theirs.
    const generatingProject = currentProjectId != null && isProjectGenerating(currentProjectId)
        ? projects.find(p => p.id === currentProjectId) : undefined;

    // Watch for ai_generating changing on the server. Refetching the WHOLE
    // project list on a timer would parse it into the store as a new array, so
    // every component reading `projects` would re-render for a flag. It asks
    // the endpoint that answers only that question (a few bytes), and pulls
    // the real list only when the answer has actually changed.
    //
    // Skipped while the document is hidden — a backgrounded PWA can't reach the
    // server anyway, and the tick right after resume refreshes.
    const generatingKey = useRef('');
    useEffect(() => {
        const interval = setInterval(async () => {
            if (document.visibilityState === 'hidden') return;
            try {
                const { generating } = await api.getGenerationStatus();
                const key = generating.map(p => p.id).sort((a, b) => a - b).join(',');
                if (key === generatingKey.current) return;
                generatingKey.current = key;
                loadProjects({ silent: true });
            } catch { /* a failed background poll is not the learner's problem */ }
        }, 3000);
        return () => clearInterval(interval);
    }, [loadProjects]);
    const [showCreate, setShowCreate] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const expanded = useStore(s => s.expanded);

    // ONE drag context for the whole board, so a row can be carried from one
    // category card into another (a context per card would keep a row inside
    // the card it started in). A drag is a CARD (reordering
    // categories) or a ROW (moving an item), told apart by the `kind` each
    // sortable carries in its data.
    const [drag, setDrag] = useState<{ kind: 'card' | 'row'; id: number; sourceCardId: number } | null>(null);
    const [over, setOver] = useState<{ kind: 'card' | 'row'; id: number } | null>(null);
    // The card a row is carried into, and where in its list it is drawn.
    const [host, setHost] = useState<BoardHost | null>(null);
    const [dragOffsetX, setDragOffsetX] = useState(0);
    // Absolute pointer position at drag start, so the live pointer can be
    // rebuilt from dnd-kit's delta (no stale activatorEvent guessing).
    const startPointer = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

    const sensors = useSensors(
        // Desktop: start dragging as soon as the mouse moves a little.
        useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
        // Touch: require a short press-and-hold before a drag begins, so a normal
        // swipe scrolls the page and only a deliberate long-press moves anything.
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } })
    );

    const activeRowId = drag?.kind === 'row' ? drag.id : null;
    const activeCategory = drag?.kind === 'card' ? (tree.find(n => n.id === drag.id) ?? null) : null;
    const lists = useMemo(() => boardRows(tree, expanded, activeRowId, host), [tree, expanded, activeRowId, host]);
    // The card drawing the dragged row. Collision detection runs inside
    // DndContext's render, after this one, so it reads this value directly.
    const drawingCard = drag?.kind === 'row' ? (host?.cardId ?? drag.sourceCardId) : null;

    const kindOf = (d: { data: { current?: Record<string, unknown> } } | null | undefined) =>
        d?.data.current?.kind === 'row' ? 'row' : 'card';

    // A card drag looks at cards only: whichever the pointer is inside, else
    // the nearest. A row drag first finds the card under the pointer, then the
    // nearest of THAT card's rows; a card showing no rows (empty, collapsed) is
    // a target itself. In the gutter the rows of the card drawing the dragged
    // row answer, so the line does not jump to a random card.
    const collisionDetection: CollisionDetection = (args) => {
        const cards = args.droppableContainers.filter(c => c.data.current?.kind === 'card');
        if (args.active.data.current?.kind !== 'row') {
            const within = pointerWithin({ ...args, droppableContainers: cards });
            return within.length ? within : closestCenter({ ...args, droppableContainers: cards });
        }
        const underPointer = pointerWithin({ ...args, droppableContainers: cards });
        const cardId = (underPointer[0]?.id as number | undefined) ?? drawingCard;
        const rows = args.droppableContainers.filter(c => c.data.current?.kind === 'row' && c.data.current?.cardId === cardId);
        if (rows.length) return closestCenter({ ...args, droppableContainers: rows });
        return underPointer;
    };

    const handleCreate = async () => {
        if (!newTitle.trim()) return;
        await createNode({ title: newTitle, parent_id: null });
        setShowCreate(false);
        setNewTitle('');
    };

    const resetDrag = () => {
        setDrag(null);
        setOver(null);
        setHost(null);
        setDragOffsetX(0);
    };

    const pointerFrom = (e: any): { x: number; y: number } => {
        if (e?.touches?.[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        if (e?.changedTouches?.[0]) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
        return { x: e?.clientX ?? 0, y: e?.clientY ?? 0 };
    };

    const handleDragStart = (event: DragStartEvent) => {
        const id = event.active.id as number;
        const kind = kindOf(event.active);
        const sourceCardId = kind === 'row' ? (cardOfNode(tree, id) ?? id) : id;
        setDrag({ kind, id, sourceCardId });
        endDropFlash(`node:${id}`);
        setOver(null);
        setHost(null);
        setDragOffsetX(0);
        startPointer.current = pointerFrom(event.activatorEvent);
    };

    // The host a row would have over `target`: a row of another card draws it
    // there, a row of its own card puts it back in its own place.
    const hostFor = (activeId: number, sourceCardId: number, target: Over, deltaY: number): BoardHost | null => {
        if (kindOf(target) !== 'row') return null;
        const cardId = target.data.current?.cardId as number;
        if (cardId === (host?.cardId ?? sourceCardId)) return host;
        const pointerY = startPointer.current.y + deltaY;
        const below = pointerY > target.rect.top + target.rect.height / 2;
        return hostOver(activeId === activeRowId ? lists : boardRows(tree, expanded, activeId, host), activeId, sourceCardId, cardId, target.id as number, below);
    };

    const track = (event: DragMoveEvent | DragOverEvent) => {
        const target = event.over;
        // Kept as whole indentation levels, so a drag re-renders the board when
        // the depth can change, not on every pixel.
        setDragOffsetX(Math.round(event.delta.x / INDENTATION_WIDTH) * INDENTATION_WIDTH);
        if (!target || (target.id === event.active.id && drag?.kind === 'card')) { setOver(null); return; }
        setOver({ kind: kindOf(target), id: target.id as number });
        if (drag?.kind !== 'row') return;
        // Over an empty or collapsed card the row is shown nowhere else.
        const next = kindOf(target) === 'card' ? null : hostFor(drag.id, drag.sourceCardId, target, event.delta.y);
        if (next !== host) setHost(next);
    };

    // What the cards draw while a row is dragged: its projected depth and the
    // row it would nest inside, on the card drawing it.
    const rowPlacement = drag?.kind === 'row' && over?.kind === 'row'
        ? boardProjection(lists, drag.id, over.id, dragOffsetX, drag.sourceCardId)
        : null;
    const rowDragFor = (cardId: number): CardRowDrag | null => {
        if (drag?.kind !== 'row' || drawingCard !== cardId) return null;
        const projection = rowPlacement?.projection ?? null;
        const dropParentId = projection && projection.depth > 0 ? projection.parentId : null;
        return {
            activeId: drag.id,
            projectedDepth: projection ? projection.depth : null,
            dropParentId,
            dropParentTitle: dropParentId != null
                ? (lists.get(cardId)?.find(i => i.id === dropParentId)?.node.title ?? null)
                : null,
        };
    };
    const ids = tree.map(n => n.id);
    const cardSide = drag?.kind === 'card' && over?.kind === 'card' ? categoryDropSide(ids, drag.id, over.id) : null;

    const handleDragEnd = async (event: DragEndEvent) => {
        // Read from the event and the tree, not from the drag state: the state
        // is whatever the last render saw, and a release can arrive before it.
        const kind = kindOf(event.active);
        const activeId = event.active.id as number;
        const sourceCardId = kind === 'row' ? cardOfNode(tree, activeId) : null;
        const target = event.over;
        const drawn = host;
        // The host the final pointer asks for: a drop can arrive before the
        // host its last move asked for was drawn.
        const finalHost = target && sourceCardId != null ? hostFor(activeId, sourceCardId, target, event.delta.y) : drawn;
        resetDrag();
        if (!target) return;

        if (kind === 'card') {
            if (kindOf(target) !== 'card') return;
            const next = categoryOrderAfterDrop(ids, activeId, target.id as number);
            if (!next) return;
            flashAfterDrop(`node:${activeId}`);
            await reorderNodes(next, null);
            return;
        }

        const placed = settleRowDrop(tree, expanded, activeId, drawn, finalHost,
            { kind: kindOf(target), id: target.id as number }, event.delta.x);
        if (!placed) return;
        if (moveChangesPlace(useStore.getState().nodes, activeId, placed.parentId, placed.position)) {
            flashAfterDrop(`node:${activeId}`);
        }
        // Open the target before the write, so the row lands in sight rather than vanishing into a closed section for a round trip.
        setExpanded(placed.parentId, true);
        await moveNode(activeId, placed.parentId, placed.position);
    };

    const handleDragCancel = () => resetDrag();

    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 shrink-0">
                {/* Left section - Categories title */}
                <div className="flex items-center gap-3 min-w-0">
                    <div>
                        <h2 className="font-semibold text-slate-800 dark:text-white">{t("Categories")}</h2>
                        <p className="text-xs text-slate-500 dark:text-slate-400">{t("Drag to reorder")}</p>
                    </div>
                </div>

                {/* Center section - AI generation status */}
                <div className="absolute left-1/2 transform -translate-x-1/2">
                    {generatingProject && (
                        <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg">
                            <Loader2 className="w-4 h-4 text-amber-500 animate-spin shrink-0" />
                            <span className="text-sm text-amber-700 dark:text-amber-300 font-medium whitespace-nowrap">{t("In progress — AI generation")}</span>
                            <div className="w-px h-4 bg-amber-300 dark:bg-amber-600 shrink-0" />
                            <Button
                                size="sm"
                                variant="quiet"
                                onClick={() => openGenerationModal(generatingProject.id)}
                                title={t("View AI generation progress")}
                                icon={<Eye className="w-4 h-4" aria-hidden="true" />}
                                className="shrink-0"
                            >
                                {t("View")}
                            </Button>
                        </div>
                    )}
                </div>

                {/* Right section - Add Category button. `whitespace-nowrap`: beside a
                    narrow pane (detail panel open) its label would wrap onto the
                    heading; the row wraps instead. */}
                <Button
                    size="sm"
                    variant="primary"
                    onClick={() => setShowCreate(true)}
                    icon={<Plus className="w-4 h-4" aria-hidden="true" />}
                    className="shrink-0 whitespace-nowrap"
                >
                    {t("Add Category")}
                </Button>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-auto p-6">
                <DndContext
                    sensors={sensors}
                    collisionDetection={collisionDetection}
                    onDragStart={handleDragStart}
                    onDragMove={track}
                    onDragOver={track}
                    onDragEnd={handleDragEnd}
                    onDragCancel={handleDragCancel}
                    measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
                >
                    {/* Static strategy: cards don't reflow while dragging — a single
                        gutter bar on the side the card lands shows the drop, so nothing jumps. */}
                    <SortableContext items={ids} strategy={() => null}>
                        <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(17rem,1fr))]">
                            {tree.map(node => (
                                <CategoryCard
                                    key={node.id}
                                    node={node}
                                    rows={lists.get(node.id) ?? []}
                                    rowDrag={rowDragFor(node.id)}
                                    rowTarget={drag?.kind === 'row' && over?.kind === 'card' && over.id === node.id}
                                    dropIndicator={over?.kind === 'card' && over.id === node.id ? cardSide : null}
                                />
                            ))}
                        </div>
                    </SortableContext>

                    {/* A row drag keeps an invisible overlay: it holds dnd-kit in
                        "sorting" mode, so the in-list placeholder snaps between
                        rows instead of following the cursor. */}
                    <DragOverlay dropAnimation={null}>
                        {activeRowId != null && <div className="h-7 opacity-0 pointer-events-none" />}
                        {activeCategory && (
                            <div className="bg-white dark:bg-slate-800 rounded-2xl border-2 border-accent shadow-2xl p-4 opacity-95 w-80">
                                <div className="flex items-center gap-3">
                                    <div className="flex gap-1">
                                        {[...Array(5)].map((_, i) => (
                                            <div key={i} className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                                        ))}
                                    </div>
                                    <span className="font-semibold text-slate-900 dark:text-white truncate">
                                        {activeCategory.title}
                                    </span>
                                    <span className="text-sm text-slate-500 dark:text-slate-400 shrink-0">
                                        ({activeCategory.children.length})
                                    </span>
                                </div>
                            </div>
                        )}
                    </DragOverlay>
                </DndContext>

                {tree.length === 0 && (
                    <div className="text-center py-16">
                        <p className="text-slate-500 dark:text-slate-400 text-lg">{t("No categories yet")}</p>
                        <p className="text-slate-500 dark:text-slate-400 mt-1">{t("Add your first category to get started")}</p>
                    </div>
                )}
            </div>

            <Modal isOpen={showCreate} onClose={() => setShowCreate(false)} title={t("Create Category")}>
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">{t("Category Name")}</label>
                        <TextInput
                            value={newTitle}
                            onChange={e => setNewTitle(e.target.value)}
                            placeholder={t("e.g., Chapter 1, Module A…")}
                            autoFocus
                            onKeyDown={e => e.key === 'Enter' && handleCreate()}
                        />
                    </div>
                    <div className="flex justify-end gap-3">
                        <Button variant="quiet" onClick={() => setShowCreate(false)}>
                            {t("Cancel")}
                        </Button>
                        <Button variant="primary" onClick={handleCreate} disabled={!newTitle.trim()}>
                            {t("Create")}
                        </Button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}