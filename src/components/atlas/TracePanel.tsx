import { useEffect, useLayoutEffect, useRef } from 'react';
import { Pause, Play, RotateCcw, Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Select } from '../ui/Field';
import { IconButton } from '../ui/Button';
import { uiLocale } from '../../utils/locale';
import { Course, CourseTrace, JourneyTimeline, journeyTimeline } from './coursePaths';
import { CHROME_SURFACE } from './chromeSurface';

interface Props {
    courses: Course[];
    /** The traced project, or null for none. */
    value: number | null;
    onChange: (projectId: number | null) => void;
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
     * notice while watching one, and "render this" means the course in this
     * select. It appears with the course for the same reason, and disappears
     * with it — a gear over an untraced map would be three video fields about
     * nothing.
     */
    onOpenSettings: () => void;
    /**
     * Where the arrow is RIGHT NOW, in steps, as a float — the map's own eased
     * value, asked for on this panel's frame rather than pushed through React.
     * Null when nothing is being drawn.
     */
    progressAt: () => number | null;
    /**
     * The map under this panel is narrow, so the panel takes the width the
     * surface switch beside it leaves rather than a width of its own.
     *
     * Decided by the page from the map's own width and passed down rather than
     * measured here: the same answer turns that switch, and two components
     * measuring the same box can disagree by a frame.
     */
    compact?: boolean;
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
 * The one control the paths layer needs: which course to trace, and whether to
 * watch it being walked.
 *
 * It lives ON the map rather than in the page header for a reason that only
 * shows up on a phone: full screen is a CSS mode that lifts the map out of the
 * page entirely, so a control in the header would be the one thing unreachable
 * exactly where the map is most usable. Map controls belong to the map.
 *
 * One select, two buttons when there is a journey to watch, and the journey's
 * own timeline. Not three toggles for branches / journey / dimming: they are
 * views of one answer to one question — "how does this course go, and how far
 * have I got?" — and separating them would make the reader assemble the picture
 * themselves.
 */
export default function TracePanel({
    courses, value, onChange, trace, step, playing, onPlay, onPause, onRestart, progressAt,
    onOpenSettings, compact = false,
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

    return (
        // Two widths, from the CONTAINER and never a viewport breakpoint (this
        // map is also mounted in a narrow column on a wide screen). On a narrow
        // map it takes whatever the surface switch beside it leaves — `min-w-0`
        // because a flex item will not let its contents truncate without it,
        // and the course name is the thing that has to give. On a wide one it
        // is 22rem: on a phone the panel IS the top of the map, and a 16rem box
        // floating in a 23rem column left the course names cut to two words
        // with empty map beside them, while a full-width one
        // crosses a desktop map it is only chrome on.
        <div className={`pointer-events-auto p-1.5 space-y-1.5 ${CHROME_SURFACE} ${compact ? 'flex-1 min-w-0' : 'w-[22rem] max-w-full'}`}>
            <div className="flex items-center gap-1">
                <Select
                    size="sm"
                    aria-label={tr("Trace a course on the map")}
                    value={value ?? ''}
                    onChange={e => onChange(e.target.value ? Number(e.target.value) : null)}
                >
                    <option value="">{tr("Trace a course…")}</option>
                    {courses.map(c => (
                        <option key={c.id} value={c.id}>
                            {c.name}{c.finished ? ` (${c.finished}/${c.topics})` : ''}
                        </option>
                    ))}
                </Select>
                {/* The gear comes BEFORE the transport buttons, not after, so
                    that Play stays on the panel's own edge at every state: ↺
                    appears and disappears with the replay, and a settings
                    button on the outside would shunt the one control the reader
                    is actually aiming at sideways under their thumb. It shows
                    for any traced course, including one with nothing walked yet
                    — the pace and the region names are still its settings, and
                    the dialog says plainly when there is no journey to film. */}
                {trace && (
                    <IconButton
                        size="sm" variant="quiet" icon={<Settings2 className="w-4 h-4" />}
                        label={tr("Replay and video settings")} onClick={onOpenSettings}
                    />
                )}
                {trace && steps > 1 && (
                    <>
                        {/* Only once there is a walk to start over: on a path
                            nobody has played yet, "again" means nothing. It
                            stays put while playing rather than appearing and
                            disappearing under the pointer. */}
                        {step != null && (
                            <IconButton
                                size="sm" variant="quiet" icon={<RotateCcw className="w-4 h-4" />}
                                label={tr("Start again from the beginning")} onClick={onRestart}
                            />
                        )}
                        <IconButton
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
                        />
                    </>
                )}
            </div>

            {/* The journey in time. The map says where and the step count says
                how many; neither says WHEN, and when is where a learner's own
                record is: the fortnight that closed nine topics and the month
                that closed none are both invisible in "Step 9 of 36". The bar
                begins where the COURSE did, so the run-up before the first
                finish is part of the picture rather than cropped out of it —
                counted in the axis, never drawn as a hole in the bar. */}
            {timeline && (
                <div className="space-y-0.5">
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
                        is a small share of a real course — six days against
                        eight weeks on the library this was built against — so a
                        centred "first" label would sit at the middle of a bar
                        whose junction is at a ninth of it, which is a caption
                        pointing at the wrong day. It belongs beside the start
                        it follows; the bar itself says where. */}
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-[11px] leading-tight text-slate-500 dark:text-slate-400 tabular-nums">
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

            {trace && (
                <div className="min-w-0 text-[11px] leading-tight text-slate-600 dark:text-slate-300">
                    {steps === 0 ? (
                        // Not a failure and not an empty state — the course's
                        // topics are lit on the map, there is simply nothing
                        // walked between them yet. Said plainly, because the
                        // alternative reading ("the replay is broken") is the
                        // one a silent panel invites.
                        <p>{tr("Nothing finished here yet — this course's topics are the lit ones.")}</p>
                    ) : step == null ? (
                        <p>
                            {tr("{{steps}} finished", { steps })}
                            {trace.points.get(trace.journey[steps - 1])?.topic.completedAt
                                ? ` · ${tr("last {{when}}", { when: shortDate(trace.points.get(trace.journey[steps - 1])!.topic.completedAt) })}`
                                : ''}
                        </p>
                    ) : (
                        // ONE line at every width — "Step 4 of 36" over the
                        // topic's name was two rows of a panel that is standing
                        // on the map, for a count four characters long.
                        //
                        // Count, then DATE, then name, in that order: the first
                        // two are short and fixed, the name is the one that can
                        // be any length, and whatever comes last is what gets
                        // cut. With the name in the middle the date was the
                        // part that disappeared — on a long topic title it was
                        // the first thing to go, and it is half of what this
                        // line is for.
                        <p className="flex items-baseline gap-1 min-w-0">
                            {/* "4/36" is a count to LOOK at; said aloud it is two
                                numbers with no noun, so the same sentence the wide
                                layout prints is the accessible name for it. */}
                            <span
                                className="tabular-nums shrink-0"
                                aria-label={tr("Step {{at}} of {{steps}}", { at: stepAt, steps })}
                            >
                                {stepAt}/{steps}
                            </span>
                            {head?.completedAt && (
                                <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">
                                    · {shortDate(head.completedAt)}
                                </span>
                            )}
                            <span className="truncate text-slate-500 dark:text-slate-400">
                                {head ? `· ${head.title}` : ''}
                            </span>
                        </p>
                    )}
                    {trace.undated > 0 && (
                        // The path is shorter than the course's proven count
                        // and the learner is owed the reason rather than left
                        // to notice the discrepancy.
                        <p className="text-slate-500 dark:text-slate-400">
                            {tr("{{undated}} finished with no date, so not on the path", { undated: trace.undated })}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}
