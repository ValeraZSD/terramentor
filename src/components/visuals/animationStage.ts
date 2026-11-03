// How wide an animation's stage is: the one rule `renderAnimation` sizes its
// stage with, kept free of the DOM so `tools/animation-frame-gates.mjs` can put
// the drawing rules' own frame through it.
//
// Legibility floor, and it is a SIZE, not a scale — the same rule Mermaid's
// renderer follows. A rule like "never shrink past 0.62" sounds like a
// legibility rule and is not one: it protects a 20-unit title and a 9-unit
// annotation equally, and those reach the reader at 12px and 5px. What the rule
// has to know is how small the type in THIS scene is, and then buy it enough
// width.
//
// MAX_PAN bounds the other side. Past the floor the scene stops shrinking and
// `.visual-block-stage` (already `overflow-x-auto`) scrolls — but a scene whose
// type is tiny could otherwise demand several screens of panning, and a moving
// picture you have to chase is worse than a small one. Two screens is the limit.
//
// The scroll is the last resort, not the plan: the drawing rules
// (ANIMATION_SPECIALIST in server/ai.js) choose a frame and a type size that
// reach this floor on the narrowest phone, so a scene drawn to them never needs
// it. Older scenes, drawn on a wider frame, still do.
//
// MAX_LABEL_PX is the ceiling on a wide card. A frame sized for a phone, drawn
// across a desktop lesson card, paints its 16-unit labels at 25px and its title
// at 31px — half again the size of the page text around it (measured 1 Nov
// 2026 at 1280px). Past the ceiling the stage stops growing and sits centred in
// the card. It never pulls a stage under the floor (20 > 12) and never touches
// one that pans. On a phone it binds only a scene whose SMALLEST text is over
// about 25 units on the 360 frame, which the drawing rules never ask for; that
// scene keeps its labels at 20px and sits centred a little inside the card.

export const MIN_LABEL_PX = 12;
export const MAX_LABEL_PX = 20;
export const MAX_OVERFLOW_WIDTH = 900;
export const MAX_PAN = 2;

/** The width the stage starts from: the card's, within sensible bounds. */
export function availableStageWidth(ctxWidth: number): number {
    return Math.max(260, Math.min(ctxWidth, 680));
}

/**
 * The stage width for a scene `intrinsicWidth` units wide whose smallest label
 * is `smallestUnits`, in a card offering `ctxWidth` px.
 *
 * A unit paints at (width / intrinsicWidth) px, so the smallest label paints at
 * smallestUnits x that; solving for the width at which it reaches MIN_LABEL_PX
 * gives intrinsicWidth x MIN_LABEL_PX / smallestUnits. Never narrower than the
 * card unless the card would paint that label above MAX_LABEL_PX, never wider
 * than MAX_OVERFLOW_WIDTH or MAX_PAN cards. A scene with no text
 * (`smallestUnits` null) has no label to protect either way and fills the card.
 */
export function legibleStageWidth(intrinsicWidth: number, smallestUnits: number | null, ctxWidth: number): number {
    const available = availableStageWidth(ctxWidth);
    if (!Number.isFinite(intrinsicWidth) || intrinsicWidth <= 0) return available;
    if (smallestUnits === null || !(smallestUnits > 0)) return available;
    const legibleWidth = Math.min(
        Math.round(intrinsicWidth * (MIN_LABEL_PX / smallestUnits)),
        MAX_OVERFLOW_WIDTH,
        Math.round(available * MAX_PAN),
    );
    const ceilingWidth = Math.round(intrinsicWidth * (MAX_LABEL_PX / smallestUnits));
    return Math.min(Math.max(available, legibleWidth), ceilingWidth);
}
