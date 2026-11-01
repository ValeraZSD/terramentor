import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import MapControls, { MapControl } from './MapControls';
import { useElementWidth } from '../../hooks/useElementWidth';
import { useRootFontSize } from '../../hooks/useRootFontSize';

/**
 * Below this much map width the bottom row stacks: the controls turn into a
 * row above a player that takes the full width. In rem, because what it
 * protects is the player's course name at the interface's own scale. At 30rem
 * the centred player keeps 22rem: the strip's 0.75rem edges, the two 2.75rem
 * gutters and the two 0.5rem gaps take the rest.
 */
const STACK_BELOW_REM = 30;

/** Clear space kept between a framed course and the top of the strip. */
const INSET_GAP_PX = 8;

/**
 * Everything that floats over an atlas surface, laid out once for both.
 *
 * Top-right: the surface switch. Bottom: the player, CENTRED on the map, with
 * the control cluster at the right edge. The player sits between a gutter on
 * each side as wide as the cluster, so it is centred on the map and never
 * under the zoom buttons; on a narrow map the cluster becomes a row above a
 * full-width player instead. Nothing here is positioned by the surfaces, so
 * the plane and the planet cannot drift apart.
 *
 * The strips span the map but pass pointer events through, so the drag they
 * cover still reaches the canvas; each control takes its own back.
 *
 * `onInset` hears how much of the map's bottom the player takes (the whole
 * strip when it is stacked), so a framed course stays above it (`framing.ts`).
 * Measured after every layout that can change it, before the next frame: a
 * course picked in the list is framed a frame later, by which time the player
 * it brought has been laid out and reported.
 */
export default function MapOverlay({ top, player, controls, onInset }: {
    top?: ReactNode;
    player?: ReactNode;
    /** Null while the phone's sheet is pulled open over the map. */
    controls?: MapControl[] | null;
    onInset?: (px: number) => void;
}) {
    const ref = useRef<HTMLDivElement | null>(null);
    const playerRef = useRef<HTMLDivElement | null>(null);
    const width = useElementWidth(ref);
    const rootPx = useRootFontSize();
    const stack = width > 0 && width < STACK_BELOW_REM * rootPx;
    const hasPlayer = !!player;

    useLayoutEffect(() => {
        const strip = ref.current;
        if (!onInset || !strip) return;
        const stage = strip.offsetParent as HTMLElement | null;
        const measure = () => {
            const el = stack ? strip : playerRef.current;
            if (!hasPlayer || !stage || !el) { onInset(0); return; }
            onInset(Math.max(0, stage.getBoundingClientRect().bottom - el.getBoundingClientRect().top + INSET_GAP_PX));
        };
        measure();
        const watch = new ResizeObserver(measure);
        watch.observe(strip);
        if (playerRef.current) watch.observe(playerRef.current);
        if (stage) watch.observe(stage);
        return () => { watch.disconnect(); onInset(0); };
    }, [onInset, stack, hasPlayer]);
    return (
        <>
            {top && (
                <div className="absolute top-3 left-3 right-3 z-10 pointer-events-none flex justify-end">{top}</div>
            )}
            <div
                ref={ref}
                // `data-stacked` lets the player style itself for the narrow
                // layout (TracePanel's step line takes two lines only there).
                data-stacked={stack ? 'true' : undefined}
                className={`group/strip absolute bottom-3 left-3 right-3 z-10 pointer-events-none flex gap-2 ${stack ? 'flex-col items-end' : 'items-end'}`}
            >
                {stack ? (
                    <>
                        {controls && <MapControls controls={controls} row />}
                        {player && <div ref={playerRef} className="w-full min-w-0 flex">{player}</div>}
                    </>
                ) : (
                    <>
                        {/* The mirror of the cluster, so the player is centred
                            on the MAP rather than on what the cluster leaves. */}
                        <div aria-hidden="true" className="w-11 shrink-0" />
                        <div ref={playerRef} className="flex-1 min-w-0 flex justify-center">{player}</div>
                        {controls ? <MapControls controls={controls} /> : <div aria-hidden="true" className="w-11 shrink-0" />}
                    </>
                )}
            </div>
        </>
    );
}
