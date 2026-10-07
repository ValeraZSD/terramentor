import { create } from 'zustand';
import type { NavigateFunction } from 'react-router-dom';
import { SearchProvider } from './utils/searchProviders';
import { Project, Node, TreeNode, Resource, Toast, ScheduleConfig, PaceData, ConfirmDialogState, ShowConfirmOptions, DashboardData, SearchResults, DailyPlan, FeedCard, FeedHeaderData, FeedStats, GlobalDueFlashcard, AITaskSummary, TransferInfo, PlacementHeadStart, WeekStartDay, AtlasColorMode, AtlasSurface, AppVersion, UpdateStatus, ProjectCompletion, FeedScope, scopeKey } from './types';
import { api } from './api';
import { configureSrs } from './utils/srs';
import { buildTree, getNodePath } from './utils/tree';
import { deepReplaceStrings } from './utils/deepReplace';
import { accentSolidTriplet, accentFgTriplet, parseCssColor } from './utils/color';
import { accentTextSurface } from './utils/accentVars';
import { themeVars, themeColorFor, themeRamp } from './utils/themeRamp';
import i18n from './i18n';
// A cycle, and a safe one: each side reads the other only inside functions.
import { openCreationRunForTask } from './components/creation/creationRuns';
import { setUiLanguage as applyUiLanguage, resolveLanguagePreference } from './i18n';
import { noteServerReconnected, canReloadNow } from './utils/freshness';
import { AUTO as NUMBER_AUTO, isNumberStyle, setNumberPreference } from './utils/numberFormat';
import { AppIcon, DEFAULT_APP_ICON, ICON_KEYS, applyAppIcon, normalizeIcon } from './utils/appIcon';
import { taskPlace } from './utils/taskPlace';
import {
    AtlasSettings, ATLAS_SETTINGS_KEY, DEFAULT_ATLAS_SETTINGS, normalizeAtlasSettings,
} from './components/atlas/atlasSettings';

type View = 'today' | 'projects' | 'workspace' | 'settings' | 'calendar' | 'schedule' | 'atlas';
/**
 * TWO QUESTIONS, NOT FOUR ANSWERS.
 *
 * A person choosing how the app looks is answering two things — light or dark,
 * and what colour — and a fixed set of named themes answers both for them in a
 * handful of combinations. So the mode is the whole of this type and the colour
 * is `themeTint`, a value like any other; `src/utils/themeRamp.ts` turns the
 * pair into the twelve surface variables and explains the arithmetic.
 *
 * The `.dark` class still carries the light/dark axis, so every `dark:` variant
 * in the app is untouched by the change — which is the reason the type kept its
 * name and its two live values rather than becoming a `{mode, tint}` object
 * that every `isDarkTheme(theme)` call site would have had to be taught.
 */
export type Theme = 'light' | 'dark';
export const THEME_IDS: readonly Theme[] = ['light', 'dark'];

/** What the four old names become. Warm's tint is SOLVED, not guessed: it is
 *  the colour whose generated ramp lands within 2.4/441 of the cream that
 *  shipped (`temp/ramp-solve.mjs`, and `theme-ramp-gates.mjs` re-checks it). */
export const LEGACY_THEMES: Record<string, { theme: Theme; tint: string }> = {
    light: { theme: 'light', tint: '#ffffff' },
    warm: { theme: 'light', tint: '#f0e1d0' },
    dark: { theme: 'dark', tint: '#ffffff' },
    black: { theme: 'dark', tint: '#000000' },
};

/** No tint: the app's own slate ramp, in either mode. Paper, which is the
 *  sixteenth swatch of every palette in this app. */
export const DEFAULT_THEME_TINT = '#ffffff';

/**
 * "The surfaces changed" as one value, for the render caches that have to
 * notice — the atlas canvases, every AI visual, a widget's iframe.
 *
 * The MODE is not that value: two themes can share a mode and share nothing
 * else, so a cache keyed on it keeps the palette it was first drawn with, which
 * is the failure `VisualBlock`'s dependency comment describes.
 */
export const themeKeyOf = (theme: Theme, tint: string) => `${theme}:${tint}`;

/** The single source of truth for "is dark". A function rather than the
 *  comparison it now is, because ninety-odd call sites read it and the day the
 *  axis grows a third answer is not the day to find them. */
export const isDarkTheme = (t: Theme): boolean => t === 'dark';
export type WorkspaceView = 'dashboard' | 'tree' | 'timeline' | 'calendar' | 'vault' | 'study';

/** The in-workspace views, used to validate the `:view` URL segment. `study`
 *  is the LEARNING view of a course: the feed scoped to the whole project
 *  (`/project/:id/study`) or to one topic (`/project/:id/study/:nodeId`).
 *  Every other view administers the course; this one teaches it. */
export const VALID_WORKSPACE_VIEWS: ReadonlySet<WorkspaceView> = new Set<WorkspaceView>([
    'dashboard', 'tree', 'timeline', 'calendar', 'vault', 'study',
]);

/** THREE SCOPES, ONE STREAM — defined in types.ts (api.ts names it too),
 *  re-exported here because every caller reaches it through the store. */
export type { FeedScope } from './types';
export { scopeKey } from './types';

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
    /** The tint, and the twelve variables it generates. BOTH, because the boot
     *  script in index.html runs before any module is parsed: it can apply a
     *  map of already-computed values, and it cannot import a ramp generator.
     *  The tint itself is cached beside them only so a corrupt `vars` can be
     *  told from an absent one. */
    themeTint?: string;
    themeVars?: Record<string, string>;
    /** The header's colour, for `<meta name="theme-color">` — computed here for
     *  the same reason. */
    themeSurface?: string;
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

/** …and the tint that went with it. An unparseable one is no tint, never a
 *  half-applied one: `themeRamp` returns the base ramp for anything it cannot
 *  read, so the app is the untinted app rather than a guess. */
const initialThemeTint = (): string =>
    parseCssColor(readThemeCache().themeTint) || DEFAULT_THEME_TINT;

/** Push the global accent onto the document root so non-project screens
 *  (projects grid, settings) pick it up. The workspace overrides these per
 *  project via an inline style on a descendant. */
