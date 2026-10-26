// src/components/ProjectsGrid.tsx
// The Projects page: every project as a card, in Active, Completed and Archived
// sections, reordered and moved between sections by dragging. Starting a new
// project (with AI, through a chat model, or from a file) is NewProjectModal;
// an AI creation, once started, lives in creation/creationRuns.ts.
import {
    useState,
    useEffect,
} from 'react';
import {
    DndContext,
    DragEndEvent,
    DragStartEvent,
    DragOverlay,
    closestCorners,
    MouseSensor,
    TouchSensor,
    useSensor,
    useSensors,
    useDroppable,
    MeasuringStrategy,
} from '@dnd-kit/core';
import {
    SortableContext,
    rectSortingStrategy,
} from '@dnd-kit/sortable';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import ProjectCard from './ProjectCard';
import NewProjectModal from './NewProjectModal';
import { Plus } from 'lucide-react';
import { Button } from './ui/Button';
import { Project } from '../types';
import { api } from '../api';
import { usePointerVerb } from '../utils/platform';
import { useTranslation } from 'react-i18next';
import { takeDraft, type CreationInput } from './creation/creationRuns';

import { projectOrderAfterDrop, type ProjectStatusValue } from '../utils/dragOrder';
import { clearDropFlashes, endDropFlash, flashAfterDrop } from '../utils/dropFlash';

// A *leaf* drop zone shown for an empty section while dragging, so a project can
// be dropped in to change its status. It must NOT wrap a SortableContext —
// nesting a droppable around sortable items makes dnd-kit's rect measurement
// loop ("Maximum update depth exceeded").
function EmptyDropZone({
    status,
    label,
}: {
    status: ProjectStatusValue;
    label: string;
}) {
    const { t } = useTranslation();
    const { setNodeRef, isOver } = useDroppable({ id: `status:${status}` });
    return (
        <div
            ref={setNodeRef}
            className={`rounded-xl border-2 border-dashed py-8 text-center text-sm transition-colors ${isOver
                ? 'border-accent text-accent-fg bg-accent/5'
                : 'border-slate-300 dark:border-slate-600 text-slate-400'
                }`}
        >
            {t("Drop here to mark as {{label}}", { label })}
        </div>
    );
}

// --------------
// MAIN COMPONENT
// --------------

