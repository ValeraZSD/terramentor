import { useEffect, useLayoutEffect, useRef } from 'react';
import { Pause, Play, RotateCcw, Settings2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '../ui/Button';
import Reveal from '../ui/Reveal';
import { uiLocale } from '../../utils/locale';
import { Course, CourseTrace, JourneyTimeline, journeyTimeline } from './coursePaths';
import { CHROME_SURFACE } from './chromeSurface';

interface Props {
    /**
     * The course being traced. The PICKING happens in the atlas index
     * (its Courses list, where each course carries its colour and its count);
     * this panel is the player for the one that was picked, so it floats on the
     * map, where it survives full screen and the phone's folded sheet.
     */
    course: Course;
    /** The course's own colour on the map, when the map paints by course. */
    swatch?: string | null;
    /** Stop tracing: the clean map again. */
    onClose: () => void;
    trace: CourseTrace | null;
    /** How far the replay has got, or null when the whole path is drawn. */
    step: number | null;
    playing: boolean;
    onPlay: () => void;
    onPause: () => void;
    /** Back to step one and away again — never "show the whole path". */
    onRestart: () => void;
    /**
     * Open the viewer's own settings — the replay's pace, the region names, and
     * making a video of this journey.
     *
     * It is here rather than in the page header because this is where the
     * questions it answers come up: a replay too quick to read is something you
     * notice while watching one, and "render this" means the course this panel
     * plays. It exists with the course for the same reason — a gear over an
     * untraced map would be three video fields about nothing.
     */
    onOpenSettings: () => void;
    /**
     * Where the arrow is RIGHT NOW, in steps, as a float — the map's own eased
     * value, asked for on this panel's frame rather than pushed through React.
     * Null when nothing is being drawn.
     */
    progressAt: () => number | null;
    /** The ✕, so the page can put focus on the player after a pick that
     *  folded the sheet the pick was made in. */
    closeRef?: React.Ref<HTMLButtonElement>;
}

/**
 * Where a float step lands on the bar: between the two finishes it is flying
 * between, in the same proportion the arrow is between the two topics.
 *
 * The bar is a DATE axis, so this interpolates the two dates — which is what
 * makes the line's speed mean something: a flight between two topics finished
 * an hour apart barely moves it, and one across a fortnight sweeps.
 */
function barFraction(timeline: JourneyTimeline, at: number): number {
    const last = timeline.at.length;
    if (!(at > 0) || last === 0) return 0;
    if (at >= last) return timeline.at[last - 1];
    const i = Math.floor(at);
    const from = i === 0 ? 0 : timeline.at[i - 1];
    const to = timeline.at[Math.min(i, last - 1)];
    return from + (to - from) * (at - i);
}

/**
 * A date the way a caption wants it: no year while the whole journey is inside
 * one, the year on every label the moment it is not. Half a bar labelled with a
 * year and half without reads as a typo rather than as a span.
 */
const dateLabel = (ms: number, withYear: boolean) =>
    new Date(ms).toLocaleDateString(uiLocale(), {
        month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}),
    });

const shortDate = (iso: string | null) =>
    (iso ? new Date(iso).toLocaleDateString(uiLocale(), { month: 'short', day: 'numeric' }) : '');

/**
 * The player for the traced course: whether to watch it being walked, and how
 * far along in time the walk has got.
 *
 * It lives ON the map rather than in the page header for a reason that only
 * shows up on a phone: full screen is a CSS mode that lifts the map out of the
 * page entirely, so a control in the header would be the one thing unreachable
 * exactly where the map is most usable. Map controls belong to the map.
 *
 * Centred along the map's bottom edge (`MapOverlay`), laid out as a media
 * player is: transport on the left where Play never moves, the course and
 * where the walk is in the middle, settings and ✕ on the right, and the
 * timeline across the whole width under them. One box, so it reads as one
 * control and not as a title with buttons and a chart near it.
 */
