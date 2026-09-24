import { ReactNode, CSSProperties, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import { ArrowLeft, Inbox, MessageSquare, Settings, Sparkles } from 'lucide-react';
import SearchBar from './SearchBar';
import ToastContainer from './Toast';
import ConfirmDialog from './ConfirmDialog';
import TaskDock from './TaskDock';
import UpdateBanner from './UpdateBanner';
import MasteryGateModal from './MasteryGateModal';
import PlacementModal from './PlacementModal';
import AnkiImportModal from './AnkiImportModal';
import CompletionSummary from './completion/CompletionSummary';
import CaptureModal from './CaptureModal';
import AssistantDrawer, { DEFAULT_WIDTH, DOCK_QUERY, MIN_WIDTH } from './AssistantDrawer';
import { useAICreationContext } from './aiCreationContext';
import { useAccentVars } from '../hooks/useAccentVars';
import { usePhysicalKeyboard } from '../utils/platform';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useTranslation } from 'react-i18next';

const ASSISTANT_WIDTH_KEY = 'assistant.width';

function storedAssistantWidth(): number {
    if (typeof localStorage === 'undefined') return DEFAULT_WIDTH;
    const raw = Number(localStorage.getItem(ASSISTANT_WIDTH_KEY));
    return Number.isFinite(raw) && raw >= MIN_WIDTH ? raw : DEFAULT_WIDTH;
}

