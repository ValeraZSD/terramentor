import { create } from 'zustand';
import type { NavigateFunction } from 'react-router-dom';
import { SearchProvider } from './utils/searchProviders';
import { Project, Node, TreeNode, Resource, Toast, ScheduleConfig, PaceData, ConfirmDialogState, ShowConfirmOptions, AICreationProgressInfo, DashboardData, SearchResults, DailyPlan, FeedCard, FeedHeaderData, FeedStats, GlobalDueFlashcard, AITaskSummary, TransferInfo, WeekStartDay, AtlasColorMode, AtlasSurface, AppVersion, UpdateStatus, ProjectCompletion } from './types';
import { api } from './api';
import { configureSrs } from './utils/srs';
import { buildTree, getNodePath } from './utils/tree';
import { deepReplaceStrings } from './utils/deepReplace';
import { accentSolidTriplet, accentFgTriplet } from './utils/color';
import i18n from './i18n';
import { setUiLanguage as applyUiLanguage, resolveLanguagePreference } from './i18n';
import { noteServerReconnected, canReloadNow } from './utils/freshness';
import { AUTO as NUMBER_AUTO, isNumberStyle, setNumberPreference } from './utils/numberFormat';
import { AppIcon, DEFAULT_APP_ICON, ICON_KEYS, applyAppIcon, normalizeIcon } from './utils/appIcon';

type View = 'today' | 'projects' | 'workspace' | 'settings' | 'calendar' | 'schedule' | 'atlas';
/** Four themes on two axes: light/dark is the `.dark` class (drives every
 *  `dark:` variant), the specific flavour is a `data-theme` attribute.
 *  light + dark render exactly as before; warm + black retint via CSS vars. */
export type Theme = 'light' | 'warm' | 'dark' | 'black';
export const THEME_IDS: readonly Theme[] = ['light', 'warm', 'dark', 'black'];

/**
 * Whether an answer may go and look something up on the live web, and who
 * decides. Mirrors `webSearchMode()` in server/webContext.js, which is the
 * authority — this copy only decides what the composer shows.
 */
export type WebSearchMode = 'off' | 'ask' | 'auto';
export const WEB_SEARCH_MODES: readonly WebSearchMode[] = ['off', 'ask', 'auto'];
/** True for the dark-axis themes — the single source of truth for "is dark". */
export const isDarkTheme = (t: Theme): boolean => t === 'dark' || t === 'black';
export type WorkspaceView = 'dashboard' | 'tree' | 'timeline' | 'calendar' | 'vault' | 'study';

/** The in-workspace views, used to validate the `:view` URL segment. `study`
 *  is not a tab: it is the feed scoped to one topic (`/project/:id/study/:nodeId`),
 *  reached from a topic's Study button, and it shows in the rail only while open. */
export const VALID_WORKSPACE_VIEWS: ReadonlySet<WorkspaceView> = new Set<WorkspaceView>([
    'dashboard', 'tree', 'timeline', 'calendar', 'vault', 'study',
]);

/** Navigation state as decoded from the URL by `useRouterStoreSync`. */
export interface RouteState {
    view: View;
    projectId?: number | null;
    workspaceView?: WorkspaceView;
    nodeId?: number | null;
}

/** Default global accent (cyan-700) — matches the fallback in index.css. */
const DEFAULT_ACCENT_COLOR = '#0E7490';

/**
 * Mirror of the resolved theme, read by the boot script in index.html BEFORE
 * the first paint. Settings on the server stay the source of truth — this only
 * removes the light-themed window between first paint and `loadSettings()`,
 * during which any AI visual that rendered baked the wrong palette into its SVG.
 */
const THEME_STORAGE_KEY = 'terramentor-theme';

interface ThemeCache {
    theme?: Theme;
    uiScale?: number;
    accentRgb?: string;
    accentFgRgb?: string;
    /** The chosen icon as a data: URL, replayed by the boot script so the tab
     *  does not show the default mark for the first few hundred milliseconds of
     *  every load and then swap. */
    iconHref?: string;
}

const readThemeCache = (): ThemeCache => {
    try {
        const raw = localStorage.getItem(THEME_STORAGE_KEY);
        return raw ? JSON.parse(raw) as ThemeCache : {};
    } catch {
        return {};
    }
};

const patchThemeCache = (patch: ThemeCache) => {
    try {
        localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ ...readThemeCache(), ...patch }));
    } catch { /* private mode — the cache is an optimisation, never a requirement */ }
};

/** Theme to start with: the last one this device saw, else light. */
const initialTheme = (): Theme => {
    const cached = readThemeCache().theme;
    return cached && THEME_IDS.includes(cached) ? cached : 'light';
};

/** Push the global accent onto the document root so non-project screens
 *  (projects grid, settings) pick it up. The workspace overrides these per
 *  project via an inline style on a descendant. */
const applyAccentVars = (hex: string, isDark: boolean) => {
    const root = document.documentElement;
    const accentRgb = accentSolidTriplet(hex);
    const accentFgRgb = accentFgTriplet(hex, isDark);
    root.style.setProperty('--accent-rgb', accentRgb);
    root.style.setProperty('--accent-fg-rgb', accentFgRgb);
    patchThemeCache({ accentRgb, accentFgRgb });
};

/** Apply a theme to the document root: the `.dark` class carries the light/dark
 *  axis (all `dark:` variants), `data-theme` carries the flavour (warm/black
 *  retints via CSS vars in index.css). */
const applyThemeToDom = (theme: Theme) => {
    const root = document.documentElement;
    root.classList.toggle('dark', isDarkTheme(theme));
    root.setAttribute('data-theme', theme);
    patchThemeCache({ theme });
    applyThemeColorMeta(theme);
};

/**
 * The browser chrome above the app — a phone's status bar in an installed PWA,
 * the URL bar in a tab — is painted from `<meta name="theme-color">`, and it was
 * a hardcoded `#0e7490`. That is the DEFAULT ACCENT, which is neither a surface
 * nor a colour that survives the learner changing their accent, so on three of
 * the four themes (and on any custom accent) the strip directly above the app
 * was teal while the app was cream, slate or true black.
 *
 * The right value is the HEADER's colour, not the canvas: the header is the
 * surface the chrome actually abuts, so matching it makes the two read as one
 * plane. Kept in sync with the boot script in index.html, which does the same
 * job before the first paint; the values are `--c-white` / `--c-slate-800` for
 * each theme as declared in index.css.
 */
const THEME_COLOR: Record<Theme, string> = {
    light: '#ffffff',
    warm: '#faf6ef',
    dark: '#1e293b',
    black: '#0d0d10',
};

const applyThemeColorMeta = (theme: Theme) => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLOR[theme] ?? THEME_COLOR.light);
};

/**
 * UI scale — one number that resizes the whole interface.
 *
 * Not a font-size preference: it is set on the ROOT element, and every size in
 * this app that matters is expressed in `rem` (Tailwind's spacing, type and
 * radius scales all are), so the layout grows as a piece rather than turning
 * into large text in small boxes. Tailwind's breakpoints stay in `px`, so
 * scaling up does NOT trip the app into its desktop layout on a phone.
 *
 * It exists because the two devices this is used on ask opposite things of it:
 * a phone held at reading distance where a furigana reading is a fraction of a
 * fraction, and a desktop across a desk. Fixing that by picking bigger
 * constants would just move whose eyes are wrong. 80-160% covers "fit more on
 * screen" through "I need this large", and the cap is where the review card's
 * own controls start to crowd a 360px phone.
 */
export const MIN_UI_SCALE = 80;
export const MAX_UI_SCALE = 160;
export const DEFAULT_UI_SCALE = 100;
/** One increment, shared by the slider's `step` and the A−/A+ buttons. They
 *  used to disagree (5 vs 10), so a value reached with the slider could not be
 *  nudged back to itself with the buttons. */
export const UI_SCALE_STEP = 5;
/** Root font size the whole rem scale is derived from. */
const BASE_ROOT_PX = 16;

export const clampUiScale = (value: unknown): number => {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return DEFAULT_UI_SCALE;
    return Math.max(MIN_UI_SCALE, Math.min(MAX_UI_SCALE, n));
};

const applyUiScale = (scale: number) => {
    const pct = clampUiScale(scale);
    document.documentElement.style.fontSize = `${(BASE_ROOT_PX * pct) / 100}px`;
    patchThemeCache({ uiScale: pct });
};

/** The scale to start with: the last one this device saw (the cache is replayed
 *  by the boot script in index.html, so this only has to agree with it). */
const initialUiScale = (): number => clampUiScale(readThemeCache().uiScale ?? DEFAULT_UI_SCALE);

/** Put the icon on the document, and mirror it for the next load's first paint. */
const applyIcon = (icon: AppIcon) => {
    const { href } = applyAppIcon(icon);
    patchThemeCache({ iconHref: href });
};

const EXPANSION_STORAGE_KEY = 'terramentor-expansion';

// Floor between background feed pulls (see `pullFeedUpdates`). The generator
// can finish an item every few seconds; the feed doesn't need to re-compose
// faster than this, and the guard keeps a burst of task events from stampeding.
const FEED_PULL_MIN_MS = 4000;
let lastFeedPullAt = 0;

// Module-level so the feed survives store updates; only ever started once.
let taskFeedStarted = false;

/** Task ids the reader has dismissed, until the server's snapshots agree. */
const dismissedTasks = new Set<string>();

const loadExpansionState = (): Record<number, boolean> => {
    try {
        const stored = localStorage.getItem(EXPANSION_STORAGE_KEY);
        return stored ? JSON.parse(stored) : {};
    } catch {
        return {};
    }
};

const saveExpansionState = (expanded: Record<number, boolean>) => {
    try {
        localStorage.setItem(EXPANSION_STORAGE_KEY, JSON.stringify(expanded));
    } catch {
    }
};

