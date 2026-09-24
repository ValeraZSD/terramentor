/**
 * What a panel floating over the atlas is made of.
 *
 * Three of them now — the control cluster, the course panel, and the surface
 * switch — and they sit on the same canvas within a few pixels of each other,
 * so any drift between them reads as one of them being a different kind of
 * thing. It had already drifted: the switch carried `bg-white/85
 * dark:bg-slate-800/85` with no border while the other two carried `/90` with
 * one, and on a dark map the switch was visibly the paler box — three panels
 * in a row at the top of the map, one of them a different colour.
 *
 * Not in `ui/vocabulary.ts` because it is not a control: it is the map's own
 * chrome material, and the only things that may be made of it are things
 * floating on a map.
 */
export const CHROME_SURFACE =
    'rounded-xl bg-white/90 dark:bg-slate-800/90 backdrop-blur '
    + 'border border-slate-200 dark:border-slate-600 shadow-sm';
