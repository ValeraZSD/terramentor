import { ReactNode, CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import { ArrowLeft, ChevronDown, Inbox, MessageSquare, Settings, Sparkles } from 'lucide-react';
import SearchBar from './SearchBar';
import { MenuItem, MenuPopover, menuTriggerKeys } from './ui/Popover';
import { Button, IconButton } from './ui/Button';
import { Chip } from './ui/Chip';
import { fitHeader, type HeaderFit } from '../utils/headerFit';
import ToastContainer from './Toast';
import ConfirmDialog from './ConfirmDialog';
import TaskDock from './TaskDock';
import UpdateControl from './update/UpdateControl';
import UpdateNotice from './update/UpdateNotice';
import ExposedBanner from './ExposedBanner';
import MasteryGateModal from './MasteryGateModal';
import PlacementModal from './PlacementModal';
import AnkiImportModal from './AnkiImportModal';
import CompletionSummary from './completion/CompletionSummary';
import CaptureModal from './CaptureModal';
import AssistantDrawer, { DEFAULT_WIDTH, DOCK_QUERY, MIN_WIDTH } from './AssistantDrawer';
import { useAICreationContext } from './aiCreationContext';
import CreationRunHost from './creation/CreationRunHost';
import { useAccentVars } from '../hooks/useAccentVars';
import { usePhysicalKeyboard } from '../utils/platform';
import { appMayTakeShortcut } from '../utils/escapeKey';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useElementWidth } from '../hooks/useElementWidth';
import { useRootFontSize } from '../hooks/useRootFontSize';
import { useTranslation } from 'react-i18next';

const ASSISTANT_WIDTH_KEY = 'assistant.width';

function storedAssistantWidth(): number {
    if (typeof localStorage === 'undefined') return DEFAULT_WIDTH;
    const raw = Number(localStorage.getItem(ASSISTANT_WIDTH_KEY));
    return Number.isFinite(raw) && raw >= MIN_WIDTH ? raw : DEFAULT_WIDTH;
}

/**
 * One of the top bar's own actions: its word beside the icon while the bar has
 * room (`barLabels`), the icon alone, named, when it has not. At the bar's
 * size, `md` (40px, 14px words), which the tabs, the search, the back arrow and
 * the update button share: at `sm` the words dropped to 12px beside 14px tabs.
 * `subtle` while its screen is the one open.
 */
function BarAction({ labelled, active = false, onClick, icon, text, label, title }: {
    labelled: boolean;
    active?: boolean;
    onClick: () => void;
    icon: ReactNode;
    text: string;
    /** The name when only the icon is drawn. */
    label: string;
    title?: string;
}) {
    const variant = active ? 'subtle' : 'quiet';
    const current = active ? 'page' as const : undefined;
    return labelled
        ? <Button variant={variant} icon={icon} title={title} aria-current={current} onClick={onClick} className="whitespace-nowrap">{text}</Button>
        : <IconButton variant={variant} icon={icon} label={label} title={title ?? label} aria-current={current} onClick={onClick} />;
}