interface AppState {
    view: View;
    theme: Theme;
    accentColor: string;
    /** Which cut of the mark, on what colour, how round. See `utils/appIcon.ts`. */
    appIcon: AppIcon;
    /** Whole-interface zoom, as a percentage. See `applyUiScale`. */
    uiScale: number;
    /** Interface language preference: 'auto' (follow the browser) or a locale code. */
    uiLanguage: string;
    /**
     * AI runtime facts, mirrored from settings purely so user-facing copy can
     * tell the truth about a slow generation (local hardware vs a remote
     * endpoint) — see `src/utils/aiHints.ts`. Never used to route a request.
     */
    aiProvider: string | null;
    aiModel: string | null;
    /**
     * How the learner has set web answering: `off`, `ask` or `auto`. Mirrored
     * here so the switch by the composer can be HIDDEN rather than offered and
     * then ignored: this app's promise is that nothing leaves the machine
     * unless asked, and a control that looks available but does nothing is the
     * worst of both readings.
     *
     * The mode also decides where that switch STARTS. `ask` opens it off, so
     * searching is a thing the learner does on purpose; `auto` opens it on, and
     * it stays there as an opt-out for the one question they would rather keep
     * to themselves.
     */
    aiWebSearchMode: WebSearchMode;
    // Single-user auth gate. `authChecked` guards the first render so we don't
    // flash the app before knowing whether a login is required.
    authEnabled: boolean;
    authenticated: boolean;
    authChecked: boolean;
    projects: Project[];
    /** Search-provider manifests (server/searchProviders.js). Declarative data only. */
    searchProviders: SearchProvider[];
    /**
     * Identity of the running build, and what the last update check found.
     *
     * In the store rather than in each component because three surfaces need
     * the same answer (the About panel, the update banner, the bug-report
     * builder) and a second fetch is a second version of the truth. Both are
     * null until `loadVersion` lands, and every consumer must render fine
     * without them — an app that cannot say what it is must still work.
     */
    appVersion: AppVersion | null;
    updateStatus: UpdateStatus | null;
    /** Version the learner dismissed with the X. Deliberately NOT persisted:
     *  "remind me next time the app starts" is exactly the lifetime of this
     *  page load, so a reload brings the banner back and nothing else does. */
    updateDismissed: string | null;
    currentProjectId: number | null;
    nodes: Node[];
    tree: TreeNode[];
    selectedNodeId: number | null;
    focusedNodeId: number | null;
    resources: Resource[];
    expanded: Record<number, boolean>;
    loading: boolean;
    sidebarWidth: number;
    detailPanelWidth: number;
    /** Which day a week starts on, in every calendar. A preference, not view
     *  state: it used to live inside the calendar component, so it reset to
     *  Monday on every navigation and cost a permanent toolbar toggle. */
    weekStartDay: WeekStartDay;
    /** What colour means on the atlas: how much is proven, or which course a
     *  topic belongs to. A preference rather than view state — a map you have
     *  chosen to read by course should still read that way tomorrow. */
    atlasColorMode: AtlasColorMode;
    /** Which surface the atlas is drawn on: the flat map, or Terra — the same
     *  library as a planet. A preference, for the same reason the colour mode
     *  is one: a reader who thinks in the globe should get the globe tomorrow. */
    atlasSurface: AtlasSurface;
    /** How numbers are WRITTEN: the thousands and decimal separators, as a
     *  style id from `utils/numberFormat`, or 'auto' to follow the interface
     *  language. Display only — what a learner may TYPE into a numeric answer
     *  is never narrowed by it. */
    numberFormat: string;
    toasts: Toast[];
    searchQuery: string;
    searchResults: SearchResults | null;
    searchLoading: boolean;
    searchOpen: boolean;
    workspaceView: WorkspaceView;
    showScheduleModal: boolean;
    scheduleModalProjectId: number | null;
    paceData: PaceData | null;
    paceLoading: boolean;
    confirmDialog: ConfirmDialogState;
    aiCreationMinimized: boolean;
    aiCreationActive: boolean;
    aiCreationProgress: AICreationProgressInfo | null;
    showAICreationModal: boolean;
    dashboardData: DashboardData | null;
    dashboardLoading: boolean;
    dailyPlan: DailyPlan | null;
    loadDailyPlan: (projectId: number) => Promise<void>;
    dueFlashcardCount: number;
    /** Learning feed (home page) — the card stream + header (GET /api/feed). */
    feedCards: FeedCard[];
    feedHeader: FeedHeaderData | null;
    feedLoading: boolean;
    feedExhausted: boolean;
    /**
     * "You proved this elsewhere" head starts for the topics on screen, by node
     * id. Kept beside the cards rather than on them: a chapter is one topic and
     * many cards, and the chapter header is what displays this — copying the
     * payload onto every lesson part would repeat it four times over.
     */
    feedTransfers: Record<number, TransferInfo>;
    /** Card keys consumed this session (cards collapse in place, never unmount). */
    feedDone: Record<string, boolean>;
    /**
     * The feed_items row the reader is actually looking at, tracked by FeedView.
     * The home page has no selected node, so this is the only way the assistant
     * can answer "explain this" about the card on screen. An id, never text —
     * the server reads the row itself (buildPageContext).
     */
    feedFocusItemId: number | null;
    /**
     * Which topic (or section) the loaded stream is scoped to; null for the
     * home feed. One slice serves both: the study page IS the feed, pointed at
     * one thing, and every card component reads the same state.
     */
    feedScope: number | null;
    /** The node the workspace's `study` view is showing (from the URL). */
    studyNodeId: number | null;
    setFeedFocusItem: (feedItemId: number | null) => void;
    /** Initial load — replaces the stream. */
    loadFeed: (scopeNodeId?: number | null) => Promise<void>;
    /** Open the feed scoped to one topic or section: `/project/:id/study/:nodeId`. */
    studyNode: (projectId: number, nodeId: number) => void;
    /** Fetch the next batch (exclude = keys already on screen); append-only. */
    extendFeed: () => Promise<void>;
    /**
     * Append cards the background generator has produced since the last fetch.
     * Ignores `feedExhausted` (that is the state it exists to clear) and stays
     * silent on failure — driven by feed-task progress, not by the reader.
     */
    pullFeedUpdates: () => Promise<void>;
    /**
     * A visual block inside a feed card was repaired: splice the fixed spec into
     * that card — lesson, question or practice alike — and persist it, so the
     * repair happens once rather than on every page load.
     */
    repairFeedVisual: (key: string, originalCode: string, repairedCode: string) => void;
    /** Mark a card done locally + report to the server (lesson/question/recall). */
    consumeFeedCard: (key: string, payload: {
        kind: 'lesson' | 'question' | 'recall';
        feedItemId?: number | null;
        nodeId?: number;
        result?: { correct?: boolean; answer?: string; gradedBy?: 'local' | 'ai' | 'fallback'; read?: boolean };
    }) => Promise<void>;
    /** Local-only done marker for cards that persist themselves (flashcard/checkpoint/notice). */
    markFeedCardDone: (key: string) => void;
    /**
     * Put a flashcard back into the stream after a rating that kept it on a
     * (re)learning ladder. Appended, never inserted — see the implementation.
     */
    requeueFeedCard: (key: string, card: GlobalDueFlashcard, dueAt: number) => void;
    updateFeedStats: (stats: FeedStats) => void;
    /** Deep-link into another project's tree at a specific node. */
    openProjectNode: (projectId: number, nodeId: number) => void;
    /** react-router's navigate, injected by `useRouterStoreSync` so store actions
     *  can drive the URL (the source of truth) from outside React components. */
    _navigate: NavigateFunction | null;
    setNavigate: (fn: NavigateFunction) => void;
    /** Reconcile store nav state to a decoded URL. The ONLY writer of `view`,
     *  `currentProjectId`, `workspaceView`, and `selectedNodeId`. */
    applyRoute: (route: RouteState) => Promise<void>;
    /** Load a project's nodes/tree/pace/dashboard without touching the URL. */
    loadProjectData: (id: number) => Promise<void>;
    /** Expand a node's ancestors so views can scroll it into view. */
    revealNode: (id: number) => void;
    /**
     * The Boss Fight modal, opened from anywhere — a completion the server
     * intercepted, or the learner choosing to prove a topic. `projectId` and
     * `onResolved` exist because the feed opens it too: the home page has no
     * "current project", so the gate has to carry its own, and the checkpoint
     * card needs to hear that its topic just closed (it can't reload the feed
     * without throwing away the reader's scroll position).
     */
    /**
     * The global assistant's open state lives here, not in Layout, so ANY screen
     * can hand it a question — "ask about this project" from the dashboard, and
     * whatever else earns the affordance later. `assistantPrefill` is consumed
     * once by the drawer (it fills the composer but does NOT send: the learner
     * still owns the message).
     */
    assistantOpen: boolean;
    assistantPrefill: string | null;
    openAssistant: (prefill?: string) => void;
    closeAssistant: () => void;
    /** Read-and-clear, so re-opening the drawer doesn't refill an old question. */
    consumeAssistantPrefill: () => string | null;

    ankiImportOpen: boolean;
    /** A deck dropped somewhere else in the app (the create-project dropzone
     *  takes .apkg too, because that is where someone with a deck looks first).
     *  Read once by the modal, then cleared — a stale File must never be
     *  re-parsed the next time the importer is opened by hand. */
    ankiImportFile: File | null;
    openAnkiImport: (file?: File) => void;
    closeAnkiImport: () => void;
    consumeAnkiImportFile: () => File | null;

    /** The placement probe (server/placement.js). Mounted at the app root like
     *  the mastery gate, and for the same reason: it is offered from the project
     *  dashboard but must be openable from anywhere without navigating. */
    placement: {
        isOpen: boolean;
        projectId: number | null;
        projectName: string;
    };
    openPlacement: (projectId: number, projectName: string) => void;
    closePlacement: () => void;

