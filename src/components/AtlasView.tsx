import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api';
import { useStore, isDarkTheme } from '../store';
import { AtlasColorMode, AtlasData, AtlasRegion, AtlasSurface, AtlasTopic } from '../types';
import AtlasMap from './atlas/AtlasMap';
import GlobeMap from './atlas/GlobeMap';
import RegionList from './atlas/RegionList';
import BridgeList from './atlas/BridgeList';
import TracePanel from './atlas/TracePanel';
import { CourseTrace, listCourses, traceCourse, stepDurationMs, END_HOLD_MS } from './atlas/coursePaths';
import { courseHues, courseSwatches, ramp, STEP_LABELS } from './atlas/atlasColors';
import { SegmentedControl } from './ui/SegmentedControl';
import { scrollIntoViewWithin } from '../utils/scrollWithin';
import { Globe2, Loader2, Map as MapIcon, RefreshCw, Search, Settings as SettingsIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNumberFormat } from '../hooks/useNumberFormat';
import { useElementWidth } from '../hooks/useElementWidth';
import { CHROME_SURFACE } from './atlas/chromeSurface';

/**
 * The atlas: the whole library as one space instead of one tree per course.
 *
 * Every other cross-project surface in this app is organised by time (the feed,
 * the calendar, the schedule board) or by container (the projects grid). None of
 * them can answer *what do I know?*, because knowledge doesn't live in the
 * course that happened to teach it — a learner who proved standing waves in a
 * Dutch curriculum knows standing waves, and no view built around project
 * boundaries can say so.
 *
 * What makes it possible is that topics are embedded (server/nodeEmbeddings.js),
 * so the engine can group by meaning; what keeps it honest is that no model is
 * called to draw it. Region names are the most central topic's own title, so the
 * map never invents a subject that isn't there, and it draws identically every
 * visit — which is the whole difference between a map and a picture.
 *
 * The page is laid out as a MAP plus its index, not as an article: the map
 * takes the height it is given and the list scrolls beside it. A column of
 * blocks in a `max-w-6xl` article is unreachable below the fold here —
 * `Layout`'s `main` is `overflow-hidden` and this page declares no scroll
 * container of its own, so the bridges and most of the region list sit past
 * the edge.
 */
/**
 * The last atlas this session drew, kept outside React so leaving the page and
 * coming back shows the map instead of a spinner.
 *
 * It is worth keeping because it is expensive at both ends: 677 kB of JSON on
 * the real library, and ~1.8 s to build server-side after a restart (13 ms once
 * the server's own cache is warm — both measured 2026-09-09). Re-fetching all of
 * that to redraw a map that is deterministic — same topics in, same picture out
 * — was the "the atlas takes forever" report.
 *
 * Held for the session only, and always revalidated behind the drawn map, so a
 * newly embedded topic still appears; `Refresh` forces the server to rebuild.
 */
let lastAtlas: AtlasData | null = null;

/**
 * Below this many pixels of map, the chrome over it is rearranged: the surface
 * switch turns on its side and sits BESIDE the course panel instead of above
 * it. Chosen from what the two of them need rather than from a device — the
 * panel caps at 22rem (352px) and the turned switch wants about 6rem beside it.
 */
const TIGHT_CHROME = 460;

/**
 * The strip of controls floating over whichever surface is drawn — and the one
 * place that decides how wide it is.
 *
 * Its own component rather than a measurement on the page, for a reason that
 * cost a screenshot: this page renders NOTHING until the atlas has loaded, so a
 * `ref` declared up there is still null when the hook's layout effect runs and
 * the width stays 0 for the life of the page. A component that exists only once
 * there is something to measure measures it on the frame it appears.
 *
 * The children are a function of the answer because both of them need it: the
 * switch turns, and the panel puts its step line on one row.
 */
