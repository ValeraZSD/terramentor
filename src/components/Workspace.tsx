import { useRef, useCallback, useEffect, useMemo, useState } from 'react';
import { useStore, WorkspaceView } from '../store';
import { TreeNode } from '../types';
import { todayStr, isLeafNode } from '../utils/tree';
import { useIsMobile } from '../hooks/useMediaQuery';
import Sidebar from './Sidebar';
import NodeTree from './NodeTree';
import DetailPanel from './DetailPanel';
import ProjectTimeline from './schedule/ProjectTimeline';
import CalendarView from './calendar/CalendarView';
import StudyDashboard from './StudyDashboard';
import DeckDashboard from './deck/DeckDashboard';
import VaultProjectView from './VaultProjectView';
import FeedView from './feed/FeedView';
import DeckStudy from './deck/DeckStudy';
import PaceIndicator from './PaceIndicator';
import ScheduleModal from './ScheduleModal';
import { LayoutGrid, GanttChart, Calendar, CalendarClock, BarChart3, Library, Layers, Menu, BookOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { countsInCards } from '../utils/projectShape';
import { useDialogFocus } from '../hooks/useDialogFocus';

export default function Workspace() {
    const { t: tr } = useTranslation();
    const selectedNodeId = useStore(s => s.selectedNodeId);
    const detailPanelWidth = useStore(s => s.detailPanelWidth);
    const setDetailPanelWidth = useStore(s => s.setDetailPanelWidth);
    const workspaceView = useStore(s => s.workspaceView);
    const studyNodeId = useStore(s => s.studyNodeId);
    const setWorkspaceView = useStore(s => s.setWorkspaceView);
    const setShowScheduleModal = useStore(s => s.setShowScheduleModal);
    const currentProjectId = useStore(s => s.currentProjectId);
    const projects = useStore(s => s.projects);
    const tree = useStore(s => s.tree);
    const dueFlashcardCount = useStore(s => s.dueFlashcardCount);

    // The Mastery Gate ("mastery check") modal is mounted in Layout, not here — the
    // learning feed opens it too, and the feed never enters a workspace.

    const resizing = useRef(false);
    // The rail scrolls, so the tab you are ON has to be brought into it —
    // arriving at Vault with the rail parked on Dashboard is the unreachable-tab
    // bug wearing a different hat (the global header rail does the same).
    const tabRailRef = useRef<HTMLDivElement | null>(null);


    const isMobile = useIsMobile();
    const [navDrawerOpen, setNavDrawerOpen] = useState(false);

    // STUDY IS A READING SURFACE, and it gets the home feed's shape: chrome at
    // the top, one centred column under it, nothing down the side. The nav tree
    // is the course's FILING — the thing the stream exists to save you from
    // walking topic by topic — and beside a lesson it costs the reading column
    // ~17rem of every screen while answering a question the reader is not
    // asking. The other five views administer the course and are exactly where
    // the tree belongs; it is one tab away from here.
    const studyView = workspaceView === 'study';

    // Close the nav drawer whenever a node is selected (the detail overlay takes
    // over) or when we leave mobile.
    useEffect(() => {
        setNavDrawerOpen(false);
    }, [selectedNodeId, isMobile]);

    // Open, the phone's nav drawer is a modal over a dimmed page: `Modal`'s
    // contract (focus in and back to the menu button, Tab kept inside,
    // Escape). Closed, it is still in the DOM, slid off screen — `inert`, so
    // Tab no longer walks through a tree nobody can see.
    const drawerRef = useRef<HTMLDivElement>(null);
    useDialogFocus(isMobile && !studyView && navDrawerOpen, drawerRef, { onEscape: () => setNavDrawerOpen(false) });

    const project = projects.find(p => p.id === currentProjectId);
    const hasSchedule = !!(project?.start_date && project?.deadline);
    // What this project HAS decides what it is shown — never where it came from.
    // A project with cards and nothing being taught gets the card page, because
    // a curriculum's questions have no useful answers for it (see
    // DeckDashboard); one with topics gets the ordinary dashboard, with the same
    // card panel inside it when it has cards too. `kind === 'deck'` used to
    // decide this permanently at import, which left one deck's 32 named
    // topics with no tree, no plan and no way to ask for one.
    // The rule is the Projects grid card's (`countsInCards`), not a copy of it.
    const cardsOnly = !!project && countsInCards({
        teaches: project.teaches, topics: project.topic_count, cards: project.card_count,
    });

    const todayTaskCount = useMemo(() => {
        if (!hasSchedule) return 0;
        const today = todayStr();
        let count = 0;
        const walk = (nodes: TreeNode[]) => {
            for (const n of nodes) {
                if (n.is_note) continue;
                if (
                    n.scheduled_start && n.scheduled_end &&
                    n.scheduled_start <= today && n.scheduled_end >= today &&
                    n.status !== 'completed' && n.status !== 'skipped'
                ) {
                    if (isLeafNode(n)) count++;
                }
                walk(n.children);
            }
        };
        walk(tree);
        return count;
    }, [tree, hasSchedule]);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        resizing.current = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    }, []);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!resizing.current) return;
            const newWidth = window.innerWidth - e.clientX;
            setDetailPanelWidth(newWidth);
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
    }, [setDetailPanelWidth]);

    // The rail shows what this project HAS, not what the app can do.
    //
    // Timeline and Calendar are two ways of reading the same thing — a set of
    // dates — and a project with no dates has nothing for either to draw. An
    // imported deck is the clearest case: 1,500 cards, one topic, no schedule,
    // and two tabs offering to plot it against a calendar. They come back the
    // moment the project is given a schedule, which is also the moment they
    // start meaning something. The active tab is always kept, so a deep link or
    // a schedule that was just cleared never strands the learner on a view with
    // no way back to it.
    //
    // A card-only project names its first tab "Deck" rather than "Dashboard" —
    // it is not a summary of a plan, it is the cards — and drops the category
    // board, whose whole vocabulary (categories, items, "Add Category") belongs
    // to a project with topics. Its stages are reachable from the card page's
    // ladder, which is a better list of them than a grid of cards would be.
    //
    // STUDY COMES FIRST AND IS ALWAYS THERE. It is the only tab here that
    // teaches — the rest administer the course — so it may not be a view
    // without a tab: a course opened from the grid would land on a dashboard
    // of counts with no visible way to learn it, leaving a 14px ⋮ on a tree
    // row as the way in.
    const viewTabs = ([
        { key: 'study', label: tr("Study"), icon: BookOpen, when: true },
        { key: 'dashboard', label: cardsOnly ? tr("Deck") : tr("Dashboard"), icon: cardsOnly ? Layers : BarChart3, when: true },
        { key: 'tree', label: tr("Tree"), icon: LayoutGrid, when: !cardsOnly },
        { key: 'timeline', label: tr("Timeline"), icon: GanttChart, when: hasSchedule },
        { key: 'calendar', label: tr("Calendar"), icon: Calendar, when: hasSchedule },
        { key: 'vault', label: tr("Vault"), icon: Library, when: true },
    ] as { key: WorkspaceView; label: string; icon: typeof LayoutGrid; when: boolean }[])
        .filter(t => t.when || workspaceView === t.key);

    useEffect(() => {
        const el = tabRailRef.current?.querySelector<HTMLElement>(`[data-tab="${workspaceView}"]`);
        el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [workspaceView]);

    // The pace pill's full form is shown only when it fits beside EVERY tab —
    // measured on this row, never guessed from the window. The width the full
    // form needs is remembered from the last time it was on screen, so the
    // decision does not depend on which form is showing and cannot flicker.
    const barRef = useRef<HTMLDivElement | null>(null);
    const sideRef = useRef<HTMLDivElement | null>(null);
    const fullSideWidth = useRef<number | null>(null);
    const [paceFull, setPaceFull] = useState(true);
    const tabKeys = viewTabs.map(t => t.key).join();
    useEffect(() => {
        const bar = barRef.current, rail = tabRailRef.current, side = sideRef.current;
        if (!bar || !rail || !side) return;
        const fit = () => {
            const items = rail.children;
            if (items.length === 0) return;
            const tabs = items[items.length - 1].getBoundingClientRect().right - items[0].getBoundingClientRect().left;
            const cs = getComputedStyle(bar);
            const room = bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - (parseFloat(cs.columnGap) || 0);
            if (paceFull) {
                fullSideWidth.current = side.getBoundingClientRect().width;
                // The arithmetic above can be a few pixels optimistic (the
                // active tab's padding, a badge); the rail itself overflowing
                // is the fact. Its shortfall joins what the full form needs,
                // so the next measurement agrees and the pill does not flip back.
                const short = rail.scrollWidth - rail.clientWidth;
                if (short > 1) fullSideWidth.current += short;
            }
            const need = fullSideWidth.current;
            const next = need == null || tabs + need <= room;
            if (next !== paceFull) setPaceFull(next);
        };
        fit();
        const ro = new ResizeObserver(fit);
        ro.observe(bar);
        ro.observe(side);
        for (const item of Array.from(rail.children)) ro.observe(item);
        return () => ro.disconnect();
    }, [paceFull, tabKeys]);

    // The rail scrolls, so SAY it does (the global header's device: `.rail-scroll`
    // hides the bar, `data-fade` fades the edge with more behind it). A visible
    // thin scrollbar did neither well: it added ~11px to the bar on exactly the
    // tabs where the rail overflowed, and a last tab sliced to "Хра" read as a
    // rendering fault rather than as more.
    const [railFade, setRailFade] = useState<'none' | 'start' | 'end' | 'both'>('none');
    useEffect(() => {
        const el = tabRailRef.current;
        if (!el) return;
        const measure = () => {
            const start = el.scrollLeft > 4;
            const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
            setRailFade(start && end ? 'both' : start ? 'start' : end ? 'end' : 'none');
        };
        measure();
        el.addEventListener('scroll', measure, { passive: true });
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        for (const item of Array.from(el.children)) ro.observe(item);
        return () => { el.removeEventListener('scroll', measure); ro.disconnect(); };
    }, [tabKeys]);

    return (
        <div className="h-full flex flex-col overflow-hidden">
            {/* Top bar with view switcher and pace */}
            {/* The view tabs and the pace pill share one row, and at a large UI
                scale they stop fitting: the right-hand group is `shrink-0`, so
                measured at 160% on a 375px phone it took 290 of 375px and left
                the tab rail an 81px window onto 496px of tabs — technically
                scrollable, in practice a third of one tab, with Timeline,
                Calendar and Vault effectively gone. Navigation loses that
                argument to a status readout, always.

                So the row WRAPS instead of strangling the rail: the rail keeps
                a floor wide enough to be a navigation control (in `rem`, so it
                tracks the tab size the same scale is growing), and when the
                pace pill and schedule button no longer fit beside it they take
                a second line rather than taking the rail's width. Nothing
                changes at the default scale, where it all still fits on one
                row. */}
            <div ref={barRef} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
                {/* The views are routes, so this is a `nav` and the tab you are on
                    is `aria-current="page"`: a tab pattern would owe arrow-key
                    behaviour and panels this rail does not have. */}
                <nav ref={tabRailRef} aria-label={tr("Project views")} data-fade={railFade} className="rail-scroll flex items-center gap-1 min-w-[9rem] flex-1 overflow-x-auto">
                    {!studyView && (
                        <button
                            onClick={() => setNavDrawerOpen(true)}
                            className="md:hidden shrink-0 p-1.5 mr-1 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                            title={tr("Open navigation")}
                            aria-label={tr("Open navigation")}
                        >
                            <Menu className="w-5 h-5" />
                        </button>
                    )}
                    {viewTabs.map(tab => {
                        const Icon = tab.icon;
                        const isCalendarTab = tab.key === 'calendar';
                        const isDashboardTab = tab.key === 'dashboard';
                        return (
                            <button
                                key={tab.key}
                                data-tab={tab.key}
                                aria-current={workspaceView === tab.key ? 'page' : undefined}
                                onClick={() => setWorkspaceView(tab.key)}
                                className={`relative flex items-center gap-1.5 shrink-0 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${workspaceView === tab.key
                                    ? 'bg-accent/10 text-accent-fg'
                                    : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                                    }`}
                            >
                                <Icon className="w-4 h-4" />
                                {/* A phone used to get SIX UNLABELLED ICONS:
                                    the rail said neither where you are nor
                                    what anything does. Two labels always
                                    survive the narrow width — the tab you are
                                    ON, so the rail answers "where am I", and
                                    Study, so the one that teaches is never a
                                    glyph to be guessed at. The rest still
                                    collapse; the rail scrolls. Collapsed is
                                    `sr-only`, never `hidden`: `display: none`
                                    took the name away from a screen reader too,
                                    and four buttons were announced as nothing. */}
                                <span className={tab.key === 'study' || workspaceView === tab.key ? 'inline' : 'sr-only sm:not-sr-only'}>{tab.label}</span>
                                {isCalendarTab && todayTaskCount > 0 && (
                                    <span className={`ml-0.5 px-1.5 py-0.5 text-3xs font-bold rounded-full ${workspaceView === 'calendar'
                                        ? 'bg-accent text-white'
                                        : 'bg-red-600 text-white'
                                        }`}>
                                        {todayTaskCount}
                                    </span>
                                )}
                                {/* Reviews OWED. This used to come from a query
                                    that treated every never-reviewed card as
                                    due — on the real 1,501-card import the badge
                                    read "1483", which is the whole deck, not a
                                    queue — so it was hidden on decks and wrong
                                    everywhere else. It counts one thing now
                                    (server/decks.js `reviewDue`), so every
                                    project may show it. */}
                                {isDashboardTab && dueFlashcardCount > 0 && (
                                    <span className={`ml-0.5 px-1.5 py-0.5 text-3xs font-bold rounded-full ${workspaceView === 'dashboard'
                                        ? 'bg-accent text-white'
                                        : 'bg-amber-600 text-white'
                                        }`}>
                                        {dueFlashcardCount}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </nav>

                <div ref={sideRef} className="flex items-center gap-3 shrink-0">
                    <PaceIndicator full={paceFull} />

                    <button
                        onClick={() => setShowScheduleModal(true, currentProjectId)}
                        // A project with nothing being taught is not urged to
                        // pick a deadline. It can have one (a language exam in
                        // December is a real date), but a pile of cards has no
                        // end to schedule towards, so the accent-filled "you
                        // have not done this yet" treatment is a nudge in the
                        // wrong direction.
                        className={`relative flex items-center gap-1.5 shrink-0 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${hasSchedule || cardsOnly
                            ? 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                            : 'text-white bg-accent hover:bg-accent/90'
                            }`}
                    >
                        <CalendarClock className="w-4 h-4" />
                        <span className="sr-only sm:not-sr-only">{hasSchedule ? tr("Edit Schedule") : tr("Set Schedule")}</span>
                    </button>
                </div>
            </div>

            {/* Main content area */}
            <div className="flex-1 flex overflow-hidden">
                {/* Sidebar: inline on desktop, off-canvas drawer on mobile —
                    and absent on Study either way (see `studyView`). */}
                {!isMobile && !studyView && <Sidebar />}

                {isMobile && !studyView && (
                    <>
                        <div
                            className={`fixed inset-0 bg-black/50 z-30 transition-opacity ${navDrawerOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                            onClick={() => setNavDrawerOpen(false)}
                            aria-hidden="true"
                        />
                        <div
                            ref={drawerRef}
                            tabIndex={-1}
                            // `inert` is a real attribute React 18 types as unknown; the string form is what the DOM wants.
                            {...(navDrawerOpen
                                ? { role: 'dialog', 'aria-modal': true, 'aria-label': tr("Navigation") }
                                : ({ inert: '' } as Record<string, string>))}
                            className={`fixed inset-y-0 left-0 z-40 w-[85vw] max-w-xs outline-none transition-[transform,box-shadow] duration-300 ${navDrawerOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'}`}
                        >
                            <Sidebar isDrawer />
                        </div>
                    </>
                )}

                {/* Center content based on view */}
                <div className="flex-1 flex flex-col overflow-hidden bg-slate-100 dark:bg-slate-900 min-w-0">
                    {workspaceView === 'dashboard' && (cardsOnly ? <DeckDashboard /> : <StudyDashboard />)}
                    {workspaceView === 'tree' && <NodeTree />}
                    {workspaceView === 'timeline' && <ProjectTimeline />}
                    {workspaceView === 'calendar' && currentProjectId != null && (
                        <CalendarView scope={{ kind: 'project', projectId: currentProjectId }} />
                    )}
                    {workspaceView === 'vault' && <VaultProjectView />}
                    {/* Study is the scoped stream — except for a project measured
                        in cards, where it is the review session (DeckStudy): a
                        deck has nothing to teach, so the stream would only hand
                        its cards over one at a time without the rating footer,
                        the keys or undo. */}
                    {workspaceView === 'study' && (cardsOnly && currentProjectId != null
                        ? <DeckStudy projectId={currentProjectId} nodeId={studyNodeId} />
                        : <FeedView studyNodeId={studyNodeId} studyProjectId={studyNodeId == null ? currentProjectId : null} />)}
                </div>

                {/* Detail panel: resizable aside on desktop, full-screen overlay on
                    mobile. The overlay no longer draws its own title + Close bar —
                    DetailPanel's header carries both on every platform, so the phone
                    doesn't spend 3rem of screen repeating the title. */}
                {selectedNodeId && (
                    isMobile ? (
                        <div className="fixed inset-0 z-40 flex flex-col bg-white dark:bg-slate-800">
                            <DetailPanel />
                        </div>
                    ) : (
                        <aside
                            className="bg-white dark:bg-slate-800 border-l border-slate-200 dark:border-slate-700 flex flex-col shrink-0 overflow-hidden relative"
                            style={{ width: detailPanelWidth }}
                        >
                            <div
                                className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-accent transition-colors z-10"
                                onMouseDown={handleMouseDown}
                            />
                            <DetailPanel />
                        </aside>
                    )
                )}
            </div>

            {/* Schedule modal */}
            <ScheduleModal />
        </div>
    );
}