export default function Layout({ children }: { children: ReactNode }) {
    const { t } = useTranslation();
    const view = useStore(s => s.view);
    const setView = useStore(s => s.setView);
    const closeProject = useStore(s => s.closeProject);
    const selectNode = useStore(s => s.selectNode);
    const selectedNodeId = useStore(s => s.selectedNodeId);
    const projects = useStore(s => s.projects);
    const currentProjectId = useStore(s => s.currentProjectId);
    const aiCreationMinimized = useStore(s => s.aiCreationMinimized);
    const setAICreationMinimized = useStore(s => s.setAICreationMinimized);
    const setShowAICreationModal = useStore(s => s.setShowAICreationModal);
    const startAiTaskFeed = useStore(s => s.startAiTaskFeed);
    const masteryGate = useStore(s => s.masteryGate);
    const closeMasteryGate = useStore(s => s.closeMasteryGate);
    const resolveMasteryGate = useStore(s => s.resolveMasteryGate);
    const ankiImportOpen = useStore(s => s.ankiImportOpen);
    const closeAnkiImport = useStore(s => s.closeAnkiImport);
    const placement = useStore(s => s.placement);
    const closePlacement = useStore(s => s.closePlacement);

    // Capture and the assistant are GLOBAL by definition: both exist to be
    // usable without first navigating somewhere, so they live in the app frame
    // rather than on any one screen.
    const [captureOpen, setCaptureOpen] = useState(false);
    // The assistant's open state is in the store, not here: screens deep in the
    // tree (the project dashboard's "ask about this project") open it with a
    // question already in the composer.
    const assistantOpen = useStore(s => s.assistantOpen);
    const openAssistant = useStore(s => s.openAssistant);
    const closeAssistant = useStore(s => s.closeAssistant);
    const [assistantWidth, setAssistantWidth] = useState(storedAssistantWidth);

    // On a wide screen the assistant DOCKS beside the page instead of covering
    // it: no backdrop, no dimming, both halves scroll on their own. That is the
    // whole point of a study assistant — you are reading the thing you want to
    // ask about, and a modal that hides it makes you close the answer to look at
    // the question. Narrow screens have no room for two columns, so there it
    // stays an overlay.
    const assistantDocked = useMediaQuery(DOCK_QUERY) && assistantOpen;

    const resizeAssistant = (px: number) => {
        setAssistantWidth(px);
        try { localStorage.setItem(ASSISTANT_WIDTH_KEY, String(px)); } catch { /* private mode */ }
    };

    // Floating, viewport-positioned furniture (toasts, the task dock) has no way
    // to know a column was carved out of the right of the screen, so the width is
    // published as a CSS variable and those two offset themselves by it.
    useEffect(() => {
        const px = assistantDocked ? `${assistantWidth}px` : '0px';
        document.documentElement.style.setProperty('--assistant-w', px);
    }, [assistantDocked, assistantWidth]);

    // Only name a key on a device that has keys.
    const hasKeyboard = usePhysicalKeyboard();

    // Keyboard: the capture box has to be cheaper than switching apps, and a
    // shortcut is the difference between "I'll save that" and actually saving
    // it. Ignored while typing, so it never eats a "c" mid-sentence.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            const el = e.target as HTMLElement | null;
            if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
            // Caps Lock reports 'C'/'A'; match case-insensitively, but leave
            // deliberate Shift combos alone.
            if (e.shiftKey) return;
            const key = e.key.toLowerCase();
            if (key === 'c') { e.preventDefault(); setCaptureOpen(true); }
            else if (key === 'a') { e.preventDefault(); openAssistant(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [openAssistant]);

    // Global feed of background AI generations — drives the TaskDock on every
    // surface (Today, projects grid, workspace, settings). Idempotent.
    useEffect(() => { startAiTaskFeed(); }, [startAiTaskFeed]);

    // A project can reach its end down paths nothing here knows about — the last
    // card of a deck rated in the feed, an import that arrives already met, a
    // topic closed on another device. The store's own triggers catch the common
    // ones the instant they happen; this is the backstop, and it costs one
    // comparison per project over a list the app already has in hand. The float
    // is only a TRIGGER — `complete` is decided exactly, on the server.
    //
    // One at a time, and each one asked about ONCE. Taking only the first
    // candidate looked right and was not: a finished project that is dismissed
    // but left in Active stays first in that list forever, so a second project
    // finishing behind it would never get its screen at all. The key carries the
    // progress with the id, so a project that drops below 100% and climbs back
    // is a new question rather than one already answered.
    const askedAbout = useRef(new Set<string>());
    const candidates = projects
        .filter(p => (p.status ?? 'active') === 'active' && (p.progress_fraction ?? 0) >= 0.999)
        .map(p => `${p.id}:${Math.round((p.progress_fraction ?? 0) * 1000)}`);
    const candidateKey = candidates.join(',');
    const completionOpen = useStore(s => s.completion != null);
    useEffect(() => {
        // Asking while one is on screen would waste the answer; the effect runs
        // again when this closes, and picks up the next.
        if (completionOpen) return;
        const next = candidates.find(key => !askedAbout.current.has(key));
        if (!next) return;
        askedAbout.current.add(next);
        useStore.getState().checkProjectCompletion(Number(next.split(':')[0]));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [candidateKey, completionOpen]);

    // …and if that landed mid review session, try again when it is over rather
    // than dropping the ending on the floor.
    const completionPending = useStore(s => s.completionPending);
    useEffect(() => {
        if (completionPending == null) return;
        const timer = setInterval(() => useStore.getState().checkProjectCompletion(completionPending), 1500);
        return () => clearInterval(timer);
    }, [completionPending]);

    // Keep the current destination visible in the scrolling tab rail. Without
    // this, arriving at Atlas on a narrow phone leaves the rail parked at
    // "Today" with the tab you are actually on off the right edge — the same
    // "unreachable tab" problem in a different costume.
    const tabRailRef = useRef<HTMLElement | null>(null);
    useEffect(() => {
        const active = tabRailRef.current?.querySelector<HTMLElement>(`[data-tab="${view}"]`);
        active?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }, [view]);

    // …and SAY that it scrolls. The rail hides its scrollbar (`.rail-scroll`),
    // which on a 375px phone left "Calendar" sliced down the middle hard against
    // the search button — indistinguishable from the icons painting over the tab,
    // which is a bug this rail has actually had. A fade at whichever edge has
    // more behind it is the difference between "cut off" and "keeps going".
    const [railFade, setRailFade] = useState<'none' | 'start' | 'end' | 'both'>('none');
    useEffect(() => {
        const el = tabRailRef.current;
        if (!el) { setRailFade('none'); return; }
        const measure = () => {
            const start = el.scrollLeft > 4;
            const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
            setRailFade(start && end ? 'both' : start ? 'start' : end ? 'end' : 'none');
        };
        measure();
        el.addEventListener('scroll', measure, { passive: true });
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => { el.removeEventListener('scroll', measure); ro.disconnect(); };
    }, [view]);

    const navigate = useNavigate();
    const currentProject = projects.find(p => p.id === currentProjectId);
    const { isProjectGenerating } = useAICreationContext();
    const isGenerating = currentProjectId ? isProjectGenerating(currentProjectId) : false;

    const handleBack = () => {
        // In a workspace, "back" is a deterministic hierarchical step *up*, not
        // a browser-history rewind. Walking `history.go(-1)` here retraced every
        // node the user had visited inside the project one entry at a time, so a
        // single click rarely escaped the project. Instead: an open node detail
        // closes back to the workspace list; a bare workspace exits to the
        // projects grid. Predictable regardless of how deep the history stack is.
        if (view === 'workspace') {
            if (selectedNodeId != null) selectNode(null);
            else closeProject();
            return;
        }
        // Other non-global surfaces (Settings): mirror the browser back button
        // when there's an in-app entry to return to, else fall home to Today.
        const idx = (window.history.state?.idx ?? 0) as number;
        if (idx > 0) navigate(-1);
        else setView('today');
    };

    // The global surfaces share a tab strip instead of a back arrow.
    const isGlobalView =
        view === 'today' || view === 'projects' || view === 'calendar'
        || view === 'schedule' || view === 'atlas';
    const globalTabs = [
        { key: 'today' as const, label: t("Today") },
        { key: 'projects' as const, label: t("Projects") },
        { key: 'calendar' as const, label: t("Calendar") },
        { key: 'schedule' as const, label: t("Schedule") },
        { key: 'atlas' as const, label: t("Atlas") },
    ];

    // Theme the whole app around the current project's colour while in a
    // workspace; elsewhere (projects grid, settings) fall back to the default
    // accent defined in index.css.
    const workspaceAccent = useAccentVars(view === 'workspace' ? currentProject?.color : null);
    const accentStyle = workspaceAccent as CSSProperties | undefined;

    return (
        <div className="h-full flex bg-slate-100 dark:bg-slate-900" style={accentStyle}>
        <div className="flex-1 min-w-0 flex flex-col">
            {/* Three columns in normal flow — the search was once absolutely
                centred, which on a phone painted it *on top of* the tab strip.
                Instead the sides split the row with `basis-0`, so they take an
                equal half of the free space and the search sits at the true
                centre. The workspace title keeps `min-w-0` because it must
                truncate.

                The tab strip is a SCROLLING RAIL, and it has to be. The old
                guard was `min-w-fit` on the left column: a nav can't compress
                below its text, so the column kept its content width and the
                search slid right of centre instead of overlapping it. That
                degrades gracefully only while the tabs actually fit. At five
                tabs they stopped: on a phone the strip was wider than the whole
                header, so the row overflowed and the inbox and assistant icons
                — which cannot shrink either — were painted straight over
                "Schedule" and "Atlas", making two destinations unreachable.
                A rail that scrolls keeps every tab reachable at any width, and
                the active one is scrolled into view on navigation so it is
                never the hidden one. */}
            <header className="h-14 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex items-center gap-1 sm:gap-2 px-2 sm:px-4 shrink-0">
                <div className="flex items-center gap-1 sm:gap-3 grow basis-0 min-w-0">
                    {!isGlobalView && (
                        <button onClick={handleBack} aria-label={t("Go back")} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition shrink-0">
                            <ArrowLeft className="w-5 h-5 text-slate-600 dark:text-slate-300" />
                        </button>
                    )}
                    {isGlobalView ? (
                        <nav
                            aria-label={t("Main")}
                            ref={tabRailRef}
                            data-fade={railFade}
                            className="rail-scroll flex items-center gap-1 min-w-0 overflow-x-auto"
                        >
                            {globalTabs.map(tab => (
                                <button
                                    key={tab.key}
                                    onClick={() => setView(tab.key)}
                                    aria-current={view === tab.key ? 'page' : undefined}
                                    data-tab={tab.key}
                                    className={`px-2.5 py-1.5 rounded-lg text-sm font-medium transition shrink-0 ${view === tab.key
                                        ? 'bg-accent/10 text-accent-fg'
                                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'}`}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </nav>
                    ) : (
                        <h1 className="text-lg font-semibold text-slate-900 dark:text-white truncate min-w-0">
                            {view === 'workspace' && currentProject?.name}
                            {view === 'settings' && t("Settings")}
                        </h1>
                    )}
                </div>

                <div className="shrink-0">
                    <SearchBar />
                </div>

                {/* `grow basis-0` on BOTH sides is what centres the search.
                    It is unconditionally right while the left side is the tab
                    rail, and it was made conditional because of a REAL failure
                    on the other views: the icon side cannot shrink below its
                    three icons, so when half the row is narrower than that it
                    takes the difference out of the title column — at a large UI
                    scale a nine-character project name, and even "Settings", measured 79px and
                    rendered as an ellipsis.

                    The SAME rule turned out to be right on the global views, for
                    the opposite reason. `grow basis-0` here splits the free space
                    down the middle, so on a 375px phone the icon column was
                    handed 160px to spend on three 32px icons while the tab rail —
                    holding 349px of destinations — got the identical 160px and
                    showed two and a half of five. The icons cannot shrink and do
                    not want the room; giving it to the rail instead buys back
                    ~44px, which is most of another tab.

                    But `shrink-0` at every width overcorrected, and on a wide
                    Settings page — where there is room for all three — it left
                    the search glued to the right-hand edge, which reads as a
                    layout bug because it is one. The binding constraint is
                    WIDTH, so that is what the rule is keyed on: from `md` up,
                    half the row is comfortably wider than three icons at any UI
                    scale, so both sides take their half and the search sits at
                    the true centre. Below it, the title wins. */}
                <div className="flex items-center gap-2 min-w-0 justify-end shrink-0 md:grow md:basis-0">
                    {view === 'workspace' && isGenerating && !aiCreationMinimized && (
                        <button
                            onClick={() => {
                                setAICreationMinimized(false);
                                setView('projects');
                                setShowAICreationModal(true);
                            }}
                            aria-label={t("AI generation in progress")}
                            className="flex items-center gap-2 px-2 sm:px-3 py-1.5 bg-accent/10 text-accent-fg rounded-lg hover:bg-accent/20 dark:hover:bg-accent/25 transition text-sm font-medium animate-pulse shrink-0"
                        >
                            <Sparkles className="w-4 h-4 shrink-0" />
                            <span className="hidden md:inline">{t("AI generation in progress")}</span>
                        </button>
                    )}
                    <button
                        onClick={() => setCaptureOpen(true)}
                        aria-label={hasKeyboard ? t("Capture something (c)") : t("Capture something")}
                        title={hasKeyboard ? t("Capture something to study later (c)") : t("Capture something to study later")}
                        className="p-1.5 sm:p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition"
                    >
                        <Inbox className="w-5 h-5 text-slate-600 dark:text-slate-300" />
                    </button>
                    <button
                        onClick={() => openAssistant()}
                        aria-label={hasKeyboard ? t("Open the assistant (a)") : t("Open the assistant")}
                        title={hasKeyboard ? t("Ask the assistant (a)") : t("Ask the assistant")}
                        className="p-1.5 sm:p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition"
                    >
                        <MessageSquare className="w-5 h-5 text-slate-600 dark:text-slate-300" />
                    </button>
                    <button
                        onClick={() => setView('settings')}
                        aria-label={t("Settings")}
                        className={`p-1.5 sm:p-2 rounded-lg transition ${view === 'settings' ? 'bg-slate-100 dark:bg-slate-700' : 'hover:bg-slate-100 dark:hover:bg-slate-700'}`}
                    >
                        <Settings className="w-5 h-5 text-slate-600 dark:text-slate-300" />
                    </button>
                </div>
            </header>

            {/* In normal flow, between the header and the content: a release
                notice must never cover the tab rail or a review session's
                rating buttons, and an in-flow strip cannot. Renders nothing
                unless a check actually found a newer version. */}
            <UpdateBanner />

            <main className="flex-1 min-h-0 overflow-hidden">
                {children}
            </main>

            <ToastContainer />
            <ConfirmDialog />

            <CaptureModal open={captureOpen} onClose={() => setCaptureOpen(false)} />

            {/* The Mastery Gate ("mastery check") lives at the app root, not in the
                workspace: the learning feed's checkpoint opens it in place, and
                the feed is not inside a project. It carries its own projectId
                for exactly that reason. */}
            {masteryGate.isOpen && masteryGate.nodeId && masteryGate.projectId && (
                <MasteryGateModal
                    isOpen={masteryGate.isOpen}
                    onClose={closeMasteryGate}
                    nodeId={masteryGate.nodeId}
                    nodeTitle={masteryGate.nodeTitle}
                    projectId={masteryGate.projectId}
                    advisory={masteryGate.advisory}
                    onPassed={() => resolveMasteryGate('completed')}
                    onMarkAnyway={() => resolveMasteryGate('completed')}
                    onSkip={() => resolveMasteryGate('skipped')}
                />
            )}

            {/* The placement probe sits at the root for the same reason the gate
                does: it is offered from a project's dashboard, but a probe under
                way must survive navigating away from it. */}
            {placement.isOpen && placement.projectId && (
                <PlacementModal
                    isOpen={placement.isOpen}
                    onClose={closePlacement}
                    projectId={placement.projectId}
                    projectName={placement.projectName}
                />
            )}

            {/* Reachable from Settings and from the projects grid, so it is
                mounted at the root rather than inside either. */}
            <AnkiImportModal open={ankiImportOpen} onClose={closeAnkiImport} />

            {/* The finished-project screen, at the root for the same reason the
                gate is: a course can be finished from the feed, from a review
                session or from the tree, and none of those is a place to own it. */}
            <CompletionSummary />

            {/* Global background-AI task bar (replaces the old single-purpose
                floating creation card — creation is one chip among the rest). */}
            <TaskDock />
        </div>

        {/* Outside the app column, so a docked assistant takes real layout space
            rather than painting over the page. */}
        <AssistantDrawer
            open={assistantOpen}
            onClose={closeAssistant}
            onCapture={() => setCaptureOpen(true)}
            docked={assistantDocked}
            width={assistantWidth}
            onResize={resizeAssistant}
        />
        </div>
    );
}