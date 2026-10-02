/**
 * A surface drawn to be RECORDED rather than used.
 *
 * Both atlas surfaces size their canvas to the box they are given at the
 * screen's pixel ratio, which is right for a map someone is reading and wrong
 * for one being filmed: a recording comes out at the canvas's BACKING STORE
 * size, so the file's dimensions would be whatever the window happened to
 * leave. Handing a surface a `capture` says "this canvas is a video frame of
 * exactly this size"; it is laid out in whatever box the preview has room for
 * and its pixel ratio is derived from the two.
 *
 * That derivation is the whole design decision, and it is deliberate: the frame
 * is the PREVIEW, scaled up. Labels, floors and fades are all sizes in CSS
 * pixels, so a preview 800px wide renders a 1080p video that says exactly what
 * an 800px-wide map says — same names kept, same names dropped. What you watch
 * is what the file holds, which is the one property a render dialog has to have.
 */
export interface AtlasCapture {
    /** The frame's pixel size — exactly what a recorded stream comes out as. */
    width: number;
    height: number;
}

/**
 * How many canvas pixels one CSS pixel is worth on this surface.
 *
 * The screen's own ratio, capped at 2 (past that the gain is invisible and the
 * fill rate is not) — or, while capturing, whatever it takes to land the
 * backing store exactly on the requested frame.
 *
 * ONE copy, read by the sizing observer and by the draw: they were two
 * expressions of the same rule in each of two surfaces, and a draw that scales
 * by a different number than the one the canvas was sized with paints a map
 * that is the right shape and the wrong size.
 */
export function captureRatio(
    capture: AtlasCapture | null | undefined, cssWidth: number,
): number {
    if (capture && cssWidth > 0) return capture.width / cssWidth;
    return Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
}
