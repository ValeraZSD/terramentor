// What a course's fields may hold, as rules both sides of the wire run: the
// icon names, the palette, and what makes a name, a description, a status, a
// daily allowance of new cards or a topic title.
//
// The assistant proposes changes to a course (src/utils/assistantWrites.ts) and
// the server applies them (server/assistantEdits.js). The preview must show
// exactly what Apply would write, and refuse exactly what Apply would refuse —
// an icon name the model made up is not drawn as a stray word, it is named as
// refused. One module, imported by the client too (like `iconArt.js`), is how
// the two cannot drift. The drawings live in `src/components/ProjectIcon.tsx`
// and the palette's tiles in `src/components/ui/ColorField.tsx`; the lists here
// are pinned to them by `assistant-edits-gates.mjs`.
import { normalizeHex } from './iconArt.js';

/** A course name is a title: one line, at most this long (projectIdentity's own cap). */
export const NAME_MAX = 80;
/** A description is a paragraph or two, not a lesson. */
export const DESCRIPTION_MAX = 2000;
/** A topic title, one line. */
export const TITLE_MAX = 200;
/** The deck setting's own ceiling (decks.js `getNewPerDay`). */
export const NEW_PER_DAY_MAX = 9999;

/** The names `projects.icon` stores, in the picker's order (eight rows of eight). */
export const PROJECT_ICON_NAMES = Object.freeze([
    'folder', 'book', 'graduation', 'idea', 'target', 'star', 'heart', 'trophy',
    'notebook', 'library', 'pen', 'bookmark', 'puzzle', 'flag', 'tools', 'check',
    'brain', 'testtube', 'flask', 'microscope', 'dna', 'atom', 'magnet', 'telescope',
    'calculator', 'sigma', 'ruler', 'chart', 'code', 'terminal', 'cpu', 'robot',
    'globe', 'languages', 'map', 'planet', 'rocket', 'mountain', 'leaf', 'sprout',
    'palette', 'brush', 'camera', 'music', 'guitar', 'mic', 'theater', 'film',
    'briefcase', 'money', 'scale', 'museum', 'hospital', 'stethoscope', 'chef', 'car',
    'dumbbell', 'bike', 'gamepad', 'dice', 'smile', 'zap', 'fire', 'history',
]);

/** The project palette, slot for slot with `PROJECT_COLORS` and its names. */
export const PROJECT_PALETTE = Object.freeze([
    { name: 'Silver', hex: '#919cac' },
    { name: 'Coral', hex: '#de7373' },
    { name: 'Apricot', hex: '#cf8e6e' },
    { name: 'Sand', hex: '#b5a04a' },
    { name: 'Sage', hex: '#5dac7a' },
    { name: 'Cornflower', hex: '#6e98cf' },
    { name: 'Lavender', hex: '#9f89d2' },
    { name: 'Mauve', hex: '#d47da8' },
    { name: 'Slate', hex: '#475569' },
    { name: 'Red', hex: '#ef4444' },
    { name: 'Orange', hex: '#f97316' },
    { name: 'Amber', hex: '#f5b30b' },
    { name: 'Green', hex: '#22c55e' },
    { name: 'Blue', hex: '#3b82f6' },
    { name: 'Violet', hex: '#8b5cf6' },
    { name: 'Pink', hex: '#ec4899' },
].map(Object.freeze));

/** The three statuses a course has, and the words a model reaches for. */
export const PROJECT_STATUSES = Object.freeze(['active', 'completed', 'archived']);
const STATUS_WORDS = {
    active: 'active', restore: 'active', restored: 'active', unarchive: 'active', unarchived: 'active',
    completed: 'completed', complete: 'completed', finished: 'completed', finish: 'completed', done: 'completed',
    archived: 'archived', archive: 'archived',
};

const ICONS = new Set(PROJECT_ICON_NAMES);
const BY_COLOUR_NAME = new Map(PROJECT_PALETTE.map(c => [c.name.toLowerCase(), c.hex]));

/** One line of text no longer than `max`, whitespace collapsed; else null. */
export function oneLine(raw, max) {
    if (typeof raw !== 'string') return null;
    const v = raw.replace(/\s+/g, ' ').trim();
    return v && v.length <= max ? v : null;
}

export const projectName = (raw) => oneLine(raw, NAME_MAX);
export const topicTitle = (raw) => oneLine(raw, TITLE_MAX);

/** Paragraphs kept, trailing space and runs of blank lines tidied; an empty
 *  description is a real choice. Null past the cap. */
export function projectDescription(raw) {
    if (typeof raw !== 'string') return null;
    const v = raw.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    return v.length <= DESCRIPTION_MAX ? v : null;
}

/** A stored icon name, or null. Case and the separators a model types between
 *  words (`test tube`, `test-tube`) are not part of a name. */
export function projectIconName(raw) {
    if (typeof raw !== 'string') return null;
    const v = raw.trim().toLowerCase().replace(/[\s_-]+/g, '');
    return ICONS.has(v) ? v : null;
}

/** `#rrggbb` for a palette name or a hex colour (`#abc` and `abc123` too), else
 *  null. Any colour is allowed — Edit project takes any — but only as a value
 *  the app can paint; a CSS keyword like "teal" is not one, and the palette's
 *  own names are the words offered for a colour. */
export function projectColour(raw) {
    if (typeof raw !== 'string') return null;
    const v = raw.trim().toLowerCase();
    if (!v) return null;
    if (BY_COLOUR_NAME.has(v)) return BY_COLOUR_NAME.get(v);
    return normalizeHex(v.startsWith('#') ? v : `#${v}`);
}

/** The palette's name for a colour, when it is one of them. */
export function projectColourName(hex) {
    const h = normalizeHex(typeof hex === 'string' ? hex : '');
    return PROJECT_PALETTE.find(c => c.hex === h)?.name ?? null;
}

/** `active | completed | archived`, from the word or a synonym; else null. */
export function projectStatus(raw) {
    return typeof raw === 'string' ? STATUS_WORDS[raw.trim().toLowerCase()] ?? null : null;
}

/** A whole number of new cards a day, 0 to the ceiling; else null. */
export function newPerDay(raw) {
    const s = String(raw ?? '').trim();
    if (!/^\d{1,4}$/.test(s)) return null;
    const n = Number(s);
    return n <= NEW_PER_DAY_MAX ? n : null;
}
