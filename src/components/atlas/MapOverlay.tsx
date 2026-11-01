import { useRef } from 'react';
import type { ReactNode } from 'react';
import MapControls, { MapControl } from './MapControls';
import { useElementWidth } from '../../hooks/useElementWidth';
import { useRootFontSize } from '../../hooks/useRootFontSize';

/**
 * Below this much map width the bottom row stacks: the controls turn into a
 * row above a player that takes the full width. In rem, because what it
 * protects is the player's course name at the interface's own scale: a 24rem
 * player beside two 2.75rem gutters is the narrowest that still centres.
 */
const STACK_BELOW_REM = 30;

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
 */
export default function MapOverlay({ top, player, controls }: {
    top?: ReactNode;
    player?: ReactNode;
    /** Null while the phone's sheet is pulled open over the map. */
    controls?: MapControl[] | null;
}) {
    const ref = useRef<HTMLDivElement | null>(null);
    const width = useElementWidth(ref);
    const rootPx = useRootFontSize();
    const stack = width > 0 && width < STACK_BELOW_REM * rootPx;
    return (
        <>
            {top && (
                <div className="absolute top-3 left-3 right-3 z-10 pointer-events-none flex justify-end">{top}</div>
            )}
            <div
                ref={ref}
                className={`absolute bottom-3 left-3 right-3 z-10 pointer-events-none flex gap-2 ${stack ? 'flex-col items-end' : 'items-end'}`}
            >
                {stack ? (
                    <>
                        {controls && <MapControls controls={controls} row />}
                        {player && <div className="w-full min-w-0 flex">{player}</div>}
                    </>
                ) : (
                    <>
                        {/* The mirror of the cluster, so the player is centred
                            on the MAP rather than on what the cluster leaves. */}
                        <div aria-hidden="true" className="w-11 shrink-0" />
                        <div className="flex-1 min-w-0 flex justify-center">{player}</div>
                        {controls ? <MapControls controls={controls} /> : <div aria-hidden="true" className="w-11 shrink-0" />}
                    </>
                )}
            </div>
        </>
    );
}