export default function Layout({ children }: { children: ReactNode }) {
    const { t, i18n } = useTranslation();
    const view = useStore(s => s.view);
    const setView = useStore(s => s.setView);
    const closeProject = useStore(s => s.closeProject);
    const selectNode = useStore(s => s.selectNode);
    const selectedNodeId = useStore(s => s.selectedNodeId);
    const projects = useStore(s => s.projects);
    const currentProjectId = useStore(s => s.currentProjectId);
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
    // it. Ignored while typing, so it never eats a "c" mid-sentence, and while
    // a dialog or a review session owns the keyboard (`appMayTakeShortcut`).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            // Caps Lock reports 'C'/'A'; match case-insensitively. Shift combos
            // are left alone by the rule.
            if (!appMayTakeShortcut(e)) return;
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
    // candidate would be wrong: a finished project that is dismissed but left
    // in Active stays first in that list forever, so a second project
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

    // Words beside the three right-hand icons, when the header has the room.
    // Measured on the header itself, never `xl:`: the assistant docks beside
    // this column at a width the learner drags, so the same window has a much
    // narrower header with it open and the labels (beside a search that
    // cannot shrink) would take the tab rail's half of the row. 56rem is where
    // each half still holds them; a running AI-generation pill, which sits in
    // that group too, takes the room first.
    const headerRef = useRef<HTMLElement | null>(null);
    const headerWidth = useElementWidth(headerRef);
    const rootPx = useRootFontSize();

    const navigate = useNavigate();
    const currentProject = projects.find(p => p.id === currentProjectId);
    const { isProjectGenerating, openGenerationModal } = useAICreationContext();
    const isGenerating = currentProjectId ? isProjectGenerating(currentProjectId) : false;
    const barLabels = headerWidth >= 56 * rootPx && !(view === 'workspace' && isGenerating);

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

    // What the bar shows at its OWN width (`fitHeader`): centred search, then
    // the icons' spare room to the rail, then the search as its icon, then a
    // "More" menu for the tabs that still do not fit. Every input is a natural
    // width, read off the elements: the tabs and the More button from a hidden
    // row that is never squeezed, the icons by summing their own boxes, the
    // search as whichever form is drawn now. The other form's width is kept
    // from when it was drawn, per language, text size and keyboard.
    const searchWrapRef = useRef<HTMLDivElement | null>(null);
    const rightRef = useRef<HTMLDivElement | null>(null);
    const measureRef = useRef<HTMLDivElement | null>(null);
    const moreRef = useRef<HTMLButtonElement | null>(null);
    const [moreOpen, setMoreOpen] = useState(false);
    const [fit, setFit] = useState<HeaderFit | null>(null);
    const searchWidths = useRef<{ key: string; full?: number; icon?: number }>({ key: '' });
    const fitKey = `${i18n.language}|${rootPx}|${hasKeyboard}`;
    const activeTab = globalTabs.findIndex(tab => tab.key === view);
    const searchIcon = !!fit?.searchIcon;
    useLayoutEffect(() => {
        if (!isGlobalView) return;
        const measure = () => {
            const header = headerRef.current, row = measureRef.current, right = rightRef.current, searchEl = searchWrapRef.current;
            if (!header || !row || !right || !searchEl || !header.clientWidth) return;
            const cache = searchWidths.current;
            if (cache.key !== fitKey) searchWidths.current = { key: fitKey };
            const searchNow = searchEl.getBoundingClientRect().width;
            if (searchIcon) searchWidths.current.icon = searchNow; else searchWidths.current.full = searchNow;
            const { full, icon } = searchWidths.current;
            // The words' width is not known yet (a new language): draw them once to learn it.
            if (full === undefined) { setFit(f => (f ? { ...f, searchIcon: false } : f)); return; }
            const gapOf = (el: Element) => parseFloat(getComputedStyle(el).columnGap) || 0;
            const hs = getComputedStyle(header);
            const kids = [...right.children].map(el => el.getBoundingClientRect().width).filter(w => w > 0);
            const cells = [...row.children].map(el => el.getBoundingClientRect().width);
            const more = cells.pop() ?? 0;
            const next = fitHeader({
                inner: header.clientWidth - parseFloat(hs.paddingLeft) - parseFloat(hs.paddingRight),
                gap: gapOf(header),
                search: full,
                // Unseen yet: the touch floor, the widest the icon is drawn.
                searchIcon: icon ?? 44,
                right: kids.reduce((s, w) => s + w, 0) + gapOf(right) * Math.max(0, kids.length - 1),
                tabs: cells,
                tabGap: gapOf(row),
                more,
            }, activeTab);
            setFit(prev => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
        };
        // The icons are watched one by one, and for arriving or leaving: the
        // update button appears a moment after the first measure, and the
        // group's own box does not change size while it is centred. Missed,
        // a phone kept the fit from before the button and its rail ran
        // "More" off the edge.
        const ro = new ResizeObserver(measure);
        const observe = () => {
            ro.disconnect();
            const right = rightRef.current;
            for (const el of [headerRef.current, measureRef.current, searchWrapRef.current, ...(right ? right.children : [])]) if (el) ro.observe(el);
        };
        observe();
        measure();
        const mo = new MutationObserver(() => { observe(); measure(); });
        if (rightRef.current) mo.observe(rightRef.current, { childList: true });
        return () => { ro.disconnect(); mo.disconnect(); };
        // `barLabels` puts words beside the icons, which changes their width
        // without resizing anything observed.
    }, [isGlobalView, fitKey, activeTab, searchIcon, barLabels]);
    const shownTabs = fit ? fit.shown.map(i => globalTabs[i]) : globalTabs;
    // No room for the tab you are on beside "More": the menu button takes its
    // name and the menu lists every tab, that one ticked.
    const switcher = !!fit?.switcher && activeTab >= 0;
    const moreTabs = switcher ? globalTabs : fit ? globalTabs.filter((_, i) => !fit.shown.includes(i)) : [];
    // The bar widening until every tab fits takes the More button away; an
    // open flag left behind would reopen the menu, unasked, when it narrows.
    useEffect(() => { if (!moreTabs.length) setMoreOpen(false); }, [moreTabs.length]);

    // Theme the whole app around the current project's colour while in a
    // workspace; elsewhere (projects grid, settings) fall back to the default
    // accent defined in index.css.
    const workspaceAccent = useAccentVars(view === 'workspace' ? currentProject?.color : null);
    const accentStyle = workspaceAccent as CSSProperties | undefined;

    return (
        <div className="h-full flex bg-slate-100 dark:bg-slate-900" style={accentStyle}>
        <div className="flex-1 min-w-0 flex flex-col">
            {/* Three columns in normal flow — an absolutely centred search
                would paint on top of the tab strip on a phone. Instead the
                sides split the row with `basis-0`, so they take an equal half
                of the free space and the search sits at the true centre. The
                workspace title keeps `min-w-0` because it must truncate.

                The tab strip is a SCROLLING RAIL, and it has to be. A `min-w-fit`
                left column cannot compress below its text, so the search slides
                right of centre instead of overlapping it, which degrades
                gracefully only while the tabs actually fit. Once they do not,
                on a phone the strip is wider than the whole header, the row
                overflows and the inbox and assistant icons — which cannot
                shrink either — are painted straight over the last tabs,
                making two destinations unreachable. A rail that scrolls keeps
                every tab reachable at any width, and the active one is
                scrolled into view on navigation so it is never the hidden
                one. */}
            <header ref={headerRef} className="h-14 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex items-center gap-1 sm:gap-2 px-2 sm:px-4 shrink-0">
                <div className="flex items-center gap-1 sm:gap-3 grow basis-0 min-w-0">
                    {!isGlobalView && (
                        <IconButton onClick={handleBack} label={t("Go back")} icon={<ArrowLeft className="w-4 h-4" aria-hidden="true" />} />
                    )}
                    {isGlobalView ? (
                        <nav
                            aria-label={t("Main")}
                            ref={tabRailRef}
                            data-fade={railFade}
                            className="rail-scroll flex items-center gap-1 min-w-0 overflow-x-auto"
                        >
                            {shownTabs.map(tab => (
                                <button
                                    key={tab.key}
                                    onClick={() => setView(tab.key)}
                                    aria-current={view === tab.key ? 'page' : undefined}
                                    data-tab={tab.key}
                                    className={`h-10 px-2.5 touch:min-h-11 rounded-lg text-sm font-medium transition shrink-0 ${view === tab.key
                                        ? 'bg-accent/10 text-accent-fg'
                                        : 'text-slate-600 dark:text-slate-300 can-hover:hover:bg-slate-100 dark:can-hover:hover:bg-slate-700'}`}
                                >
                                    {tab.label}
                                </button>
                            ))}
                            {moreTabs.length > 0 && (
                                <button
                                    ref={moreRef}
                                    data-tab={switcher ? view : 'more'}
                                    aria-haspopup="menu"
                                    aria-expanded={moreOpen}
                                    aria-current={switcher ? 'page' : undefined}
                                    onClick={() => setMoreOpen(o => !o)}
                                    onKeyDown={menuTriggerKeys(() => setMoreOpen(true))}
                                    className={`flex items-center gap-1 h-10 px-2.5 touch:min-h-11 rounded-lg text-sm font-medium transition ${switcher
                                        ? 'min-w-0 bg-accent/10 text-accent-fg'
                                        : 'shrink-0 text-slate-600 dark:text-slate-300 can-hover:hover:bg-slate-100 dark:can-hover:hover:bg-slate-700'}`}
                                >
                                    <span className="min-w-0 truncate">{switcher ? globalTabs[activeTab].label : t("More")}</span>
                                    <ChevronDown className="w-4 h-4 shrink-0" aria-hidden="true" />
                                </button>
                            )}
                        </nav>
                    ) : (
                        // The Settings screen carries its own h1 (like Atlas and Schedule);
                        // naming it here as well put the word on screen twice, so the
                        // header holds only the back arrow there.
                        view === 'settings' ? null : (
                            <h1 className="text-lg font-semibold text-slate-900 dark:text-white truncate min-w-0">
                                {view === 'workspace' && currentProject?.name}
                            </h1>
                        )
                    )}
                </div>

                <div ref={searchWrapRef} className="shrink-0">
                    <SearchBar iconOnly={isGlobalView && fit ? fit.searchIcon : undefined} />
                </div>

                {/* `grow basis-0` on BOTH sides is what centres the search.
                    It is unconditionally right while the left side is the tab
                    rail. It is conditional on the other views: the icon side
                    cannot shrink below its three icons, so when half the row is
                    narrower than that it takes the difference out of the title
                    column — at a large UI scale even a short project name or
                    "Settings" would render as an ellipsis.

                    On the global views the rule is conditional for the opposite
                    reason. `grow basis-0` there splits the free space down the
                    middle, so on a phone the icon column is handed far more
                    room than three small icons need while the tab rail, which
                    holds all the destinations, gets the identical share and
                    shows only some of them. The icons cannot shrink and do not
                    want the room; giving it to the rail buys back most of
                    another tab.

                    But `shrink-0` at every width would leave the search glued
                    to the right-hand edge on a wide Settings page, where there
                    is room for all three. The binding constraint is WIDTH, so
                    that is what the rule is keyed on: from `md` up, half the
                    row is comfortably wider than three icons at any UI scale,
                    so both sides take their half and the search sits at the
                    true centre. Below it, the title wins. */}
                <div
                    ref={rightRef}
                    className={`flex items-center gap-2 min-w-0 justify-end shrink-0 ${isGlobalView && fit ? (fit.centred ? 'grow basis-0' : '') : 'md:grow md:basis-0'}`}
                >
                    {view === 'workspace' && isGenerating && currentProjectId != null && (
                        // A status the reader can open, so a pill, not a
                        // button: it opens THIS project's run over the
                        // workspace.
                        <Chip
                            tone="accent"
                            onClick={() => openGenerationModal(currentProjectId)}
                            aria-label={t("AI generation in progress")}
                            icon={<Sparkles className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
                            className="motion-safe:animate-pulse"
                        >
                            <span className="hidden md:inline">{t("AI generation in progress")}</span>
                        </Chip>
                    )}
                    <UpdateControl />
                    <BarAction
                        labelled={barLabels}
                        onClick={() => setCaptureOpen(true)}
                        icon={<Inbox className="w-4 h-4" aria-hidden="true" />}
                        text={t("Capture")}
                        label={hasKeyboard ? t("Capture something (c)") : t("Capture something")}
                        title={hasKeyboard ? t("Capture something to study later (c)") : t("Capture something to study later")}
                    />
                    <BarAction
                        labelled={barLabels}
                        onClick={() => openAssistant()}
                        icon={<MessageSquare className="w-4 h-4" aria-hidden="true" />}
                        text={t("Assistant")}
                        label={hasKeyboard ? t("Open the assistant (a)") : t("Open the assistant")}
                        title={hasKeyboard ? t("Ask the assistant (a)") : t("Ask the assistant")}
                    />
                    <BarAction
                        labelled={barLabels}
                        active={view === 'settings'}
                        onClick={() => setView('settings')}
                        icon={<Settings className="w-4 h-4" aria-hidden="true" />}
                        text={t("Settings")}
                        label={t("Settings")}
                    />
                </div>

                {/* The tabs and the More button at their natural widths, for
                    `fitHeader`: never drawn, never squeezed (`w-max` inside a
                    box that clips it to nothing). Horizontal classes only, the
                    same as the real ones above. */}
                {isGlobalView && (
                    <div className="absolute left-0 top-0 max-w-0 overflow-hidden invisible pointer-events-none" aria-hidden="true">
                        <div ref={measureRef} className="flex w-max gap-1">
                            {globalTabs.map(tab => (
                                <span key={tab.key} className="px-2.5 text-sm font-medium whitespace-nowrap">{tab.label}</span>
                            ))}
                            <span className="flex items-center gap-1 px-2.5 text-sm font-medium whitespace-nowrap">
                                {t("More")}
                                <ChevronDown className="w-4 h-4" />
                            </span>
                        </div>
                    </div>
                )}
                <MenuPopover open={moreOpen && moreTabs.length > 0} onClose={() => setMoreOpen(false)} anchorRef={moreRef} label={switcher ? t("Main") : t("More")} align="start">
                    {moreTabs.map(tab => (
                        <MenuItem key={tab.key} current={tab.key === view} onSelect={() => { setMoreOpen(false); setView(tab.key); }}>{tab.label}</MenuItem>
                    ))}
                </MenuPopover>
            </header>

            {/* In normal flow, between the header and the content, so it can
                never cover the tab rail or a review session's rating buttons:
                the note after an update, or the one-time "check for updates?"
                question. The update itself lives in the header's button.
                Above it, for as long as it is true, that the app can be
                reached from other devices and has no password. */}
            <ExposedBanner />
            <UpdateNotice />

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

            {/* Every AI project creation's screen, and the reattach after a
                reload — at the root, because a run is reached from the dock on
                any page and outlives the grid that started it. */}
            <CreationRunHost />
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