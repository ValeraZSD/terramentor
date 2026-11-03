// src/components/ProjectsGrid.tsx
// The Projects page: every project as a card, in Active, Completed and Archived
// sections, reordered and moved between sections by dragging. Each card carries
// its dates and pace (schedule/ProjectDates.tsx), which is all the Schedule
// screen held that this one did not, so that screen is gone. Starting a new
// project (with AI, through a chat model, or from a file) is NewProjectModal;
// an AI creation, once started, lives in creation/creationRuns.ts.
import {
    useState,
    useEffect,
    useCallback,
    useRef,
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
import { Plus, Search, X } from 'lucide-react';
import { Button, IconButton } from './ui/Button';
import { TextInput } from './ui/Field';
import { SegmentedControl } from './ui/SegmentedControl';
import { RecordCard } from './projects/RecordCard';
import { COMPACT_GRID } from './projects/CompactCard';
import { Project, ScheduleOverviewRow, StagedDocument } from '../types';
import { api } from '../api';
import { usePointerVerb } from '../utils/platform';
import { useTranslation } from 'react-i18next';
import { takeDraft, type CreationInput } from './creation/creationRuns';
import ShortCourses, { SectionLabel } from './shortCourses/ShortCourses';
import type { ShortCourseRow } from './shortCourses/shortCourseTypes';

import { projectOrderAfterDrop, type ProjectStatusValue } from '../utils/dragOrder';
import { endDropFlash, endDropFlashIf, flashAfterDrop } from '../utils/dropFlash';

/**
 * The card grid. `auto-fill` with a floor, never a viewport breakpoint: the
 * layout follows the room the page actually has.
 *
 * The floor is 21.25rem (340px), so a card's DATE EDITOR, two columns, keeps
 * each column at ~145px: 40px of padding and 2 of border leave 298, an 8px gap
 * between. That is well above the 108px below which a native date field clips
 * its own year, and wide enough for Remove schedule under the start. `min(100%,
 * …)` lets a phone narrower than that have one full-width column.
 *
 * `auto-rows-fr` makes every card in a section equally tall; with the dates
 * and the footer pinned to the bottom (`mt-auto`), the rows stay level.
 */
const GRID = 'grid auto-rows-fr gap-6 [grid-template-columns:repeat(auto-fill,minmax(min(100%,21.25rem),1fr))]';

/** Which of the page's three views is open: `?show=` in the URL, Active by default. */
type Show = 'active' | 'finished' | 'archived';
const showFrom = (search: string): Show => {
    const v = new URLSearchParams(search).get('show');
    return v === 'finished' || v === 'archived' ? v : 'active';
};

/** From this many projects the page offers to find one by name. */
const FIND_FROM = 12;

/** Case and accents aside, so "resume" finds "Résumé". */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

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
    const aiTasks = useStore(s => s.aiTasks);

    const [showCreate, setShowCreate] = useState(false);
    const [draft, setDraft] = useState<CreationInput | null>(null);
    const [activeProject, setActiveProject] = useState<Project | null>(null);

    // Each project's pace, open topics and topic extent (`calculatePace` and
    // two grouped counts, server-side). The dates themselves are the project's
    // own, so a failed load costs the pace pills and nothing else: no toast for
    // a verdict the cards simply do not show. Re-read whenever a project's
    // window, status or progress changes (every write path reloads the list),
    // and after the strip writes: a reschedule inside the same window changes
    // none of those fields. Only the LATEST request may land, and the key is
    // sorted by id so a drag (a new order, the same projects) asks nothing.
    const [schedule, setSchedule] = useState<Map<number, ScheduleOverviewRow>>(() => new Map());
    const scheduleSeq = useRef(0);
    const loadSchedule = useCallback(async () => {
        const seq = ++scheduleSeq.current;
        try {
            const data = await api.getScheduleOverview();
            if (seq === scheduleSeq.current) setSchedule(new Map(data.projects.map(r => [r.id, r])));
        } catch { /* the cards keep their dates; the pills wait for the next load */ }
    }, []);
    const scheduleKey = [...projects].sort((a, b) => a.id - b.id)
        .map(p => `${p.id}:${p.status}:${p.start_date}:${p.deadline}:${p.completed_topic_count}:${p.progress_fraction}`)
        .join(',');
    useEffect(() => { void loadSchedule(); }, [loadSchedule, scheduleKey]);

    // The short courses (shortCourses/ShortCourses.tsx): drawn on their strip
    // above the grid and left out of it. Re-read when a project changes (made,
    // written, archived, deleted, a topic closed) and when a short course's
    // task moves, which is when its topics land. Only the LATEST request lands.
    const [shortRows, setShortRows] = useState<ShortCourseRow[] | null>(null);
    const shortSeq = useRef(0);
    const loadShort = useCallback(async () => {
        const seq = ++shortSeq.current;
        try {
            const data = await api.listShortCourses();
            if (seq === shortSeq.current) setShortRows(data.courses);
        } catch {
            // The strip keeps what it had; until a first answer the courses
            // stay in the grid rather than nowhere.
            if (seq === shortSeq.current) setShortRows(rows => rows ?? []);
        }
    }, []);
    const shortKey = projects
        .map(p => `${p.id}:${p.status}:${p.ai_generating ?? 0}:${p.topic_count ?? 0}:${p.completed_topic_count ?? 0}:${p.made_from ? 1 : 0}`)
        .join(',');
    useEffect(() => { void loadShort(); }, [loadShort, shortKey]);
    const shortTaskKey = aiTasks.filter(task => task.kind === 'short_course').map(task => `${task.id}:${task.status}`).join(',');
    useEffect(() => {
        if (!shortTaskKey) return;
        void loadShort();
        void loadProjects({ silent: true });
    }, [shortTaskKey, loadShort, loadProjects]);
    const shortChanged = useCallback(() => {
        void loadShort();
        void loadProjects({ silent: true });
    }, [loadShort, loadProjects]);
    // A book read on the strip, made a FULL course instead: the New course
    // dialog opens with it as the course's material.
    const fullCourse = useCallback((doc: StagedDocument, title: string) => {
        setDraft({ name: title, description: '', color: '', icon: '', language: '', documents: [doc] });
        setShowCreate(true);
    }, []);

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
        // Now, not when the overlay lands: the overlay carries the ring on its
        // way home and the card, hidden until it lands, carries the same one on.
        const flash = flashAfterDrop(`project:${draggedId}`);
        try {
            if (sourceStatus !== targetStatus) {
                await api.updateProject(draggedId, { status: targetStatus });
            }
            await api.reorderProjects(newOrder.map(p => p.id));
        } catch (e: any) {
            // This drop's flash only: the card may have been dropped again since.
            endDropFlashIf(`project:${draggedId}`, flash);
            await loadProjects();
            addToast('error', t("Failed to move project"), e.message);
        }
    };

    // Group projects for display: active (reorderable) on top, then completed &
    // archived below their own dividers.
    // The learner's own order is the only order: a "Sort: Deadline" control
    // was built and taken out, since every card already shows its own dates.
    // A short course is on the strip, not in these sections; before the strip's
    // list arrives, every unarchived course made from a source is taken to be
    // one, so none flashes into the grid and out again.
    const shortIds = new Set((shortRows ?? []).map(r => r.id));
    const onStrip = (p: Project) => (shortRows ? shortIds.has(p.id) : !!p.made_from && p.status !== 'archived');

    // Three views of one library. Active is what is being studied, short and
    // full; Finished and Archived hold both kinds as small cards, newest
    // first, one press away with their counts always on the switch, so a
    // course that left Active is never "gone". The name filter narrows all
    // three at once and the counts follow it, so a match in another view
    // shows on that view's segment instead of hiding.
    const show = showFrom(location.search);
    const setShow = (next: Show) => navigate(next === 'active' ? '/projects' : `/projects?show=${next}`, { replace: true });
    const [query, setQuery] = useState('');
    const findRef = useRef<HTMLInputElement>(null);
    const q = fold(query.trim());
    const matches = (name: string) => !q || fold(name).includes(q);
    const byId = new Map(projects.map(p => [p.id, p]));
    const isActive = (p: Project) => (p.status ?? 'active') === 'active';

    const activeProjects = projects.filter(p => isActive(p) && !onStrip(p) && matches(p.name));
    // What needs the learner first: the one being written (just made), then
    // those under way (last studied first), then those not begun (newest
    // first), and last the ones done to the end and kept in Active.
    const stage = (r: ShortCourseRow) =>
        r.state === 'building' || r.state === 'failed' ? 0 : r.state === 'studying' ? 1 : r.state === 'ready' ? 2 : 3;
    const activeShort = (shortRows ?? []).filter(r => {
        const p = byId.get(r.id);
        return (!p || isActive(p)) && matches(r.name);
    }).sort((a, b) => stage(a) - stage(b)
        || (byId.get(b.id)?.last_done_at ?? '').localeCompare(byId.get(a.id)?.last_done_at ?? '')
        || b.id - a.id);
    const recent = (a: Project, b: Project) => (b.last_done_at ?? '').localeCompare(a.last_done_at ?? '') || b.id - a.id;
    const finishedProjects = projects.filter(p => p.status === 'completed' && matches(p.name)).sort(recent);
    const archivedProjects = projects.filter(p => p.status === 'archived' && matches(p.name))
        .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '') || b.id - a.id);
    const counts: Record<Show, number> = {
        active: activeProjects.length + activeShort.length,
        finished: finishedProjects.length,
        archived: archivedProjects.length,
    };
    // A first library has nothing finished or put away: no switch to explain.
    const hasRecords = projects.some(p => p.status === 'completed' || p.status === 'archived');
    const canFind = projects.length >= FIND_FROM;

    // ------
    // RENDER
    // ------

    return (
        <>
            <div className="h-full overflow-auto px-4 py-6 sm:p-8 bg-slate-100 dark:bg-slate-900">
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

                    {(hasRecords || canFind) && (
                        // The switch and the name filter: one line where the page
                        // is wide; on a phone the filter wraps under the switch
                        // and takes the whole line.
                        <div className="flex flex-wrap items-center gap-3 mb-8">
                            {hasRecords && (
                                <SegmentedControl<Show>
                                    label={t("Which courses")}
                                    onPage
                                    value={show}
                                    onChange={setShow}
                                    options={(['active', 'finished', 'archived'] as const).map(v => ({
                                        value: v,
                                        label: (
                                            <span className="inline-flex items-baseline gap-1.5">
                                                {v === 'active' ? t("Active") : v === 'finished' ? t("Finished") : t("Archived")}
                                                <span className="tabular-nums text-slate-500 dark:text-slate-400">{counts[v]}</span>
                                            </span>
                                        ),
                                    }))}
                                />
                            )}
                            {canFind && (
                                // A text field, not `type="search"`: Edge and Chrome
                                // draw their own blue ✕ inside a search field, one
                                // the app does not style. Ours is the one clear.
                                <div className="relative flex-1 min-w-[14rem] max-w-sm ml-auto">
                                    <TextInput
                                        ref={findRef}
                                        type="text"
                                        role="searchbox"
                                        enterKeyHint="search"
                                        icon={<Search className="w-4 h-4" aria-hidden="true" />}
                                        value={query}
                                        onChange={e => setQuery(e.target.value)}
                                        onKeyDown={e => {
                                            if (e.key === 'Escape' && query && !e.nativeEvent.isComposing) { e.stopPropagation(); setQuery(''); }
                                        }}
                                        placeholder={t("Find a course…")}
                                        aria-label={t("Find a course…")}
                                        className={query ? 'pr-10 touch:pr-12' : undefined}
                                    />
                                    {query && (
                                        <IconButton
                                            size="sm"
                                            className="absolute right-1 top-1/2 -translate-y-1/2"
                                            // Clearing keeps the caret in the field.
                                            onMouseDown={e => e.preventDefault()}
                                            onClick={() => { setQuery(''); findRef.current?.focus(); }}
                                            label={t("Clear")}
                                            icon={<X className="w-4 h-4" aria-hidden="true" />}
                                        />
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {show === 'active' && (
                        <>
                            <ShortCourses rows={shortRows ? activeShort : null} projects={projects} onChanged={shortChanged} onFullCourse={fullCourse} showBox={!q} />
                            {activeProjects.length > 0 && (
                                <SectionLabel>{t("Courses")} · {activeProjects.length}</SectionLabel>
                            )}

                            {/* Only Active is reordered by dragging: Finished and
                                Archived are in the order they ended. A course
                                changes view by its menu (Mark completed, Archive,
                                Move to active). */}
                            <DndContext
                                sensors={sensors}
                                collisionDetection={closestCorners}
                                measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
                                onDragStart={handleDragStart}
                                onDragEnd={handleDragEnd}
                            >
                                <SortableContext items={activeProjects.map(p => p.id)} strategy={rectSortingStrategy}>
                                    <div className={GRID}>
                                        {activeProjects.map(project => (
                                            <ProjectCard key={project.id} project={project} schedule={schedule.get(project.id)} onScheduleChanged={loadSchedule} />
                                        ))}
                                    </div>
                                </SortableContext>
                                <DragOverlay>
                                    {/* Opaque, lifted by its shadow: at 80% the card
                                        under it read through (two titles over each
                                        other), and the landing ended on a step from 80%
                                        to the real card. */}
                                    {activeProject && (
                                        <div className="h-full rounded-2xl shadow-2xl">
                                            <ProjectCard project={activeProject} schedule={schedule.get(activeProject.id)} isDragOverlay />
                                        </div>
                                    )}
                                </DragOverlay>
                            </DndContext>

                            {q && counts.active === 0 && (
                                <p className="py-12 text-center text-slate-500 dark:text-slate-400">
                                    {t("No active course matches “{{query}}”.", { query: query.trim() })}
                                </p>
                            )}
                            {!q && projects.length > 0 && counts.active === 0 && (
                                <p className="py-12 text-center text-slate-500 dark:text-slate-400">
                                    {t("Nothing in progress. Paste a link above for a short course, or start a new project.")}
                                </p>
                            )}
                        </>
                    )}

                    {show !== 'active' && (() => {
                        const items = show === 'finished' ? finishedProjects : archivedProjects;
                        if (!items.length) {
                            return (
                                <p className="py-12 text-center text-slate-500 dark:text-slate-400">
                                    {q ? t("Nothing here matches “{{query}}”.", { query: query.trim() })
                                        : show === 'finished' ? t("Nothing finished yet. A course you finish moves here.")
                                            : t("Nothing archived. A course you archive leaves Active and waits here.")}
                                </p>
                            );
                        }
                        return (
                            <div className={COMPACT_GRID}>
                                {items.map(p => <RecordCard key={p.id} project={p} onChanged={shortChanged} />)}
                            </div>
                        );
                    })()}

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