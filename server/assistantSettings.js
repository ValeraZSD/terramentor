/**
 * What the assistant is told about the settings it may change.
 *
 * The CLIENT validates and applies a `[[set:key:value]]` marker
 * (src/utils/assistantSettings.ts); the server applies nothing. It only READS,
 * so the model can be told two things it had no way to know: what each setting
 * holds right now, and what its own recent changes replaced. Without the
 * second, "undo" was answered with "I don't have an undo control myself — tap
 * the button" (2026-09-23): putting a setting back is an ordinary marker, but
 * only for a model that knows what "back" is.
 *
 * A leaf: `getSetting` is passed in, so a gate can drive every function here
 * against a plain object.
 */

/** The whitelist, mirrored from the client's `SettingKey`. */
export const SETTABLE_KEYS = ['theme', 'theme_tint', 'accent_color', 'ui_scale', 'week_start_day', 'ui_language', 'number_format'];

/** The client's key aliases, so a marker it accepts is one recorded here. */
const ALIASES = {
    page_colour: 'theme_tint', page_color: 'theme_tint', tint: 'theme_tint',
    accent: 'accent_color', scale: 'ui_scale', text_size: 'ui_scale',
    language: 'ui_language', interface_language: 'ui_language',
    numbers: 'number_format', number_separator: 'number_format', week_start: 'week_start_day',
};

/** The client's defaults (store.ts), so an absent row reads as what the app shows. */
const DEFAULT_ACCENT = '#0E7490';
const NO_TINT = '#ffffff';

const SET_MARKER_RE = /\[\[\s*set\s*:\s*([a-z_ -]+?)\s*:\s*([^\]]+?)\s*\]\]/gi;

/**
 * Every settable value as the app currently shows it, each written as a value
 * the marker accepts — so "put it back" can copy one verbatim.
 */
export function readSettable(getSetting) {
    const theme = String(getSetting('theme', '') || '');
    const tint = String(getSetting('theme_tint', '') || '').toLowerCase();
    const scale = Number(getSetting('ui_scale', null));
    return {
        // `warm` and `black` were themes before a theme became a mode and a
        // tint; a library that never re-saved still carries the name.
        theme: theme === 'dark' || theme === 'black' ? 'dark' : 'light',
        theme_tint: !tint || tint === NO_TINT ? 'none' : tint,
        accent_color: getSetting('accent_color', null) || DEFAULT_ACCENT,
        ui_scale: Number.isFinite(scale) && scale > 0 ? Math.round(scale) : 100,
        week_start_day: String(getSetting('week_start_day', '')) === '0' ? 'sunday' : 'monday',
        ui_language: getSetting('ui_language', null) || 'auto',
        number_format: getSetting('number_format', null) || 'auto',
    };
}

/** The settable keys an answer's markers name, canonical and once each. */
export function settingKeysIn(content) {
    const keys = [];
    for (const m of String(content || '').matchAll(SET_MARKER_RE)) {
        const raw = m[1].trim().toLowerCase().replace(/[\s-]+/g, '_');
        const key = SETTABLE_KEYS.includes(raw) ? raw : ALIASES[raw];
        if (key && !keys.includes(key)) keys.push(key);
    }
    return keys;
}

/**
 * What the keys an answer is about to change hold NOW. Called as the answer is
 * stored, which is before the client applies it (it applies at settle), so
 * these are the values the change replaces. Null when the answer sets nothing.
 */
export function settingsBefore(content, getSetting) {
    const keys = settingKeysIn(content);
    if (!keys.length) return null;
    const now = readSettable(getSetting);
    return Object.fromEntries(keys.map(k => [k, now[k]]));
}

/**
 * The prompt block. `recent` is newest first: `{ minutesAgo, before }` per
 * earlier answer that changed something.
 */
export function assistantSettingsBlock({ now, recent = [] }) {
    const current = SETTABLE_KEYS.map(k => `${k}: ${now[k]}`).join(' · ');
    const lines = recent.map(r => {
        const when = r.minutesAgo < 1 ? 'just now' : r.minutesAgo < 90 ? `${r.minutesAgo} min ago` : `${Math.round(r.minutesAgo / 60)} h ago`;
        const was = Object.entries(r.before).map(([k, v]) => `${k} was ${v}`).join('; ');
        return `- ${when}: ${was}`;
    });
    return `THE SETTINGS YOU CAN CHANGE, AS THEY ARE RIGHT NOW (read from the app this turn):
${current}
${lines.length
        ? `YOUR OWN RECENT CHANGES, newest first — what each key held BEFORE you changed it:
${lines.join('\n')}
UNDOING: "undo", "put it back" or "change it back" means setting those keys to what they held before, with ordinary markers — e.g. [[set:theme:light]]. You CAN do this; never send them to a button instead. A key whose value right now already equals what it held before has been put back already (there is an Undo beside each change you make): say so rather than setting it again.`
        : 'You have not changed any setting recently, so there is nothing of yours to undo; if they ask, say so and offer to set whatever they want.'}`;
}