const applyAccentVars = (hex: string, theme: Theme, tint: string) => {
    const root = document.documentElement;
    const isDark = isDarkTheme(theme);
    const accentRgb = accentSolidTriplet(hex);
    // The TINT is half of what accent TEXT has to be legible against: the page
    // it lands on can be cream, slate or true black, and until this was passed
    // the answer was measured against stock white or stock slate-800 whatever
    // the reader had chosen.
    const accentFgRgb = accentFgTriplet(hex, isDark, accentTextSurface(isDark ? 'dark' : 'light', tint));
    root.style.setProperty('--accent-rgb', accentRgb);
    root.style.setProperty('--accent-fg-rgb', accentFgRgb);
    patchThemeCache({ accentRgb, accentFgRgb });
};

/**
 * Apply a theme to the document root.
 *
 * Three things, and the third is new: the `.dark` class carries the light/dark
 * axis (every `dark:` variant in the app), `data-theme` carries the mode for
 * the few places that read an attribute rather than a class, and the twelve
 * surface variables are WRITTEN HERE rather than declared per-theme in
 * `index.css`. That is the whole of the tint — every `bg-slate-*`,
 * `text-slate-*` and `border-slate-*` in the app resolves through them
 * (`tailwind.config.js`), so one assignment re-paints every surface without a
 * single component knowing a theme exists.
 *
 * Written as an inline style on `<html>`, which beats the `:root` block in
 * `index.css`: that block stays as the untinted fallback for the moment before
 * any script runs, and for anything rendering outside this document.
 */
const applyThemeToDom = (theme: Theme, tint: string) => {
    const root = document.documentElement;
    root.classList.toggle('dark', isDarkTheme(theme));
    root.setAttribute('data-theme', theme);
    const vars = themeVars(theme, tint);
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
    const surface = themeColorFor(theme, tint);
    patchThemeCache({ theme, themeTint: tint, themeVars: vars, themeSurface: surface });
    applyThemeColorMeta(surface);
    rememberPaintedSurfaces(theme, tint, surface);
};

/**
 * WHAT A PHONE PAINTS BEFORE THIS CODE HAS RUN AT ALL.
 *
 * An installed app's splash screen and its status strip come from the
 * `manifest.webmanifest` the platform fetched, so they are decided by the
 * SERVER, which has the mode and the tint but not the arithmetic between them
 * — that is this module, and the container ships no `src/`. Rather than a
 * second copy of the ramp over there, the two colours travel: the page and the
 * header, tagged with the pair they were generated from.
 *
 * `server/appIcon.js` uses the row only while that pair still matches the
 * theme settings, so there is no way for it to answer with a colour the app
 * would not paint — at worst it falls back to the untinted page.
 *
 * Sent once per distinct value per session, and seeded from the settings load,
 * so opening the app writes nothing and changing the theme writes one row.
 */