    masteryGate: {
        isOpen: boolean;
        nodeId: number | null;
        nodeTitle: string;
        advisory: boolean;
        projectId: number | null;
        onResolved: (() => void) | null;
    };
    openMasteryGate: (
        nodeId: number,
        nodeTitle: string,
        advisory?: boolean,
        projectId?: number | null,
        onResolved?: (() => void) | null,
    ) => void;
    closeMasteryGate: () => void;
    /** Close the gate by completing (override) or skipping the node it holds. */
    resolveMasteryGate: (outcome: 'completed' | 'skipped') => Promise<void>;

    /** The finished-project summary, when one is on screen. */
    completion: ProjectCompletion | null;
    /** A project that finished at a bad moment (mid review session, mid stream).
     *  Layout retries until the moment is right rather than interrupting. */
    completionPending: number | null;
    /** Ask the server whether a project is finished, and open the summary if it
     *  is and has not been seen. Safe to call often — it answers `complete:
     *  false` for everything else and opens nothing. */
    checkProjectCompletion: (projectId: number) => Promise<void>;
    /** Open it unconditionally, from the project's own menu. */
    openCompletion: (projectId: number) => Promise<void>;
    /** `seen: true` also records the dismissal, so it stops opening itself. */
    closeCompletion: (seen?: boolean) => void;

    setView: (view: View) => void;
    setTheme: (theme: Theme) => void;
    loadAuth: () => Promise<void>;
    recheckAuth: () => Promise<void>;
    login: (password: string) => Promise<void>;
    logout: () => Promise<void>;
    lockApp: () => void;
    setAccentColor: (hex: string) => Promise<void>;
    /** Change one or more of the three icon choices; the rest are kept. */
    setAppIcon: (patch: Partial<AppIcon>) => Promise<void>;
    setUiScale: (scale: number) => Promise<void>;
    setUiLanguage: (code: string) => Promise<void>;
    setSidebarWidth: (width: number) => Promise<void>;
    setDetailPanelWidth: (width: number) => Promise<void>;
    setWeekStartDay: (day: WeekStartDay) => Promise<void>;
    setNumberFormat: (style: string) => Promise<void>;
    setAtlasColorMode: (mode: AtlasColorMode) => Promise<void>;
    setAtlasSurface: (surface: AtlasSurface) => Promise<void>;
    setProjects: (projects: Project[]) => void;
    setTree: (tree: TreeNode[]) => void;
    /**
     * `silent` suppresses the error toast — for background refreshes (the 3s
     * poll) where a failure is not user-actionable and the next tick retries.
     */
    loadProjects: (opts?: { silent?: boolean }) => Promise<void>;
    loadSearchProviders: () => Promise<void>;
    /** Fetch identity + the cached update verdict. No network beyond this app. */
    loadVersion: () => Promise<void>;
    /** The button. User-initiated, so it is allowed to reach GitHub. */
    checkForUpdates: () => Promise<void>;
    setAutoUpdateCheck: (enabled: boolean) => Promise<void>;
    dismissUpdate: () => void;
    setSearchProviderEnabled: (id: string, enabled: boolean) => Promise<void>;
    addSearchProvider: (manifest: unknown) => Promise<boolean>;
    removeSearchProvider: (id: string) => Promise<void>;
    loadSettings: () => Promise<void>;
    openProject: (id: number) => Promise<void>;
    closeProject: () => void;
    selectNode: (id: number | null) => Promise<void>;
    setFocusedNode: (id: number | null) => void;
    toggleExpanded: (id: number) => void;
    expandAll: () => void;
    collapseAll: () => void;
    toggleAllExpanded: () => void;
    setExpanded: (id: number, value: boolean) => void;
    createProject: (projectData: Partial<Project>) => Promise<Project>;
    updateProject: (id: number, updates: Partial<Project>) => Promise<void>;
    deleteProject: (id: number) => Promise<void>;
    reorderProjects: (projectIds: number[]) => Promise<void>;
    createNode: (nodeData: Partial<Node>) => Promise<void>;
    updateNode: (id: number, updates: Partial<Node> & { override?: boolean }) => Promise<boolean>;
    skipNode: (id: number) => Promise<boolean>;
    deleteNode: (id: number) => Promise<void>;
    moveNode: (id: number, parentId: number | null, position: number) => Promise<void>;
    reorderNodes: (nodeIds: number[], parentId: number | null) => Promise<void>;
    refreshNodes: () => Promise<void>;
    loadResources: (nodeId: number) => Promise<void>;
    createResource: (resData: Partial<Resource>) => Promise<void>;
    updateResource: (id: number, updates: Partial<Resource>) => Promise<void>;
    deleteResource: (id: number) => Promise<void>;
    reorderResources: (resourceIds: number[]) => Promise<void>;
    addToast: (type: Toast['type'], message: string, details?: string) => void;
    removeToast: (id: string) => void;
    setSearchQuery: (query: string) => void;
    setSearchOpen: (open: boolean) => void;
    performSearch: (query: string) => Promise<void>;
    clearSearch: () => void;
    setWorkspaceView: (view: WorkspaceView) => void;
    setShowScheduleModal: (show: boolean, projectId?: number | null) => void;
    scheduleProject: (projectId: number, config: ScheduleConfig) => Promise<boolean>;
    recalibrateSchedule: (projectId: number) => Promise<boolean>;
    removeSchedule: (projectId: number) => Promise<void>;
    loadPaceData: (projectId: number) => Promise<void>;
    showConfirm: (options: ShowConfirmOptions) => Promise<boolean>;
    hideConfirm: (result: boolean) => void;
    setAICreationMinimized: (val: boolean) => void;
    setAICreationActive: (val: boolean) => void;
    setAICreationProgress: (data: AICreationProgressInfo | null) => void;
    setShowAICreationModal: (val: boolean) => void;
    loadDashboard: (projectId: number) => Promise<{ success: boolean; error?: string }>;
    loadDueFlashcardCount: (projectId: number) => Promise<void>;

    /** Live snapshot of background AI generations (server task registry),
     *  rendered by the global TaskDock at the bottom of the screen. */
    aiTasks: AITaskSummary[];
    /** Start the global task feed (SSE, auto-reconnect). Idempotent; called
     *  once from Layout on mount. */
    startAiTaskFeed: () => void;
    cancelAiTask: (id: string) => Promise<void>;
    dismissAiTask: (id: string) => Promise<void>;
    /** Navigate to the surface a task belongs to (dock chip click). */
    openAiTask: (task: AITaskSummary) => void;
}

