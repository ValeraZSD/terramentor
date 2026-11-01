import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api';
import { useStore, isDarkTheme } from '../store';
import { AtlasColorMode, AtlasData, AtlasRegion, AtlasSurface, AtlasTopic } from '../types';
import AtlasMap from './atlas/AtlasMap';
import GlobeMap from './atlas/GlobeMap';
import RegionList from './atlas/RegionList';
import BridgeList from './atlas/BridgeList';
import CourseList from './atlas/CourseList';
import TracePanel from './atlas/TracePanel';
import { CourseTrace, listCourses, traceCourse } from './atlas/coursePaths';
import { AtlasStage, useJourneyReplay } from './atlas/useJourneyReplay';
import { paceOf } from './atlas/atlasSettings';
import AtlasSettingsModal from './atlas/AtlasSettingsModal';
import { ColourSurface, courseHues, courseSwatches, globeRamp, ramp } from './atlas/atlasColors';
import { SegmentedControl } from './ui/SegmentedControl';
import { Button } from './ui/Button';
import { TextInput } from './ui/Field';
import { scrollIntoViewWithin } from '../utils/scrollWithin';
import { Globe2, Loader2, Map as MapIcon, RefreshCw, Search, Settings as SettingsIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useNumberFormat } from '../hooks/useNumberFormat';
import { useElementHeight, useElementWidth } from '../hooks/useElementWidth';
import { CHROME_SURFACE } from './atlas/chromeSurface';
import { atlasEscapeLayer, pageMayTakeEscape } from '../utils/escapeKey';
import { useRootFontSize } from '../hooks/useRootFontSize';

/**
 * The atlas: the whole library as one space instead of one tree per course.
 *
 * Every other cross-project surface in this app is organised by time (the feed,
 * the calendar, the schedule board) or by container (the projects grid). None of
 * them can answer *what do I know?*, because knowledge doesn't live in the
 * course that happened to teach it — a learner who proved standing waves in a
 * language course's physics unit knows standing waves, and no view built
 * around project boundaries can say so.
 *
 * What makes it possible is that topics are embedded (server/nodeEmbeddings.js),
 * so the engine can group by meaning; what keeps it honest is that no model is
 * called to draw it. Region names are the most central topic's own title, so the
 * map never invents a subject that isn't there, and it draws identically every
 * visit — which is the whole difference between a map and a picture.
 *
 * The page IS the map: no title block, no legend under it, no paragraph saying
 * what the colours mean. The map takes everything under the top bar, and one
 * index sits beside it (a docked column when the page is wide, a sheet folded
 * under the map when it is narrow) holding the three things a reader comes for:
 * how much is proven (one line and one bar painted in the map's own ramp — the
 * bar is the legend), where they have been (Explored, then Terra incognita), and
 * the courses (each in its colour, and the way to trace one). The map's own
 * chrome is the surface switch and the control cluster, plus the player while a
 * course is traced.
 */
/**
 * The last atlas this session drew, kept outside React so leaving the page and
 * coming back shows the map instead of a spinner.
 *
 * It is worth keeping because it is expensive at both ends: the payload is
 * hundreds of kB of JSON for a large library, and the server needs seconds to
 * build it after a restart (milliseconds once its own cache is warm).
 * Re-fetching all of that to redraw a map that is deterministic — same topics
 * in, same picture out — would make the atlas feel slow.
 *
 * Held for the session only, and always revalidated behind the drawn map, so a
 * newly embedded topic or a newly proven one still appears: the server's cache
 * is keyed on the library's progress as well as its vectors.
 */
let lastAtlas: AtlasData | null = null;

/**
 * Below this page width the index stops being a column beside the map and
 * folds under it as a sheet. In REM, because what it protects is: a 22rem
 * column needs a map beside it at least as wide again to be a map with an
 * index rather than an index with a strip of picture. At 160% scale a phone in
 * landscape is a sheet, and the same phone at 100% is a column.
 */
const SHEET_BELOW_REM = 44;

/**
 * Below this much MAP width the map's own top row is rearranged: the surface
 * switch turns on its side and sits beside the player instead of in the far
 * corner. Measured on the map, not the page — the column beside it takes 22rem.
 */
const TIGHT_CHROME_REM = 32;

/**
 * Measures the box it draws and hands its children the answer.
 *
 * Its own component rather than a measurement on the page: this page renders
 * NOTHING until the atlas has loaded, so a `ref` declared up there is still null
 * when the hook's layout effect runs and the width stays 0 for the life of the
 * page. A component that exists only once there is something to measure
 * measures it on the frame it appears.
 */
