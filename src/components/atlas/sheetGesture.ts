/**
 * The phone's atlas sheet under a finger: two snap points, folded and open,
 * and a handle that is both a button and a grip.
 *
 * Pure, so the rules a thumb meets are pinned by a gate rather than by hand
 * (`tools/atlas-sheet-gates.mjs`): one finger drives a drag and any other is
 * ignored; a drag shorter than the tap slop is a tap; letting go settles on the
 * snap point the finger was flung towards, or on the nearer one after a slow
 * drag; a cancelled drag goes back to where it started and is never a tap.
 */

/** How much of the page the sheet takes when it is pulled open, and how much
 *  the folded one may take at most before what it holds scrolls inside it.
 *  The `h-[62%]` and `max-h-[45%]` the sheet is drawn with at rest. */
export const SHEET_OPEN = 0.62;
export const SHEET_FOLDED_MAX = 0.45;

/** A release faster than this (px per ms) goes the way the finger was moving,
 *  however little of the way it got. */
export const SHEET_FLING = 0.5;
/** A finger that moves less than this before letting go has tapped. */
export const SHEET_TAP_PX = 6;
/** A finger resting this long (ms) before it let go flung nothing. */
export const SHEET_REST_MS = 120;
/** How long the sheet takes to settle on a snap point after a drag
 *  (the 200 ms transition it is drawn with, and a frame to spare). */
export const SHEET_SETTLE_MS = 220;

export interface SheetDrag {
    pointerId: number;
    /** Where the finger was when the drag took hold (after the tap slop). */
    y0: number;
    y: number;
    t: number;
    /** Smoothed velocity, px per ms, positive downwards. */
    v: number;
    /** The sheet's height when the drag took hold. */
    h0: number;
    min: number;
    max: number;
    moved: boolean;
    /** Whether the sheet was open when the finger came down. */
    wasOpen: boolean;
}

export function beginSheetDrag(p: {
    pointerId: number; y: number; t: number;
    /** The sheet's height now, the page box's height, and the folded height
     *  last measured (0 when never seen folded). */
    sheetPx: number; boxPx: number; foldedPx: number;
    open: boolean;
}): SheetDrag {
    const folded = p.open ? (p.foldedPx || p.sheetPx) : p.sheetPx;
    return {
        pointerId: p.pointerId, y0: p.y, y: p.y, t: p.t, v: 0, h0: p.sheetPx, moved: false, wasOpen: p.open,
        min: Math.min(folded, p.boxPx * SHEET_FOLDED_MAX),
        max: Math.max(p.boxPx * SHEET_OPEN, folded),
    };
}

const clamp = (d: SheetDrag, h: number) => Math.max(d.min, Math.min(d.max, h));

/**
 * One move of a finger. Returns the sheet's height to draw, or null when the
 * move is not this drag's finger or has not yet left the tap slop. The drag
 * takes hold where the finger LEAVES the slop, so the sheet does not jump by
 * the slop when it starts to follow.
 */
export function moveSheetDrag(d: SheetDrag, pointerId: number, y: number, t: number): number | null {
    if (pointerId !== d.pointerId) return null;
    if (!d.moved) {
        if (Math.abs(y - d.y0) < SHEET_TAP_PX) return null;
        d.moved = true;
        d.y0 = y;
        d.y = y;
        d.t = t;
        return d.h0;
    }
    const dt = t - d.t;
    // Smoothed, so one jittery last event does not decide the fling.
    if (dt > 0) d.v = 0.7 * ((y - d.y) / dt) + 0.3 * d.v;
    d.t = t;
    d.y = y;
    return clamp(d, d.h0 - (y - d.y0));
}

export type SheetRelease =
    /** Not this drag's finger: nothing happens. */
    | { kind: 'other' }
    /** Never left the tap slop: the click that follows toggles the sheet. */
    | { kind: 'tap' }
    /** Settle on a snap point. */
    | { kind: 'settle'; open: boolean; px: number };

/** The finger let go. */
export function releaseSheetDrag(d: SheetDrag, pointerId: number, y: number, t: number): SheetRelease {
    if (pointerId !== d.pointerId) return { kind: 'other' };
    if (!d.moved) return { kind: 'tap' };
    const h = clamp(d, d.h0 - (y - d.y0));
    const v = t - d.t > SHEET_REST_MS ? 0 : d.v;
    const open = Math.abs(v) > SHEET_FLING ? v < 0 : h > (d.min + d.max) / 2;
    return { kind: 'settle', open, px: open ? d.max : d.min };
}

/**
 * The drag was taken away (a cancel, a lost capture, the handle unmounted):
 * back to the snap point it started on. Never a tap, so no click is waited
 * for and none is swallowed later.
 */
export function cancelSheetDrag(d: SheetDrag): { open: boolean; px: number; moved: boolean } {
    return { open: d.wasOpen, px: d.wasOpen ? d.max : d.min, moved: d.moved };
}