/** Auto-dismiss timers keyed by toast id, so a re-bumped toast can reset its own countdown. */
const TOAST_DURATION = 4000;
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useStore = create<AppState>((set, get) => ({
    view: 'today',
    theme: initialTheme(),
    accentColor: DEFAULT_ACCENT_COLOR,
    appIcon: DEFAULT_APP_ICON,
    uiScale: initialUiScale(),
    aiProvider: null,
    aiModel: null,
    aiWebSearchMode: 'off',
    authEnabled: false,
    authenticated: true,
    authChecked: false,
    projects: [],
    searchProviders: [],
    appVersion: null,
    updateStatus: null,
    updateDismissed: null,
    currentProjectId: null,
    nodes: [],
    tree: [],
    selectedNodeId: null,
    focusedNodeId: null,
    resources: [],
    expanded: loadExpansionState(),
    loading: false,
    sidebarWidth: 256,
    detailPanelWidth: 420,
    weekStartDay: 1,
    atlasColorMode: 'mastery',
    atlasSurface: 'map',
    numberFormat: NUMBER_AUTO,
    uiLanguage: 'auto',
    toasts: [],
    searchQuery: '',
    searchResults: null,
    searchLoading: false,
    searchOpen: false,
    workspaceView: 'dashboard',
    showScheduleModal: false,
    scheduleModalProjectId: null,
    paceData: null,
    paceLoading: false,
    confirmDialog: {
        isOpen: false,
        title: '',
        message: '',
        confirmLabel: '',
        cancelLabel: '',
        variant: 'info',
        resolvePromise: null,
    },
    aiCreationMinimized: false,
    aiCreationActive: false,
    aiCreationProgress: null,
    showAICreationModal: false,
    dashboardData: null,
    dashboardLoading: false,
    dailyPlan: null,
    dueFlashcardCount: 0,
    feedCards: [],
    feedHeader: null,
    feedTransfers: {},
    feedLoading: false,
    feedExhausted: false,
    feedDone: {},
    feedFocusItemId: null,
    feedScope: null,
    studyNodeId: null,
    _navigate: null,
    assistantOpen: false,
    assistantPrefill: null,
    openAssistant: (prefill) => set({ assistantOpen: true, assistantPrefill: prefill ?? null }),
    closeAssistant: () => set({ assistantOpen: false }),
    consumeAssistantPrefill: () => {
        const pending = get().assistantPrefill;
        if (pending !== null) set({ assistantPrefill: null });
        return pending;
    },
    ankiImportOpen: false,
    ankiImportFile: null,
    openAnkiImport: (file) => set({ ankiImportOpen: true, ankiImportFile: file ?? null }),
    closeAnkiImport: () => set({ ankiImportOpen: false, ankiImportFile: null }),
    consumeAnkiImportFile: () => {
        const pending = get().ankiImportFile;
        if (pending) set({ ankiImportFile: null });
        return pending;
    },

    placement: { isOpen: false, projectId: null, projectName: '' },
    openPlacement: (projectId, projectName) => set({ placement: { isOpen: true, projectId, projectName } }),
    closePlacement: () => set({ placement: { isOpen: false, projectId: null, projectName: '' } }),

    masteryGate: { isOpen: false, nodeId: null, nodeTitle: '', advisory: true, projectId: null, onResolved: null },
    openMasteryGate: (nodeId, nodeTitle, advisory = true, projectId = null, onResolved = null) =>
        set({
            masteryGate: {
                isOpen: true, nodeId, nodeTitle, advisory,
                projectId: projectId ?? get().currentProjectId,
                onResolved: onResolved ?? null,
            },
        }),
    closeMasteryGate: () =>
        set({ masteryGate: { isOpen: false, nodeId: null, nodeTitle: '', advisory: true, projectId: null, onResolved: null } }),

    resolveMasteryGate: async (outcome) => {
        const gate = get().masteryGate;
        const nodeId = gate.nodeId;
        if (!nodeId) return;
        const onResolved = gate.onResolved;
        const inLoadedProject = gate.projectId != null && gate.projectId === get().currentProjectId;
        get().closeMasteryGate();

        let ok = false;
        if (inLoadedProject) {
            // A workspace is open: go through the normal actions so the tree,
            // pace and dashboard all refresh from one place.
            ok = outcome === 'skipped'
                ? await get().skipNode(nodeId)
                : await get().updateNode(nodeId, { status: 'completed', override: true });
        } else {
            // Opened from the feed — no project tree is loaded to refresh, so
            // write directly and let the caller update its own card.
            try {
                await api.updateNode(nodeId, outcome === 'skipped'
                    ? { status: 'skipped' }
                    : { status: 'completed', override: true });
                ok = true;
                get().addToast(
                    outcome === 'skipped' ? 'info' : 'success',
                    outcome === 'skipped'
                        ? i18n.t('Marked as skipped')
                        : i18n.t('"{{title}}" completed', { title: gate.nodeTitle }),
                );
            } catch (e: any) {
                get().addToast('error', i18n.t('Failed to update topic'), e.message);
            }
        }
        if (ok) onResolved?.();
        if (ok && gate.projectId) get().checkProjectCompletion(gate.projectId);
    },

    completion: null,
    completionPending: null,

    checkProjectCompletion: async (projectId) => {
        // Never over the top of something. A project can be finished by the last
        // card of a review session or the last answer of a streaming turn, and a
        // full-screen celebration arriving mid-rating is a dialog you dismiss
        // without reading. `holdReload` is already the app's register of "this
        // is a bad moment to interrupt" (a session, a stream, a half-typed
        // field), so it decides here too — the next call finds the project just
        // as finished as it was.
        if (get().completion) return;
        if (!canReloadNow()) { set({ completionPending: projectId }); return; }
        // Cleared before the answer, not after: whatever the server says, this
        // project has had its turn and the retry timer must stop.
        set({ completionPending: null });
        try {
            const data = await api.getProjectCompletion(projectId);
            if (!data.complete || data.celebrated) return;
            // Only an ACTIVE project interrupts: one already filed as completed
            // or archived has had its ending, whatever the setting row says.
            if (data.project.status !== 'active') return;
            set({ completion: data });
        } catch { /* a summary that cannot be fetched is not an error worth a toast */ }
    },

    openCompletion: async (projectId) => {
        try {
            set({ completion: await api.getProjectCompletion(projectId) });
        } catch (e: any) {
            get().addToast('error', i18n.t('Could not open the summary'), e.message);
        }
    },

    closeCompletion: (seen = true) => {
        const open = get().completion;
        set({ completion: null });
        if (seen && open?.complete) api.markCompletionSeen(open.project.id).catch(() => { /* it will offer again */ });
    },

    setView: (view) => {
        const nav = get()._navigate;
        if (!nav) { set({ view }); return; }
        if (view === 'settings') nav('/settings');
        else if (view === 'today') nav('/');
        else if (view === 'projects') nav('/projects');
        else if (view === 'calendar') nav('/calendar');
        else if (view === 'schedule') nav('/schedule');
        else if (view === 'atlas') nav('/atlas');
        else { const pid = get().currentProjectId; nav(pid ? `/project/${pid}` : '/'); }
    },

    setTheme: async (theme) => {
        set({ theme });
        applyThemeToDom(theme);
        // Accent text brightness depends on the light/dark axis, so re-apply it.
        applyAccentVars(get().accentColor, isDarkTheme(theme));
        await api.setSetting('theme', theme);
    },

    loadAuth: async () => {
        try {
            const { enabled, authenticated } = await api.getAuthStatus();
            set({ authEnabled: enabled, authenticated, authChecked: true });
        } catch {
            // If even the status probe fails, don't hard-lock the user out of a
            // local session — assume open and let real requests surface errors.
            set({ authChecked: true });
        }
    },

    /**
     * Ask the server again whether this device is still locked out.
     *
     * `loadAuth` runs ONCE, at mount, which is right for a first paint and
     * wrong for the lock screen: turning the password off on the desktop leaves
     * every other device sitting on a login form for a gate that no longer
     * exists, with no way back except a full page reload. The lock screen is
     * precisely the surface with no other route to fresh state — nothing else
     * on it talks to the server — so it has to ask.
     *
     * Unlocking here must also do what a successful login does: the data loads
     * are gated on being through the gate, so a device that becomes unlocked
     * without logging in would otherwise land on an empty app.
     */
    recheckAuth: async () => {
        try {
            const { enabled, authenticated } = await api.getAuthStatus();
            const before = get();
            const wasLocked = before.authEnabled && !before.authenticated;
            if (before.authEnabled === enabled && before.authenticated === authenticated) return;
            set({ authEnabled: enabled, authenticated, authChecked: true });
            if (wasLocked && (!enabled || authenticated)) {
                await Promise.all([get().loadSettings(), get().loadProjects(), get().loadSearchProviders()]);
                get().loadVersion();
            }
        } catch {
            // A failed probe is not a verdict — leave whatever we last knew
            // standing rather than locking or unlocking on a dropped request.
        }
    },

    login: async (password) => {
        await api.login(password); // throws on wrong password / lockout — caller shows it
        set({ authenticated: true, authEnabled: true });
        // Pull the data that was blocked while locked.
        await Promise.all([get().loadSettings(), get().loadProjects(), get().loadSearchProviders()]);
    },

    logout: async () => {
        try { await api.logout(); } catch { /* best effort */ }
        set({ authenticated: false });
    },

    // Called when a protected request returns 401 mid-session (session expired or
    // the gate was switched on elsewhere) — flip to the locked screen.
    lockApp: () => {
        if (get().authenticated) set({ authenticated: false, authEnabled: true });
    },

    setAccentColor: async (hex) => {
        set({ accentColor: hex });
        applyAccentVars(hex, isDarkTheme(get().theme));
        try { await api.setSetting('accent_color', hex); } catch { }
    },

    setAppIcon: async (patch) => {
        const icon = normalizeIcon({ ...get().appIcon, ...patch });
        set({ appIcon: icon });
        applyIcon(icon);
        // One row per choice, and only the ones that moved: the three are
        // independent settings, not one JSON blob, so a value written by an
        // older build (or by hand) still reads.
        const rows: [string, string][] = [];
        if (patch.style !== undefined) rows.push([ICON_KEYS.style, icon.style]);
        if (patch.background !== undefined) rows.push([ICON_KEYS.background, icon.background]);
        if (patch.radius !== undefined) rows.push([ICON_KEYS.radius, String(icon.radius)]);
        for (const [key, value] of rows) {
            try { await api.setSetting(key, value); } catch { }
        }
    },

    setUiScale: async (scale) => {
        const pct = clampUiScale(scale);
        set({ uiScale: pct });
        applyUiScale(pct);
        try { await api.setSetting('ui_scale', String(pct)); } catch { }
    },

    setSidebarWidth: async (width) => {
        // Cap against the viewport so a narrow laptop can't let the sidebar
        // starve the center pane.
        const vwCap = typeof window !== 'undefined' ? Math.round(window.innerWidth * 0.4) : 600;
        const clamped = Math.max(200, Math.min(600, vwCap, width));
        set({ sidebarWidth: clamped });
        try { await api.setSetting('sidebarWidth', String(clamped)); } catch { }
    },

    setDetailPanelWidth: async (width) => {
        const vwCap = typeof window !== 'undefined' ? Math.round(window.innerWidth * 0.5) : 600;
        const clamped = Math.max(300, Math.min(600, Math.max(300, vwCap), width));
        set({ detailPanelWidth: clamped });
        try { await api.setSetting('detailPanelWidth', String(clamped)); } catch { }
    },

    setWeekStartDay: async (day) => {
        set({ weekStartDay: day });
        try { await api.setSetting('week_start_day', String(day)); } catch { }
    },

    setNumberFormat: async (style) => {
        // Applied before it is stored, like the theme and the language: the
        // change IS the feedback, and every number on screen is the preview.
        set({ numberFormat: style });
        setNumberPreference(style);
        try { await api.setSetting('number_format', style); } catch { }
    },

    setAtlasColorMode: async (mode) => {
        set({ atlasColorMode: mode });
        try { await api.setSetting('atlas_color_mode', mode); } catch { }
    },

    setAtlasSurface: async (surface) => {
        set({ atlasSurface: surface });
        try { await api.setSetting('atlas_surface', surface); } catch { }
    },

    setUiLanguage: async (code) => {
        // Applied before it is stored, like the theme: the change is the
        // feedback, and a setting that only lands after a round trip reads as
        // a control that did nothing.
        set({ uiLanguage: code });
        await applyUiLanguage(resolveLanguagePreference(code));
        try { await api.setSetting('ui_language', code); } catch { }
    },

    setProjects: (projects) => set({ projects }),
    setTree: (tree) => set({ tree }),

    loadSettings: async () => {
        try {
            const settings = await api.getSettings();
            // Legacy value 'dark'/'light' still maps cleanly; anything unknown → light.
            const theme: Theme = THEME_IDS.includes(settings.theme as Theme)
                ? (settings.theme as Theme) : 'light';
            const sidebarWidth = settings.sidebarWidth ? parseInt(settings.sidebarWidth) : 256;
            const detailPanelWidth = settings.detailPanelWidth ? parseInt(settings.detailPanelWidth) : 420;
            const accentColor = settings.accent_color || DEFAULT_ACCENT_COLOR;
            const appIcon = normalizeIcon({
                style: settings[ICON_KEYS.style],
                background: settings[ICON_KEYS.background],
                radius: settings[ICON_KEYS.radius],
            });
            const weekStartDay: WeekStartDay = settings.week_start_day === '0' ? 0 : 1;
            const atlasColorMode: AtlasColorMode =
                settings.atlas_color_mode === 'course' ? 'course' : 'mastery';
            // The flat map is the default and anything unrecognised falls back
            // to it — a stored value from a future build must never leave the
            // atlas with no surface to draw on.
            const atlasSurface: AtlasSurface =
                settings.atlas_surface === 'globe' ? 'globe' : 'map';
            const uiScale = clampUiScale(settings.ui_scale ?? DEFAULT_UI_SCALE);
            const uiLanguage = settings.ui_language || 'auto';
            // An unknown or absent value follows the interface language, which
            // is what every reader got before this preference existed.
            const numberFormat = isNumberStyle(settings.number_format) ? settings.number_format : NUMBER_AUTO;
            // The scheduler runs the fitted FSRS parameters when the optimiser
            // has produced an accepted set (Settings → Learning), else the
            // published defaults. Applied here, on every settings load, so a
            // fit done on another device reaches this one without a reload.
            try {
                configureSrs({ w: settings.fsrs_params ? JSON.parse(settings.fsrs_params) : null });
            } catch {
                configureSrs({ w: null });
            }
            // Mirror of the server's own provider→model resolution in
            // getAISettings(): the OpenAI-compatible path has its own model key.
            const aiProvider = settings.ai_provider === 'openai' ? 'openai' : 'ollama';
            const aiModel = (aiProvider === 'openai' ? settings.ai_openai_model : settings.ai_model) || null;
            // `true` was the old checkbox, and it meant "ask me each time" —
            // never the looser reading, which the learner has not chosen.
            const raw = settings.ai_web_search;
            const aiWebSearchMode: WebSearchMode = raw === 'auto' ? 'auto'
                : (raw === 'ask' || raw === 'true') ? 'ask' : 'off';
            set({ theme, sidebarWidth, detailPanelWidth, accentColor, appIcon, uiScale, weekStartDay, atlasColorMode, atlasSurface, numberFormat, uiLanguage, aiProvider, aiModel, aiWebSearchMode });
            // The non-component call sites read a module variable rather than
            // the store, so it has to be written here too.
            setNumberPreference(numberFormat);
            applyThemeToDom(theme);
            applyAccentVars(accentColor, isDarkTheme(theme));
            applyIcon(appIcon);
            applyUiScale(uiScale);
            // The server's choice wins over this device's cache — a language picked
            // on the desktop reaches the phone on its next load.
            void applyUiLanguage(resolveLanguagePreference(uiLanguage));
        } catch { }
    },

    loadVersion: async () => {
        // Two calls, both local: identity never changes, and the update verdict
        // is whatever the last check stored. Neither reaches the network, so
        // this is safe to fire on every app start regardless of the setting.
        try {
            const [appVersion, updateStatus] = await Promise.all([api.getVersion(), api.getUpdates()]);
            set({ appVersion, updateStatus });
        } catch {
            // Identity is a nicety, not a dependency. A server too old to serve
            // /api/version simply shows nothing in About.
        }
    },

    checkForUpdates: async () => {
        try {
            set({ updateStatus: await api.checkUpdates() });
        } catch (e: any) {
            get().addToast(e?.message || i18n.t('Could not check for updates'), 'error');
        }
    },

    setAutoUpdateCheck: async (enabled: boolean) => {
        // Optimistic on the toggle only — flipping a switch must feel immediate
        // even though turning it ON performs a check before it answers.
        const prev = get().updateStatus;
        if (prev) set({ updateStatus: { ...prev, enabled } });
        try {
            set({ updateStatus: await api.setAutoUpdateCheck(enabled) });
        } catch (e: any) {
            if (prev) set({ updateStatus: prev });
            get().addToast(e?.message || i18n.t('Could not change the update setting'), 'error');
        }
    },

    dismissUpdate: () => set({ updateDismissed: get().updateStatus?.latest?.version ?? null }),

    loadSearchProviders: async () => {
        try {
            const { providers } = await api.getSearchProviders();
            set({ searchProviders: providers });
        } catch {
            // Providers are an enhancement, never a dependency: with none loaded
            // the outbound-search buttons simply don't render.
        }
    },

    setSearchProviderEnabled: async (id, enabled) => {
        // Optimistic: this is a checkbox, and a round trip before the tick moves
        // reads as a broken control.
        set({ searchProviders: get().searchProviders.map(p => (p.id === id ? { ...p, enabled } : p)) });
        try {
            await api.setSearchProviderEnabled(id, enabled);
        } catch (e: any) {
            set({ searchProviders: get().searchProviders.map(p => (p.id === id ? { ...p, enabled: !enabled } : p)) });
            get().addToast('error', i18n.t('Could not change that search provider'), e.message);
        }
    },

    addSearchProvider: async (manifest) => {
        try {
            const provider = await api.addSearchProvider(manifest);
            await get().loadSearchProviders();
            get().addToast('success', i18n.t('Added "{{label}}"', { label: provider.label }));
            return true;
        } catch (e: any) {
            get().addToast('error', i18n.t('Search provider rejected'), e.message);
            return false;
        }
    },

    removeSearchProvider: async (id) => {
        try {
            await api.removeSearchProvider(id);
            await get().loadSearchProviders();
        } catch (e: any) {
            get().addToast('error', i18n.t('Could not remove that search provider'), e.message);
        }
    },

    loadProjects: async ({ silent = false } = {}) => {
        set({ loading: true });
        try {
            const projects = await api.getProjects();
            set({ projects, loading: false });
            const currentId = get().currentProjectId;
            if (currentId) {
                const current = projects.find(p => p.id === currentId);
                if (current && current.due_flashcard_count !== undefined) {
                    set({ dueFlashcardCount: current.due_flashcard_count });
                }
            }
        } catch (e: any) {
            set({ loading: false });
            // A backgrounded phone (PWA switched away, screen off) drops in-flight
            // fetches; the 3s poll then piles up failures that all surface at once
            // on resume. Nothing is wrong and nothing is actionable — the next tick
            // refetches — so background callers stay quiet. Only a load the learner
            // actually triggered (app start, manual refresh) reports.
            if (!silent) get().addToast('error', i18n.t('Failed to load projects'), e.message);
        }
    },

    setNavigate: (fn) => set({ _navigate: fn }),

    // Navigation actions below are thin wrappers over the router: they change the
    // URL, and `applyRoute` (driven by `useRouterStoreSync`) reconciles the store.
    // This keeps the URL authoritative — back/forward, deep links and refresh all
    // "just work" — while every existing call-site keeps the same signature.
    openProject: async (id) => {
        const nav = get()._navigate;
        if (nav) nav(`/project/${id}`);
        else { set({ view: 'workspace' }); await get().loadProjectData(id); }
    },

    closeProject: () => {
        // "Up" from a workspace is the project list, not the Today hub.
        const nav = get()._navigate;
        if (nav) nav('/projects');
        else set({
            currentProjectId: null, view: 'projects', nodes: [], tree: [],
            selectedNodeId: null, focusedNodeId: null, resources: [], paceData: null,
            workspaceView: 'dashboard', dashboardData: null, dueFlashcardCount: 0,
        });
    },

    openProjectNode: (projectId, nodeId) => {
        // Cross-project deep link (Today hub / global calendar / briefing action).
        // applyRoute → loadProjectData → revealNode handles the cold load.
        const nav = get()._navigate;
        if (nav) nav(`/project/${projectId}/tree/${nodeId}`);
    },

    studyNode: (projectId, nodeId) => {
        const nav = get()._navigate;
        if (nav) nav(`/project/${projectId}/study/${nodeId}`);
    },

    loadFeed: async (scopeNodeId = null) => {
        set({ feedLoading: true, feedScope: scopeNodeId });
        try {
            const res = await api.getFeed(undefined, 15, scopeNodeId);
            // A slower load for another scope must not land on this one.
            if (get().feedScope !== scopeNodeId) return;
            set({
                feedCards: res.items,
                feedHeader: res.header,
                feedTransfers: res.transfers || {},
                feedExhausted: res.exhausted,
                feedDone: {},
                feedFocusItemId: null,
                feedLoading: false,
            });
        } catch (e: any) {
            set({ feedLoading: false });
            get().addToast('error', i18n.t('Failed to load your feed'), e.message);
        }
    },

    extendFeed: async () => {
        if (get().feedLoading || get().feedExhausted) return;
        set({ feedLoading: true });
        try {
            const exclude = get().feedCards.map(c => c.key);
            const res = await api.getFeed(exclude, 15, get().feedScope);
            // Append-only, deduped by key: cards already on screen are never
            // reordered or replaced, so the scroll position can't jump.
            const seen = new Set(exclude);
            const fresh = res.items.filter(c => !seen.has(c.key));
            set(state => ({
                feedCards: [...state.feedCards, ...fresh],
                feedHeader: res.header,
                // Merged, not replaced: a later page carries head starts only
                // for the topics IT holds, and dropping the earlier ones would
                // blank the banner on chapters still on screen.
                feedTransfers: { ...state.feedTransfers, ...(res.transfers || {}) },
                feedExhausted: res.exhausted,
                feedLoading: false,
            }));
        } catch (e: any) {
            set({ feedLoading: false });
            get().addToast('error', i18n.t('Failed to load more cards'), e.message);
        }
    },

    pullFeedUpdates: async () => {
        // Background generation (server/feedGen.js) writes lessons into
        // feed_items while the learner is sitting on the page. Without this they
        // only surface on a full reload — the dead end you hit after burning
        // through the feed while the AI was unavailable: generation resumes, new
        // lessons exist, and the page keeps showing "that's everything".
        //
        // Unlike extendFeed this deliberately ignores `feedExhausted`: exhausted
        // was true a moment ago, and the entire point is that it no longer is.
        // Failures are silent — this is a background poll, not a user action.
        if (get().feedLoading) return;
        const now = Date.now();
        if (now - lastFeedPullAt < FEED_PULL_MIN_MS) return;
        lastFeedPullAt = now;

        set({ feedLoading: true });
        try {
            const exclude = get().feedCards.map(c => c.key);
            const res = await api.getFeed(exclude, 15, get().feedScope);
            const seen = new Set(exclude);
            const fresh = res.items.filter(c => !seen.has(c.key));
            set(state => ({
                // Append-only and never reordered, same contract as extendFeed —
                // cards already on screen must not move under the reader.
                feedCards: fresh.length ? [...state.feedCards, ...fresh] : state.feedCards,
                feedHeader: res.header,
                feedTransfers: { ...state.feedTransfers, ...(res.transfers || {}) },
                feedExhausted: res.exhausted,
                feedLoading: false,
            }));
        } catch {
            set({ feedLoading: false });
        }
    },

    repairFeedVisual: (key, originalCode, repairedCode) => {
        const card = get().feedCards.find(c => c.key === key);
        if (!card) return;
        // Shape-agnostic on purpose: a lesson keeps its spec in `markdown`, a
        // question in its stem, a practice card in its brief. Identity tells us
        // whether anything actually matched.
        const patched = deepReplaceStrings(card, originalCode, repairedCode);
        if (patched === card) return;
        set(state => ({
            feedCards: state.feedCards.map(c => (c.key === key ? patched : c)),
        }));
        // Degraded cards (built from the node's own notes) have no row to write to.
        // Best-effort: the on-screen render is already fixed either way.
        const feedItemId = 'feedItemId' in card ? card.feedItemId : null;
        if (feedItemId) api.repairFeedVisual(feedItemId, originalCode, repairedCode).catch(() => { });
    },

    consumeFeedCard: async (key, payload) => {
        // Optimistic: collapse the card immediately; the server call settles stats.
        set(state => ({ feedDone: { ...state.feedDone, [key]: true } }));
        try {
            const res = await api.consumeFeedCard({ key, ...payload });
            if (res?.stats) get().updateFeedStats(res.stats);
        } catch (e: any) {
            get().addToast('error', i18n.t('Failed to save your progress'), e.message);
        }
    },

    setFeedFocusItem: (feedItemId) => {
        // Fires on scroll, so guard the no-op: a set() with an unchanged value
        // still notifies every subscriber.
        if (get().feedFocusItemId !== feedItemId) set({ feedFocusItemId: feedItemId });
    },

    markFeedCardDone: (key) => {
        set(state => ({ feedDone: { ...state.feedDone, [key]: true } }));
    },

    /**
     * A card rated Again in the feed comes back in the feed.
     *
     * Without this the ladder was half-built: the rating scheduled the card ten
     * minutes out, correctly, and the stream then never showed it — the learner
     * met it again on the next feed load, whenever that happened to be. Anki
     * treats learning cards as their own time-ordered queue that is served
     * before anything else; a stream cannot do "before", but it can do "later in
     * this scroll", which is the same promise kept in the shape this surface has.
     *
     * **Appended, not inserted.** The feed's standing contract is that cards
     * already rendered never move (`extendFeed`, `pullFeedUpdates`): splicing a
     * card in above the reader's position would shift everything below it and
     * take the scroll with it. Appending puts the repetition after whatever is
     * loaded — which is what the reader reaches next — and `extendFeed` then
     * appends the next server page after THAT, so the gap grows naturally rather
     * than being a number somebody picked.
     *
     * A fresh `key` (never the server's) is what makes it a new card to React,
     * so it mounts unflipped and unanswered instead of inheriting the done state
     * of the copy above it. The row travels with it, so the next rating is
     * computed from the state the ladder actually left the card in.
     */
    requeueFeedCard: (key, card, dueAt) => {
        set(state => {
            const original = state.feedCards.find(c => c.key === key);
            if (!original || original.kind !== 'flashcard') return {};
            // Count from the ORIGINAL key, so a card that goes round three times
            // gets three distinct keys rather than colliding on the second.
            const round = state.feedCards.filter(
                c => c.kind === 'flashcard' && c.card.id === card.id
            ).length;
            return {
                feedCards: [...state.feedCards, {
                    ...original,
                    key: `${key}-again${round}`,
                    card,
                    isNew: false,
                    requeuedAt: dueAt,
                }],
            };
        });
    },

    updateFeedStats: (stats) => {
        set(state => state.feedHeader
            ? { feedHeader: { ...state.feedHeader, stats } }
            : {});
    },

    selectNode: async (id) => {
        const nav = get()._navigate;
        const pid = get().currentProjectId;
        if (nav && pid) {
            const view = get().workspaceView || 'tree';
            nav(`/project/${pid}/${view}${id != null ? `/${id}` : ''}`);
            return;
        }
        // Fallback (router not yet wired): select directly.
        if (id != null) get().revealNode(id);
        set({ selectedNodeId: id, focusedNodeId: id, resources: [] });
        if (id) {
            const resources = await api.getResources(id);
            if (get().selectedNodeId === id) set({ resources });
        }
    },

    loadProjectData: async (id) => {
        set({ loading: true, currentProjectId: id });
        try {
            const nodes = await api.getNodes(id);
            const tree = buildTree(nodes);
            const storedExpansion = loadExpansionState();
            const expanded: Record<number, boolean> = { ...storedExpansion };
            const setDefaultExpanded = (items: TreeNode[]) => {
                items.forEach(n => {
                    if (expanded[n.id] === undefined) expanded[n.id] = true;
                    setDefaultExpanded(n.children);
                });
            };
            setDefaultExpanded(tree);
            set({ nodes, tree, expanded, loading: false, selectedNodeId: null, focusedNodeId: null, resources: [], dashboardData: null });
            saveExpansionState(expanded);
            get().loadPaceData(id);
            get().loadDashboard(id);
            get().loadDueFlashcardCount(id);
        } catch (e: any) {
            set({ loading: false });
            get().addToast('error', i18n.t('Failed to open project'), e.message);
        }
    },

    revealNode: (id) => {
        // Expand a node's ancestors so tree/sidebar (which only render nodes whose
        // ancestors are expanded) can scroll it into view.
        const path = getNodePath(get().tree, id);
        if (path.length > 1) {
            const expanded = { ...get().expanded };
            let changed = false;
            for (let i = 0; i < path.length - 1; i++) {
                if (expanded[path[i].id] !== true) { expanded[path[i].id] = true; changed = true; }
            }
            if (changed) { set({ expanded }); saveExpansionState(expanded); }
        }
    },

    applyRoute: async ({ view, projectId = null, workspaceView = 'dashboard', nodeId = null }) => {
        // SETTINGS: render as an overlay; leave any loaded project intact so
        // returning to it is instant (no reload).
        if (view === 'settings') {
            if (get().view !== 'settings') set({ view: 'settings' });
            return;
        }
        // GLOBAL VIEWS (Today hub, projects grid, global calendar): clear any open
        // project (mirrors the old closeProject reset).
        if (view === 'today' || view === 'projects' || view === 'calendar' || view === 'schedule' || view === 'atlas') {
            const s = get();
            if (s.view !== view || s.currentProjectId !== null) {
                set({
                    view, currentProjectId: null, nodes: [], tree: [],
                    selectedNodeId: null, focusedNodeId: null, resources: [], paceData: null,
                    workspaceView: 'dashboard', dashboardData: null, dueFlashcardCount: 0,
                });
            }
            // Refresh the feed on every entry to the home page (non-blocking;
            // FeedView renders the cached stream first). Skip when a stream is
            // already on screen — re-entering must not reset reading position.
            // A stream scoped to one topic (the study page) is not the home
            // feed, so coming home from it always reloads.
            if (view === 'today' && (get().feedCards.length === 0 || get().feedScope !== null)) void get().loadFeed();
            if (get().studyNodeId !== null) set({ studyNodeId: null });
            return;
        }
        // WORKSPACE
        if (projectId == null || Number.isNaN(projectId)) { get()._navigate?.('/'); return; }
        const wsView = VALID_WORKSPACE_VIEWS.has(workspaceView) ? workspaceView : 'dashboard';
        // Switch the shell to workspace up front so the header updates immediately,
        // even while a cold deep-link is still loading its data below.
        if (get().view !== 'workspace' || get().workspaceView !== wsView) {
            set({ view: 'workspace', workspaceView: wsView });
        }
        // Load when entering a different project (or when nothing is loaded, e.g. a
        // deep-link / refresh straight into a workspace URL).
        if (get().currentProjectId !== projectId || get().nodes.length === 0) {
            await get().loadProjectData(projectId);
        }
        // STUDY: the feed scoped to the URL's node. The node is the page, not a
        // selection — the detail panel stays closed, so on a phone the study
        // stream is not covered by the panel's full-screen overlay.
        if (wsView === 'study') {
            if (nodeId == null || Number.isNaN(nodeId)) { get()._navigate?.(`/project/${projectId}`); return; }
            if (get().selectedNodeId !== null) set({ selectedNodeId: null, focusedNodeId: null, resources: [] });
            if (get().studyNodeId !== nodeId) set({ studyNodeId: nodeId });
            if (get().feedScope !== nodeId) void get().loadFeed(nodeId);
            return;
        }
        if (get().studyNodeId !== null) set({ studyNodeId: null });
        // Node selection is driven by the URL's optional :nodeId segment.
        if (nodeId == null || Number.isNaN(nodeId)) {
            if (get().selectedNodeId !== null) set({ selectedNodeId: null, focusedNodeId: null, resources: [] });
        } else if (get().selectedNodeId !== nodeId) {
            set({ selectedNodeId: nodeId, focusedNodeId: nodeId, resources: [] });
            get().revealNode(nodeId);
            try {
                const resources = await api.getResources(nodeId);
                if (get().selectedNodeId === nodeId) set({ resources });
            } catch { /* resource load is best-effort */ }
        }
    },

    setFocusedNode: (id) => set({ focusedNodeId: id }),

    toggleExpanded: (id) => {
        const newExpanded = { ...get().expanded, [id]: !get().expanded[id] };
        set({ expanded: newExpanded });
        saveExpansionState(newExpanded);
    },

    setExpanded: (id, value) => {
        const newExpanded = { ...get().expanded, [id]: value };
        set({ expanded: newExpanded });
        saveExpansionState(newExpanded);
    },

    expandAll: () => {
        const expanded: Record<number, boolean> = {};
        get().nodes.forEach(n => { expanded[n.id] = true; });
        set({ expanded });
        saveExpansionState(expanded);
    },

    collapseAll: () => {
        const expanded: Record<number, boolean> = {};
        get().nodes.forEach(n => { expanded[n.id] = false; });
        set({ expanded });
        saveExpansionState(expanded);
    },

    toggleAllExpanded: () => {
        const currentExpanded = get().expanded;
        const nodes = get().nodes;
        const allExpanded = nodes.every(n => currentExpanded[n.id] !== false);
        const expanded: Record<number, boolean> = {};
        nodes.forEach(n => { expanded[n.id] = !allExpanded; });
        set({ expanded });
        saveExpansionState(expanded);
    },

    createProject: async (projectData) => {
        try {
            const project = await api.createProject(projectData);
            await get().loadProjects();
            get().addToast('success', i18n.t('Project "{{name}}" created', { name: project.name }));
            return project;
        } catch (e: any) {
            get().addToast('error', i18n.t('Failed to create project'), e.message);
            throw e;
        }
    },

    updateProject: async (id, updates) => {
        try {
            await api.updateProject(id, updates);
            await get().loadProjects();
            get().addToast('success', i18n.t('Project updated'));
        } catch (e: any) {
            get().addToast('error', i18n.t('Failed to update project'), e.message);
        }
    },

    deleteProject: async (id) => {
        try {
            await api.deleteProject(id);
            await get().loadProjects();
            get().addToast('success', i18n.t('Project deleted'));
        } catch (e: any) {
            get().addToast('error', i18n.t('Failed to delete project'), e.message);
        }
    },

    reorderProjects: async (projectIds) => {
        try {
            const projects = await api.reorderProjects(projectIds);
            set({ projects });
        } catch (e: any) {
            await get().loadProjects();
            get().addToast('error', i18n.t('Failed to reorder projects'), e.message);
        }
    },

    createNode: async (nodeData) => {
        const projectId = get().currentProjectId;
        if (!projectId) return;
        try {
            await api.createNode({ ...nodeData, project_id: projectId });
            await get().refreshNodes();
            get().addToast('success', i18n.t('Item created'));
        } catch (e: any) {
            get().addToast('error', i18n.t('Failed to create item'), e.message);
        }
    },

    updateNode: async (id, updates) => {
        try {
            await api.updateNode(id, updates);
            await get().refreshNodes();
            const projectId = get().currentProjectId;
            if (projectId) {
                const project = get().projects.find(p => p.id === projectId);
                if (project?.start_date && project?.deadline) {
                    get().loadPaceData(projectId);
                }
                get().loadDashboard(projectId);
            }
            if (updates.status === undefined || Object.keys(updates).length > 1) {
                get().addToast('success', i18n.t('Changes saved'));
            }
            // Closing a topic is the commonest way a project reaches its end.
            if (updates.status && projectId) get().checkProjectCompletion(projectId);
            return true;
        } catch (e: any) {
            const msg = e.message || 'Failed to save changes';
            if (e.data?.mastery_gate || msg.includes('mastery_gate')) {
                // Completion was intercepted by the mastery gate. Open the Boss
                // Fight modal; in advisory mode it also offers "mark done anyway".
                const node = get().nodes.find(n => n.id === id);
                if (node) get().openMasteryGate(id, node.title, e.data?.advisory ?? true);
                return false;
            } else {
                get().addToast('error', i18n.t('Failed to save changes'), msg);
                return false;
            }
        }
    },

    skipNode: async (id) => {
        // Mark a topic "skipped" — honestly closed without proving mastery.
        // Bypasses the gate entirely (handled server-side).
        try {
            await api.updateNode(id, { status: 'skipped' });
            await get().refreshNodes();
            const projectId = get().currentProjectId;
            if (projectId) {
                const project = get().projects.find(p => p.id === projectId);
                if (project?.start_date && project?.deadline) get().loadPaceData(projectId);
                get().loadDashboard(projectId);
            }
            get().addToast('info', i18n.t('Marked as skipped'), i18n.t('Tracked separately from verified completions.'));
            if (projectId) get().checkProjectCompletion(projectId);
            return true;
        } catch (e: any) {
            get().addToast('error', i18n.t('Failed to skip topic'), e.message);
            return false;
        }
    },

    deleteNode: async (id) => {
        const selectedId = get().selectedNodeId;
        try {
            await api.deleteNode(id);
            // Drop the deleted node from the URL/selection if it was open.
            if (selectedId === id) get().selectNode(null);
            await get().refreshNodes();
            const projectId = get().currentProjectId;
            if (projectId) {
                const project = get().projects.find(p => p.id === projectId);
                if (project?.start_date && project?.deadline) {
                    get().loadPaceData(projectId);
                }
                get().loadDashboard(projectId);
            }
            get().addToast('success', i18n.t('Item deleted'));
        } catch (e: any) {
            get().addToast('error', i18n.t('Failed to delete item'), e.message);
        }
    },

    moveNode: async (id, parentId, position) => {
        const projectId = get().currentProjectId;
        if (!projectId) return;
        try {
            await api.moveNode(id, parentId, position);
            await get().refreshNodes();
        } catch (e: any) {
            get().addToast('error', i18n.t('Failed to move item'), e.message);
        }
    },

    reorderNodes: async (nodeIds, parentId) => {
        try {
            await api.reorderNodes(nodeIds, parentId);
            await get().refreshNodes();
        } catch (e: any) {
            await get().refreshNodes();
            get().addToast('error', i18n.t('Failed to reorder items'), e.message);
        }
    },

    refreshNodes: async () => {
        const projectId = get().currentProjectId;
        if (!projectId) return;
        const nodes = await api.getNodes(projectId);
        const tree = buildTree(nodes);
        set({ nodes, tree });
    },

    loadResources: async (nodeId) => {
        const resources = await api.getResources(nodeId);
        set({ resources });
    },

    createResource: async (resData) => {
        try {
            await api.createResource(resData);
            if (resData.node_id) {
                const resources = await api.getResources(resData.node_id);
                set({ resources });
            }
            get().addToast('success', i18n.t('Resource added'));
        } catch (e: any) {
            get().addToast('error', i18n.t('Failed to add resource'), e.message);
        }
    },

    updateResource: async (id, updates) => {
        try {
            await api.updateResource(id, updates);
            const nodeId = get().selectedNodeId;
            if (nodeId) {
                const resources = await api.getResources(nodeId);
                set({ resources });
            }
        } catch (e: any) {
            get().addToast('error', i18n.t('Failed to update resource'), e.message);
        }
    },

    deleteResource: async (id) => {
        try {
            await api.deleteResource(id);
            const nodeId = get().selectedNodeId;
            if (nodeId) {
                const resources = await api.getResources(nodeId);
                set({ resources });
            }
            get().addToast('success', i18n.t('Resource deleted'));
        } catch (e: any) {
            get().addToast('error', i18n.t('Failed to delete resource'), e.message);
        }
    },

    reorderResources: async (resourceIds) => {
        try {
            await api.reorderResources(resourceIds);
            const nodeId = get().selectedNodeId;
            if (nodeId) {
                const resources = await api.getResources(nodeId);
                set({ resources });
            }
        } catch (e: any) {
            get().addToast('error', i18n.t('Failed to reorder resources'), e.message);
        }
    },

    addToast: (type, message, details) => {
        // Collapse into an existing floating toast with the identical type + message:
        // bump its counter, keep the first one's details, and restart its countdown so it
        // lingers while duplicates keep arriving (the component re-blips on the count change).
        const existing = get().toasts.find(t => t.type === type && t.message === message);
        if (existing) {
            set(state => ({
                toasts: state.toasts.map(t =>
                    t.id === existing.id
                        ? { ...t, count: t.count + 1, timestamp: Date.now() }
                        : t
                ),
            }));
            const prev = toastTimers.get(existing.id);
            if (prev) clearTimeout(prev);
            toastTimers.set(existing.id, setTimeout(() => { get().removeToast(existing.id); }, TOAST_DURATION));
            return;
        }
        const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const toast: Toast = { id, type, message, details, timestamp: Date.now(), count: 1 };
        set(state => ({ toasts: [...state.toasts, toast] }));
        toastTimers.set(id, setTimeout(() => { get().removeToast(id); }, TOAST_DURATION));
    },

    removeToast: (id) => {
        const timer = toastTimers.get(id);
        if (timer) { clearTimeout(timer); toastTimers.delete(id); }
        set(state => ({ toasts: state.toasts.filter(t => t.id !== id) }));
    },

    setSearchQuery: (query) => {
        set({ searchQuery: query });
    },

    setSearchOpen: (open) => {
        set({ searchOpen: open });
        if (!open) {
            set({ searchQuery: '', searchResults: null, searchLoading: false });
        }
    },

    performSearch: async (query) => {
        const trimmed = query.trim();
        if (trimmed.length < 2) {
            set({ searchResults: null, searchLoading: false });
            return;
        }

        set({ searchLoading: true });

        try {
            const currentProjectId = get().currentProjectId;
            const results = await api.search(trimmed, {
                projectId: currentProjectId || undefined,
                limit: 8,
            });
            set({ searchResults: results, searchLoading: false });
        } catch {
            set({ searchLoading: false });
        }
    },

    clearSearch: () => {
        set({ searchQuery: '', searchResults: null, searchLoading: false, searchOpen: false });
    },

    setWorkspaceView: (view) => {
        const nav = get()._navigate;
        const pid = get().currentProjectId;
        if (!nav || !pid) { set({ workspaceView: view }); return; }
        const nodeId = get().selectedNodeId;
        nav(`/project/${pid}/${view}${nodeId ? `/${nodeId}` : ''}`);
    },

    setShowScheduleModal: (show, projectId) => set({
        showScheduleModal: show,
        scheduleModalProjectId: projectId ?? get().currentProjectId,
    }),

    scheduleProject: async (projectId, config) => {
        try {
            const result = await api.scheduleProject(projectId, config);
            if (!result.success) { get().addToast('error', i18n.t('Failed to generate schedule'), result.error); return false; }
            if (result.warnings && result.warnings.length > 0) {
                get().addToast('info', i18n.t('Schedule Notes'), result.warnings.join(i18n.t('\n')));
            }
            await get().loadProjects();
            if (projectId === get().currentProjectId) { await get().refreshNodes(); await get().loadPaceData(projectId); await get().loadDashboard(projectId); }
            get().addToast('success', i18n.t('Schedule generated successfully'));
            set({ showScheduleModal: false });
            return true;
        } catch (e: any) {
            get().addToast('error', i18n.t('Failed to generate schedule'), e.message);
            return false;
        }
    },

    recalibrateSchedule: async (projectId) => {
        try {
            const result = await api.recalibrateSchedule(projectId);
            if (!result.success) {
                if (result.suggestedDeadline) get().addToast('info', i18n.t('Deadline Suggestion'), i18n.t('Consider extending deadline to {{date}}', { date: result.suggestedDeadline }));
                get().addToast('error', i18n.t('Recalibration failed'), result.error);
                return false;
            }
            if (result.unchanged) { get().addToast('success', i18n.t('All tasks completed!')); return true; }
            if (result.warnings && result.warnings.length > 0) {
                get().addToast('info', i18n.t('Schedule Notes'), result.warnings.join(i18n.t('\n')));
            }
            await get().loadProjects();
            if (projectId === get().currentProjectId) { await get().refreshNodes(); await get().loadPaceData(projectId); await get().loadDashboard(projectId); }
            // Recalibrating (from a workspace) reshapes the feed's focus — rebuild
            // the stream if the user is currently on the home page.
            if (get().view === 'today') await get().loadFeed();
            get().addToast('success', i18n.t('Schedule recalibrated from today'));
            return true;
        } catch (e: any) {
            get().addToast('error', i18n.t('Failed to recalibrate schedule'), e.message);
            return false;
        }
    },

    removeSchedule: async (projectId) => {
        try {
            await api.removeSchedule(projectId);
            await get().loadProjects();
            if (projectId === get().currentProjectId) { await get().refreshNodes(); set({ paceData: null }); await get().loadDashboard(projectId); }
            get().addToast('success', i18n.t('Schedule removed'));
        } catch (e: any) {
            get().addToast('error', i18n.t('Failed to remove schedule'), e.message);
        }
    },

    loadPaceData: async (projectId) => {
        set({ paceLoading: true });
        try {
            const pace = await api.getProjectPace(projectId);
            set({ paceData: pace, paceLoading: false });
        } catch {
            set({ paceLoading: false });
        }
    },

    showConfirm: (options: ShowConfirmOptions) => {
        return new Promise<boolean>((resolve) => {
            set({
                confirmDialog: {
                    isOpen: true,
                    title: options.title,
                    message: options.message,
                    confirmLabel: options.confirmLabel || i18n.t('Confirm'),
                    cancelLabel: options.cancelLabel || i18n.t('Cancel'),
                    // Default is benign: a confirm with no variant must never
                    // imply destruction. Destructive callers pass 'danger'
                    // explicitly (they all already do).
                    variant: options.variant || 'info',
                    resolvePromise: resolve,
                }
            });
        });
    },

    hideConfirm: (result: boolean) => {
        const { resolvePromise } = get().confirmDialog;
        resolvePromise?.(result);
        set({
            confirmDialog: {
                isOpen: false,
                title: '',
                message: '',
                confirmLabel: '',
                cancelLabel: '',
                variant: 'info',
                resolvePromise: null,
            }
        });
    },

    setAICreationMinimized: (val) => set({ aiCreationMinimized: val }),

    setAICreationActive: (val) => {
        set({ aiCreationActive: val });
        if (!val) set({ aiCreationMinimized: false, aiCreationProgress: null });
    },

    setAICreationProgress: (data) => set({ aiCreationProgress: data }),

    setShowAICreationModal: (val) => set({ showAICreationModal: val }),

    loadDashboard: async (projectId) => {
        set({ dashboardLoading: true });
        try {
            const data = await api.getStudyDashboard(projectId);
            set({ dashboardData: data, dashboardLoading: false });
            // Keep "Today's Plan" in lockstep with the dashboard: every refresh path
            // (node completed/skipped, schedule edit, recalibrate) flows through here.
            get().loadDailyPlan(projectId);
            return { success: true };
        } catch (e: any) {
            console.error('Failed to load dashboard:', e);
            set({ dashboardLoading: false });
            return { success: false, error: e.message };
        }
    },

    loadDailyPlan: async (projectId) => {
        try {
            const plan = await api.getDailyPlan(projectId);
            set({ dailyPlan: plan });
        } catch (e) {
            console.error('Failed to load daily plan:', e);
            set({ dailyPlan: null });
        }
    },

    loadDueFlashcardCount: async (projectId) => {
        // Use count from project list first (avoids a separate API call)
        const project = get().projects.find(p => p.id === projectId);
        if (project && project.due_flashcard_count !== undefined) {
            set({ dueFlashcardCount: project.due_flashcard_count });
            return;
        }
        try {
            const dueCards = await api.getDueFlashcards(projectId);
            set({ dueFlashcardCount: dueCards.length });
        } catch {
            set({ dueFlashcardCount: 0 });
        }
    },

    aiTasks: [],

    startAiTaskFeed: () => {
        if (taskFeedStarted) return;
        taskFeedStarted = true;
        (async () => {
            // Reconnect forever with a short backoff — this feed is the task
            // dock's only data source and must survive server restarts.
            let dropped = false;
            while (true) {
                try {
                    await api.streamTaskList((tasks) => {
                        // The first snapshot of a stream that replaces a dropped
                        // one means the server came back. That is what a relaunch
                        // looks like from in here, and the build on disk may not
                        // be the build this page is running — so ask.
                        if (dropped) { dropped = false; noteServerReconnected(); }
                        // A chip the reader has dismissed stays gone. The
                        // server's snapshots are coalesced over 250ms, so one
                        // sent just before the DELETE landed can still carry the
                        // task — and putting it back for a quarter of a second
                        // reads as the ✕ having failed. Each id is forgotten as
                        // soon as a snapshot agrees it is gone.
                        for (const id of dismissedTasks) {
                            if (!tasks.some(t => t.id === id)) dismissedTasks.delete(id);
                        }
                        set({ aiTasks: dismissedTasks.size ? tasks.filter(t => !dismissedTasks.has(t.id)) : tasks });
                    });
                } catch { /* server unreachable — retry below */ }
                dropped = true;
                // Keep the last known list across a transient reconnect so the
                // dock doesn't flash empty on a blip; the fresh full snapshot the
                // server sends on (re)connect replaces it (empty if it restarted).
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        })();
    },

    // Cancel and dismiss both change the list HERE first, and let the server's
    // next snapshot confirm it.
    //
    // They used to do neither: the request went out and the chip waited for the
    // feed to say it had gone. That is one round trip on a desktop and forever
    // on a phone — the OS drops a backgrounded SSE socket without erroring, so
    // the reader sits on a stream that will never speak again until it times out
    // (SSE_STALE_MS) and reconnects. Which is exactly what "the ✕ does nothing,
    // though the backend probably did it" was. A control that has been pressed
    // must show that it has been pressed; the snapshot is the confirmation, not
    // the feedback.
    cancelAiTask: async (id) => {
        try {
            await api.cancelTask(id);
            set(s => ({
                aiTasks: s.aiTasks.map(t => (t.id === id ? { ...t, status: 'cancelled' as const } : t)),
            }));
        } catch (e: any) {
            get().addToast('error', i18n.t('Failed to cancel task'), e.message);
        }
    },

    dismissAiTask: async (id) => {
        const before = get().aiTasks;
        dismissedTasks.add(id);
        set({ aiTasks: before.filter(t => t.id !== id) });
        try {
            await api.dismissTask(id);
        } catch {
            dismissedTasks.delete(id);
            // The server still has it and still thinks it is live — a running
            // task cannot be dismissed, only cancelled. Put the chip back rather
            // than leave the dock disagreeing with the server until the next
            // snapshot lands (which, on a stale stream, is a minute away).
            // (Order is the dock's own business — it sorts what it is given.)
            set(s => (s.aiTasks.some(t => t.id === id)
                ? s
                : { aiTasks: [...s.aiTasks, ...before.filter(t => t.id === id)] }));
        }
    },

    openAiTask: (task) => {
        const nav = get()._navigate;
        switch (task.kind) {
            case 'chat':
            case 'quiz':
            case 'boss_fight':
            case 'flashcards':
                if (task.projectId != null && task.nodeId != null) {
                    get().openProjectNode(task.projectId, task.nodeId);
                }
                break;
            case 'insights':
                if (task.projectId != null) nav?.(`/project/${task.projectId}/dashboard`);
                break;
            case 'briefing':
            case 'today_chat':
            case 'feed':
                nav?.('/');
                break;
            case 'create_project':
                nav?.('/projects');
                // Reopen the creation modal only if this session still owns the
                // run (after a reload the grid shows the generating card instead).
                if (get().aiCreationActive) {
                    get().setAICreationMinimized(false);
                    get().setShowAICreationModal(true);
                }
                break;
        }
    },
}));