let paintedSurfaces = '';
export const seedPaintedSurfaces = (row: string | null | undefined) => { paintedSurfaces = row || ''; };
const rememberPaintedSurfaces = (theme: Theme, tint: string, header: string) => {
    const page = themeRamp(theme, tint)[theme === 'dark' ? '900' : '100'];
    const row = JSON.stringify({ mode: theme, tint, background: page, theme: header });
    if (row === paintedSurfaces) return;
    paintedSurfaces = row;
    // A locked app, a server that has gone away: the splash keeps the colour it
    // had, which is the failure this whole path is already tolerant of.
    void api.setSetting('theme_surfaces', row).catch(() => { paintedSurfaces = ''; });
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
 * plane. `themeColorFor` reads the same rung the header does out of the same
 * generated ramp, so there is nothing to keep in sync — a table of one hex per
 * theme could not hold the answer once a theme became a colour, and would have
 * left the strip above a lavender app painted slate.
 */
const applyThemeColorMeta = (surface: string) => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', surface);
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

/** This device has seen the library past its welcome screen. Only a shortcut
 *  for the first paint: the settings row is the answer, and overwrites it. */
const WELCOME_CACHE_KEY = 'terramentor-welcome-done';
const readWelcomeCache = (): boolean => {
    try { return localStorage.getItem(WELCOME_CACHE_KEY) === '1'; } catch { return false; }
};
const writeWelcomeCache = (done: boolean) => {
    try {
        if (done) localStorage.setItem(WELCOME_CACHE_KEY, '1');
        else localStorage.removeItem(WELCOME_CACHE_KEY);
    } catch { /* private mode: the next start waits for the settings instead */ }
};

// Floor between background feed pulls (see `pullFeedUpdates`). The generator
// can finish an item every few seconds; the feed doesn't need to re-compose
// faster than this, and the guard keeps a burst of task events from stampeding.
const FEED_PULL_MIN_MS = 4000;

/**
 * Merge a pulled page into the stream: every card appended, except a topic's
 * checkpoint, which goes straight after the last card that topic already has
 * on screen (its chapter's end). A checkpoint for a topic not on screen is
 * appended like anything else. Everything held keeps its order.
 */
export function placeCheckpoints(held: FeedCard[], fresh: FeedCard[]): FeedCard[] {
    const out = [...held];
    const tail: FeedCard[] = [];
    for (const c of fresh) {
        if (c.kind !== 'checkpoint') { tail.push(c); continue; }
        let at = -1;
        for (let i = out.length - 1; i >= 0; i--) {
            const o = out[i];
            if (o.kind !== 'flashcard' && 'nodeId' in o && o.nodeId === c.nodeId) { at = i; break; }
        }
        if (at < 0) tail.push(c);
        else out.splice(at + 1, 0, c);
    }
    return [...out, ...tail];
}
/** Which performSearch call is the newest; an older answer is dropped. */
let searchSeq = 0;
/** Which applyRoute call is the newest. Every route bumps it — Settings and the
 *  global views too — and a route that awaited checks it before writing, so a
 *  slow answer for a page already left cannot select a topic, load resources
 *  or open a study scope on the page after it (A → B → A included, where the
 *  project id alone says the stale continuation is still current). */
let routeSeq = 0;
/** Which loadProjectData call is the newest: only it may paint the tree. */
let projectLoadSeq = 0;
let lastFeedPullAt = 0;
/** Which stream the feed is showing: every loadFeed bumps it, and a load, a
 *  page or a pull acts on its answer only while it is still current. The scope
 *  alone cannot say so — after A → B → A the first A's late answer names the
 *  right scope and is still the older stream. */
let feedSeq = 0;
/** The words of a caught value: an error's message (from any realm), else the value itself. */
const messageOf = (e: unknown): string => {
    const message = (e as { message?: unknown } | null)?.message;
    return typeof message === 'string' ? message : String(e);
};

/**
 * Where each setting's writes stand. A setter shows its value at once and
 * stores it after; if the store refuses, the value goes back to the last one
 * that WAS saved and the learner is told, because Settings says every change
 * saves. Only the newest write for a key decides: a slider sends one per step,
 * and an older step failing after a newer one saved must not drag it back.
 */
const settingWrites = new Map<string, { seq: number; inFlight: number; saved: unknown; savedSeq: number; failedSeq: number }>();

async function saveSetting<T>(
    get: () => AppState, key: string, stored: string, before: T, mine: T, restore: (value: T) => void,
): Promise<void> {
    let w = settingWrites.get(key);
    if (!w) { w = { seq: 0, inFlight: 0, saved: before, savedSeq: 0, failedSeq: 0 }; settingWrites.set(key, w); }
    // With nothing in flight, what was on screen before this change is what
    // the server holds (loadSettings or an earlier save put it there).
    if (w.inFlight === 0) { w.saved = before; w.savedSeq = w.seq; }
    const seq = ++w.seq;
    w.inFlight++;
    try {
        await api.setSetting(key, stored);
        if (seq > w.savedSeq) { w.saved = mine; w.savedSeq = seq; }
    } catch {
        if (seq === w.seq) w.failedSeq = seq;
    } finally {
        w.inFlight--;
        // Put back only once every write for the key has answered: an OLDER
        // write still in flight may yet land, and restoring before it does
        // shows a value the server no longer holds.
        if (w.inFlight === 0 && w.failedSeq === w.seq) {
            w.failedSeq = 0;
            restore(w.saved as T);
            get().addToast('error', i18n.t("Couldn't save that setting. It has been put back."));
        }
    }
}

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
    /** The colour every surface is tinted toward. `#ffffff` is no tint at all —
     *  see `src/utils/themeRamp.ts`. */
    themeTint: string;
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
     * Bumped by Settings → AI & Models each time a write that changes WHAT
     * answers (provider, model, address, key, the on/off switch) has landed on
     * the server. Every surface that shows the connection re-asks
     * `/api/ai/status` when it moves, so a model picked in Settings is the one
     * the open Assistant names at once, not a minute later.
     */
    aiConfigRev: number;
    /**
     * Has this library been through the welcome screen? `unknown` until the
     * settings arrive, and App shows nothing rather than guess: guessing "done"
     * paints the empty feed under a new learner for a frame, guessing "needed"
     * paints the welcome over an old one. A device that has seen `done` before
     * starts there (WELCOME_CACHE_KEY), so an ordinary start waits for nothing.
     */
    welcome: 'unknown' | 'needed' | 'done';
    /**
     * May an answer go and look something up on the live web? Mirrors
     * `webSearchEnabled()` in server/webContext.js, which is the authority —
     * this copy exists so a chat surface can SAY so, under its composer, and
     * the learner is never guessing whether the answer they just read could
     * have checked anything.
     *
     * A boolean rather than three states and a composer switch, which is the
     * shape this needs while the APP writes the query and asking per question
     * means something. The model decides mid-answer, so the client has nothing
     * to decide: it reports.
     */
    aiWebSearch: boolean;
    // Single-user auth gate. `authChecked` guards the first render so we don't
    // flash the app before knowing whether a login is required.
    authEnabled: boolean;
    authenticated: boolean;
    authChecked: boolean;
    /** This device is not the server's machine and no password exists yet: the
     *  lock screen is the first-password form, which takes the log's setup code. */
    authSetupRequired: boolean;
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
     *  state: living inside the calendar component would reset it to Monday on
     *  every navigation and cost a permanent toolbar toggle. */
    weekStartDay: WeekStartDay;
    /** What colour means on the atlas: how much is proven, or which course a
     *  topic belongs to. A preference rather than view state — a map you have
     *  chosen to read by course should still read that way tomorrow. */
    atlasColorMode: AtlasColorMode;
    /** Which surface the atlas is drawn on: the flat map, or Terra — the same
     *  library as a planet. A preference, for the same reason the colour mode
     *  is one: a reader who thinks in the globe should get the globe tomorrow. */
    atlasSurface: AtlasSurface;
    /** The atlas VIEWER's own dials — how fast a course replays, how long it
     *  stands on each topic, whether the regions print their names, and the
     *  shape of a video made of it. One object because it is one panel, and a
     *  preference for the same reason the two above are. */
    atlasSettings: AtlasSettings;
    /** How numbers are WRITTEN: the thousands and decimal separators, as a
     *  style id from `utils/numberFormat`, or 'auto' to follow the interface
     *  language. Display only — what a learner may TYPE into a numeric answer
     *  is never narrowed by it. */
    numberFormat: string;
    toasts: Toast[];
    searchQuery: string;
    searchResults: SearchResults | null;
    /** The query `searchResults` answer — the box may already hold another. */
    searchResultsQuery: string | null;
    /** The query whose search FAILED, or null. Not an empty result. */
    searchError: string | null;
    searchLoading: boolean;
    searchOpen: boolean;
    workspaceView: WorkspaceView;
    showScheduleModal: boolean;
    scheduleModalProjectId: number | null;
    paceData: PaceData | null;
    paceLoading: boolean;
    confirmDialog: ConfirmDialogState;
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
    /** Placement head starts, kept the same way and for the same reason. */
    feedPlacements: Record<number, PlacementHeadStart>;
    /** Card keys consumed this session (cards collapse in place, never unmount). */
    feedDone: Record<string, boolean>;
    /** Per topic: how many feed answers have been SAVED this session. A
     *  checkpoint standing at the topic's end re-reads its numbers on each. */
    feedSavedByNode: Record<number, number>;
    /**
     * The feed_items row the reader is actually looking at, tracked by FeedView.
     * The home page has no selected node, so this is the only way the assistant
     * can answer "explain this" about the card on screen. An id, never text —
     * the server reads the row itself (buildPageContext).
     */
    feedFocusItemId: number | null;
    /**
     * What the loaded stream is scoped to; null for the whole library. One
     * slice serves all three scopes: every study surface IS the feed, pointed
     * at something, and every card component reads the same state.
     */
    feedScope: FeedScope;
    /** The node the workspace's `study` view is showing (from the URL). */
    studyNodeId: number | null;
    setFeedFocusItem: (feedItemId: number | null) => void;
    /** Initial load — replaces the stream. */
    loadFeed: (scope?: FeedScope) => Promise<void>;
    /** Open the feed scoped to one topic or section: `/project/:id/study/:nodeId`. */
    studyNode: (projectId: number, nodeId: number) => void;
    /** Open the feed scoped to one course: `/project/:id/study`. */
    studyProject: (projectId: number) => void;
    /** Fetch the next batch (exclude = keys already on screen); append-only. */
    extendFeed: () => Promise<void>;
    /**
     * Append cards the background generator has produced since the last fetch.
     * Ignores `feedExhausted` (that is the state it exists to clear) and stays
     * silent on failure — driven by feed-task progress, not by the reader.
     */
    /** `force` skips the throttle: the caller knows a new card exists. */
    pullFeedUpdates: (opts?: { force?: boolean }) => Promise<void>;
    /**
     * A visual block inside a feed card was repaired: splice the fixed spec into
     * that card — lesson, question or practice alike — and persist it, so the
     * repair happens once rather than on every page load.
     */
    repairFeedVisual: (key: string, originalCode: string, repairedCode: string) => void;
    /**
     * Mark a card done locally + report to the server (lesson/question/recall).
     * Resolves false when the save failed — the card is then NOT done, and the
     * caller retries with the same `attemptId`.
     */
    consumeFeedCard: (key: string, payload: {
        kind: 'lesson' | 'question' | 'recall';
        feedItemId?: number | null;
        nodeId?: number;
        result?: { correct?: boolean; answer?: string; gradedBy?: 'local' | 'ai' | 'fallback'; read?: boolean };
        attemptId?: string;
    }) => Promise<boolean>;
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
     * The mastery check modal, opened from anywhere — a completion the server
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
    /** The colour the surfaces take. Applied before it is stored, like the
     *  theme, the accent and the language: the change is the confirmation. */
    setThemeTint: (tint: string) => void;
    loadAuth: () => Promise<void>;
    recheckAuth: () => Promise<void>;
    login: (password: string) => Promise<void>;
    /** Set the first password from another device, with the server log's code. */
    setupFromRemote: (password: string, setupCode: string) => Promise<void>;
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
    /** Change some of the viewer's dials; the rest keep their values. */
    setAtlasSettings: (patch: Partial<AtlasSettings>) => Promise<void>;
    resetAtlasSettings: () => Promise<void>;
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
    /** Leave the welcome screen for good on this library, finished or skipped. */
    finishWelcome: () => Promise<void>;
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
    pauseToast: (id: string) => void;
    resumeToast: (id: string) => void;
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
    /**
     * Go to where a background task belongs (a dock chip press). Returns FALSE
     * when the task has no screen of its own — a visual repaired inside a feed
     * card, a document indexed because it was uploaded — and the dock then
     * opens the task's detail dialog instead, so a press is never nothing.
     */
    openAiTask: (task: AITaskSummary) => boolean;
}