function Measured({ belowRem, className, style, children }: {
    belowRem: number;
    className: string;
    style?: React.CSSProperties;
    children: (below: boolean) => ReactNode;
}) {
    const ref = useRef<HTMLDivElement | null>(null);
    const width = useElementWidth(ref);
    const rootPx = useRootFontSize();
    // Width 0 is "not measured yet", and the answer then is the wide one: it is
    // what every desktop gets, and a phone corrects itself on the first frame.
    const below = width > 0 && width < belowRem * rootPx;
    return <div ref={ref} className={className} style={style}>{children(below)}</div>;
}

/**
 * Less list than this under the index's header, and the header scrolls with
 * the list instead of standing over it. At 160% scale, or on a phone held
 * sideways, search + progress + two switches filled the whole column and the
 * list under them was a strip one row tall, or nothing.
 */
const LIST_MIN_REM = 12;

/**
 * The index's header and its list, with ONE scroller between them: the list
 * alone while it has room, header and list together when it does not. The
 * same two boxes in both cases (only their classes change), so neither is
 * remounted and both stay measured; `scrollerRef` always names the box that
 * actually scrolls, for the code that brings a picked region into view.
 */
function IndexBody({ header, list, scrollerRef }: {
    header: ReactNode;
    list: ReactNode;
    scrollerRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
    const outer = useRef<HTMLDivElement | null>(null);
    const head = useRef<HTMLDivElement | null>(null);
    const inner = useRef<HTMLDivElement | null>(null);
    const height = useElementHeight(outer);
    const headHeight = useElementHeight(head);
    const rootPx = useRootFontSize();
    const short = !!list && height > 0 && height - headHeight < LIST_MIN_REM * rootPx;
    useLayoutEffect(() => {
        scrollerRef.current = short ? outer.current : inner.current;
    }, [short, scrollerRef, list]);
    // `overscroll-contain` on whichever box scrolls, so reaching the end of the
    // list does not hand the swipe to the page under a phone's sheet.
    return (
        <div ref={outer} className={`flex-1 min-h-0 flex flex-col ${short ? 'overflow-y-auto overscroll-contain' : ''}`}>
            <div ref={head} className="shrink-0">{header}</div>
            {list && (
                <div ref={inner} className={short ? 'shrink-0 px-1.5 pb-3' : 'flex-1 min-h-0 overflow-y-auto overscroll-contain px-1.5 pb-3'}>
                    {list}
                </div>
            )}
        </div>
    );
}

export default function AtlasView() {
    const { t: tr } = useTranslation();
    const num = useNumberFormat();
    const theme = useStore(s => s.theme);
    const accentColor = useStore(s => s.accentColor);
    const navigate = useNavigate();
    const openProjectNode = useStore(s => s.openProjectNode);
    const addToast = useStore(s => s.addToast);
    const colorMode = useStore(s => s.atlasColorMode);
    const setAtlasColorMode = useStore(s => s.setAtlasColorMode);
    const surface = useStore(s => s.atlasSurface);
    const setAtlasSurface = useStore(s => s.setAtlasSurface);
    // Terra paints on its own ladder (`courseFill`'s and `regionColor`'s
    // `surface`), so the swatches in the index show that ladder.
    const colourSurface: ColourSurface = surface === 'globe' ? 'globe' : 'map';
    const viewer = useStore(s => s.atlasSettings);
    const dark = isDarkTheme(theme);
    // Not read here: handed to the canvases so their palette memo re-resolves
    // when the surfaces change. See `AtlasMap`'s prop doc.
    const themeTint = useStore(s => s.themeTint);
    // The two dials the replay's arithmetic takes, rebuilt only when they move:
    // the surfaces hold it in a ref that is read every frame, and the clock
    // schedules on it, so a new object each render would rearm the timeout.
    const pace = useMemo(() => paceOf(viewer), [viewer]);

    const [data, setData] = useState<AtlasData | null>(lastAtlas);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [query, setQuery] = useState('');
    /** Which list the index shows: the map's regions, or the courses on it. */
    const [tab, setTab] = useState<'regions' | 'courses'>('regions');
    /**
     * Whether the folded sheet is open (narrow pages only). Folded, it shows
     * the search and the progress line and gives the rest of the screen to the
     * map; open, it takes most of it for the list.
     */
    const [sheetOpen, setSheetOpen] = useState(false);
    // Full screen is a CSS mode, not the Fullscreen API: `requestFullscreen`
    // is unsupported for arbitrary elements on iOS Safari, so on the phone this
    // is meant for it would silently do nothing.
    const [fullscreen, setFullscreen] = useState(false);
    // Which course is being traced, and how far along its journey the replay
    // has got. `journeyStep === null` means the whole path is drawn, which is
    // the resting state — the replay is a way of watching a path that is
    // already there, never the only way to see it.
    const [traceId, setTraceId] = useState<number | null>(null);
    /** Whether the viewer's own settings are open — see `AtlasSettingsModal`. */
    const [settingsOpen, setSettingsOpen] = useState(false);
    /** The index's scroller — the one thing a pick on the map may move. */
    const listRef = useRef<HTMLDivElement | null>(null);
    /**
     * Whichever surface is on screen.
     *
     * One ref for both, because everything this page asks of a surface means
     * the same thing on either one — go to that region, frame that course,
     * ride with the replay, where is the arrow — even though the sheet answers
     * with a pan and the planet with a turn. Only one of them is ever mounted,
     * so a callback ref that both components write to holds exactly the live
     * one, and the page never branches on which it is drawing.
     */
    const stageRef = useRef<AtlasStage | null>(null);

    const load = async (refresh = false) => {
        setLoading(true);
        setError(null);
        try {
            const next = await api.getAtlas({ refresh });
            lastAtlas = next;
            setData(next);
        } catch (e: any) {
            // A revalidation that fails behind an already-drawn map is not an
            // error the reader can act on — the map on screen is still true.
            if (!lastAtlas) setError(e?.message || 'Could not load the atlas.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { void load(); }, []);

    const q = query.trim().toLowerCase();

    // Filtering is on the whole library, so a search matches a topic buried in a
    // region whose name says nothing about it — which is most of them.
    const regions = useMemo(() => {
        if (!data) return [];
        if (!q) return data.regions;
        return data.regions
            .map(r => {
                const hitsLabel = r.label.toLowerCase().includes(q);
                const topics = r.topics.filter(t =>
                    t.title.toLowerCase().includes(q) || t.projectName.toLowerCase().includes(q));
                if (!hitsLabel && topics.length === 0) return null;
                return hitsLabel ? r : { ...r, topics };
            })
            .filter((r): r is NonNullable<typeof r> => r !== null);
    }, [data, q]);

    // The map keeps every region drawn and highlights the hits instead of
    // filtering: a map that deletes everything you didn't search for stops
    // being a map, and "where is this in the library" is the question.
    const matches = useMemo(() => {
        if (!data || !q) return null;
        const ids = new Set<number>();
        for (const r of data.regions) {
            const hitsLabel = r.label.toLowerCase().includes(q);
            for (const t of r.topics) {
                if (hitsLabel || t.title.toLowerCase().includes(q) || t.projectName.toLowerCase().includes(q)) {
                    ids.add(t.id);
                }
            }
        }
        return ids;
    }, [data, q]);

    // ---- tracing a course ----------------------------------------------------
    // Derived from the drawn regions, not fetched: the map already holds
    // exactly the topics that have coordinates, so this can never offer a
    // course whose topics are not on screen.
    const courses = useMemo(() => (data?.available ? listCourses(data.regions) : []), [data]);
    const shownCourses = useMemo(
        () => (q ? courses.filter(c => c.name.toLowerCase().includes(q)) : courses), [courses, q]);
    const trace = useMemo(
        () => (data?.available && traceId != null ? traceCourse(data.regions, traceId) : null),
        [data, traceId],
    );
    const tracedCourse = traceId != null ? courses.find(c => c.id === traceId) ?? null : null;

    // A redraw can retire the traced course (a project archived, its topics
    // re-embedded away). Dropping the selection rather than leaving a dead id
    // in state keeps the panel and the map saying the same thing.
    useEffect(() => {
        if (traceId != null && data?.available && !trace) setTraceId(null);
    }, [traceId, data, trace]);

    // The replay's clock — which finish has been reached and when the next one
    // is — lives in `useJourneyReplay` rather than here, because there are now
    // two places a course replays: this page, and the render dialog filming it.
    // A second hand-written copy of those beats is a video that runs at a
    // different speed than the map it is a video of.
    const { step: journeyStep, playing, play: startReplay, pause, restart: restartReplay, stop }
        = useJourneyReplay(trace, stageRef, pace);

    // ---- Escape ----------------------------------------------------------------
    // ONE handler for the whole atlas, whatever holds focus — the canvas, a
    // button in the chrome, the course list just used, or nothing. Each press
    // takes back one layer, innermost first: the floating card, the selected
    // region, the traced course (the clean map again, which is what a learner
    // reaching for Escape after a replay wants), then full screen. The surfaces
    // register no Escape of their own; two handlers for one key would close the
    // card and leave full screen on a single press.
    // `pageMayTakeEscape` stands back for a dialog, a field being typed in, a key
    // someone else claimed, and focus outside this page (the docked assistant).
    const rootRef = useRef<HTMLDivElement | null>(null);
    const escapeState = useRef({ selectedId, traceId, fullscreen, stop });
    escapeState.current = { selectedId, traceId, fullscreen, stop };
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!pageMayTakeEscape(e, rootRef.current)) return;
            const s = escapeState.current;
            if (stageRef.current?.dismissCard()) { e.preventDefault(); return; }
            const layer = atlasEscapeLayer({ selected: s.selectedId != null, traced: s.traceId != null, fullscreen: s.fullscreen });
            if (!layer) return;
            e.preventDefault();
            if (layer === 'selection') setSelectedId(null);
            // The same road as the player's ✕: the replay stops and everything
            // the trace dimmed comes back.
            else if (layer === 'trace') { s.stop(); setTraceId(null); }
            else setFullscreen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    // Changing surface mid-replay hands the camera to the one that has just
    // arrived. The replay itself never stops — the step clock belongs to this
    // page, not to either canvas — but the new surface opens on the opening
    // view, so without this the reader switches to Terra halfway through a walk
    // and watches the rest of it happen somewhere off the far side of the
    // planet. The course being traced survives for the same reason: it is state
    // here, and the player that shows it is handed to whichever surface is drawn.
    useEffect(() => {
        if (playing) stageRef.current?.followJourney();
        // `playing` is deliberately not a dependency: this is about the SURFACE
        // changing under a running replay, and starting one already follows.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [surface]);

    // The player's timeline follows the arrow, and this is how it asks where the
    // arrow is: the canvas owns that float because the canvas is what eases it.
    // A stable callback, so the player's frame loop is not torn down and rebuilt
    // on every render of this page.
    const journeyProgress = useCallback(() => stageRef.current?.journeyAt() ?? null, []);

    // Which colour each course is drawn in, and the ladders that name them back
    // in the course list. Both derived from the drawn regions, so a course with
    // nothing on the map is neither coloured nor listed.
    const hues = useMemo(() => courseHues(
        (data?.regions ?? []).flatMap(r => r.projects.map(p => ({ id: p.id, color: p.color })))),
        [data]);
    const swatches = useMemo(() => {
        if (colorMode !== 'course') return [];
        const byId = new Map<number, { id: number; name: string; color: string | null; count: number }>();
        for (const region of data?.regions ?? []) {
            for (const p of region.projects) {
                const seen = byId.get(p.id);
                if (seen) seen.count += p.count;
                else byId.set(p.id, { id: p.id, name: p.name, color: p.color, count: p.count });
            }
        }
        return courseSwatches(
            [...byId.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
            hues, dark, colourSurface);
    }, [data, hues, dark, colorMode, colourSurface]);

    const selectFromList = (id: number | null) => {
        setSelectedId(id);
        // Whichever surface is on screen. On the plane that is a pan; on the
        // planet it is a turn — the same instruction, and the only place the
        // page has to know which one it is drawing.
        if (id == null) return;
        stageRef.current?.flyTo(id);
    };

    const selectFromMap = (id: number | null) => {
        setSelectedId(id);
        if (id == null) return;
        // The answer to a tap on a region is its row, so the index shows the
        // regions — and moves to the row. `start`, not `nearest`: a region row
        // EXPANDS when it is selected, and `nearest` parks a row below the fold
        // at the BOTTOM edge, so the thing you asked to see opens off-screen
        // underneath itself. And the LIST is what moves, never the page:
        // `scrollIntoViewWithin` moves the one scroller it is given.
        setTab('regions');
        requestAnimationFrame(() => {
            const row = listRef.current?.querySelector<HTMLElement>('[aria-expanded="true"]');
            scrollIntoViewWithin(row, {
                boundary: listRef.current, block: 'start', behavior: 'smooth',
            });
        });
    };

    const traceCourseById = (id: number | null, narrow: boolean) => {
        setTraceId(id);
        stop();
        // Go to the course, the way picking a region goes to the region.
        // Without this, choosing a course that lives in one or two bubbles
        // appears to do nothing at all: at the fitted zoom the whole path is a
        // few pixels across and the only visible change is that the rest of the
        // map dimmed.
        if (id == null || !data?.available) return;
        // On a narrow page the open sheet covers most of the map, and what the
        // reader picked a course to see is the map: fold the sheet, and the
        // player on the map is where the course is now.
        if (narrow) setSheetOpen(false);
        // Recomputed rather than read off `trace`, which is memoised on state
        // this call has not committed yet.
        const next = traceCourse(data.regions, id);
        if (next) stageRef.current?.frameOnCourse(next);
    };

    const openTopic = (t: AtlasTopic) => openProjectNode(t.projectId, t.id);

    /**
     * Renaming patches the loaded atlas in place instead of refetching it.
     *
     * The server has already invalidated its cache, so a refetch would be
     * correct — and would also rebuild the whole map, throwing away the pan,
     * the zoom and the open region while the learner is looking at the name
     * they just typed. The one thing that changed is one string, and the map
     * redraws from this state, so it lands on the bubble immediately.
     */
    const patchRegion = (signature: string, patch: Partial<AtlasRegion>) =>
        setData(d => d && ({ ...d, regions: d.regions.map(r => r.signature === signature ? { ...r, ...patch } : r) }));

    const renameRegion = async (region: AtlasRegion, label: string) => {
        try {
            await api.renameAtlasRegion(region.signature, label, region.size);
            patchRegion(region.signature, { label, labelSource: 'user' });
        } catch (e: any) {
            addToast('error', tr("Could not rename this region"), e?.message || '');
        }
    };

    const resetRegionName = async (region: AtlasRegion) => {
        try {
            await api.resetAtlasRegionName(region.signature);
            patchRegion(region.signature, { label: region.medoidLabel, labelSource: 'medoid' });
            addToast('info', tr("Back to the automatic name"), tr("A name will be written for it on the next naming pass."));
        } catch (e: any) {
            addToast('error', tr("Could not reset this name"), e?.message || '');
        }
    };

    // ---- states ----
    if (!data && loading) {
        return (
            <div className="flex items-center justify-center h-full text-slate-500 dark:text-slate-400">
                <Loader2 className="w-5 h-5 animate-spin mr-2" aria-hidden="true" />
                {tr("Drawing your atlas…")}
            </div>
        );
    }

    if (error) {
        return (
            <div className="max-w-md mx-auto mt-16 text-center px-4">
                <p className="text-slate-700 dark:text-slate-200 mb-3">{error}</p>
                <Button variant="primary" onClick={() => load()}>
                    {tr("Try again")}
                </Button>
            </div>
        );
    }

    // An unmapped library is a legitimate state, not a failure: the atlas needs
    // an embedding model, and this app is built to work without one. So the
    // empty state explains the gap and points at the switch, rather than
    // apologising or pretending the feature is broken.
    if (data && !data.available) {
        return (
            <div className="max-w-lg mx-auto mt-12 sm:mt-20 px-4 text-center">
                <MapIcon className="w-10 h-10 mx-auto text-slate-300 dark:text-slate-600 mb-4" aria-hidden="true" />
                <h1 className="text-xl font-semibold text-slate-900 dark:text-white mb-2">{tr("Your atlas isn't drawn yet")}</h1>
                <p className="text-sm text-slate-600 dark:text-slate-300 mb-1">
                    {/* The server writes English; the one reason a new library always meets is translated here. */}
                    {data.reason === 'No topics have been mapped yet.' ? tr("No topics have been mapped yet.") : data.reason}
                </p>
                <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
                    {tr("The atlas groups topics by meaning, which needs an embedding model. Everything else in the app works without one.")}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                    <Button
                        variant="primary"
                        // Straight to the field, opened and flashed — not to
                        // whichever Settings tab was last open.
                        onClick={() => navigate('/settings#ai/embeddings')}
                        icon={<SettingsIcon className="w-4 h-4" aria-hidden="true" />}
                    >
                        {tr("Set up an embedding model")}
                    </Button>
                    <Button onClick={() => load(true)} icon={<RefreshCw className="w-4 h-4" aria-hidden="true" />}>
                        {tr("Check again")}
                    </Button>
                </div>
            </div>
        );
    }

    if (!data) return null;
    const { stats } = data;
    // The ladder the map paints in the app's colour — the progress bar is drawn
    // in it, which makes the bar the map's key without a legend of its own.
    const steps = (colourSurface === 'globe' ? globeRamp : ramp)(accentColor, dark);
    const total = stats.proven + stats.learning + stats.untouched;
    const share = (n: number) => (total > 0 ? `${(n / total) * 100}%` : '0%');

    // The surface switch, drawn OVER the surface it switches, in the map's own
    // top-right corner on both surfaces, so the control does not move when it
    // is used — which is the whole difference between a switch and two buttons
    // that swap places. It turns on its side only when it shares a narrow map's
    // top row with the player.
    const surfaceSwitch = (turn: boolean) => (
        <SegmentedControl<AtlasSurface>
            size="sm"
            orientation={turn ? 'vertical' : 'horizontal'}
            // A panel on the map rather than a control on a page: the map's own
            // chrome material, with no track of its own inside it.
            track={false}
            className={`pointer-events-auto w-max shrink-0 ${CHROME_SURFACE}`}
            label={tr("How the atlas is drawn")}
            value={surface}
            onChange={next => void setAtlasSurface(next)}
            // On its side the names go and the icons stay: the player beside it
            // needs the width for the course's name, and the icons are the ones
            // the switch always carried. The names stay for a screen reader.
            options={[
                {
                    value: 'map',
                    label: <span className="flex items-center gap-1.5"><MapIcon className="w-3.5 h-3.5" aria-hidden="true" /><span className={turn ? 'sr-only' : ''}>{tr("Map")}</span></span>,
                    title: tr("The whole library on one sheet"),
                },
                {
                    value: 'globe',
                    label: <span className="flex items-center gap-1.5"><Globe2 className="w-3.5 h-3.5" aria-hidden="true" /><span className={turn ? 'sr-only' : ''}>{tr("Terra")}</span></span>,
                    title: tr("The same library as a planet you can turn"),
                },
            ]}
        />
    );

    // On a phone with the index open the map is a strip about a third of the
    // screen tall: the zoom cluster stands down (pinch still zooms, folding the
    // sheet brings it back) and the surface switch turns into a column of icons
    // in the corner, so neither lands on the planet.
    const sheetCovers = (narrow: boolean) => narrow && sheetOpen && !fullscreen;

    // The map's top row, handed to whichever surface is drawing: the player
    // (only while a course is traced) on the left, the switch on the right. It
    // floats over the canvas so it survives full screen, and it never unmounts
    // when the surface changes, so a replay carries on across the switch.
    const chrome = (narrow: boolean) => (
        <Measured belowRem={TIGHT_CHROME_REM} className="flex items-start justify-end gap-2">
            {tight => (<>
                {tracedCourse && (
                    <div className={tight ? 'flex-1 min-w-0 flex' : 'mr-auto max-w-full flex'}>
                        <TracePanel
                            course={tracedCourse}
                            swatch={swatches.find(s => s.id === tracedCourse.id)?.color ?? null}
                            onClose={() => traceCourseById(null, narrow)}
                            trace={trace}
                            step={journeyStep}
                            playing={playing}
                            onPlay={startReplay}
                            onPause={pause}
                            onRestart={restartReplay}
                            onOpenSettings={() => setSettingsOpen(true)}
                            progressAt={journeyProgress}
                            compact={tight}
                        />
                    </div>
                )}
                {surfaceSwitch(tight && (!!tracedCourse || sheetCovers(narrow)))}
            </>)}
        </Measured>
    );

    // ---- the index -----------------------------------------------------------
    const searchField = (narrow: boolean) => (
        <TextInput
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            // Typing is asking for the list: a folded sheet opens for it.
            onFocus={() => { if (narrow) setSheetOpen(true); }}
            placeholder={tr("Find a topic or project…")}
            aria-label={tr("Filter regions and topics")}
            icon={<Search className="w-4 h-4" aria-hidden="true" />}
        />
    );

    // How much of the library is proven: one line and one bar, the bar in the
    // map's own ladder (proven at the top rung, in progress mid-way, the rest
    // the untouched rung), so it is the map's key as well as the count.
    const progress = (
        <div className="space-y-1.5">
            <p className="text-sm text-slate-600 dark:text-slate-300 tabular-nums">
                {tr("{{proven}} proven · {{learning}} in progress · {{untouched}} untouched", {
                    proven: num(stats.proven), learning: num(stats.learning), untouched: num(stats.untouched),
                })}
            </p>
            <div
                role="img"
                aria-label={tr("{{proven}} proven · {{learning}} in progress · {{untouched}} untouched", {
                    proven: num(stats.proven), learning: num(stats.learning), untouched: num(stats.untouched),
                })}
                className="flex h-2 rounded-full overflow-hidden ring-1 ring-black/5 dark:ring-white/10"
                style={{ background: steps[0] }}
            >
                <span style={{ width: share(stats.proven), background: steps[4] }} />
                <span style={{ width: share(stats.learning), background: steps[2] }} />
            </div>
        </div>
    );

    const colourSwitch = (
        // The switch names what it CHANGES, which is where the hue comes from —
        // the app's own colour for the whole map, or each course's. Both modes
        // show proof, in the same five steps. It sits under the bar whose
        // colours it changes.
        <SegmentedControl<AtlasColorMode>
            size="sm"
            // The column's width, in two equal halves: two controls stacked in a
            // narrow column read as one column only when both span it.
            className="w-full [&>button]:flex-1"
            label={tr("Where the map’s colour comes from")}
            value={colorMode}
            onChange={mode => void setAtlasColorMode(mode)}
            options={[
                { value: 'mastery', label: tr("App colour") },
                { value: 'course', label: tr("Course colour") },
            ]}
        />
    );

    const tabs = (narrow: boolean) => (
        <SegmentedControl<'regions' | 'courses'>
            size="sm"
            className="w-full [&>button]:flex-1"
            label={tr("What the list shows")}
            value={tab}
            // On a folded sheet the tabs are how the list is reached: pressing
            // either one, even the one already chosen, opens the sheet on it.
            onChange={next => { setTab(next); if (narrow) setSheetOpen(true); }}
            options={[
                { value: 'regions', label: tr("Regions") },
                { value: 'courses', label: tr("Courses") },
            ]}
        />
    );

    const list = (narrow: boolean) => (
        <>
            {tab === 'regions' ? (
                <section aria-label={tr("Regions")}>
                    <RegionList
                        regions={regions}
                        selectedId={selectedId}
                        onSelect={selectFromList}
                        dark={dark}
                        accent={accentColor}
                        colorMode={colorMode}
                        hues={hues}
                        surface={colourSurface}
                        onRename={renameRegion}
                        onResetName={resetRegionName}
                    />
                    <div className="px-1.5 pt-4">
                        <BridgeList bridges={data.bridges} />
                    </div>
                    {/* Naming runs behind the map, so its failures are
                        invisible by construction — the map just goes on
                        showing topic titles as place names and nothing says
                        why. Named here, under the names it is about, because
                        the fix is a setting the learner owns. */}
                    {!!data.naming?.givenUp && (
                        <p className="px-3 pt-4 text-xs text-slate-500 dark:text-slate-400">
                            {tr("{{count}} regions could not be named by", { count: data.naming.givenUp })}{' '}
                            <span className="font-medium">{data.naming.model || tr("the current model")}</span>{' '}
                            {tr("and keep their most central topic’s title. Pick a different naming model in Settings → AI & Models, or rename them yourself.", { count: data.naming.givenUp })}
                        </p>
                    )}
                </section>
            ) : (
                <section aria-label={tr("Courses")}>
                    <CourseList
                        courses={shownCourses}
                        value={traceId}
                        onChange={id => traceCourseById(id, narrow)}
                        swatches={swatches}
                    />
                </section>
            )}
        </>
    );

    const index = (narrow: boolean) => {
        const open = !narrow || sheetOpen;
        return (
            <aside
                key="index"
                aria-label={tr("Atlas index")}
                className={narrow
                    // Docked under the map, its top edge the sheet's: folded it
                    // is as tall as what it shows; open, most of the screen.
                    ? `shrink-0 flex flex-col min-h-0 rounded-t-2xl border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 ${open ? 'h-[62%]' : ''}`
                    : 'w-[22rem] shrink-0 flex flex-col min-h-0 border-r border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800'}
            >
                {narrow && (
                    // The sheet's handle: the whole strip is the target, the
                    // bar is what says it can be pulled.
                    <button
                        type="button"
                        data-disclosure
                        aria-expanded={open}
                        aria-label={open ? tr("Hide the list") : tr("Show the list")}
                        onClick={() => setSheetOpen(o => !o)}
                        className="shrink-0 w-full flex justify-center pt-2 pb-1.5 min-h-6 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 rounded-t-2xl"
                    >
                        <span aria-hidden="true" className="block w-10 h-1.5 rounded-full bg-slate-300 dark:bg-slate-600" />
                    </button>
                )}
                <IndexBody
                    scrollerRef={listRef}
                    header={
                        <div className={`space-y-3 px-3 ${narrow ? 'pb-3' : 'pt-3 pb-2'}`}>
                            {searchField(narrow)}
                            {progress}
                            {open && colourSwitch}
                            {tabs(narrow)}
                        </div>
                    }
                    list={open ? list(narrow) : null}
                />
            </aside>
        );
    };

    const stage = (narrow: boolean) => (
        <section
            key="stage"
            aria-label={tr("Topic map")}
            // Full screen lifts the map out of the page entirely. Below the
            // TaskDock's z-40 on purpose: a background generation must stay
            // visible and clickable rather than being buried by the thing the
            // learner is looking at.
            className={fullscreen ? 'fixed inset-0 z-30' : 'relative flex-1 min-w-0 min-h-0'}
            style={fullscreen ? { paddingBottom: 'var(--task-dock-h, 0px)' } : undefined}
        >
            {surface === 'globe' ? (
                <GlobeMap
                    ref={h => { stageRef.current = h; }}
                    regions={data.regions}
                    selectedId={selectedId}
                    onSelect={selectFromMap}
                    onOpenTopic={openTopic}
                    matches={matches}
                    dark={dark}
                    themeTint={themeTint}
                    accent={accentColor}
                    colorMode={colorMode}
                    hues={hues}
                    trace={trace}
                    journeyStep={journeyStep}
                    pace={pace}
                    regionNames={viewer.regionNames}
                    fullscreen={fullscreen}
                    onToggleFullscreen={() => setFullscreen(f => !f)}
                    controls={!sheetCovers(narrow)}
                >
                    {chrome(narrow)}
                </GlobeMap>
            ) : (
                <AtlasMap
                    ref={h => { stageRef.current = h; }}
                    regions={data.regions}
                    selectedId={selectedId}
                    onSelect={selectFromMap}
                    onOpenTopic={openTopic}
                    matches={matches}
                    dark={dark}
                    themeTint={themeTint}
                    accent={accentColor}
                    colorMode={colorMode}
                    hues={hues}
                    trace={trace}
                    journeyStep={journeyStep}
                    pace={pace}
                    regionNames={viewer.regionNames}
                    fullscreen={fullscreen}
                    onToggleFullscreen={() => setFullscreen(f => !f)}
                    controls={!sheetCovers(narrow)}
                >
                    {chrome(narrow)}
                </AtlasMap>
            )}
        </section>
    );

    return (
        // Not dimmed while it revalidates: the map on screen stays true while
        // the server rebuilds behind it, and since the cache follows progress
        // that rebuild takes seconds after a study session — seconds of a
        // greyed-out page over a map that is still right.
        <div ref={rootRef} className="h-full">
            {/* The top bar already names the page; the heading is for the
                outline a screen reader walks, not for the eye. */}
            <h1 className="sr-only">{tr("Atlas")}</h1>
            {/* The dock floats over the bottom of the page and publishes its
                real height (0px when it is not on screen): reserving it keeps
                the map's control cluster and the sheet out from under it. */}
            <Measured
                belowRem={SHEET_BELOW_REM}
                className="h-full"
                style={{ paddingBottom: 'var(--task-dock-h, 0px)' }}
            >
                {narrow => (
                    <div className={`h-full flex ${narrow ? 'flex-col' : 'flex-row'}`}>
                        {/* Keyed, so crossing the width MOVES the map and index
                            rather than remounting them: a rotation must keep the
                            camera, the pinned card and the search box's focus. */}
                        {narrow ? <>{stage(true)}{index(true)}</> : <>{index(false)}{stage(false)}</>}
                    </div>
                )}
            </Measured>

            {/* The viewer's own settings, and the render that uses them. Mounted
                at the page rather than inside the player that opens it: full
                screen lifts the map out of the page grid, and a dialog written
                inside that subtree would be drawn inside the map. It portals to
                the body anyway (`Modal`), which is what makes that safe. */}
            <AtlasSettingsModal
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                regions={data.regions}
                trace={trace as CourseTrace | null}
                courseName={tracedCourse?.name ?? tr("Atlas")}
                surface={surface}
                dark={dark}
                themeTint={themeTint}
                accent={accentColor}
                colorMode={colorMode}
                hues={hues}
            />
        </div>
    );
}
