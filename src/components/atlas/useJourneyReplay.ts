import { RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { CourseTrace, END_HOLD_MS, ReplayPace, stepDurationMs } from './coursePaths';

/**
 * What a replay asks of whichever surface is drawing the library.
 *
 * Both `AtlasMapHandle` and `GlobeMapHandle` carry these, and each answers them
 * in its own geometry: framing a course is a pan and a zoom on the sheet and a
 * turn on the planet, following a replay slides one camera and swings the
 * other. The caller states the intention; the surface owns the move.
 */
export interface AtlasStage {
    flyTo: (regionId: number) => void;
    /** `instant` puts the camera there on the next frame instead of flying it. */
    frameOnCourse: (trace: CourseTrace, opts?: { instant?: boolean }) => void;
    endJourney: (trace: CourseTrace) => void;
    followJourney: () => void;
    journeyAt: () => number | null;
    canvas: () => HTMLCanvasElement | null;
    /** Nothing is moving, fading or flying — what a film waits for at each end. */
    settled: () => boolean;
}

export interface JourneyReplay {
    /** Topics reached — null is the resting state, the whole path drawn. */
    step: number | null;
    playing: boolean;
    /** Carry on from wherever it is; start from the beginning if it is nowhere. */
    play: () => void;
    pause: () => void;
    /** Back to step one and away again. */
    restart: () => void;
    /** Stopped, with the whole path on screen — what picking another course does. */
    stop: () => void;
}

/**
 * The replay's clock: which finish has been reached, and when the next one is.
 *
 * It counts EVENTS. The journey is a sequence of finishes and this state is
 * which of them has been reached; the travel between two of them is the
 * surface's business (`stepDurationMs` and the flight beside it) and is a way
 * of showing the ORDER, not a claim about what the learner was doing in
 * between — which is why the number the panel reads is still an integer.
 *
 * A chain of timeouts rather than one interval, because the beat is not one
 * number: each step is bought by the distance it has to cover, so the next tick
 * cannot be scheduled until it is known which step is next. The surface reads
 * the same function for the speed it flies at, which is what keeps the two from
 * drifting — an arrow flying slower than the steps arrive never lands.
 *
 * ONE copy, because there are now two places a course replays: the atlas page,
 * and the render dialog filming it. A second hand-written clock is a video that
 * runs at a different speed than the map it is a video of.
 */
export function useJourneyReplay(
    trace: CourseTrace | null,
    stage: RefObject<AtlasStage | null>,
    pace: ReplayPace,
    /** Called once the ending has been handed back and the camera let go. */
    onFinished?: () => void,
): JourneyReplay {
    const [step, setStep] = useState<number | null>(null);
    const [playing, setPlaying] = useState(false);
    // In a ref, not a dependency: a caller that rebuilds this callback every
    // render would otherwise tear the ending's timeout down and rearm it, and
    // the replay would never finish.
    const finished = useRef(onFinished);
    finished.current = onFinished;

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
        const at = step ?? 0;
        if (at >= total) { setPlaying(false); return; }
        const id = window.setTimeout(() => {
            const next = at + 1;
            setStep(next);
            // Landing on the end is the end: the path stays whole on screen
            // rather than snapping back to nothing.
            if (next >= total) setPlaying(false);
        }, stepDurationMs(trace, Math.max(1, at), pace));
        return () => window.clearTimeout(id);
    }, [playing, trace, step, pace]);

    // How the replay ENDS: it holds on the last arrival long enough to read it,
    // then hands back the whole path and pulls the camera out to frame it.
    //
    // A "Show the whole path" button would be a strange thing to ask someone to
    // press: the walk is over, the path is drawn, and the reader is left parked
    // inside whichever bubble the last topic lives in. Ending on the wide shot
    // is what the replay is for, and it frees the ↺ beside Play to mean the one
    // thing a reader ever wants from it — start again. A replay PAUSED on its
    // last step is not this: nothing ends until the clock does.
    //
    // `endJourney`, not `frameOnCourse`: the same destination and a different
    // MOVE. Picking a course off the list is a cut with a destination and is
    // meant to be brisk; this one is the camera the reader has been riding for
    // half a minute letting go, so it keeps that camera's weight and takes its
    // time. Handing the ending to the brisk arm reads as a snap.
    useEffect(() => {
        if (playing || !trace || step == null) return;
        if (step < trace.journey.length) return;
        const id = window.setTimeout(() => {
            setStep(null);
            stage.current?.endJourney(trace);
            finished.current?.();
        }, END_HOLD_MS);
        return () => window.clearTimeout(id);
    }, [playing, trace, step, stage]);

    // Play RESUMES. A replay is a thing you can stop halfway to look at
    // something, and a play button that silently rewound to step one made
    // pausing cost the whole walk — so the only time it starts from the
    // beginning is when there is nothing to carry on from: no replay yet, or
    // one that has run out. Starting over is the other button's job.
    const play = useCallback(() => {
        if (!trace || trace.journey.length < 2) return;
        stage.current?.followJourney();
        // Resuming takes the next step IMMEDIATELY rather than arming the clock
        // and waiting a beat for it. The arrow is parked on the topic it landed
        // on, so a beat spent before it moves is a beat of nothing happening —
        // up to 1.2s of it on a long hop — and the reader reads that as the
        // button not having worked. Carrying on means carrying on; the beat
        // this press skips is the LANDING it was already sitting in.
        setStep(s => (s == null || s >= trace.journey.length ? 1 : s + 1));
        setPlaying(true);
    }, [trace, stage]);

    const pause = useCallback(() => setPlaying(false), []);

    const restart = useCallback(() => {
        if (!trace || trace.journey.length < 2) return;
        // Watch it from beside the arrow, not from the whole-journey framing.
        // That framing is what picking the course already does, and it answers
        // "what shape is this course?" — but a course whose steps run through
        // one part of the library is a few pixels of movement from out there.
        // The camera goes where the thing being watched is.
        stage.current?.followJourney();
        setStep(1);
        setPlaying(true);
    }, [trace, stage]);

    const stop = useCallback(() => { setPlaying(false); setStep(null); }, []);

    return { step, playing, play, pause, restart, stop };
}