export default function TracePanel({
    course, swatch, onClose, trace, step, playing, onPlay, onPause, onRestart, progressAt,
    onOpenSettings, closeRef,
}: Props) {
    const { t: tr } = useTranslation();
    const steps = trace?.journey.length ?? 0;
    const stepAt = step == null ? steps : step;
    const headId = trace && stepAt > 0 ? trace.journey[stepAt - 1] : null;
    const head = headId != null ? trace?.points.get(headId)?.topic : null;

    // The same journey on a date axis. Not memoised: it is one pass over a list
    // the panel already holds, and a `useMemo` whose dependency is an object
    // rebuilt by its own parent's memo buys nothing but a stale-key hazard.
    const timeline = trace ? journeyTimeline(trace) : null;
    // Where the replay is, in TIME rather than in events. A finished path is
    // the whole bar: there is nowhere further along for it to be.
    const headFraction = timeline
        ? (step == null ? 1 : timeline.at[Math.min(Math.max(stepAt, 1), timeline.at.length) - 1] ?? 1)
        : 0;
    const crossesYear = timeline
        ? new Date(timeline.startMs).getFullYear() !== new Date(timeline.lastMs).getFullYear()
        : false;
    // The bar is drawn by two elements this component moves itself, at the
    // rate the MAP is moving the arrow — so they are refs, not state: a replay
    // that re-rendered React sixty times a second to slide a line 2px is the
    // thing the canvas exists to avoid.
    const fillRef = useRef<HTMLDivElement | null>(null);
    const headRef = useRef<HTMLSpanElement | null>(null);
    const placeHead = (f: number) => {
        const at = `${Math.max(0, Math.min(1, f)) * 100}%`;
        if (fillRef.current) fillRef.current.style.width = at;
        if (headRef.current) headRef.current.style.left = at;
    };
    // Where the step the page is on puts them — the whole answer while nothing
    // is playing. NOT while it is: a replay re-renders this panel on every
    // step, and placing the line at the step the data has just reached yanks it
    // to the topic the arrow is still flying TOWARD, which the frame loop then
    // drags back. Measured as a 48px jump on a 334px bar, twelve of them
    // backwards, in fourteen seconds.
    useLayoutEffect(() => { if (!playing) placeHead(headFraction); });
    // Follow the arrow. Only while a replay is actually running — a frame loop
    // held open on a settled panel is the trap the map's own draw loop has to
    // avoid too — and the value is the canvas's, never a second clock of this
    // component's own.
    useEffect(() => {
        if (!playing || !timeline) return;
        let raf = 0;
        const tick = () => {
            const at = progressAt();
            if (at != null) placeHead(barFraction(timeline, at));
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [playing, timeline, progressAt]);

    // Under the course's name: where the walk is. One line, because the panel
    // stands on the map.
    const status = !trace ? null : (
        <p className="min-w-0 text-2xs leading-tight text-slate-600 dark:text-slate-300">
            {steps === 0 ? (
                // Not a failure and not an empty state — the course's topics
                // are lit on the map, there is simply nothing walked between
                // them yet. Said plainly, because the alternative reading ("the
                // replay is broken") is the one a silent panel invites.
                tr("Nothing finished here yet — this course's topics are the lit ones.")
            ) : step == null ? (
                <>
                    {tr("{{steps}} finished", { steps })}
                    {/* The bar already ends on "Last <date>"; the same date
                        twice in one panel is one too many. */}
                    {!timeline && trace.points.get(trace.journey[steps - 1])?.topic.completedAt
                        ? ` · ${tr("last {{when}}", { when: shortDate(trace.points.get(trace.journey[steps - 1])!.topic.completedAt) })}`
                        : ''}
                </>
            ) : (
                // Count, then DATE, then name: the first two are short and
                // fixed, the name can be any length, and whatever comes last is
                // what gets cut.
                <span className="flex items-baseline gap-1 min-w-0">
                    {/* "4/36" is a count to LOOK at; said aloud it is two numbers
                        with no noun, so a screen reader gets the sentence. */}
                    <span className="tabular-nums shrink-0">
                        <span aria-hidden="true">{stepAt}/{steps}</span>
                        <span className="sr-only">{tr("Step {{at}} of {{steps}}", { at: stepAt, steps })}</span>
                    </span>
                    {head?.completedAt && (
                        <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">
                            · {shortDate(head.completedAt)}
                        </span>
                    )}
                    <span className="truncate text-slate-500 dark:text-slate-400">
                        {head ? `· ${head.title}` : ''}
                    </span>
                </span>
            )}
        </p>
    );

    return (
        // As wide as the map allows up to 34rem, from the CONTAINER and never a
        // viewport breakpoint: `MapOverlay` centres it, or gives it the whole
        // width on a narrow map. What comes and goes in it — Restart, the
        // timeline — GROWS in (`Reveal`) rather than jumping the box in a frame.
        <div
            role="group"
            aria-label={tr("Course player")}
            className={`pointer-events-auto w-full max-w-[34rem] min-w-0 p-1.5 ${CHROME_SURFACE}`}
        >
            <div className="flex items-center">
                {/* Transport first, where Play is found at every state: ↺
                    arrives beside it once there is a walk to start over, and
                    nothing that comes and goes sits before it. Spacing inside
                    the Reveals, so a closed one takes no gap with it. */}
                <Reveal axis="x" open={!!trace && steps > 1}>
                    <div className="pr-1"><IconButton
                        size="sm" variant="subtle"
                        icon={playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                        // Three different things this button can do, and it
                        // says which: a paused replay carries on from where
                        // it stopped, which is only obvious if the label
                        // says so.
                        label={playing ? tr("Pause the replay")
                            : step != null ? tr("Carry on from here")
                                : tr("Replay this journey")}
                        onClick={playing ? onPause : onPlay}
                    /></div>
                </Reveal>
                <Reveal axis="x" open={!!trace && steps > 1 && step != null}>
                    <div className="pr-1"><IconButton
                        size="sm" variant="quiet" icon={<RotateCcw className="w-4 h-4" />}
                        label={tr("Start again from the beginning")} onClick={onRestart}
                    /></div>
                </Reveal>
                {/* The course and where its walk is: the name behind the
                    colour the map draws it in, the step under it. */}
                <div className="flex-1 min-w-0 px-1">
                    {/* Two lines before it is cut: on a phone at 160% scale the
                        name has about ten characters of one line, and "VWO P…"
                        names no course. */}
                    <p className="flex items-start gap-2 text-sm leading-snug font-medium text-slate-900 dark:text-white">
                        {swatch && (
                            <span aria-hidden="true" className="mt-[0.3125rem] w-2.5 h-2.5 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/15" style={{ background: swatch }} />
                        )}
                        <span className="min-w-0 line-clamp-2 break-words" title={course.name}>{course.name}</span>
                    </p>
                    {trace && status}
                </div>
                {/* Settings for any traced course, including one with nothing
                    walked yet: the pace and the region names are still its
                    settings, and the dialog says plainly when there is no
                    journey to film. ✕ last, on the panel's own edge, where a
                    closing ✕ is looked for: the same road as Escape. */}
                <IconButton
                    size="sm" variant="quiet" icon={<Settings2 className="w-4 h-4" />}
                    label={tr("Replay and video settings")} onClick={onOpenSettings}
                />
                <IconButton
                    ref={closeRef}
                    className="ml-1"
                    size="sm" variant="quiet" icon={<X className="w-4 h-4" />}
                    label={tr("Stop tracing this course")} onClick={onClose}
                />
            </div>

            {/* The journey in time. The map says where and the step count says
                how many; neither says WHEN, and when is where a learner's own
                record is: the fortnight that closed nine topics and the month
                that closed none are both invisible in "Step 9 of 36". The bar
                begins where the COURSE did, so the run-up before the first
                finish is part of the picture rather than cropped out of it —
                counted in the axis, never drawn as a hole in the bar. */}
            <Reveal open={!!timeline}>
            {timeline && (
                <div className="space-y-0.5 pt-1.5">
                    {/* The head overhangs the track, so the wrapper is not the
                        thing that clips the track's own corners. */}
                    <div className="relative">
                        <div
                            role="img"
                            aria-label={tr("The journey runs from {{from}} to {{to}}", {
                                from: dateLabel(timeline.startMs, true), to: dateLabel(timeline.lastMs, true),
                            })}
                            className="relative h-2 rounded-full overflow-hidden bg-slate-200 dark:bg-slate-700"
                        >
                            {/* How far along in TIME the replay has got — from
                                the bar's own start, because a bar that begins
                                with a hole in it reads as something failing to
                                draw rather than as a course nobody had started
                                proving yet. Under the marks, so a proven topic
                                stays visible inside it. */}
                            <div ref={fillRef} className="absolute inset-y-0 left-0 bg-accent/35" />
                            {/* One mark per finish — deduped to a grid in
                                `journeyTimeline`, because a four-thousand-card
                                deck would otherwise ask for four thousand of
                                these. */}
                            {timeline.marks.map(f => (
                                <span
                                    key={f}
                                    aria-hidden="true"
                                    className="absolute inset-y-0 w-px bg-slate-500/60 dark:bg-slate-300/50"
                                    style={{ left: `${f * 100}%` }}
                                />
                            ))}
                        </div>
                        {/* The playhead: one bright line, overhanging the track
                            top and bottom so it reads as a cursor ON the bar
                            rather than another mark IN it, and glowing in its
                            own colour — which is bright against a dark map and
                            the darkened, AA-clamped accent on a light one, so
                            neither theme needs its own rule. It moves at the
                            arrow's own rate, written straight to the style. */}
                        <span
                            ref={headRef}
                            aria-hidden="true"
                            className="pointer-events-none absolute -top-1 -bottom-1 w-0.5 -ml-px rounded-full bg-accent"
                            style={{ boxShadow: '0 0 6px rgb(var(--accent-rgb) / 0.85)' }}
                        />
                    </div>
                    {/* Two clusters, not three evenly spaced dates. The run-up
                        is usually a small share of a course (days against
                        weeks), so a
                        centred "first" label would sit at the middle of a bar
                        whose junction is at a ninth of it, which is a caption
                        pointing at the wrong day. It belongs beside the start
                        it follows; the bar itself says where. */}
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-2xs leading-tight text-slate-500 dark:text-slate-400 tabular-nums">
                        <span className="whitespace-nowrap">
                            {tr("Started {{when}}", { when: dateLabel(timeline.startMs, crossesYear) })}
                            {/* Only when the course began before it: a first
                                finish ON the start date is the start said twice. */}
                            {timeline.hasRunUp
                                && ` · ${tr("first {{when}}", { when: dateLabel(timeline.firstMs, crossesYear) })}`}
                        </span>
                        <span className="whitespace-nowrap ml-auto">
                            {tr("Last {{when}}", { when: dateLabel(timeline.lastMs, crossesYear) })}
                        </span>
                    </div>
                </div>
            )}
            </Reveal>

            {trace && trace.undated > 0 && (
                // The path is shorter than the course's proven count and the
                // learner is owed the reason rather than left to notice it.
                <p className="px-1 pt-1 text-2xs leading-tight text-slate-500 dark:text-slate-400">
                    {tr("{{undated}} finished with no date, so not on the path", { undated: trace.undated })}
                </p>
            )}
        </div>
    );
}
