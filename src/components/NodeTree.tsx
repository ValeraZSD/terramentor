import { useState, useEffect, useRef } from 'react';
import { DndContext, DragEndEvent, DragStartEvent, DragMoveEvent, DragOverlay, pointerWithin, closestCenter, MouseSensor, TouchSensor, useSensor, useSensors, CollisionDetection } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { useStore } from '../store';
import { api } from '../api';
import Modal from './Modal';
import CategoryCard from './CategoryCard';
import { Plus, Eye, Loader2 } from 'lucide-react';
import { useAICreationContext } from './aiCreationContext';
import { TreeNode } from '../types';
import { useScrollToSelected } from '../hooks/useScrollToSelected';
import { useTranslation } from 'react-i18next';

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
    const { isProjectGenerating, openGenerationModal } = useAICreationContext();

    // Scroll the selected node (a category card or a nested row) into view.
    const scrollRef = useRef<HTMLDivElement>(null);
    useScrollToSelected(selectedNodeId, scrollRef);

    // Find the project that is being generated
    const generatingProject = projects.find(p => isProjectGenerating(p.id));

    // Watch for ai_generating changing on the server. This used to refetch the
    // WHOLE project list every 3 seconds — 333 kB of JSON on the real library,
    // parsed and written into the store as a new array, so every component
    // reading `projects` re-rendered twenty times a minute for a flag. It asks
    // the endpoint that answers only that question now (17 bytes), and pulls the
    // real list only when the answer has actually changed.
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
    const [activeCategory, setActiveCategory] = useState<TreeNode | null>(null);
    const [overId, setOverId] = useState<number | null>(null);
    // Where a drop would land on the hovered card: reorder (before/after) or nest (inside).
    const [dropMode, setDropMode] = useState<'before' | 'after' | 'inside' | null>(null);
    // Absolute pointer position at drag start, so we can reconstruct the live
    // pointer from dnd-kit's delta (no stale activatorEvent guessing).
    const startPointer = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

    const sensors = useSensors(
        // Desktop: start dragging as soon as the mouse moves a little.
        useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
        // Touch: require a short press-and-hold before a drag begins, so a normal
        // swipe scrolls the page and only a deliberate long-press reorders a category.
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } })
    );

    // Pointer-first collision: whatever card the cursor is inside wins; fall back
    // to nearest-center when the cursor is in the gutter between cards.
    const collisionDetection: CollisionDetection = (args) => {
        const within = pointerWithin(args);
        return within.length ? within : closestCenter(args);
    };

    const handleCreate = async () => {
        if (!newTitle.trim()) return;
        await createNode({ title: newTitle, parent_id: null });
        setShowCreate(false);
        setNewTitle('');
    };

    const resetDrag = () => {
        setActiveCategory(null);
        setOverId(null);
        setDropMode(null);
    };

    const pointerFrom = (e: any): { x: number; y: number } => {
        if (e?.touches?.[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        if (e?.changedTouches?.[0]) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
        return { x: e?.clientX ?? 0, y: e?.clientY ?? 0 };
    };

    const handleDragStart = (event: DragStartEvent) => {
        const nodeId = event.active.id as number;
        setActiveCategory(tree.find(n => n.id === nodeId) || null);
        setOverId(nodeId);
        setDropMode(null);
        startPointer.current = pointerFrom(event.activatorEvent);
    };

    // Decide before / after / inside from where the pointer sits horizontally
    // across the hovered card. The list stays static (no reflow) — the only
    // feedback is a single gutter bar or a "nest" ring.
    const handleDragMove = (event: DragMoveEvent) => {
        const { active, over, delta } = event;
        if (!over || over.id === active.id) { setOverId(null); setDropMode(null); return; }
        const px = startPointer.current.x + delta.x;
        const relX = (px - over.rect.left) / over.rect.width;
        const mode = relX < 0.3 ? 'before' : relX > 0.7 ? 'after' : 'inside';
        setOverId(over.id as number);
        setDropMode(mode);
    };

    const handleDragEnd = async (event: DragEndEvent) => {
        const activeId = event.active.id as number;
        const targetId = overId;
        const mode = dropMode;
        resetDrag();

        if (targetId == null || !mode || activeId === targetId) return;

        if (mode === 'inside') {
            const target = tree.find(n => n.id === targetId);
            if (!target) return;
            await moveNode(activeId, targetId, target.children.length);
            setExpanded(targetId, true);
            return;
        }

        // Reorder among top-level categories.
        const ids = tree.map(n => n.id);
        const from = ids.indexOf(activeId);
        if (from === -1) return;
        ids.splice(from, 1);
        let to = ids.indexOf(targetId);
        if (to === -1) return;
        if (mode === 'after') to += 1;
        ids.splice(to, 0, activeId);
        await reorderNodes(ids, null);
    };

    const handleDragCancel = () => resetDrag();

    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between shrink-0">
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
                            <button
                                onClick={openGenerationModal}
                                className="flex items-center gap-1.5 px-2 py-1 bg-amber-100 dark:bg-amber-900/40 rounded hover:bg-amber-200 dark:hover:bg-amber-900/60 transition shrink-0"
                                title={t("View AI generation progress")}
                            >
                                <Eye className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                                <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">{t("View")}</span>
                            </button>
                        </div>
                    )}
                </div>

                {/* Right section - Add Category button */}
                <button
                    onClick={() => setShowCreate(true)}
                    className="flex items-center gap-2 px-3 py-1.5 bg-accent text-white rounded-lg hover:bg-accent/90 transition text-sm"
                >
                    <Plus className="w-4 h-4" />
                    {t("Add Category")}
                </button>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-auto p-6">
                <DndContext
                    sensors={sensors}
                    collisionDetection={collisionDetection}
                    onDragStart={handleDragStart}
                    onDragMove={handleDragMove}
                    onDragEnd={handleDragEnd}
                    onDragCancel={handleDragCancel}
                >
                    {/* Static strategy: cards don't reflow while dragging — a single
                        gutter bar / nest ring shows the drop, so nothing jumps. */}
                    <SortableContext items={tree.map(n => n.id)} strategy={() => null}>
                        <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(17rem,1fr))]">
                            {tree.map(node => (
                                <CategoryCard
                                    key={node.id}
                                    node={node}
                                    dropIndicator={overId === node.id ? dropMode : null}
                                />
                            ))}
                        </div>
                    </SortableContext>

                    <DragOverlay dropAnimation={null}>
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
                        <input
                            value={newTitle}
                            onChange={e => setNewTitle(e.target.value)}
                            placeholder={t("e.g., Chapter 1, Module A…")}
                            className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-700 text-slate-900 dark:text-white focus:ring-2 focus:ring-accent"
                            autoFocus
                            onKeyDown={e => e.key === 'Enter' && handleCreate()}
                        />
                    </div>
                    <div className="flex justify-end gap-3">
                        <button
                            onClick={() => setShowCreate(false)}
                            className="px-4 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-xl"
                        >
                            {t("Cancel")}
                        </button>
                        <button
                            onClick={handleCreate}
                            disabled={!newTitle.trim()}
                            className="px-4 py-2 bg-slate-900 dark:bg-accent text-white rounded-xl hover:bg-slate-800 dark:hover:bg-accent/90 disabled:opacity-50"
                        >
                            {t("Create")}
                        </button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}