/** Auto-dismiss timers keyed by toast id, so a re-bumped toast can reset its own countdown. */
const TOAST_DURATION = 4000;
/** An error says why something did not happen: long enough to read it and reach for it. */
const TOAST_ERROR_DURATION = 8000;
/** What is left of a held toast is never handed back shorter than this, or it blinks out. */
const TOAST_RESUME_FLOOR = 1500;
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** `since` is null while the toast is held (pointer over it, or focus inside it). */
const toastClock = new Map<string, { left: number; since: number | null }>();
const toastDuration = (type: Toast['type']) => (type === 'error' ? TOAST_ERROR_DURATION : TOAST_DURATION);
function armToast(id: string, ms: number, expire: () => void, held = false) {
    const prev = toastTimers.get(id);
    if (prev) clearTimeout(prev);
    if (held) { toastTimers.delete(id); toastClock.set(id, { left: ms, since: null }); return; }
    toastTimers.set(id, setTimeout(expire, ms));
    toastClock.set(id, { left: ms, since: Date.now() });
}

export const useStore = create<AppState>((set, get) => ({
    view: 'today',
    theme: initialTheme(),
    themeTint: initialThemeTint(),
    accentColor: DEFAULT_ACCENT_COLOR,
    appIcon: DEFAULT_APP_ICON,
    uiScale: initialUiScale(),
    aiProvider: null,
    aiModel: null,
    aiConfigRev: 0,
    welcome: readWelcomeCache() ? 'done' : 'unknown',
    aiWebSearch: false,
    authEnabled: false,
    authenticated: true,
    authChecked: false,
    authSetupRequired: false,
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
    atlasColorMode: 'course',
    atlasSurface: 'map',
    atlasSettings: { ...DEFAULT_ATLAS_SETTINGS },
    numberFormat: NUMBER_AUTO,
    uiLanguage: 'auto',
    toasts: [],
    searchQuery: '',
    searchResults: null,
    searchResultsQuery: null,
    searchError: null,
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
    dashboardData: null,
    dashboardLoading: false,
    dailyPlan: null,
    dueFlashcardCount: 0,
    feedCards: [],
    feedHeader: null,
    feedTransfers: {},
    feedPlacements: {},
    feedLoading: false,
    feedExhausted: false,
    feedDone: {},
    feedSavedByNode: {},
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
        const before = get().theme;
        const paint = (mode: Theme) => {
            set({ theme: mode });
            applyThemeToDom(mode, get().themeTint);
            // Accent text brightness depends on the light/dark axis, so re-apply it.
            applyAccentVars(get().accentColor, mode, get().themeTint);
        };
        paint(theme);
        await saveSetting(get, 'theme', theme, before, theme, paint);
    },

    setThemeTint: async (tint) => {
        const hex = parseCssColor(tint) || DEFAULT_THEME_TINT;
        const before = get().themeTint;
        const paint = (value: string) => {
            set({ themeTint: value });
            applyThemeToDom(get().theme, value);
            // The page the accent's TEXT is read on just changed, so what clears AA
            // on it did too. Without this the link colour stayed whatever the last
            // tint asked for until a reload.
            applyAccentVars(get().accentColor, get().theme, value);
        };
        paint(hex);
        await saveSetting(get, 'theme_tint', hex, before, hex, paint);
    },

    loadAuth: async () => {
        try {
            const { enabled, authenticated, setupRequired } = await api.getAuthStatus();
            set({ authEnabled: enabled, authenticated, authChecked: true, authSetupRequired: !!setupRequired });
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
            const { enabled, authenticated, setupRequired } = await api.getAuthStatus();
            const before = get();
            const wasLocked = before.authEnabled && !before.authenticated;
            if (before.authEnabled === enabled && before.authenticated === authenticated
                && before.authSetupRequired === !!setupRequired) return;
            set({ authEnabled: enabled, authenticated, authChecked: true, authSetupRequired: !!setupRequired });
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

    setupFromRemote: async (password, setupCode) => {
        await api.setupPassword(password, setupCode); // throws on a wrong code / lockout — caller shows it
        // Setting the password also signs this device in (the route sets the cookie).
        set({ authenticated: true, authEnabled: true, authSetupRequired: false });
        await Promise.all([get().loadSettings(), get().loadProjects(), get().loadSearchProviders()]);
        get().loadVersion();
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
        const before = get().accentColor;
        const paint = (value: string) => {
            set({ accentColor: value });
            applyAccentVars(value, get().theme, get().themeTint);
        };
        paint(hex);
        await saveSetting(get, 'accent_color', hex, before, hex, paint);
    },

    setAppIcon: async (patch) => {
        const before = get().appIcon;
        const icon = normalizeIcon({ ...before, ...patch });
        set({ appIcon: icon });
        applyIcon(icon);
        // One row per choice, and only the ones that moved: the three are
        // independent settings, not one JSON blob, so a value written by an
        // older build (or by hand) still reads.
        const fields = (['style', 'background', 'radius'] as const).filter(f => patch[f] !== undefined);
        for (const field of fields) {
            const putBack = (value: unknown) => {
                const restored = normalizeIcon({ ...get().appIcon, [field]: value });
                set({ appIcon: restored });
                applyIcon(restored);
            };
            await saveSetting(get, ICON_KEYS[field], String(icon[field]), before[field] as unknown, icon[field] as unknown, putBack);
        }
    },

    setUiScale: async (scale) => {
        const pct = clampUiScale(scale);
        const before = get().uiScale;
        const paint = (value: number) => { set({ uiScale: value }); applyUiScale(value); };
        paint(pct);
        await saveSetting(get, 'ui_scale', String(pct), before, pct, paint);
    },

    setSidebarWidth: async (width) => {
        // Cap against the viewport so a narrow laptop can't let the sidebar
        // starve the center pane.
        const vwCap = typeof window !== 'undefined' ? Math.round(window.innerWidth * 0.4) : 600;
        const clamped = Math.max(200, Math.min(600, vwCap, width));
        const before = get().sidebarWidth;
        set({ sidebarWidth: clamped });
        await saveSetting(get, 'sidebarWidth', String(clamped), before, clamped, value => set({ sidebarWidth: value }));
    },

    setDetailPanelWidth: async (width) => {
        const vwCap = typeof window !== 'undefined' ? Math.round(window.innerWidth * 0.5) : 600;
        const clamped = Math.max(300, Math.min(600, Math.max(300, vwCap), width));
        const before = get().detailPanelWidth;
        set({ detailPanelWidth: clamped });
        await saveSetting(get, 'detailPanelWidth', String(clamped), before, clamped, value => set({ detailPanelWidth: value }));
    },

    setWeekStartDay: async (day) => {
        const before = get().weekStartDay;
        set({ weekStartDay: day });
        await saveSetting(get, 'week_start_day', String(day), before, day, value => set({ weekStartDay: value }));
    },

    setNumberFormat: async (style) => {
        // Applied before it is stored, like the theme and the language: the
        // change IS the feedback, and every number on screen is the preview.
        const before = get().numberFormat;
        const paint = (value: string) => { set({ numberFormat: value }); setNumberPreference(value); };
        paint(style);
        await saveSetting(get, 'number_format', style, before, style, paint);
    },

    setAtlasColorMode: async (mode) => {
        const before = get().atlasColorMode;
        set({ atlasColorMode: mode });
        await saveSetting(get, 'atlas_color_mode', mode, before, mode, value => set({ atlasColorMode: value }));
    },

    setAtlasSurface: async (surface) => {
        const before = get().atlasSurface;
        set({ atlasSurface: surface });
        await saveSetting(get, 'atlas_surface', surface, before, surface, value => set({ atlasSurface: value }));
    },

    // Applied before it is stored, like the theme and the accent: the map is
    // redrawn from this state, so the change IS the preview — a slider whose
    // effect only landed after a round trip would be a control you cannot feel.
    // Normalised on the way out as well as on the way in, so a patch can never
    // put a speed of 0 into the running app and only fail on the next load.
    setAtlasSettings: async (patch) => {
        const before = get().atlasSettings;
        const next = normalizeAtlasSettings({ ...before, ...patch });
        set({ atlasSettings: next });
        await saveSetting(get, ATLAS_SETTINGS_KEY, JSON.stringify(next), before, next, value => set({ atlasSettings: value }));
    },

    resetAtlasSettings: async () => {
        const before = get().atlasSettings;
        const next = { ...DEFAULT_ATLAS_SETTINGS };
        set({ atlasSettings: next });
        await saveSetting(get, ATLAS_SETTINGS_KEY, JSON.stringify(next), before, next, value => set({ atlasSettings: value }));
    },

    setUiLanguage: async (code) => {
        // Applied before it is stored, like the theme: the change is the
        // feedback, and a setting that only lands after a round trip reads as
        // a control that did nothing.
        const before = get().uiLanguage;
        set({ uiLanguage: code });
        await applyUiLanguage(resolveLanguagePreference(code));
        await saveSetting(get, 'ui_language', code, before, code, value => {
            set({ uiLanguage: value });
            void applyUiLanguage(resolveLanguagePreference(value));
        });
    },

    setProjects: (projects) => set({ projects }),
    setTree: (tree) => set({ tree }),

    loadSettings: async () => {
        try {
            const settings = await api.getSettings();
            // THE FOUR OLD NAMES. `light` and `dark` are still themselves, so
            // most libraries need no migration at all; `warm` and `black` become
            // the mode they always were plus the tint that reproduces them. The
            // stored row is left alone — it is read through this table on every
            // load, so a library opened by an older build still works and one
            // opened by this build does not have to be written to be right.
            // Anything unrecognised is light, as before.
            const legacy = LEGACY_THEMES[String(settings.theme)];
            const theme: Theme = legacy?.theme
                ?? (THEME_IDS.includes(settings.theme as Theme) ? settings.theme as Theme : 'light');
            // An explicit tint wins over the legacy one: a learner who has
            // chosen a colour since the migration is not sent back to cream.
            const themeTint = parseCssColor(settings.theme_tint)
                || legacy?.tint || DEFAULT_THEME_TINT;
            const sidebarWidth = settings.sidebarWidth ? parseInt(settings.sidebarWidth) : 256;
            const detailPanelWidth = settings.detailPanelWidth ? parseInt(settings.detailPanelWidth) : 420;
            const accentColor = settings.accent_color || DEFAULT_ACCENT_COLOR;
            const appIcon = normalizeIcon({
                style: settings[ICON_KEYS.style],
                background: settings[ICON_KEYS.background],
                radius: settings[ICON_KEYS.radius],
            });
            const weekStartDay: WeekStartDay = settings.week_start_day === '0' ? 0 : 1;
            // Course colour is the default (2026-09-30): a map where each course
            // has its own hue, and proof still strengthens it, read better than
            // one colour for every region. Only an explicit choice of the other
            // mode keeps it.
            const atlasColorMode: AtlasColorMode =
                settings.atlas_color_mode === 'mastery' ? 'mastery' : 'course';
            // The flat map is the default and anything unrecognised falls back
            // to it — a stored value from a future build must never leave the
            // atlas with no surface to draw on.
            const atlasSurface: AtlasSurface =
                settings.atlas_surface === 'globe' ? 'globe' : 'map';
            // Stored as JSON and normalised rather than trusted: an absent row,
            // a half-written one and one from a build that knew a fourth aspect
            // ratio all have to come out as something the map can draw.
            const atlasSettings = normalizeAtlasSettings(settings[ATLAS_SETTINGS_KEY]);
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
            // One shape in the column, normalised once by the migration in
            // server/database.js, so this is the same single comparison the
            // server makes and it fails closed on anything else.
            const aiWebSearch = settings.ai_web_search === 'on';
            // Written by the welcome screen, or by the migration in
            // server/database.js for a library that was already in use.
            const welcome = settings.welcome_done === 'true' ? 'done' : 'needed';
            writeWelcomeCache(welcome === 'done');
            set({ theme, themeTint, sidebarWidth, detailPanelWidth, accentColor, appIcon, uiScale, weekStartDay, atlasColorMode, atlasSurface, atlasSettings, numberFormat, uiLanguage, aiProvider, aiModel, aiWebSearch, welcome });
            // The non-component call sites read a module variable rather than
            // the store, so it has to be written here too.
            setNumberPreference(numberFormat);
            // Before the theme is applied: what the server already holds is what
            // the next manifest fetch will answer with, so a load that changes
            // nothing writes nothing.
            seedPaintedSurfaces(settings.theme_surfaces);
            applyThemeToDom(theme, themeTint);
            applyAccentVars(accentColor, theme, themeTint);
            applyIcon(appIcon);
            applyUiScale(uiScale);
            // The server's choice wins over this device's cache — a language picked
            // on the desktop reaches the phone on its next load.
            void applyUiLanguage(resolveLanguagePreference(uiLanguage));
        } catch {
            // No settings, no verdict — and the welcome must never be the
            // reason the app does not open, so an unanswered question is "done".
            if (get().welcome === 'unknown') set({ welcome: 'done' });
        }
    },

    finishWelcome: async () => {
        set({ welcome: 'done' });
        writeWelcomeCache(true);
        try { await api.setSetting('welcome_done', 'true'); } catch { /* shown again next start; harmless */ }
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
        } catch (e: unknown) {
            get().addToast('error', i18n.t('Could not check for updates'), messageOf(e));
        }
    },

    setAutoUpdateCheck: async (enabled: boolean) => {
        // Optimistic on the toggle only — flipping a switch must feel immediate
        // even though turning it ON performs a check before it answers.
        const prev = get().updateStatus;
        if (prev) set({ updateStatus: { ...prev, enabled } });
        try {
            set({ updateStatus: await api.setAutoUpdateCheck(enabled) });
        } catch (e: unknown) {
            if (prev) set({ updateStatus: prev });
            get().addToast('error', i18n.t('Could not change the update setting'), messageOf(e));
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

    studyProject: (projectId) => {
        const nav = get()._navigate;
        if (nav) nav(`/project/${projectId}/study`);
    },

    loadFeed: async (scope = null) => {
        const seq = ++feedSeq;
        set({ feedLoading: true, feedScope: scope });
        try {
            const res = await api.getFeed(undefined, 15, scope);
            // A slower load — for another scope, or an older load of this one —
            // must not land on the stream that replaced it.
            if (seq !== feedSeq) return;
            set({
                feedCards: res.items,
                feedHeader: res.header,
                feedTransfers: res.transfers || {},
                feedPlacements: res.placements || {},
                feedExhausted: res.exhausted,
                feedDone: {},
                feedFocusItemId: null,
                feedLoading: false,
            });
        } catch (e: any) {
            if (seq !== feedSeq) return;
            set({ feedLoading: false });
            get().addToast('error', i18n.t('Failed to load your feed'), e.message);
        }
    },

    extendFeed: async () => {
        if (get().feedLoading || get().feedExhausted) return;
        set({ feedLoading: true });
        const seq = feedSeq;
        try {
            const exclude = get().feedCards.map(c => c.key);
            const res = await api.getFeed(exclude, 15, get().feedScope);
            // A page for the stream the learner has left is not a page of this
            // one; the load that replaced it owns the spinner now.
            if (seq !== feedSeq) return;
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
                feedPlacements: { ...state.feedPlacements, ...(res.placements || {}) },
                feedExhausted: res.exhausted,
                feedLoading: false,
            }));
        } catch (e: any) {
            if (seq !== feedSeq) return;
            set({ feedLoading: false });
            get().addToast('error', i18n.t('Failed to load more cards'), e.message);
        }
    },

    pullFeedUpdates: async ({ force = false } = {}) => {
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
        if (!force && now - lastFeedPullAt < FEED_PULL_MIN_MS) return;
        lastFeedPullAt = now;

        set({ feedLoading: true });
        const seq = feedSeq;
        try {
            const exclude = get().feedCards.map(c => c.key);
            const res = await api.getFeed(exclude, 15, get().feedScope);
            if (seq !== feedSeq) return;
            const seen = new Set(exclude);
            const fresh = res.items.filter(c => !seen.has(c.key));
            set(state => ({
                // Never reordered, same contract as extendFeed — cards already
                // on screen must not move under the reader. One exception: a
                // topic's CHECKPOINT goes straight after that topic's last card,
                // which is where the learner just finished it; appended, it sat
                // below the next topics they had already moved on to.
                feedCards: fresh.length ? placeCheckpoints(state.feedCards, fresh) : state.feedCards,
                feedHeader: res.header,
                feedTransfers: { ...state.feedTransfers, ...(res.transfers || {}) },
                feedPlacements: { ...state.feedPlacements, ...(res.placements || {}) },
                feedExhausted: res.exhausted,
                feedLoading: false,
            }));
        } catch {
            if (seq === feedSeq) set({ feedLoading: false });
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
            const { feedCards, feedDone } = get();
            const card = feedCards.find(c => c.key === key);
            if (card && 'nodeId' in card) {
                set(state => ({ feedSavedByNode: { ...state.feedSavedByNode, [card.nodeId]: (state.feedSavedByNode[card.nodeId] ?? 0) + 1 } }));
            }
            // The topic's LAST teaching card in the stream was just answered
            // and no checkpoint stands after it (a topic whose parts were not
            // all written when the page was composed): ask for it now. A
            // stream whose first page was all there was never asks again, so
            // the chapter ended on "That's all of this topic" with no way to
            // close it, and the topic stayed open.
            if (card && (card.kind === 'lesson' || card.kind === 'question')) {
                const teaching = (c: FeedCard) => (c.kind === 'lesson' || c.kind === 'question') && c.nodeId === card.nodeId;
                const open = feedCards.some(c => teaching(c) && !feedDone[c.key]);
                const closed = feedCards.some(c => c.kind === 'checkpoint' && c.nodeId === card.nodeId);
                if (!open && !closed) {
                    const pull = () => get().pullFeedUpdates({ force: true });
                    // A page already in flight was composed before this answer.
                    if (get().feedLoading) setTimeout(() => void pull(), 1500);
                    else void pull();
                }
            }
            return true;
        } catch (e: unknown) {
            // A save that did not land is not done: the card opens again so the
            // same press sends it again (same attemptId, so a save that did land
            // and only lost its answer is not counted twice).
            set(state => {
                const feedDone = { ...state.feedDone };
                delete feedDone[key];
                return { feedDone };
            });
            get().addToast('error', i18n.t('Failed to save your progress'), messageOf(e));
            return false;
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
        const seq = ++projectLoadSeq;
        // Another project's tree goes as the id changes. Left in place, a
        // second route to this project (A loading → Settings → A again) found
        // "a project loaded" and selected its topic in the OLD tree, and then
        // this load painted over that selection with nobody left to redo it.
        set(get().currentProjectId === id
            ? { loading: true }
            : { loading: true, currentProjectId: id, nodes: [], tree: [] });
        // A newer load owns the tree and the spinner. Without the sequence an
        // older answer for the SAME project (A → B → A) painted over the newer
        // one and cleared the selection its route had just made.
        const superseded = () => {
            if (seq !== projectLoadSeq) return true;
            // A slow answer for a project the learner has already left must
            // not paint that project's tree under the one now open.
            if (get().currentProjectId !== id) { set({ loading: false }); return true; }
            return false;
        };
        try {
            const nodes = await api.getNodes(id);
            if (superseded()) return;
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
            if (superseded()) return;
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
        const route = ++routeSeq;
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
            if (view === 'today' && (get().feedCards.length === 0 || get().feedScope !== null)) void get().loadFeed(null);
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
            // Another route was applied while this project loaded: the topic,
            // the resources and the study scope below are that route's to set.
            if (route !== routeSeq) return;
        }
        // STUDY: the feed scoped to the URL. With a `:nodeId` it teaches that
        // topic or section; WITHOUT one it teaches the whole course, by the
        // same urgency rules the home feed uses — which is what makes a course
        // something you can sit down and learn rather than a list of topics to
        // open one at a time. The node (when there is one) is the page, not a
        // selection: the detail panel stays closed, so on a phone the study
        // stream is not covered by the panel's full-screen overlay.
        if (wsView === 'study') {
            const scope: FeedScope = nodeId != null && !Number.isNaN(nodeId)
                ? { kind: 'node', id: nodeId }
                : { kind: 'project', id: projectId };
            if (get().selectedNodeId !== null) set({ selectedNodeId: null, focusedNodeId: null, resources: [] });
            const wantNode = scope.kind === 'node' ? scope.id : null;
            if (get().studyNodeId !== wantNode) set({ studyNodeId: wantNode });
            if (scopeKey(get().feedScope) !== scopeKey(scope)) void get().loadFeed(scope);
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
            // The tree's top level is what the page calls a category.
            get().addToast('success', nodeData.parent_id == null ? i18n.t('Category created') : i18n.t('Item created'));
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
                // Completion was intercepted by the mastery gate. Open the mastery
                // check modal; in advisory mode it also offers "mark done anyway".
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
            get().addToast('info', i18n.t('Marked as skipped'), i18n.t('Counted apart from the topics you completed.'));
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
        if (get().currentProjectId !== projectId) return;
        const tree = buildTree(nodes);
        set({ nodes, tree });
    },

    loadResources: async (nodeId) => {
        const resources = await api.getResources(nodeId);
        if (get().selectedNodeId === nodeId) set({ resources });
    },

    createResource: async (resData) => {
        try {
            await api.createResource(resData);
            if (resData.node_id) {
                const resources = await api.getResources(resData.node_id);
                if (get().selectedNodeId === resData.node_id) set({ resources });
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
                if (get().selectedNodeId === nodeId) set({ resources });
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
                if (get().selectedNodeId === nodeId) set({ resources });
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
                if (get().selectedNodeId === nodeId) set({ resources });
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
            // A duplicate arriving under the pointer restarts the clock, but does not start it.
            const held = toastClock.get(existing.id)?.since === null;
            armToast(existing.id, toastDuration(type), () => { get().removeToast(existing.id); }, held);
            return;
        }
        const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const toast: Toast = { id, type, message, details, timestamp: Date.now(), count: 1 };
        set(state => ({ toasts: [...state.toasts, toast] }));
        armToast(id, toastDuration(type), () => { get().removeToast(id); });
    },

    removeToast: (id) => {
        const timer = toastTimers.get(id);
        if (timer) { clearTimeout(timer); toastTimers.delete(id); }
        toastClock.delete(id);
        set(state => ({ toasts: state.toasts.filter(t => t.id !== id) }));
    },

    // Hover or focus holds a toast; what was left of its clock is kept and handed back.
    pauseToast: (id) => {
        const clock = toastClock.get(id);
        if (!clock || clock.since === null) return;
        const timer = toastTimers.get(id);
        if (timer) { clearTimeout(timer); toastTimers.delete(id); }
        clock.left = Math.max(0, clock.left - (Date.now() - clock.since));
        clock.since = null;
    },

    resumeToast: (id) => {
        const clock = toastClock.get(id);
        if (!clock || clock.since !== null) return;
        armToast(id, Math.max(clock.left, TOAST_RESUME_FLOOR), () => { get().removeToast(id); });
    },

    setSearchQuery: (query) => {
        set({ searchQuery: query });
    },

    setSearchOpen: (open) => {
        set({ searchOpen: open });
        if (!open) {
            searchSeq++;
            set({ searchQuery: '', searchResults: null, searchResultsQuery: null, searchError: null, searchLoading: false });
        }
    },

    performSearch: async (query) => {
        const trimmed = query.trim();
        if (trimmed.length < 2) {
            searchSeq++;
            set({ searchResults: null, searchResultsQuery: null, searchError: null, searchLoading: false });
            return;
        }

        set({ searchLoading: true, searchError: null });
        // Typing "ab", then "abc", sends two searches; the shorter one is often
        // the slower, and landing second it put "ab"'s results under "abc".
        const seq = ++searchSeq;

        try {
            const currentProjectId = get().currentProjectId;
            const results = await api.search(trimmed, {
                projectId: currentProjectId || undefined,
                limit: 8,
            });
            if (seq !== searchSeq) return;
            set({ searchResults: results, searchResultsQuery: trimmed, searchLoading: false });
        } catch {
            // A failure is its own state, not an empty answer: "No results"
            // over a dropped connection tells the learner their library has
            // nothing on it. The last query's results go too, or they would
            // stand under this one as if they were its matches.
            if (seq === searchSeq) set({ searchResults: null, searchResultsQuery: null, searchError: trimmed, searchLoading: false });
        }
    },

    clearSearch: () => {
        searchSeq++; // a search still in flight must not refill a cleared box
        set({ searchQuery: '', searchResults: null, searchResultsQuery: null, searchError: null, searchLoading: false, searchOpen: false });
    },

    setWorkspaceView: (view) => {
        const nav = get()._navigate;
        const pid = get().currentProjectId;
        if (!nav || !pid) { set({ workspaceView: view }); return; }
        // The `:nodeId` segment means two different things. On every other
        // view it is a SELECTION (keep the detail panel open across a tab
        // change); on `study` it is the SCOPE. Pressing the Study tab means
        // "teach me this course", so the selection is deliberately not
        // carried — otherwise whichever topic happened to be open silently
        // narrowed the whole course down to itself.
        const nodeId = view === 'study' ? null : get().selectedNodeId;
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
            if (get().currentProjectId !== projectId) return;
            set({ paceData: pace, paceLoading: false });
        } catch {
            if (get().currentProjectId === projectId) set({ paceLoading: false });
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

    loadDashboard: async (projectId) => {
        set({ dashboardLoading: true });
        try {
            const data = await api.getStudyDashboard(projectId);
            if (get().currentProjectId !== projectId) return { success: true }; // superseded, not failed
            set({ dashboardData: data, dashboardLoading: false });
            // Keep "Today's Plan" in lockstep with the dashboard: every refresh path
            // (node completed/skipped, schedule edit, recalibrate) flows through here.
            get().loadDailyPlan(projectId);
            return { success: true };
        } catch (e: any) {
            console.error('Failed to load dashboard:', e);
            if (get().currentProjectId === projectId) set({ dashboardLoading: false });
            return { success: false, error: e.message };
        }
    },

    loadDailyPlan: async (projectId) => {
        try {
            const plan = await api.getDailyPlan(projectId);
            if (get().currentProjectId === projectId) set({ dailyPlan: plan });
        } catch (e) {
            console.error('Failed to load daily plan:', e);
            if (get().currentProjectId === projectId) set({ dailyPlan: null });
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
            if (get().currentProjectId === projectId) set({ dueFlashcardCount: dueCards.length });
        } catch {
            if (get().currentProjectId === projectId) set({ dueFlashcardCount: 0 });
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
        const place = taskPlace(task);
        if (!place) return false;
        const nav = get()._navigate;
        switch (place.go) {
            case 'node':
                get().openProjectNode(place.projectId!, place.nodeId!);
                return true;
            case 'project':
                if (!nav) return false;
                nav(`/project/${place.projectId}/dashboard`);
                return true;
            case 'route':
                if (!nav) return false;
                nav(place.route!);
                return true;
            // The planner's own surface is a DRAWER over whatever is on
            // screen, so reaching it must not navigate: sending the reader to
            // '/' would take them off their page and still not open the drawer,
            // which is the one thing the press is for.
            case 'assistant':
                get().openAssistant();
                return true;
            case 'creation':
                // A creation's screen opens over whatever page the reader is
                // on (creation/creationRuns.ts), for THAT run — several may be
                // live. Only a run this page has never heard of falls back to
                // the projects page.
                if (openCreationRunForTask(task)) return true;
                if (!nav) return false;
                nav(place.route!);
                return true;
        }
        return false;
    },
}));