function MapChrome({ children }: { children: (tight: boolean) => ReactNode }) {
    const ref = useRef<HTMLDivElement | null>(null);
    const width = useElementWidth(ref);
    // Width 0 is "not measured yet", and the answer then is the wide one: it is
    // what every desktop gets, and a phone corrects itself on the first frame.
    const tight = width > 0 && width < TIGHT_CHROME;
    return (
        // ONE ROW at both widths: the surface switch in the map's top-left
        // corner, the course panel in its top-right. The chrome floats OVER the
        // map, so every row of it is a row of map the reader does not get —
        // stacked, the two of them cost the switch's height plus the panel's,
        // and side by side they cost the taller of the two. What changes with
        // the width is only how they fill the row: narrow, the switch turns and
        // the panel takes whatever is left; wide, the switch stays a row of two
        // and the panel is its own 22rem against the far edge.
        //
        // `items-start` with the switch stretching itself (below) rather than
        // `items-stretch`: when the panel is the taller of the two the switch
        // matches it, and when the panel is a single row — no course picked —
        // it is not blown up to the switch's own height with air underneath.
        <div ref={ref} className={`flex items-start gap-2${tight ? '' : ' justify-between'}`}>
            {children(tight)}
        </div>
    );
}

/**
 * What this page asks of whichever surface is drawing the library.
 *
 * Both `AtlasMapHandle` and `GlobeMapHandle` carry these, and each answers them
 * in its own geometry: framing a course is a pan and a zoom on the sheet and a
 * turn on the planet, following a replay slides one camera and swings the
 * other. The page states the intention; the surface owns the move.
 */
interface AtlasStage {
    flyTo: (regionId: number) => void;
    frameOnCourse: (trace: CourseTrace) => void;
    endJourney: (trace: CourseTrace) => void;
    followJourney: () => void;
    journeyAt: () => number | null;
}