export default function ProjectsGrid() {
    const { t } = useTranslation();
    const pointerVerb = usePointerVerb();
    const projects = useStore(s => s.projects);
    const setProjects = useStore(s => s.setProjects);
    const loadProjects = useStore(s => s.loadProjects);
    const addToast = useStore(s => s.addToast);

    const [showCreate, setShowCreate] = useState(false);
    const [draft, setDraft] = useState<CreationInput | null>(null);
    const [activeProject, setActiveProject] = useState<Project | null>(null);

    const sensors = useSensors(
        // Desktop: start dragging as soon as the mouse moves a little.
        useSensor(MouseSensor, { activationConstraint: { distance: 10 } }),
        // Touch: require a short press-and-hold before a drag begins, so a normal
        // swipe scrolls the page and only a deliberate long-press reorders a card.
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } })
    );

    // "Create your first project" (the welcome's last step, the home checklist)
    // arrives asking for the creation dialog, not the list it sits behind. The
    // request is cleared as it is taken, so Back and a reload show the list.
    const location = useLocation();
    const navigate = useNavigate();
    // The same request carries a run's "Back": a creation that failed before it
    // made a project hands the form back with what was typed in it.
    useEffect(() => {
        if ((location.state as { create?: boolean } | null)?.create !== true) return;
        const taken = takeDraft();
        if (taken) setDraft(taken);
        setShowCreate(true);
        navigate(location.pathname, { replace: true, state: null });
    }, [location.state, location.pathname, navigate]);

    const closeCreate = () => {
        setShowCreate(false);
        setDraft(null);
    };

    // Project Grid Drag

    const statusOf = (id: number, list: Project[]): ProjectStatusValue =>
        (list.find(p => p.id === id)?.status ?? 'active') as ProjectStatusValue;

    const handleDragStart = (event: DragStartEvent) => {
        const project = projects.find(p => p.id === event.active.id);
        setActiveProject(project || null);
        endDropFlash(`project:${event.active.id}`);
    };

    // All reordering / cross-section moves are resolved once, on drop. (Moving a
    // card between SortableContexts live in onDragOver remounts it every pointer
    // move and loops dnd-kit's rect measurement — so we don't do that.) The drop
    // target is either another card or an empty section's drop-zone
    // ("status:<name>"); where that puts the card is `projectOrderAfterDrop`.
    // closestCorners makes the card under the pointer win over its containing
    // section, so drops land where you point.
    const handleDragEnd = async (event: DragEndEvent) => {
        setActiveProject(null);
        const { active, over } = event;
        if (!over) return;

        const draggedId = active.id as number;
        const sourceStatus = statusOf(draggedId, projects);
        const newOrder = projectOrderAfterDrop(projects, draggedId, over.id);
        if (!newOrder) return;
        const targetStatus = statusOf(draggedId, newOrder);

        setProjects(newOrder);
        // Now, not when the overlay lands: the overlay lights up on its way
        // home and the card, hidden until it lands, carries the same flash on.
        flashAfterDrop(`project:${draggedId}`);
        try {
            if (sourceStatus !== targetStatus) {
                await api.updateProject(draggedId, { status: targetStatus });
            }
            await api.reorderProjects(newOrder.map(p => p.id));
        } catch (e: any) {
            clearDropFlashes();
            await loadProjects();
            addToast('error', t("Failed to move project"), e.message);
        }
    };

    // Group projects for display: active (reorderable) on top, then completed &
    // archived below their own dividers.
    const activeProjects = projects.filter(p => (p.status ?? 'active') === 'active');
    const completedProjects = projects.filter(p => p.status === 'completed');
    const archivedProjects = projects.filter(p => p.status === 'archived');

    // ------
    // RENDER
    // ------

    return (
        <>
            <div className="h-full overflow-auto p-8 bg-slate-100 dark:bg-slate-900">
                <div className="max-w-6xl mx-auto">
                    <div className="flex items-center justify-between mb-8">
                        <div>
                            <h2 className="text-2xl font-bold text-slate-900 dark:text-white">
                                {t("Your Projects")}
                            </h2>
                            {/* It said "Drag to reorder • Click to open" — a
                                mouse verb on a phone (there is no click and
                                the drag is a press-and-hold), and it named
                                the wrong action now that every card carries
                                Study. The sentence says what the card DOES,
                                with the verb the reader's own pointer uses
                                (`usePointerVerb`, the same hook the detail
                                panel's rename hint reads). */}
                            <p className="text-slate-500 dark:text-slate-400 mt-1">
                                {t("Study starts a course • {{pointerVerb}} a card to manage it", { pointerVerb: pointerVerb })}
                            </p>
                        </div>
                        {/* One line at every width: a button is a fixed height,
                            so a wrapped label is two lines pressed into 40px.
                            The heading beside it wraps instead. */}
                        <Button variant="primary" className="shrink-0 whitespace-nowrap" icon={<Plus className="w-4 h-4" aria-hidden="true" />} onClick={() => setShowCreate(true)}>
                            {t("New Project")}
                        </Button>
                    </div>

                    <DndContext
                        sensors={sensors}
                        collisionDetection={closestCorners}
                        // Re-measure droppables during the drag so the empty-section
                        // drop zones (which mount only once a drag starts) are detected.
                        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                    >
                        {/* Active section. Plain SortableContext (NO droppable wrapper —
                            wrapping a droppable around sortable items loops dnd-kit's
                            measurement). Cross-section drops land on a card in the target
                            section; empty sections use a separate leaf drop zone below. */}
                        <SortableContext
                            items={activeProjects.map(p => p.id)}
                            strategy={rectSortingStrategy}
                        >
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-fr gap-6 min-h-[2rem]">
                                {activeProjects.map(project => (
                                    <ProjectCard key={project.id} project={project} />
                                ))}
                            </div>
                        </SortableContext>
                        {activeProjects.length === 0 && activeProject && (
                            <EmptyDropZone status="active" label={t("Active")} />
                        )}

                        {([
                            { label: t("Completed"), status: 'completed' as const, items: completedProjects },
                            { label: t("Archived"), status: 'archived' as const, items: archivedProjects },
                        ]).map(section => {
                            const isEmpty = section.items.length === 0;
                            const isDragging = activeProject != null;
                            // Hidden entirely when empty and not dragging.
                            if (isEmpty && !isDragging) return null;
                            return (
                                <div key={section.label}>
                                    <div className="flex items-center gap-3 mt-10 mb-5">
                                        <div className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
                                        <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                                            {section.label} · {section.items.length}
                                        </span>
                                        <div className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
                                    </div>
                                    {isEmpty ? (
                                        <EmptyDropZone status={section.status} label={section.label} />
                                    ) : (
                                        <SortableContext
                                            items={section.items.map(p => p.id)}
                                            strategy={rectSortingStrategy}
                                        >
                                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-fr gap-6 opacity-70 hover:opacity-100 transition-opacity">
                                                {section.items.map(project => (
                                                    <ProjectCard key={project.id} project={project} />
                                                ))}
                                            </div>
                                        </SortableContext>
                                    )}
                                </div>
                            );
                        })}

                        <DragOverlay>
                            {/* Opaque, lifted by its shadow: at 80% the card
                                under it read through (two titles over each
                                other), and the landing ended on a step from 80%
                                to the real card. */}
                            {activeProject && (
                                <div className="h-full rounded-2xl shadow-2xl">
                                    <ProjectCard project={activeProject} isDragOverlay />
                                </div>
                            )}
                        </DragOverlay>
                    </DndContext>

                    {projects.length === 0 && (
                        <div className="text-center py-16">
                            <p className="text-slate-500 dark:text-slate-400 text-lg">{t("No projects yet")}</p>
                            <p className="text-slate-500 dark:text-slate-400 mt-1">
                                {t("Create your first learning project to get started")}
                            </p>
                        </div>
                    )}
                </div>

                <NewProjectModal isOpen={showCreate} draft={draft} onClose={closeCreate} />
            </div>
        </>
    );
}