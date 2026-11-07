// The colour a NEW course is offered: one no other course wears, so it stands
// apart on the map and on Projects. Shared by the New course dialog and the
// short courses made from a link.
import { PROJECT_COLORS, sameColor } from '../components/ui/ColorField';
import { parseCssColor } from './color';

/**
 * The order a new course is offered a colour in: the VIVID row from blue
 * round the wheel, then the soft row the same way, the greys last. Not the
 * palette's own order, which starts on the soft row's grey; and not red
 * first, which beside a focused Name field reads as an error.
 */
const OFFER_ORDER = [13, 14, 15, 9, 10, 11, 12, 5, 6, 7, 1, 2, 3, 4, 8, 0];

/** The first colour in `OFFER_ORDER` no other project wears, else blue. */
export function freeColour(projects: { color: string }[]): string {
    const worn = projects.map(p => parseCssColor(p.color)).filter((c): c is string => !!c);
    const offered = OFFER_ORDER.map(i => PROJECT_COLORS[i]);
    return offered.find(c => !worn.some(w => sameColor(w, c))) || offered[0];
}