export default function AtlasView() {
    const { t: tr } = useTranslation();
    const num = useNumberFormat();
    const theme = useStore(s => s.theme);
    const accentColor = useStore(s => s.accentColor);
    const setView = useStore(s => s.setView);
    const openProjectNode = useStore(s => s.openProjectNode);
    const addToast = useStore(s => s.addToast);
    const colorMode = useStore(s => s.atlasColorMode);
    const setAtlasColorMode = useStore(s => s.setAtlasColorMode);
    const surface = useStore(s => s.atlasSurface);
    const setAtlasSurface = useStore(s => s.setAtlasSurface);
    const dark = isDarkTheme(theme);

    const [data, setData] = useState<AtlasData | null>(lastAtlas);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [query, setQuery] = useState('');
    // Full screen is a CSS mode, not the Fullscreen API: `requestFullscreen`
    // is unsupported for arbitrary elements on iOS Safari, so on the phone this
    // is meant for it would silently do nothing.
    const [fullscreen, setFullscreen] = useState(false);
    // Which course is being traced, and how far along its journey the replay
    // has got. `journeyStep === null` means the whole path is drawn, which is
    // the resting state — the replay is a way of watching a path that is
    // already there, never the only way to see it.
    const [traceId, setTraceId] = useState<number | null>(null);
    const [journeyStep, setJourneyStep] = useState<number | null>(null);
    const [playing, setPlaying] = useState(false);
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

    // Escape leaves full screen from anywhere, including when focus is on a
    // control rather than the canvas — the canvas's own handler only fires
    // while it holds focus, and a map with no visible way out is a trap.
    useEffect(() => {
        if (!fullscreen) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [fullscreen]);

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
    const trace = useMemo(
        () => (data?.available && traceId != null ? traceCourse(data.regions, traceId) : null),
        [data, traceId],
    );

    // A redraw can retire the traced course (a project archived, its topics
    // re-embedded away). Dropping the selection rather than leaving a dead id
    // in state keeps the panel and the map saying the same thing.
    useEffect(() => {
        if (traceId != null && data?.available && !trace) setTraceId(null);
    }, [traceId, data, trace]);

    // The replay clock, which counts EVENTS: the journey is a sequence of
    // finishes, and this state is which of them has been reached. The travel
    // between two of them is the map's business (`stepDurationMs` and the
    // flight beside it) and is a way of showing the ORDER, not a claim about
    // what the learner was doing in between — which is why the number the
    // panel reads is still an integer.
    //
    // A chain of timeouts rather than one interval, because the beat is no
    // longer one number: each step is bought by the distance it has to cover
    // (`stepDurationMs`), so the next tick cannot be scheduled until it is
    // known which step is next. The canvas reads the same function for the
    // speed it flies at, which is what keeps the two from drifting — an arrow
    // flying slower than the steps arrive never lands.
    //
    // The beat being waited here is the one the arrow is flying RIGHT NOW —
    // `stepDurationMs(trace, step)`, the leg INTO the step on screen — not the
    // next one. Waiting for the next leg's beat instead was a phase error with
    // two faces, and both were visible: a short hop followed by a long one
    // landed the arrow and left it parked for up to a second before it moved
    // again, and a long hop followed by short ones started the next beat before
    // the arrow had landed, so the lag grew step by step until it passed
    // `FLIGHT_CUT` and the map cut straight from one topic to another.
    useEffect(() => {
        if (!playing || !trace) return;
        const total = trace.journey.length;
        const step = journeyStep ?? 0;
        if (step >= total) { setPlaying(false); return; }
        const id = window.setTimeout(() => {
            const next = step + 1;
            setJourneyStep(next);
            // Landing on the end is the end: the path stays whole on screen
            // rather than snapping back to nothing.
            if (next >= total) setPlaying(false);
        }, stepDurationMs(trace, Math.max(1, step)));
        return () => window.clearTimeout(id);
    }, [playing, trace, journeyStep]);

    // How the replay ENDS: it holds on the last arrival long enough to read it,
    // then hands back the whole path and pulls the camera out to frame it.
    //
    // A "Show the whole path" button would be a strange thing to ask someone
    // to press: the walk is over, the path is drawn, and the reader is left
    // parked inside whichever bubble the last topic lives in. Ending on the
    // wide shot is what the replay is for, and it frees the
    // ↺ beside Play to mean the one thing a reader ever wants from it — start
    // again. A replay PAUSED on its last step is not this: nothing ends until
    // the clock does.
    //
    // `endJourney`, not `frameOnCourse`: the same destination and a different
    // MOVE. Picking a course off the list is a cut with a destination and is
    // meant to be brisk; this one is the camera the reader has been riding for
    // half a minute letting go, so it keeps that camera's weight and takes its
    // time. Handing the ending to the brisk arm reads as a snap.
    useEffect(() => {
        if (playing || !trace || journeyStep == null) return;
        if (journeyStep < trace.journey.length) return;
        const id = window.setTimeout(() => {
            setJourneyStep(null);
            stageRef.current?.endJourney(trace);
        }, END_HOLD_MS);
        return () => window.clearTimeout(id);
    }, [playing, trace, journeyStep]);

    // Changing surface mid-replay hands the camera to the one that has just
    // arrived. The replay itself never stops — the step clock belongs to this
    // page, not to either canvas — but the new surface opens on the opening
    // view, so without this the reader switches to Terra halfway through a walk
    // and watches the rest of it happen somewhere off the far side of the
    // planet. The course being traced survives for the same reason: it is state
    // here, and the panel that holds it is handed to whichever surface is drawn.
    useEffect(() => {
        if (playing) stageRef.current?.followJourney();
        // `playing` is deliberately not a dependency: this is about the SURFACE
        // changing under a running replay, and starting one already follows.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [surface]);

    // Play RESUMES. A replay is a thing you can stop halfway to look at
    // something, and a play button that silently rewound to step one made
    // pausing cost the whole walk — so the only time it starts from the
    // beginning is when there is nothing to carry on from: no replay yet, or
    // one that has run out. Starting over is the other button's job.
    const startReplay = () => {
        if (!trace || trace.journey.length < 2) return;
        stageRef.current?.followJourney();
        // Resuming takes the next step IMMEDIATELY rather than arming the clock
        // and waiting a beat for it. The arrow is parked on the topic it landed
        // on, so a beat spent before it moves is a beat of nothing happening —
        // up to 1.2s of it on a long hop — and the reader reads that as the
        // button not having worked. Carrying on means carrying on; the beat
        // this press skips is the LANDING it was already sitting in.
        setJourneyStep(s => (s == null || s >= trace.journey.length ? 1 : s + 1));
        setPlaying(true);
    };

    // The panel's timeline follows the arrow, and this is how it asks where the
    // arrow is: the canvas owns that float because the canvas is what eases it.
    // A stable callback, so the panel's frame loop is not torn down and rebuilt
    // on every render of this page.
    const journeyProgress = useCallback(() => stageRef.current?.journeyAt() ?? null, []);

    /** Back to the first step and away again — the ↺ next to the play button. */
    const restartReplay = () => {
        if (!trace || trace.journey.length < 2) return;
        // Watch it from beside the arrow, not from the whole-journey framing.
        // That framing is what picking the course already does, and it answers
        // "what shape is this course?" — but a course whose steps run through
        // one part of the library is a few pixels of movement from out there.
        // The camera goes where the thing being watched is.
        stageRef.current?.followJourney();
        setJourneyStep(1);
        setPlaying(true);
    };

    // Which colour each course is drawn in, and the legend that names them
    // back. Both derived from the drawn regions, so a course with nothing on
    // the map is neither coloured nor legended.
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
            hues, dark);
    }, [data, hues, dark, colorMode]);

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
        // Selecting on the map has to move the list, or the answer to the tap
        // is a row somewhere in a scroller that nothing pointed at.
        //
        // `start`, not `nearest`. A region row EXPANDS when it is selected, and
        // `nearest` does the least work that makes the element visible — which
        // for a row below the fold means parking it at the BOTTOM edge, so the
        // thing you just asked to see opens off-screen underneath itself and
        // you scroll again by hand. Putting it at the top of the scroller means
        // the row and its topics are what you are looking at.
        //
        // And the LIST is what moves — never the page. `scrollIntoView` scrolls
        // every scrollable ancestor, and from `lg` down the index has no
        // scroller of its own: the page scrolls it. Measured on a 390px phone,
        // one tap on a topic pinned the card AND scrolled the page 1,013px, so
        // the map and the card that had just opened on it ended up 322px above
        // the top of the screen. On that width there is nothing to move and the
        // card on the map is the whole answer, so `scrollIntoViewWithin` finds
        // no scroller inside the section and leaves the screen alone.
        if (id != null && listRef.current) {
            requestAnimationFrame(() => {
                const row = listRef.current?.querySelector<HTMLElement>('[aria-expanded="true"]');
                scrollIntoViewWithin(row, {
                    boundary: listRef.current, block: 'start', behavior: 'smooth',
                });
            });
        }
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
                <button onClick={() => load()} className="px-4 py-2 min-h-11 rounded-xl bg-accent text-white text-sm font-medium hover:brightness-90 transition">
                    {tr("Try again")}
                </button>
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
                <p className="text-sm text-slate-600 dark:text-slate-300 mb-1">{data.reason}</p>
                <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
                    {tr("The atlas groups topics by meaning, which needs an embedding model. Everything else in the app works without one.")}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                    <button
                        onClick={() => setView('settings')}
                        className="flex items-center gap-2 px-4 py-2 min-h-11 rounded-xl bg-accent text-white text-sm font-medium hover:brightness-90 transition"
                    >
                        <SettingsIcon className="w-4 h-4" aria-hidden="true" />
                        {tr("Set up an embedding model")}
                    </button>
                    <button
                        onClick={() => load(true)}
                        className="flex items-center gap-2 px-4 py-2 min-h-11 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition"
                    >
                        <RefreshCw className="w-4 h-4" aria-hidden="true" />
                        {tr("Check again")}
                    </button>
                </div>
            </div>
        );
    }

    if (!data) return null;
    const { stats } = data;
    const steps = ramp(accentColor, dark);

    // The surface switch, drawn OVER the surface it switches. It floats on the
    // canvas rather than sitting above it because the map is `flex-1` and
    // already gives its height to the page — a row above it would come out of
    // the picture, on the phone where there is least of it. Both surfaces carry
    // the same chrome slot in the same place, so the control does not move when
    // it is used, which is the whole difference between a switch and two
    // buttons that swap places.
    /**
     * `narrow` is the map's own width; `turn` is whether the panel beside it
     * needs the room a turned switch saves.
     *
     * They are two questions because the answers differ: the switch matches the
     * panel's HEIGHT only while the two are neighbours, which is the narrow
     * layout. Wide, they are in opposite corners of the map with the whole
     * picture between them — nothing lines up across that gap, so matching a
     * taller panel just spends map on a bigger box. Stretching mattered on a
     * phone, where the switch came out 44px against the select's 56 (the
     * select's `touch:min-h-11` applies and the segments' `touch:min-h-9` does
     * not) and the mismatch is under the reader's thumb.
     */
    const surfaceSwitch = (narrow: boolean, turn: boolean) => (
        <SegmentedControl<AtlasSurface>
            size="sm"
            orientation={turn ? 'vertical' : 'horizontal'}
            // A panel on the map rather than a control on a page: the map's own
            // chrome material, with no track of its own inside it (a track
            // there is a second, paler surface on the first — which is what
            // made this box the odd one out beside the course panel).
            track={false}
            className={`pointer-events-auto w-max ${CHROME_SURFACE}${narrow ? ' self-stretch' : ''}`}
            label={tr("How the atlas is drawn")}
            value={surface}
            onChange={next => void setAtlasSurface(next)}
            options={[
                {
                    value: 'map',
                    label: <span className="flex items-center gap-1.5"><MapIcon className="w-3.5 h-3.5" aria-hidden="true" />{tr("Map")}</span>,
                    title: tr("The whole library on one sheet"),
                },
                {
                    value: 'globe',
                    label: <span className="flex items-center gap-1.5"><Globe2 className="w-3.5 h-3.5" aria-hidden="true" />{tr("Terra")}</span>,
                    title: tr("The same library as a planet you can turn"),
                },
            ]}
        />
    );

    // The switch and the course panel, built once and handed to whichever
    // surface is drawing. Both of them float in the same slot over the canvas,
    // so nothing moves when the surface changes — and a course being traced
    // survives the change, because the panel that owns it never unmounts.
    //
    // `MapChrome` decides how the two are arranged from the map's own width,
    // and hands the answer to both: it turns the switch and it puts the panel's
    // step line on one row.
    const chrome = (
        <MapChrome>{tight => (<>
            {/* The switch turns only when something NEEDS the room it saves.
                With no course traced the panel beside it is one select, which
                fits on a phone next to a switch that is a row of two — and a
                turned switch there costs a second line of map for nothing.
                Picking a course grows that panel into a bar, a step line and
                three buttons, and the switch goes on its side to pay for it. */}
            {surfaceSwitch(tight, tight && traceId != null)}
            <TracePanel
                courses={courses}
                value={traceId}
                onChange={id => {
                    setTraceId(id);
                    setPlaying(false);
                    setJourneyStep(null);
                    // Go to the course, the way picking a region goes to the
                    // region. Without this, choosing a course that lives in one
                    // or two bubbles appears to do nothing at all: at the fitted
                    // zoom the whole path is a few pixels across and the only
                    // visible change is that the rest of the map dimmed.
                    if (id == null || !data?.available) return;
                    // Recomputed rather than read off `trace`, which is memoised
                    // on state this call has not committed yet. Two passes over
                    // a few thousand topics, once per press.
                    const next = traceCourse(data.regions, id);
                    if (next) stageRef.current?.frameOnCourse(next);
                }}
                trace={trace}
                step={journeyStep}
                playing={playing}
                onPlay={startReplay}
                onPause={() => setPlaying(false)}
                onRestart={restartReplay}
                progressAt={journeyProgress}
                compact={tight}
            />
        </>)}</MapChrome>
    );

    return (
        // Two scroll models, one page: on a phone the whole thing scrolls and
        // the map takes a fixed slice of the viewport; from `lg` the page stops
        // scrolling and the map fills the height with the index scrolling
        // beside it. Held at reduced opacity while refetching rather than
        // replaced by a skeleton — the map's whole value is recognising it, and
        // a flash of grey boxes throws that away on every reload.
        <div className={`h-full overflow-y-auto lg:overflow-hidden lg:flex lg:flex-col px-3 sm:px-4 py-3 sm:py-4 transition-opacity ${loading ? 'opacity-60' : ''}`}>
            <header className="shrink-0 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-3">
                <div className="min-w-0">
                    <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 dark:text-white">{tr("Atlas")}</h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                        {tr("{{mapped}} topics from {{projects}} projects, grouped into {{regions}} regions by meaning.", { count: stats.mapped, mapped: num(stats.mapped), projects: num(stats.projects), regions: num(stats.regions) })}
                    </p>
                </div>

                <div className="flex items-center gap-3 sm:gap-4">
                    <dl className="flex items-center gap-3 sm:gap-4">
                        {[
                            { label: tr("Proven"), value: stats.proven, tone: 'text-emerald-700 dark:text-emerald-400' },
                            { label: tr("In progress"), value: stats.learning, tone: 'text-amber-700 dark:text-amber-400' },
                            { label: tr("Untouched"), value: stats.untouched, tone: 'text-slate-700 dark:text-slate-200' },
                        ].map(s => (
                            <div key={s.label} className="text-right">
                                <dt className="text-[11px] leading-tight text-slate-500 dark:text-slate-400">{s.label}</dt>
                                {/* Proportional figures on a standalone number —
                                    tabular-nums is for columns that align. */}
                                <dd className={`text-lg sm:text-xl font-semibold leading-tight ${s.tone}`}>{num(s.value)}</dd>
                            </div>
                        ))}
                    </dl>
                    <button
                        onClick={() => load(true)}
                        disabled={loading}
                        className="flex items-center gap-1.5 px-3 py-2 min-h-11 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 transition"
                    >
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
                        <span className="hidden sm:inline">{tr("Redraw")}</span>
                    </button>
                </div>
            </header>

            <div className="lg:flex-1 lg:min-h-0 grid lg:grid-cols-[minmax(0,1fr)_23rem] gap-3 lg:gap-4 items-stretch">
                <section aria-label={tr("Topic map")} className="flex flex-col min-h-0 min-w-0">
                    {/* Full screen lifts the map out of the page grid entirely.
                        Below the TaskDock's z-40 on purpose: a background
                        generation must stay visible and clickable rather than
                        being buried by the thing the learner is looking at. */}
                    <div
                        className={fullscreen
                            ? 'fixed inset-0 z-30 p-2 bg-slate-100 dark:bg-slate-900'
                            : 'h-[58vh] lg:h-auto lg:flex-1 lg:min-h-0'}
                        // Full screen fills the viewport, and the dock floats over
                        // the bottom of it — where the map keeps its own hint line
                        // and, on a phone, the control cluster including the way
                        // OUT of full screen. The legend below reserves the dock's
                        // real height for the same reason; here it is the map's own
                        // chrome that would otherwise be underneath it.
                        style={fullscreen ? { paddingBottom: 'calc(0.5rem + var(--task-dock-h, 0px))' } : undefined}
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
                                theme={theme}
                                accent={accentColor}
                                colorMode={colorMode}
                                hues={hues}
                                trace={trace}
                                journeyStep={journeyStep}
                                fullscreen={fullscreen}
                                onToggleFullscreen={() => setFullscreen(f => !f)}
                            >
                                {chrome}
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
                                theme={theme}
                                accent={accentColor}
                                colorMode={colorMode}
                                hues={hues}
                                trace={trace}
                                journeyStep={journeyStep}
                                fullscreen={fullscreen}
                                onToggleFullscreen={() => setFullscreen(f => !f)}
                            >
                                {chrome}
                            </AtlasMap>
                        )}
                    </div>

                    {/* The atlas is `h-full`, so this legend is pinned to the
                        bottom of the VIEWPORT — which is exactly where the
                        TaskDock floats. Measured with a naming sweep running:
                        the dock's pill sat over "…closer = more alike…", cutting
                        the one sentence that says what the map means. The dock
                        publishes its real height (`--task-dock-h`, 0px when it
                        isn't on screen), so reserve that rather than guessing a
                        constant that would leave dead space the rest of the
                        time. Same fix the tutor's composer already makes. */}
                    <div
                        className="shrink-0 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 pt-2"
                        style={{ paddingBottom: 'var(--task-dock-h, 0px)' }}
                    >
                        {/* The legend and the switch that decides what it
                            legends, together: a control that changes what
                            colour means belongs beside the thing explaining
                            what colour means. */}
                        {/* `w-full`: this is a flex item of a `justify-between`
                            row, so without it the block is sized to its own
                            content and stops at 823px inside a 1024px column —
                            measured — and the legend inside it can only lay out
                            as many columns as that leaves. */}
                        <div className="flex w-full items-center gap-2 flex-wrap">
                            {/* The switch names what it CHANGES, which is where
                                the hue comes from — the app's own colour for
                                the whole map, or each course's. "Proven /
                                Course" would read as a choice between showing
                                proof and showing courses; both modes show
                                proof, in the same five steps, and the one
                                beside "Course" would be the one with no course
                                in it. */}
                            <SegmentedControl<AtlasColorMode>
                                size="sm"
                                label={tr("Where the map’s colour comes from")}
                                value={colorMode}
                                onChange={mode => void setAtlasColorMode(mode)}
                                options={[
                                    { value: 'mastery', label: tr("App colour") },
                                    { value: 'course', label: tr("Course colour") },
                                ]}
                            />
                            {colorMode === 'mastery' ? (
                                <>
                                    <span className="text-xs text-slate-500 dark:text-slate-400">{tr(STEP_LABELS[0])}</span>
                                    <span className="flex rounded-md overflow-hidden ring-1 ring-black/10 dark:ring-white/10" aria-hidden="true">
                                        {steps.map((c, i) => (
                                            <span key={i} className="w-6 h-3.5" style={{ background: c }} />
                                        ))}
                                    </span>
                                    <span className="text-xs text-slate-500 dark:text-slate-400">{tr(STEP_LABELS[4])}</span>
                                </>
                            ) : (
                                // Hue names the course, so the legend has to
                                // name it back — a colour key nobody can read is
                                // decoration. Ordered by how much of the map
                                // each course occupies, because that is the
                                // order a reader meets them in.
                                //
                                // Each course carries the SAME ladder the
                                // mastery legend shows, in its own hue, because
                                // that is what the map paints: hue says which
                                // course, lightness still says how much is
                                // proven. One flat chip per course showed half
                                // the encoding and left the other half to a
                                // sentence underneath.
                                //
                                // The ladder is worded ONCE, ahead of the
                                // courses, rather than bracketing them the way
                                // the mastery legend does: this list wraps, so
                                // an "all proven" after it would land at the end
                                // of whatever line happened to be last and read
                                // as belonging to that course.
                                <>
                                <span className="text-xs text-slate-500 dark:text-slate-400">
                                    {tr(STEP_LABELS[0])} → {tr(STEP_LABELS[4])}
                                </span>
                                {/* A GRID, not a wrap. Flex-wrapped, every row
                                    breaks wherever the names on it happen to
                                    end, so eighteen courses come out as ragged
                                    lines of unequal cells and no two ladders
                                    below each other line up — a colour key is
                                    read by comparing the swatches, and
                                    comparing them means the eye tracking a
                                    column. Columns are sized by the CONTAINER
                                    (`auto-fill`, never a breakpoint), because
                                    this legend sits under a map that is also
                                    mounted in a ~390px panel, where a `md:`
                                    rule would say "desktop" and lay out five
                                    columns 70px wide. Each cell is as wide as
                                    the widest one the row can fit, so a long
                                    course name truncates inside its own cell
                                    rather than pushing its neighbours along. */}
                                {/* `basis-full` because this is a flex row whose
                                    other children are the colour switch and the
                                    ramp label: without it the legend is laid out
                                    as their line-mate and comes out 823px inside
                                    a 1024px column, which is four columns where
                                    six fit. It takes its own line, full width,
                                    and 9rem cells — measured, the widest course
                                    names truncate at 11rem too, so the extra
                                    columns cost nothing that was readable. */}
                                <ul className="grid basis-full w-full min-w-0 grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-x-4 gap-y-1">
                                    {swatches.map(s => (
                                        <li key={s.id} className="flex items-center gap-1.5 min-w-0">
                                            <span
                                                className="flex shrink-0 rounded-sm overflow-hidden ring-1 ring-black/10 dark:ring-white/10"
                                                title={`${s.name}: ${tr(STEP_LABELS[0])} → ${tr(STEP_LABELS[4])}`}
                                                aria-hidden="true"
                                            >
                                                {s.steps.map((c, i) => (
                                                    <span key={i} className="w-1.5 h-3.5" style={{ background: c }} />
                                                ))}
                                            </span>
                                            <span className="text-xs text-slate-600 dark:text-slate-300 truncate">{s.name}</span>
                                        </li>
                                    ))}
                                </ul>
                                </>
                            )}
                        </div>
                        {/* The projection is lossy and the atlas should say so
                            once, quietly, rather than implying the axes mean
                            something — and it must say which projection: the
                            sheet keeps two directions out of hundreds, the
                            planet keeps three, which is the whole reason the
                            second surface exists. */}
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                            {surface === 'globe'
                                ? tr("Area = topics · closer = more alike · the planet is a three-directional view of a much higher-dimensional space, so there is no edge and no corner.")
                                : tr("Bubble size = topics · closer = more alike · positions are a flattened view of a much higher-dimensional space.")}
                            {colorMode === 'course' && ` ${tr("Hue = course, and the colour strengthens as you prove it, so an untouched region sits grey. A bubble shared by several courses is greyed too — no one course owns it. Past about a dozen courses the hues sit close together, and the list beside the map is what names them.")}`}
                            {stats.capped && tr("Grouping is capped at {{regionCap}} regions, so some areas are coarser than they'd otherwise be.", { regionCap: stats.regionCap })}
                        </p>
                        {/* Naming runs behind the map, so its failures are
                            invisible by construction — the map just goes on
                            showing topic titles as place names and nothing says
                            why. Named here, with the model, because the fix is a
                            setting the learner owns. */}
                        {!!data.naming?.givenUp && (
                            <p className="w-full text-xs text-slate-500 dark:text-slate-400">
                                {tr("{{count}} regions could not be named by", { count: data.naming.givenUp })}{' '}
                                <span className="font-medium">{data.naming.model || tr("the current model")}</span>{' '}
                                {tr("and keep their most central topic’s title. Pick a different naming model in Settings → AI & Models, or rename them yourself.", { count: data.naming.givenUp })}
                            </p>
                        )}
                    </div>
                </section>

                <section aria-label={tr("Regions")} className="flex flex-col min-h-0 min-w-0 gap-2" ref={listRef}>
                    <div className="relative shrink-0">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" aria-hidden="true" />
                        <input
                            type="search"
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            placeholder={tr("Find a topic or project…")}
                            aria-label={tr("Filter regions and topics")}
                            className="w-full pl-9 pr-3 py-2 min-h-11 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-accent/60"
                        />
                    </div>
                    {query && (
                        <p className="shrink-0 text-xs text-slate-500 dark:text-slate-400 px-1">
                            {tr("{{count}} regions match “{{query}}”", { count: regions.length, query })}
                            {matches ? ` · ${tr("{{count}} topics lit up on the map", { count: matches.size })}` : ''}.
                        </p>
                    )}
                    <div className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto lg:pr-1 space-y-4">
                        <RegionList
                            regions={regions}
                            selectedId={selectedId}
                            onSelect={selectFromList}
                            dark={dark}
                            accent={accentColor}
                            colorMode={colorMode}
                            hues={hues}
                            onRename={renameRegion}
                            onResetName={resetRegionName}
                        />
                        <BridgeList bridges={data.bridges} />
                    </div>
                </section>
            </div>
        </div>
    );
}
